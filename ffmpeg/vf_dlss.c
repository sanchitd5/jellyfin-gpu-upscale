/*
 * NVIDIA DLSS Super Resolution / DLAA as an FFmpeg video filter.
 *
 * This file is part of FFmpeg.
 *
 * FFmpeg is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 2.1 of the License, or (at your option) any later version.
 *
 * FFmpeg is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public
 * License along with FFmpeg; if not, write to the Free Software
 * Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA 02110-1301 USA
 */

/**
 * @file
 * DLSS Super Resolution and DLAA through NGX's Vulkan path.
 *
 * Everything vf_fsr2.c says about synthesised inputs applies here unchanged,
 * and DLAA has one problem of its own worth stating before anyone enables it.
 *
 * DLAA is DLSS at a 1:1 scale factor.  At 1:1 there is no resolution to
 * recover, so EVERY bit of what it does comes from accumulating samples taken
 * at different sub-pixel positions across frames, and from the anti-aliasing it
 * was trained to undo.  Recorded video supplies neither: the jitter sequence is
 * whatever a fixed sensor happened to produce, and the aliasing the network was
 * trained on is rasterisation aliasing, which a camera does not create.  What a
 * camera creates is compression artefacts and lens blur, which the network has
 * never seen.  The expected result is close to a pass-through with a mild
 * temporal blur.  That is measured and reported rather than assumed.
 *
 * NOTHING FROM NVIDIA IS VENDORED.  The NGX headers, the static NGX library and
 * the DLSS feature blob are all covered by the NVIDIA proprietary licence in
 * github.com/NVIDIA/DLSS.  A builder must fetch them and accept that licence.
 * DLSS.md lists exactly what and from where.
 */

#include <errno.h>
#include <stdbool.h>
#include <stdlib.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <vulkan/vulkan.h>

#include "libavutil/intfloat.h"
#include "libavutil/internal.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "libavutil/thread.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include "gu_inputs.h"

#include <nvsdk_ngx.h>
#include <nvsdk_ngx_vk.h>
#include <nvsdk_ngx_helpers_vk.h>

enum DLSSMode { DLSS_MODE_SR = 0, DLSS_MODE_DLAA };

typedef struct DLImage {
    VkImage        img;
    VkDeviceMemory mem;
    VkImageView    view;
    VkBuffer       stage;
    VkDeviceMemory stage_mem;
    void          *host;
    VkFormat       fmt;
    int            w, h;
    size_t         bytes;
} DLImage;

typedef struct DLSSContext {
    const AVClass *class;

    int   out_w, out_h;
    int   mode;
    int   quality;
    int   jitter_mode, depth_mode, react_mode;
    char *depth_model;
    char *sdk_path;
    float sharpness;
    int   device_index;

    GUInputs g;

    VkInstance       inst;
    VkPhysicalDevice phys;
    VkDevice         dev;
    VkQueue          queue;
    uint32_t         qfam;
    VkCommandPool    pool;
    VkCommandBuffer  cmd;
    VkFence          fence;
    VkPhysicalDeviceMemoryProperties memprops;

    DLImage color, depth, mv, bias, out;

    NVSDK_NGX_Parameter *params;
    NVSDK_NGX_Handle    *dlss;
    /* ngx_inited: Init succeeded, so Shutdown1 owes it a call.  ngx_ready: the
     * whole feature came up and filter_frame may run.  They are not the same
     * thing - everything between the two can fail - and shutting down on the
     * second leaks NGX's per-process state, file lock included, on every
     * partial init. */
    int                  ngx_inited;
    int                  ngx_ready;
    /* cfg_w/cfg_h: the input size the live state was built for, so a second
     * config_props knows whether it has anything to rebuild.  req_w/req_h: the
     * w=/h= request as the user gave it, because out_w/out_h are the option
     * storage and the defaulting in config_output overwrites them with its own
     * answer, which a rebuild would then default off. */
    int                  cfg_w, cfg_h;
    int                  req_w, req_h;
} DLSSContext;

#define OFFSET(x) offsetof(DLSSContext, x)
#define FLAGS AV_OPT_FLAG_FILTERING_PARAM | AV_OPT_FLAG_VIDEO_PARAM

static const AVOption dlss_options[] = {
    { "w", "output width (0: twice the input, or the input for dlaa)",  OFFSET(out_w), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16384, FLAGS },
    { "h", "output height (0: twice the input, or the input for dlaa)", OFFSET(out_h), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16384, FLAGS },
    { "mode", "which NGX feature to run", OFFSET(mode), AV_OPT_TYPE_INT, { .i64 = DLSS_MODE_SR }, 0, 1, FLAGS, .unit = "mode" },
        { "sr",   "DLSS Super Resolution (upscale)",          0, AV_OPT_TYPE_CONST, { .i64 = DLSS_MODE_SR },   0, 0, FLAGS, .unit = "mode" },
        { "dlaa", "DLAA - the same network at 1:1, no upscale",0, AV_OPT_TYPE_CONST, { .i64 = DLSS_MODE_DLAA }, 0, 0, FLAGS, .unit = "mode" },
    { "quality", "DLSS performance/quality preset", OFFSET(quality), AV_OPT_TYPE_INT, { .i64 = 1 }, 0, 3, FLAGS, .unit = "q" },
        { "maxperf", "maximum performance", 0, AV_OPT_TYPE_CONST, { .i64 = 0 }, 0, 0, FLAGS, .unit = "q" },
        { "balanced","balanced",            0, AV_OPT_TYPE_CONST, { .i64 = 1 }, 0, 0, FLAGS, .unit = "q" },
        { "quality", "maximum quality",     0, AV_OPT_TYPE_CONST, { .i64 = 2 }, 0, 0, FLAGS, .unit = "q" },
        { "ultraperf","ultra performance",  0, AV_OPT_TYPE_CONST, { .i64 = 3 }, 0, 0, FLAGS, .unit = "q" },
    { "jitter", "how the sub-pixel jitter sequence is supplied", OFFSET(jitter_mode), AV_OPT_TYPE_INT, { .i64 = GU_JITTER_MEASURED }, 0, 3, FLAGS, .unit = "jitter" },
        { "measured", "measured global sub-pixel offset (phase correlation)",  0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_MEASURED }, 0, 0, FLAGS, .unit = "jitter" },
        { "cancel",   "measured, and declare the MVs jittered",                0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_CANCEL },   0, 0, FLAGS, .unit = "jitter" },
        { "zero",     "no jitter at all",                                      0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_ZERO },     0, 0, FLAGS, .unit = "jitter" },
        { "halton",   "a renderer's Halton sequence - fiction on recorded video",0,AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_HALTON },   0, 0, FLAGS, .unit = "jitter" },
    { "depth", "how the depth buffer is supplied", OFFSET(depth_mode), AV_OPT_TYPE_INT, { .i64 = GU_DEPTH_MODEL }, 0, 2, FLAGS, .unit = "depth" },
        { "flat",         "a constant plane",                    0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_FLAT },         0, 0, FLAGS, .unit = "depth" },
        { "model",        "monocular estimate (dmodel=)",        0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_MODEL },        0, 0, FLAGS, .unit = "depth" },
        { "model-stable", "monocular estimate, flow-warped EMA", 0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_MODEL_STABLE }, 0, 0, FLAGS, .unit = "depth" },
    { "dmodel", "path to the monocular depth ONNX model", OFFSET(depth_model), AV_OPT_TYPE_STRING, { .str = "/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx" }, 0, 0, FLAGS },
    { "reactive", "how the bias-current-colour mask is supplied", OFFSET(react_mode), AV_OPT_TYPE_INT, { .i64 = GU_REACT_FLOW }, 0, 1, FLAGS, .unit = "react" },
        { "none", "nothing - DLSS trusts history everywhere", 0, AV_OPT_TYPE_CONST, { .i64 = GU_REACT_NONE }, 0, 0, FLAGS, .unit = "react" },
        { "flow", "forward/backward flow inconsistency",      0, AV_OPT_TYPE_CONST, { .i64 = GU_REACT_FLOW }, 0, 0, FLAGS, .unit = "react" },
    { "sdk", "directory holding libnvidia-ngx-dlss.so (not shipped: see DLSS.md)", OFFSET(sdk_path), AV_OPT_TYPE_STRING, { .str = "/usr/lib/jellyfin-ffmpeg-oidn/dlss" }, 0, 0, FLAGS },
    { "sharpness", "legacy DLSS sharpening", OFFSET(sharpness), AV_OPT_TYPE_FLOAT, { .dbl = 0.0 }, 0.0, 1.0, FLAGS },
    { "device", "CUDA/Vulkan device index", OFFSET(device_index), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16, FLAGS },
    { NULL }
};

AVFILTER_DEFINE_CLASS(dlss);

static const enum AVPixelFormat pixel_fmts[] = {
    AV_PIX_FMT_GBRPF32LE,
    AV_PIX_FMT_NONE,
};

#define VK_CHECK(ctx, x)                                                       \
    do {                                                                       \
        VkResult _r = (x);                                                     \
        if (_r != VK_SUCCESS) {                                                \
            av_log(ctx, AV_LOG_ERROR, "Vulkan error %d at " #x "\n", (int)_r);  \
            return AVERROR_EXTERNAL;                                           \
        }                                                                      \
    } while (0)

static int mem_type(DLSSContext *s, uint32_t bits, VkMemoryPropertyFlags want)
{
    uint32_t i;
    for (i = 0; i < s->memprops.memoryTypeCount; i++)
        if ((bits & (1u << i)) &&
            (s->memprops.memoryTypes[i].propertyFlags & want) == want)
            return (int)i;
    return -1;
}

static int image_create(AVFilterContext *ctx, DLSSContext *s, DLImage *im,
                        int w, int h, VkFormat fmt, int texel, int storage)
{
    VkImageCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO };
    VkMemoryRequirements req;
    VkMemoryAllocateInfo mai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };
    VkImageViewCreateInfo ivi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO };
    VkBufferCreateInfo bci = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
    int mt;

    im->w = w; im->h = h; im->fmt = fmt;
    im->bytes = (size_t)w * h * texel;

    ici.imageType = VK_IMAGE_TYPE_2D;
    ici.format    = fmt;
    ici.extent    = (VkExtent3D){ w, h, 1 };
    ici.mipLevels = 1;
    ici.arrayLayers = 1;
    ici.samples   = VK_SAMPLE_COUNT_1_BIT;
    ici.tiling    = VK_IMAGE_TILING_OPTIMAL;
    ici.usage     = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                    VK_IMAGE_USAGE_TRANSFER_SRC_BIT | VK_IMAGE_USAGE_STORAGE_BIT;
    ici.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
    ici.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    VK_CHECK(ctx, vkCreateImage(s->dev, &ici, NULL, &im->img));

    vkGetImageMemoryRequirements(s->dev, im->img, &req);
    if ((mt = mem_type(s, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT)) < 0)
        return AVERROR_EXTERNAL;
    mai.allocationSize = req.size; mai.memoryTypeIndex = mt;
    VK_CHECK(ctx, vkAllocateMemory(s->dev, &mai, NULL, &im->mem));
    VK_CHECK(ctx, vkBindImageMemory(s->dev, im->img, im->mem, 0));

    ivi.image = im->img;
    ivi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    ivi.format = fmt;
    ivi.subresourceRange = (VkImageSubresourceRange){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    VK_CHECK(ctx, vkCreateImageView(s->dev, &ivi, NULL, &im->view));

    bci.size = im->bytes;
    bci.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VK_CHECK(ctx, vkCreateBuffer(s->dev, &bci, NULL, &im->stage));
    vkGetBufferMemoryRequirements(s->dev, im->stage, &req);
    if ((mt = mem_type(s, req.memoryTypeBits,
                       VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT |
                       VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)) < 0)
        return AVERROR_EXTERNAL;
    mai.allocationSize = req.size; mai.memoryTypeIndex = mt;
    VK_CHECK(ctx, vkAllocateMemory(s->dev, &mai, NULL, &im->stage_mem));
    VK_CHECK(ctx, vkBindBufferMemory(s->dev, im->stage, im->stage_mem, 0));
    VK_CHECK(ctx, vkMapMemory(s->dev, im->stage_mem, 0, VK_WHOLE_SIZE, 0, &im->host));
    return 0;
}

static void image_destroy(DLSSContext *s, DLImage *im)
{
    if (!s->dev) return;
    if (im->host)      vkUnmapMemory(s->dev, im->stage_mem);
    if (im->stage)     vkDestroyBuffer(s->dev, im->stage, NULL);
    if (im->stage_mem) vkFreeMemory(s->dev, im->stage_mem, NULL);
    if (im->view)      vkDestroyImageView(s->dev, im->view, NULL);
    if (im->img)       vkDestroyImage(s->dev, im->img, NULL);
    if (im->mem)       vkFreeMemory(s->dev, im->mem, NULL);
    memset(im, 0, sizeof(*im));
}

static void barrier(VkCommandBuffer cmd, VkImage img, VkImageLayout from, VkImageLayout to,
                    VkAccessFlags sa, VkAccessFlags da)
{
    VkImageMemoryBarrier b = { .sType = VK_STRUCTURE_TYPE_IMAGE_MEMORY_BARRIER };
    b.oldLayout = from; b.newLayout = to;
    b.srcAccessMask = sa; b.dstAccessMask = da;
    b.srcQueueFamilyIndex = b.dstQueueFamilyIndex = VK_QUEUE_FAMILY_IGNORED;
    b.image = img;
    b.subresourceRange = (VkImageSubresourceRange){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    vkCmdPipelineBarrier(cmd, VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,
                         VK_PIPELINE_STAGE_ALL_COMMANDS_BIT, 0, 0, NULL, 0, NULL, 1, &b);
}

static void cmd_upload(VkCommandBuffer cmd, DLImage *im)
{
    VkBufferImageCopy c = { 0 };
    c.imageSubresource = (VkImageSubresourceLayers){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
    c.imageExtent = (VkExtent3D){ im->w, im->h, 1 };
    barrier(cmd, im->img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            0, VK_ACCESS_TRANSFER_WRITE_BIT);
    vkCmdCopyBufferToImage(cmd, im->stage, im->img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &c);
    barrier(cmd, im->img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, VK_IMAGE_LAYOUT_GENERAL,
            VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT);
}

static NVSDK_NGX_Resource_VK ngx_res(DLImage *im, int rw)
{
    VkImageSubresourceRange r = { VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    return NVSDK_NGX_Create_ImageView_Resource_VK(im->view, im->img, r, im->fmt,
                                                  im->w, im->h, rw);
}

static av_cold int vk_init(AVFilterContext *ctx)
{
    DLSSContext *s = ctx->priv;
    VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO };
    VkInstanceCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO };
    VkDeviceQueueCreateInfo qci = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO };
    VkDeviceCreateInfo dci = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO };
    VkPhysicalDeviceFeatures2 feat2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
    VkCommandPoolCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
    VkCommandBufferAllocateInfo cai = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO };
    VkFenceCreateInfo fci = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    VkPhysicalDevice devs[16];
    VkQueueFamilyProperties qprops[16];
    VkPhysicalDeviceProperties props;
    unsigned int n_iext = 0, n_dext = 0;
    const char **iext = NULL, **dext = NULL;
    uint32_t n = 16, i, nq = 16;
    float prio = 1.0f;

    /* NGX dictates the instance and device extensions, so it has to be asked
     * before either is created.  This call is the reason vf_dlss cannot borrow
     * FFmpeg's own Vulkan device. */
    if (NVSDK_NGX_VULKAN_RequiredExtensions(&n_iext, &iext, &n_dext, &dext) != NVSDK_NGX_Result_Success) {
        av_log(ctx, AV_LOG_ERROR, "NVSDK_NGX_VULKAN_RequiredExtensions failed\n");
        return AVERROR_EXTERNAL;
    }

    app.pApplicationName = "ffmpeg-dlss";
    app.apiVersion = VK_API_VERSION_1_1;
    ici.pApplicationInfo = &app;
    ici.enabledExtensionCount = n_iext;
    ici.ppEnabledExtensionNames = iext;
    VK_CHECK(ctx, vkCreateInstance(&ici, NULL, &s->inst));

    VK_CHECK(ctx, vkEnumeratePhysicalDevices(s->inst, &n, devs));
    if (!n) { av_log(ctx, AV_LOG_ERROR, "no Vulkan device\n"); return AVERROR_EXTERNAL; }
    s->phys = devs[s->device_index < (int)n ? s->device_index : 0];
    vkGetPhysicalDeviceProperties(s->phys, &props);

    vkGetPhysicalDeviceQueueFamilyProperties(s->phys, &nq, qprops);
    s->qfam = UINT32_MAX;
    for (i = 0; i < nq; i++)
        if (qprops[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { s->qfam = i; break; }
    if (s->qfam == UINT32_MAX) return AVERROR_EXTERNAL;

    vkGetPhysicalDeviceFeatures2(s->phys, &feat2);
    feat2.features.shaderStorageImageReadWithoutFormat  = VK_TRUE;
    feat2.features.shaderStorageImageWriteWithoutFormat = VK_TRUE;

    qci.queueFamilyIndex = s->qfam;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;
    dci.pNext = &feat2;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    dci.enabledExtensionCount = n_dext;
    dci.ppEnabledExtensionNames = dext;
    VK_CHECK(ctx, vkCreateDevice(s->phys, &dci, NULL, &s->dev));
    vkGetDeviceQueue(s->dev, s->qfam, 0, &s->queue);
    vkGetPhysicalDeviceMemoryProperties(s->phys, &s->memprops);

    pci.queueFamilyIndex = s->qfam;
    pci.flags = VK_COMMAND_POOL_CREATE_RESET_COMMAND_BUFFER_BIT;
    VK_CHECK(ctx, vkCreateCommandPool(s->dev, &pci, NULL, &s->pool));
    cai.commandPool = s->pool;
    cai.level = VK_COMMAND_BUFFER_LEVEL_PRIMARY;
    cai.commandBufferCount = 1;
    VK_CHECK(ctx, vkAllocateCommandBuffers(s->dev, &cai, &s->cmd));
    VK_CHECK(ctx, vkCreateFence(s->dev, &fci, NULL, &s->fence));

    av_log(ctx, AV_LOG_VERBOSE, "Vulkan device %s for NGX (%u instance, %u device extensions)\n",
           props.deviceName, n_iext, n_dext);
    return 0;
}

static int submit_wait(AVFilterContext *ctx, DLSSContext *s)
{
    VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO };
    si.commandBufferCount = 1;
    si.pCommandBuffers = &s->cmd;
    VK_CHECK(ctx, vkQueueSubmit(s->queue, 1, &si, s->fence));
    VK_CHECK(ctx, vkWaitForFences(s->dev, 1, &s->fence, VK_TRUE, UINT64_MAX));
    VK_CHECK(ctx, vkResetFences(s->dev, 1, &s->fence));
    return 0;
}

/* NGX's Vulkan state is per PROCESS, but Init binds it to one VkDevice and
 * every instance of this filter creates its own.  A second live instance would
 * re-Init NGX onto a different device, and whichever finished first would call
 * Shutdown1 underneath the other while it is still evaluating its feature.  A
 * refcount cannot fix that, because the surviving instance would be left with
 * NGX bound to a device that no longer exists, so a second CONCURRENT instance
 * is refused instead.  Sequential ones are fine: the claim is released in
 * teardown, after Shutdown1. */
static AVMutex ngx_claim_lock = AV_MUTEX_INITIALIZER;
static int     ngx_claimed;

static int ngx_claim(AVFilterContext *ctx)
{
    int taken;

    ff_mutex_lock(&ngx_claim_lock);
    taken = ngx_claimed;
    if (!taken)
        ngx_claimed = 1;
    ff_mutex_unlock(&ngx_claim_lock);

    if (taken) {
        av_log(ctx, AV_LOG_ERROR,
               "another dlss filter instance already owns NGX in this process; NGX "
               "binds to a single Vulkan device, so only one dlss instance can run "
               "at a time. Split the work into separate ffmpeg processes.\n");
        return AVERROR(EBUSY);
    }
    return 0;
}

static void ngx_unclaim(void)
{
    ff_mutex_lock(&ngx_claim_lock);
    ngx_claimed = 0;
    ff_mutex_unlock(&ngx_claim_lock);
}

static av_cold void dlss_teardown(DLSSContext *s)
{
    if (s->dev) vkDeviceWaitIdle(s->dev);
    if (s->dlss)   { NVSDK_NGX_VULKAN_ReleaseFeature(s->dlss);      s->dlss = NULL; }
    if (s->params) { NVSDK_NGX_VULKAN_DestroyParameters(s->params); s->params = NULL; }
    if (s->ngx_inited) {
        NVSDK_NGX_VULKAN_Shutdown1(s->dev);
        s->ngx_inited = 0;
        ngx_unclaim();
    }
    s->ngx_ready = 0;

    image_destroy(s, &s->color);
    image_destroy(s, &s->depth);
    image_destroy(s, &s->mv);
    image_destroy(s, &s->bias);
    image_destroy(s, &s->out);

    if (s->fence) { vkDestroyFence(s->dev, s->fence, NULL);      s->fence = VK_NULL_HANDLE; }
    if (s->pool)  { vkDestroyCommandPool(s->dev, s->pool, NULL); s->pool  = VK_NULL_HANDLE; }
    if (s->dev)   { vkDestroyDevice(s->dev, NULL);               s->dev   = VK_NULL_HANDLE; }
    if (s->inst)  { vkDestroyInstance(s->inst, NULL);            s->inst  = VK_NULL_HANDLE; }
    s->cmd   = VK_NULL_HANDLE;
    s->queue = VK_NULL_HANDLE;
    s->phys  = VK_NULL_HANDLE;

    gu_inputs_uninit(&s->g);
    s->cfg_w = s->cfg_h = 0;
}

static int config_output(AVFilterLink *outlink)
{
    AVFilterContext *ctx = outlink->src;
    AVFilterLink *inlink = ctx->inputs[0];
    DLSSContext *s = ctx->priv;
    NVSDK_NGX_FeatureCommonInfo common = { 0 };
    NVSDK_NGX_DLSS_Create_Params cp = { 0 };
    NVSDK_NGX_Result r;
    VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    const wchar_t *paths[1];
    wchar_t wpath[512];
    size_t i;
    int ret, dlss_avail = 0;

    /* config_props runs again whenever the link is reconfigured.  Everything
     * below creates device- and process-level state, so running it a second
     * time over the live handles leaks the instance, the device, every image
     * and NGX itself.  Unchanged geometry means there is nothing to do; changed
     * geometry means the old state goes first. */
    if (s->cfg_w) {
        if (s->ngx_ready && s->cfg_w == inlink->w && s->cfg_h == inlink->h) {
            outlink->w = s->out_w;
            outlink->h = s->out_h;
            return 0;
        }
        s->out_w = s->req_w;
        s->out_h = s->req_h;
        dlss_teardown(s);
    } else {
        s->req_w = s->out_w;
        s->req_h = s->out_h;
    }
    s->cfg_w = inlink->w;
    s->cfg_h = inlink->h;

    if (s->mode == DLSS_MODE_DLAA) {
        s->out_w = inlink->w;
        s->out_h = inlink->h;
    } else {
        s->out_w = s->out_w ? s->out_w : inlink->w * 2;
        s->out_h = s->out_h ? s->out_h : inlink->h * 2;
    }
    outlink->w = s->out_w;
    outlink->h = s->out_h;

    s->g.jitter_mode  = s->jitter_mode;
    s->g.depth_mode   = s->depth_mode;
    s->g.react_mode   = s->react_mode;
    s->g.depth_model  = s->depth_model;
    s->g.device_index = s->device_index;
    if ((ret = gu_inputs_init(ctx, &s->g, inlink->w, inlink->h)) < 0)
        return ret;

    if ((ret = vk_init(ctx)) < 0)
        return ret;

    /* NGX takes a per-user lock under $XDG_RUNTIME_DIR (it hard-codes /run/user/<uid>
     * when the variable is unset).  In a container with no logind session that
     * directory does not exist, and NGX does NOT fail: it retries the O_CREAT|O_EXCL
     * forever, so NVSDK_NGX_VULKAN_Init never returns and the transcode hangs with no
     * log line.  That was measured with strace, and it is the single reason this
     * filter needs any environment at all. */
    {
        const char *rt = getenv("XDG_RUNTIME_DIR");
        struct stat st_rt;
        if (!rt || !*rt || stat(rt, &st_rt) != 0 || !S_ISDIR(st_rt.st_mode)) {
            const char *fallback = "/tmp/.ngx-runtime";
            if (mkdir(fallback, 0700) != 0 && errno != EEXIST) {
                av_log(ctx, AV_LOG_ERROR,
                       "cannot create %s; NGX needs a usable XDG_RUNTIME_DIR or it "
                       "will hang rather than fail\n", fallback);
                return AVERROR(errno);
            }
            setenv("XDG_RUNTIME_DIR", fallback, 1);
            av_log(ctx, AV_LOG_VERBOSE, "XDG_RUNTIME_DIR was unusable; set to %s for NGX\n",
                   fallback);
        }
    }

    for (i = 0; s->sdk_path && s->sdk_path[i] && i < FF_ARRAY_ELEMS(wpath) - 1; i++)
        wpath[i] = (wchar_t)s->sdk_path[i];
    wpath[i] = 0;
    paths[0] = wpath;
    common.PathListInfo.Path   = paths;
    common.PathListInfo.Length = 1;
    common.LoggingInfo.LoggingCallback = NULL;
    common.LoggingInfo.MinimumLoggingLevel = NVSDK_NGX_LOGGING_LEVEL_OFF;

    /* The DLSS feature blob (libnvidia-ngx-dlss.so) is NOT shipped with this
     * plugin and cannot be: it is NVIDIA proprietary.  `sdk=` points at wherever
     * the operator put their own copy.  DLSS.md says which file and from where. */
    /* The application-ID form of Init is for titles NVIDIA has registered.  This is
     * not one, so the documented path is Init_with_ProjectID with EngineType CUSTOM:
     * the app-ID form was measured to hang here rather than return an error. */
    if ((ret = ngx_claim(ctx)) < 0)
        return ret;
    r = NVSDK_NGX_VULKAN_Init_with_ProjectID(
            /* NGX validates the project id as a GUID string, not a free-form name. */
            "a0f57b54-1daf-4934-90ae-c4035c19df04",
            NVSDK_NGX_ENGINE_TYPE_CUSTOM, "1.0", wpath,
            s->inst, s->phys, s->dev, vkGetInstanceProcAddr, vkGetDeviceProcAddr,
            &common, NVSDK_NGX_Version_API);
    if (r != NVSDK_NGX_Result_Success) {
        av_log(ctx, AV_LOG_ERROR,
               "NVSDK_NGX_VULKAN_Init_with_ProjectID failed (0x%08x). The DLSS runtime is not "
               "shipped with this plugin; put libnvidia-ngx-dlss.so.* in %s "
               "(see DLSS.md)\n", (unsigned)r, s->sdk_path);
        ngx_unclaim();
        return AVERROR_EXTERNAL;
    }
    s->ngx_inited = 1;
    if (NVSDK_NGX_VULKAN_GetCapabilityParameters(&s->params) != NVSDK_NGX_Result_Success) {
        av_log(ctx, AV_LOG_ERROR, "NVSDK_NGX_VULKAN_GetCapabilityParameters failed\n");
        return AVERROR_EXTERNAL;
    }
    NVSDK_NGX_Parameter_GetI(s->params, NVSDK_NGX_Parameter_SuperSampling_Available, &dlss_avail);
    if (!dlss_avail) {
        av_log(ctx, AV_LOG_ERROR, "NGX reports DLSS unavailable on this driver/GPU\n");
        return AVERROR_EXTERNAL;
    }

    if ((ret = image_create(ctx, s, &s->color, inlink->w, inlink->h, VK_FORMAT_R16G16B16A16_SFLOAT, 8, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->depth, inlink->w, inlink->h, VK_FORMAT_R32_SFLOAT,          4, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->mv,    inlink->w, inlink->h, VK_FORMAT_R16G16_SFLOAT,       4, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->bias,  inlink->w, inlink->h, VK_FORMAT_R32_SFLOAT,          4, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->out,   s->out_w,  s->out_h,  VK_FORMAT_R16G16B16A16_SFLOAT, 8, 1)) < 0)
        return ret;

    cp.Feature.InWidth        = inlink->w;
    cp.Feature.InHeight       = inlink->h;
    cp.Feature.InTargetWidth  = s->out_w;
    cp.Feature.InTargetHeight = s->out_h;
    cp.Feature.InPerfQualityValue =
        s->mode == DLSS_MODE_DLAA ? NVSDK_NGX_PerfQuality_Value_DLAA :
        s->quality == 0 ? NVSDK_NGX_PerfQuality_Value_MaxPerf :
        s->quality == 2 ? NVSDK_NGX_PerfQuality_Value_MaxQuality :
        s->quality == 3 ? NVSDK_NGX_PerfQuality_Value_UltraPerformance :
                          NVSDK_NGX_PerfQuality_Value_Balanced;
    cp.InFeatureCreateFlags = NVSDK_NGX_DLSS_Feature_Flags_MVLowRes |
                              NVSDK_NGX_DLSS_Feature_Flags_AutoExposure;
    if (s->depth_mode != GU_DEPTH_FLAT)
        cp.InFeatureCreateFlags |= NVSDK_NGX_DLSS_Feature_Flags_DepthInverted;
    if (s->jitter_mode == GU_JITTER_CANCEL)
        cp.InFeatureCreateFlags |= NVSDK_NGX_DLSS_Feature_Flags_MVJittered;
    if (s->sharpness > 0.0f)
        cp.InFeatureCreateFlags |= NVSDK_NGX_DLSS_Feature_Flags_DoSharpening;

    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkResetCommandBuffer(s->cmd, 0);
    vkBeginCommandBuffer(s->cmd, &bi);
    r = NGX_VULKAN_CREATE_DLSS_EXT(s->cmd, 1, 1, &s->dlss, s->params, &cp);
    vkEndCommandBuffer(s->cmd);
    if (r != NVSDK_NGX_Result_Success) {
        av_log(ctx, AV_LOG_ERROR, "NGX_VULKAN_CREATE_DLSS_EXT failed (0x%08x)\n", (unsigned)r);
        return AVERROR_EXTERNAL;
    }
    if ((ret = submit_wait(ctx, s)) < 0)
        return ret;
    s->ngx_ready = 1;

    av_log(ctx, AV_LOG_WARNING,
           "%s %dx%d -> %dx%d DEGRADED: motion vectors are NVOFA optical flow, "
           "depth is %s, jitter is %s, bias mask is %s. %s\n",
           s->mode == DLSS_MODE_DLAA ? "dlaa" : "dlss",
           inlink->w, inlink->h, s->out_w, s->out_h,
           s->depth_mode == GU_DEPTH_FLAT ? "a flat constant" :
           s->depth_mode == GU_DEPTH_MODEL ? "a monocular estimate" :
                                             "a flow-stabilised monocular estimate",
           s->jitter_mode == GU_JITTER_ZERO   ? "zero" :
           s->jitter_mode == GU_JITTER_HALTON ? "a Halton sequence that does not "
                                                "describe the recording" :
           s->jitter_mode == GU_JITTER_CANCEL ? "measured, declared present in the MVs" :
                                                "measured global phase correlation",
           s->react_mode == GU_REACT_FLOW ? "forward/backward flow inconsistency" : "absent",
           s->mode == DLSS_MODE_DLAA
             ? "DLAA at 1:1 has no resolution to recover: without a real jitter "
               "sequence there is nothing to accumulate, and the aliasing it was "
               "trained on is rasterisation aliasing, which a camera does not make."
             : "DLSS is a renderer algorithm; recorded video cannot supply its "
               "inputs properly. Expect ghosting and no true super-resolution.");
    return 0;
}

static uint16_t f2h(float f)
{
    union { float f; uint32_t u; } v = { .f = f };
    uint32_t u = v.u, sign = (u >> 16) & 0x8000;
    int32_t  exp = (int32_t)((u >> 23) & 0xff) - 127 + 15;
    uint32_t man = u & 0x7fffff;
    if (exp <= 0)  return (uint16_t)sign;
    if (exp >= 31) return (uint16_t)(sign | 0x7c00);
    return (uint16_t)(sign | (exp << 10) | (man >> 13));
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    DLSSContext *s = ctx->priv;
    AVFrame *out;
    NVSDK_NGX_VK_DLSS_Eval_Params ep = { 0 };
    NVSDK_NGX_Resource_VK r_color, r_depth, r_mv, r_bias, r_out;
    VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    NVSDK_NGX_Result r;
    const float *R, *G, *B;
    uint16_t *h16;
    int rls, gls, bls, x, y, ret;

    if (!s->ngx_ready) { av_frame_free(&in); return AVERROR(EINVAL); }

    if ((ret = gu_inputs_frame(ctx, &s->g, in)) < 0) { av_frame_free(&in); return ret; }

    out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
    if (!out) { av_frame_free(&in); return AVERROR(ENOMEM); }
    av_frame_copy_props(out, in);

    R = (const float *)in->data[2]; G = (const float *)in->data[0]; B = (const float *)in->data[1];
    rls = in->linesize[2] / 4; gls = in->linesize[0] / 4; bls = in->linesize[1] / 4;

    h16 = (uint16_t *)s->color.host;
    for (y = 0; y < inlink->h; y++)
        for (x = 0; x < inlink->w; x++) {
            size_t k = ((size_t)y * inlink->w + x) * 4;
            h16[k]     = f2h(R[(size_t)y * rls + x]);
            h16[k + 1] = f2h(G[(size_t)y * gls + x]);
            h16[k + 2] = f2h(B[(size_t)y * bls + x]);
            h16[k + 3] = f2h(1.0f);
        }
    memcpy(s->depth.host, s->g.depth, (size_t)inlink->w * inlink->h * sizeof(float));
    memcpy(s->bias.host,  s->g.reactive, (size_t)inlink->w * inlink->h * sizeof(float));

    /* current -> previous, render-resolution pixels, so InMVScale is 1,1 */
    h16 = (uint16_t *)s->mv.host;
    for (y = 0; y < inlink->h; y++)
        for (x = 0; x < inlink->w; x++) {
            size_t k = (size_t)y * inlink->w + x;
            h16[k * 2]     = f2h(-s->g.flow[k * 2]);
            h16[k * 2 + 1] = f2h(-s->g.flow[k * 2 + 1]);
        }

    vkResetCommandBuffer(s->cmd, 0);
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(s->cmd, &bi);
    cmd_upload(s->cmd, &s->color);
    cmd_upload(s->cmd, &s->depth);
    cmd_upload(s->cmd, &s->mv);
    if (s->react_mode == GU_REACT_FLOW)
        cmd_upload(s->cmd, &s->bias);
    barrier(s->cmd, s->out.img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL,
            0, VK_ACCESS_SHADER_WRITE_BIT);

    r_color = ngx_res(&s->color, 0);
    r_depth = ngx_res(&s->depth, 0);
    r_mv    = ngx_res(&s->mv,    0);
    r_bias  = ngx_res(&s->bias,  0);
    r_out   = ngx_res(&s->out,   1);

    ep.Feature.pInColor  = &r_color;
    ep.Feature.pInOutput = &r_out;
    ep.Feature.InSharpness = s->sharpness;
    ep.pInDepth          = &r_depth;
    ep.pInMotionVectors  = &r_mv;
    if (s->react_mode == GU_REACT_FLOW)
        ep.pInBiasCurrentColorMask = &r_bias;
    /* Only the sub-pixel residual is jitter; the integer part is already in the
     * flow field, which is where DLSS's contract puts it. */
    ep.InJitterOffsetX   = s->g.jitter_x - nearbyintf(s->g.jitter_x);
    ep.InJitterOffsetY   = s->g.jitter_y - nearbyintf(s->g.jitter_y);
    ep.InRenderSubrectDimensions.Width  = inlink->w;
    ep.InRenderSubrectDimensions.Height = inlink->h;
    ep.InReset     = s->g.frame_index <= 1;
    ep.InMVScaleX  = 1.0f;
    ep.InMVScaleY  = 1.0f;
    ep.InPreExposure = 1.0f;

    r = NGX_VULKAN_EVALUATE_DLSS_EXT(s->cmd, s->dlss, s->params, &ep);
    if (r != NVSDK_NGX_Result_Success) {
        av_log(ctx, AV_LOG_ERROR, "NGX_VULKAN_EVALUATE_DLSS_EXT failed (0x%08x)\n", (unsigned)r);
        vkEndCommandBuffer(s->cmd);
        av_frame_free(&in); av_frame_free(&out);
        return AVERROR_EXTERNAL;
    }

    {
        VkBufferImageCopy c = { 0 };
        c.imageSubresource = (VkImageSubresourceLayers){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
        c.imageExtent = (VkExtent3D){ s->out.w, s->out.h, 1 };
        barrier(s->cmd, s->out.img, VK_IMAGE_LAYOUT_GENERAL, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT);
        vkCmdCopyImageToBuffer(s->cmd, s->out.img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                               s->out.stage, 1, &c);
    }
    vkEndCommandBuffer(s->cmd);
    if ((ret = submit_wait(ctx, s)) < 0) {
        av_frame_free(&in); av_frame_free(&out);
        return ret;
    }

    {
        const uint16_t *src = (const uint16_t *)s->out.host;
        float *oR = (float *)out->data[2], *oG = (float *)out->data[0],
              *oB = (float *)out->data[1];
        int lr = out->linesize[2] / 4, lg = out->linesize[0] / 4, lb = out->linesize[1] / 4;
        /* half -> float, straightforward and not on the hot path */
        for (y = 0; y < s->out_h; y++)
            for (x = 0; x < s->out_w; x++) {
                size_t k = ((size_t)y * s->out_w + x) * 4;
                int c;
                float *dstp[3] = { &oR[(size_t)y * lr + x], &oG[(size_t)y * lg + x],
                                   &oB[(size_t)y * lb + x] };
                for (c = 0; c < 3; c++) {
                    uint16_t v = src[k + c];
                    uint32_t sign = (uint32_t)(v & 0x8000) << 16;
                    int32_t  exp  = (v >> 10) & 0x1f;
                    uint32_t man  = v & 0x3ff;
                    uint32_t bits;
                    if (!exp)       bits = sign;
                    else if (exp == 31) bits = sign | 0x7f800000 | (man << 13);
                    else            bits = sign | ((uint32_t)(exp - 15 + 127) << 23) | (man << 13);
                    *dstp[c] = av_int2float(bits);
                }
            }
    }

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);
}

static av_cold void uninit(AVFilterContext *ctx)
{
    dlss_teardown(ctx->priv);
}

static const AVFilterPad dlss_inputs[] = {
    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .filter_frame = filter_frame },
};

static const AVFilterPad dlss_outputs[] = {
    { .name = "default", .type = AVMEDIA_TYPE_VIDEO, .config_props = config_output },
};

const FFFilter ff_vf_dlss = {
    .p.name        = "dlss",
    .p.description = NULL_IF_CONFIG_SMALL("NVIDIA DLSS Super Resolution / DLAA (DEGRADED: "
                                          "synthesised motion vectors, depth and jitter)"),
    .p.priv_class  = &dlss_class,
    .priv_size     = sizeof(DLSSContext),
    .uninit        = uninit,
    FILTER_INPUTS(dlss_inputs),
    FILTER_OUTPUTS(dlss_outputs),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
