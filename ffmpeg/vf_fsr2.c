/*
 * AMD FidelityFX Super Resolution 2 as an FFmpeg video filter.
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
 * FSR2 (github.com/GPUOpen-Effects/FidelityFX-FSR2, MIT) driven from decoded
 * video, through its Vulkan backend.
 *
 * FSR2 IS NOT AN IMAGE UPSCALER.  It is a temporal reconstruction algorithm
 * for a renderer, and the thing it reconstructs from is a sequence of frames
 * the renderer deliberately sampled at DIFFERENT sub-pixel positions.  The
 * renderer knows those positions exactly, because it chose them.  Everything
 * FSR2 gains over a Lanczos resize comes from that.
 *
 * A camera does not do that, and a recording does not record it.  Every input
 * this filter hands FSR2 is therefore an estimate made from the picture:
 *
 *   motion vectors   NVOFA optical flow.  Flow, not screen-space MVs.
 *   depth            flat, or a monocular model - relative, unscaled, unstable.
 *   jitter           measured global sub-pixel offset, or zero, or Halton.
 *   reactive mask    forward/backward flow inconsistency.
 *
 * What that costs is not a detail.  With the jitter sequence near-null - which
 * is what a fixed camera gives, and what AMD's own documentation says must
 * never be supplied - FSR2's lock creation (ComputeHrPosFromLrPos) picks the
 * same display-resolution pixels every frame.  The locks never sweep the
 * display grid.  What is left is a temporal denoise plus a fixed Lanczos
 * upsample: not super-resolution.  the jitter measurements (see the README) has the
 * measurements; FSR2.md has the summary that belongs in front of a user.
 *
 * This filter exists because it was asked for with that understood.  It is
 * labelled degraded everywhere it is exposed, it is off by default, and it is
 * not a rung of the quality ladder.
 */

#include <stdbool.h>
#include <vulkan/vulkan.h>

#include "libavutil/internal.h"
#include "libavutil/mem.h"
#include "libavutil/opt.h"
#include "libavutil/pixdesc.h"
#include "avfilter.h"
#include "filters.h"
#include "video.h"

#include "gu_inputs.h"

#include <ffx_fsr2.h>

/* Declared here rather than included: vk/ffx_fsr2_vk.h is a C++ header (it uses
 * default arguments).  The symbols themselves are extern "C". */
size_t       ffxFsr2GetScratchMemorySizeVK(VkPhysicalDevice physicalDevice);
FfxErrorCode ffxFsr2GetInterfaceVK(FfxFsr2Interface *outInterface, void *scratchBuffer,
                                   size_t scratchBufferSize, VkPhysicalDevice physicalDevice,
                                   PFN_vkGetDeviceProcAddr getDeviceProcAddr);
FfxDevice      ffxGetDeviceVK(VkDevice device);
FfxCommandList ffxGetCommandListVK(VkCommandBuffer cmdBuf);
FfxResource    ffxGetTextureResourceVK(FfxFsr2Context *context, VkImage imgVk,
                                       VkImageView imageView, uint32_t width, uint32_t height,
                                       VkFormat imgFormat, const wchar_t *name,
                                       FfxResourceStates state);

typedef struct GUImage {
    VkImage        img;
    VkDeviceMemory mem;
    VkImageView    view;
    VkBuffer       stage;
    VkDeviceMemory stage_mem;
    void          *host;
    VkFormat       fmt;
    int            w, h;
    size_t         bytes;
    int            texel;      /* bytes per texel */
} GUImage;

typedef struct FSR2Context {
    const AVClass *class;

    /* options */
    int   out_w, out_h;
    int   jitter_mode, depth_mode, react_mode;
    char *depth_model;
    float sharpness;
    int   device_index;

    GUInputs g;

    /* Vulkan */
    VkInstance       inst;
    VkPhysicalDevice phys;
    VkDevice         dev;
    VkQueue          queue;
    uint32_t         qfam;
    VkCommandPool    pool;
    VkCommandBuffer  cmd;
    VkFence          fence;
    VkPhysicalDeviceMemoryProperties memprops;

    GUImage color, depth, mv, reactive, out;

    /* FSR2 */
    FfxFsr2Context     fsr2;
    FfxFsr2ContextDescription desc;
    void              *scratch;
    int                fsr2_ready;

    /* cfg_w/cfg_h: the input size the live state was built for, so a second
     * config_props knows whether it has anything to rebuild.  req_w/req_h: the
     * w=/h= request as the user gave it, because out_w/out_h are the option
     * storage and the defaulting in config_output overwrites them with its own
     * answer, which a rebuild would then default off. */
    int                cfg_w, cfg_h;
    int                req_w, req_h;
} FSR2Context;

#define OFFSET(x) offsetof(FSR2Context, x)
#define FLAGS AV_OPT_FLAG_FILTERING_PARAM | AV_OPT_FLAG_VIDEO_PARAM

static const AVOption fsr2_options[] = {
    { "w", "output width (0: twice the input)",  OFFSET(out_w), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16384, FLAGS },
    { "h", "output height (0: twice the input)", OFFSET(out_h), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16384, FLAGS },
    { "jitter", "how the sub-pixel jitter sequence is supplied", OFFSET(jitter_mode), AV_OPT_TYPE_INT, { .i64 = GU_JITTER_MEASURED }, 0, 3, FLAGS, .unit = "jitter" },
        { "measured", "measured global sub-pixel offset (phase correlation)", 0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_MEASURED }, 0, 0, FLAGS, .unit = "jitter" },
        { "cancel",   "measured, and tell FSR2 the motion vectors contain it",  0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_CANCEL },   0, 0, FLAGS, .unit = "jitter" },
        { "zero",     "no jitter at all",                                       0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_ZERO },     0, 0, FLAGS, .unit = "jitter" },
        { "halton",   "a renderer's Halton sequence - fiction on recorded video",0, AV_OPT_TYPE_CONST, { .i64 = GU_JITTER_HALTON },   0, 0, FLAGS, .unit = "jitter" },
    { "depth", "how the depth buffer is supplied", OFFSET(depth_mode), AV_OPT_TYPE_INT, { .i64 = GU_DEPTH_MODEL }, 0, 2, FLAGS, .unit = "depth" },
        { "flat",         "a constant plane",                       0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_FLAT },         0, 0, FLAGS, .unit = "depth" },
        { "model",        "monocular estimate (dmodel=)",           0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_MODEL },        0, 0, FLAGS, .unit = "depth" },
        { "model-stable", "monocular estimate, flow-warped EMA",    0, AV_OPT_TYPE_CONST, { .i64 = GU_DEPTH_MODEL_STABLE }, 0, 0, FLAGS, .unit = "depth" },
    { "dmodel", "path to the monocular depth ONNX model", OFFSET(depth_model), AV_OPT_TYPE_STRING, { .str = "/usr/lib/jellyfin-ffmpeg-oidn/models/depth_anything_v2_vits.onnx" }, 0, 0, FLAGS },
    { "reactive", "how the reactive mask is supplied", OFFSET(react_mode), AV_OPT_TYPE_INT, { .i64 = GU_REACT_FLOW }, 0, 1, FLAGS, .unit = "react" },
        { "none", "nothing - FSR2 trusts history everywhere",       0, AV_OPT_TYPE_CONST, { .i64 = GU_REACT_NONE }, 0, 0, FLAGS, .unit = "react" },
        { "flow", "forward/backward flow inconsistency",            0, AV_OPT_TYPE_CONST, { .i64 = GU_REACT_FLOW }, 0, 0, FLAGS, .unit = "react" },
    { "sharpness", "RCAS sharpness, 0 disables the pass", OFFSET(sharpness), AV_OPT_TYPE_FLOAT, { .dbl = 0.0 }, 0.0, 1.0, FLAGS },
    { "device", "CUDA/Vulkan device index", OFFSET(device_index), AV_OPT_TYPE_INT, { .i64 = 0 }, 0, 16, FLAGS },
    { NULL }
};

AVFILTER_DEFINE_CLASS(fsr2);

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

static int mem_type(FSR2Context *s, uint32_t bits, VkMemoryPropertyFlags want)
{
    uint32_t i;
    for (i = 0; i < s->memprops.memoryTypeCount; i++)
        if ((bits & (1u << i)) &&
            (s->memprops.memoryTypes[i].propertyFlags & want) == want)
            return (int)i;
    return -1;
}

static int image_create(AVFilterContext *ctx, FSR2Context *s, GUImage *im,
                        int w, int h, VkFormat fmt, int texel, int storage)
{
    VkImageCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_IMAGE_CREATE_INFO };
    VkMemoryRequirements req;
    VkMemoryAllocateInfo mai = { .sType = VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO };
    VkImageViewCreateInfo ivi = { .sType = VK_STRUCTURE_TYPE_IMAGE_VIEW_CREATE_INFO };
    VkBufferCreateInfo bci = { .sType = VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO };
    int mt;

    im->w = w; im->h = h; im->fmt = fmt; im->texel = texel;
    im->bytes = (size_t)w * h * texel;

    ici.imageType = VK_IMAGE_TYPE_2D;
    ici.format    = fmt;
    ici.extent    = (VkExtent3D){ w, h, 1 };
    ici.mipLevels = 1;
    ici.arrayLayers = 1;
    ici.samples   = VK_SAMPLE_COUNT_1_BIT;
    ici.tiling    = VK_IMAGE_TILING_OPTIMAL;
    ici.usage     = VK_IMAGE_USAGE_SAMPLED_BIT | VK_IMAGE_USAGE_TRANSFER_DST_BIT |
                    VK_IMAGE_USAGE_TRANSFER_SRC_BIT |
                    (storage ? VK_IMAGE_USAGE_STORAGE_BIT : 0);
    ici.sharingMode   = VK_SHARING_MODE_EXCLUSIVE;
    ici.initialLayout = VK_IMAGE_LAYOUT_UNDEFINED;
    VK_CHECK(ctx, vkCreateImage(s->dev, &ici, NULL, &im->img));

    vkGetImageMemoryRequirements(s->dev, im->img, &req);
    mt = mem_type(s, req.memoryTypeBits, VK_MEMORY_PROPERTY_DEVICE_LOCAL_BIT);
    if (mt < 0) return AVERROR_EXTERNAL;
    mai.allocationSize  = req.size;
    mai.memoryTypeIndex = mt;
    VK_CHECK(ctx, vkAllocateMemory(s->dev, &mai, NULL, &im->mem));
    VK_CHECK(ctx, vkBindImageMemory(s->dev, im->img, im->mem, 0));

    ivi.image    = im->img;
    ivi.viewType = VK_IMAGE_VIEW_TYPE_2D;
    ivi.format   = fmt;
    ivi.subresourceRange = (VkImageSubresourceRange){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 1, 0, 1 };
    VK_CHECK(ctx, vkCreateImageView(s->dev, &ivi, NULL, &im->view));

    bci.size  = im->bytes;
    bci.usage = VK_BUFFER_USAGE_TRANSFER_SRC_BIT | VK_BUFFER_USAGE_TRANSFER_DST_BIT;
    bci.sharingMode = VK_SHARING_MODE_EXCLUSIVE;
    VK_CHECK(ctx, vkCreateBuffer(s->dev, &bci, NULL, &im->stage));
    vkGetBufferMemoryRequirements(s->dev, im->stage, &req);
    mt = mem_type(s, req.memoryTypeBits,
                  VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT | VK_MEMORY_PROPERTY_HOST_COHERENT_BIT);
    if (mt < 0) return AVERROR_EXTERNAL;
    mai.allocationSize  = req.size;
    mai.memoryTypeIndex = mt;
    VK_CHECK(ctx, vkAllocateMemory(s->dev, &mai, NULL, &im->stage_mem));
    VK_CHECK(ctx, vkBindBufferMemory(s->dev, im->stage, im->stage_mem, 0));
    VK_CHECK(ctx, vkMapMemory(s->dev, im->stage_mem, 0, VK_WHOLE_SIZE, 0, &im->host));
    return 0;
}

static void image_destroy(FSR2Context *s, GUImage *im)
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

static void cmd_upload(VkCommandBuffer cmd, GUImage *im)
{
    VkBufferImageCopy c = { 0 };
    c.imageSubresource = (VkImageSubresourceLayers){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
    c.imageExtent = (VkExtent3D){ im->w, im->h, 1 };
    barrier(cmd, im->img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            0, VK_ACCESS_TRANSFER_WRITE_BIT);
    vkCmdCopyBufferToImage(cmd, im->stage, im->img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL, 1, &c);
    barrier(cmd, im->img, VK_IMAGE_LAYOUT_TRANSFER_DST_OPTIMAL,
            VK_IMAGE_LAYOUT_SHADER_READ_ONLY_OPTIMAL,
            VK_ACCESS_TRANSFER_WRITE_BIT, VK_ACCESS_SHADER_READ_BIT);
}

static void cmd_download(VkCommandBuffer cmd, GUImage *im, VkImageLayout from)
{
    VkBufferImageCopy c = { 0 };
    c.imageSubresource = (VkImageSubresourceLayers){ VK_IMAGE_ASPECT_COLOR_BIT, 0, 0, 1 };
    c.imageExtent = (VkExtent3D){ im->w, im->h, 1 };
    barrier(cmd, im->img, from, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
            VK_ACCESS_SHADER_WRITE_BIT, VK_ACCESS_TRANSFER_READ_BIT);
    vkCmdCopyImageToBuffer(cmd, im->img, VK_IMAGE_LAYOUT_TRANSFER_SRC_OPTIMAL,
                           im->stage, 1, &c);
}

static av_cold int vk_init(AVFilterContext *ctx)
{
    FSR2Context *s = ctx->priv;
    VkApplicationInfo app = { .sType = VK_STRUCTURE_TYPE_APPLICATION_INFO };
    VkInstanceCreateInfo ici = { .sType = VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO };
    VkDeviceQueueCreateInfo qci = { .sType = VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO };
    VkDeviceCreateInfo dci = { .sType = VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO };
    VkPhysicalDeviceFeatures2 feat2 = { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2 };
    VkPhysicalDeviceShaderFloat16Int8Features f16 =
        { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_SHADER_FLOAT16_INT8_FEATURES };
    VkPhysicalDevice16BitStorageFeatures st16 =
        { .sType = VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_16BIT_STORAGE_FEATURES };
    VkCommandPoolCreateInfo pci = { .sType = VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO };
    VkCommandBufferAllocateInfo cai = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO };
    VkFenceCreateInfo fci = { .sType = VK_STRUCTURE_TYPE_FENCE_CREATE_INFO };
    VkPhysicalDevice devs[16];
    uint32_t n = 16, i, nq;
    VkQueueFamilyProperties qprops[16];
    float prio = 1.0f;
    const char *dext[] = {
        VK_KHR_SHADER_FLOAT16_INT8_EXTENSION_NAME,
        VK_KHR_16BIT_STORAGE_EXTENSION_NAME,
        VK_EXT_SUBGROUP_SIZE_CONTROL_EXTENSION_NAME,
    };
    VkPhysicalDeviceProperties props;

    app.pApplicationName = "ffmpeg-fsr2";
    app.apiVersion = VK_API_VERSION_1_1;
    ici.pApplicationInfo = &app;
    VK_CHECK(ctx, vkCreateInstance(&ici, NULL, &s->inst));

    VK_CHECK(ctx, vkEnumeratePhysicalDevices(s->inst, &n, devs));
    if (!n) {
        av_log(ctx, AV_LOG_ERROR, "no Vulkan device\n");
        return AVERROR_EXTERNAL;
    }
    s->phys = devs[s->device_index < (int)n ? s->device_index : 0];
    vkGetPhysicalDeviceProperties(s->phys, &props);

    nq = 16;
    vkGetPhysicalDeviceQueueFamilyProperties(s->phys, &nq, qprops);
    s->qfam = UINT32_MAX;
    for (i = 0; i < nq; i++)
        if (qprops[i].queueFlags & VK_QUEUE_COMPUTE_BIT) { s->qfam = i; break; }
    if (s->qfam == UINT32_MAX) {
        av_log(ctx, AV_LOG_ERROR, "no compute queue on %s\n", props.deviceName);
        return AVERROR_EXTERNAL;
    }

    /* FSR2 picks its fp16 shader permutations from the PHYSICAL device's
     * capability, not from what was enabled, so the matching features have to
     * be turned on here or half the pipelines fail to create. */
    feat2.pNext = &f16;
    f16.pNext   = &st16;
    vkGetPhysicalDeviceFeatures2(s->phys, &feat2);
    feat2.features.shaderStorageImageReadWithoutFormat  = VK_TRUE;
    feat2.features.shaderStorageImageWriteWithoutFormat = VK_TRUE;

    qci.queueFamilyIndex = s->qfam;
    qci.queueCount = 1;
    qci.pQueuePriorities = &prio;
    dci.pNext = &feat2;
    dci.queueCreateInfoCount = 1;
    dci.pQueueCreateInfos = &qci;
    dci.enabledExtensionCount = FF_ARRAY_ELEMS(dext);
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

    av_log(ctx, AV_LOG_VERBOSE, "Vulkan device %s, fp16 %s\n",
           props.deviceName, f16.shaderFloat16 ? "yes" : "no");
    return 0;
}

static void fsr2_msg(FfxFsr2MsgType type, const wchar_t *message)
{
    char buf[512];
    size_t i = 0;
    while (message[i] && i < sizeof(buf) - 1) { buf[i] = (char)message[i]; i++; }
    buf[i] = 0;
    av_log(NULL, type == FFX_FSR2_MESSAGE_TYPE_ERROR ? AV_LOG_ERROR : AV_LOG_WARNING,
           "fsr2: %s\n", buf);
}

static av_cold void fsr2_teardown(FSR2Context *s)
{
    if (s->dev) vkDeviceWaitIdle(s->dev);
    if (s->fsr2_ready) ffxFsr2ContextDestroy(&s->fsr2);
    s->fsr2_ready = 0;
    av_freep(&s->scratch);

    image_destroy(s, &s->color);
    image_destroy(s, &s->depth);
    image_destroy(s, &s->mv);
    image_destroy(s, &s->reactive);
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
    FSR2Context *s = ctx->priv;
    size_t scratch_size;
    FfxErrorCode err;
    int ret;

    /* config_props runs again whenever the link is reconfigured.  Everything
     * below creates device-level state, so running it a second time over the
     * live handles leaks the instance, the device, every image and the FSR2
     * context.  Unchanged geometry means there is nothing to do; changed
     * geometry means the old state goes first. */
    if (s->cfg_w) {
        if (s->fsr2_ready && s->cfg_w == inlink->w && s->cfg_h == inlink->h) {
            outlink->w = s->out_w;
            outlink->h = s->out_h;
            return 0;
        }
        s->out_w = s->req_w;
        s->out_h = s->req_h;
        fsr2_teardown(s);
    } else {
        s->req_w = s->out_w;
        s->req_h = s->out_h;
    }
    s->cfg_w = inlink->w;
    s->cfg_h = inlink->h;

    s->out_w = s->out_w ? s->out_w : inlink->w * 2;
    s->out_h = s->out_h ? s->out_h : inlink->h * 2;
    if (s->out_w < inlink->w || s->out_h < inlink->h) {
        av_log(ctx, AV_LOG_ERROR, "fsr2 upscales; %dx%d -> %dx%d is not an upscale\n",
               inlink->w, inlink->h, s->out_w, s->out_h);
        return AVERROR(EINVAL);
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

    if ((ret = image_create(ctx, s, &s->color,    inlink->w, inlink->h, VK_FORMAT_R32G32B32A32_SFLOAT, 16, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->depth,    inlink->w, inlink->h, VK_FORMAT_R32_SFLOAT,           4, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->mv,       inlink->w, inlink->h, VK_FORMAT_R32G32_SFLOAT,        8, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->reactive, inlink->w, inlink->h, VK_FORMAT_R32_SFLOAT,           4, 0)) < 0 ||
        (ret = image_create(ctx, s, &s->out,      s->out_w,  s->out_h,  VK_FORMAT_R32G32B32A32_SFLOAT, 16, 1)) < 0)
        return ret;

    scratch_size = ffxFsr2GetScratchMemorySizeVK(s->phys);
    s->scratch = av_malloc(scratch_size);
    if (!s->scratch)
        return AVERROR(ENOMEM);

    memset(&s->desc, 0, sizeof(s->desc));
    err = ffxFsr2GetInterfaceVK(&s->desc.callbacks, s->scratch, scratch_size,
                                s->phys, vkGetDeviceProcAddr);
    if (err != FFX_OK) {
        av_log(ctx, AV_LOG_ERROR, "ffxFsr2GetInterfaceVK failed (%d)\n", (int)err);
        return AVERROR_EXTERNAL;
    }
    s->desc.device            = ffxGetDeviceVK(s->dev);
    s->desc.maxRenderSize.width  = inlink->w;
    s->desc.maxRenderSize.height = inlink->h;
    s->desc.displaySize.width    = s->out_w;
    s->desc.displaySize.height   = s->out_h;
    s->desc.flags = FFX_FSR2_ENABLE_AUTO_EXPOSURE;
    /* Depth Anything V2 emits inverse depth (large = near), which is exactly
     * what FFX_FSR2_ENABLE_DEPTH_INVERTED describes.  Flat depth is a constant,
     * so the flag is meaningless there and left off. */
    if (s->depth_mode != GU_DEPTH_FLAT)
        s->desc.flags |= FFX_FSR2_ENABLE_DEPTH_INVERTED;
    /* FSR2's contract is that motion vectors are jitter-FREE.  Ours are
     * optical flow between two recorded frames, so whatever sub-pixel motion
     * exists is already in them - including the part being handed over
     * separately as jitterOffset.  This flag tells FSR2 to subtract it back
     * out.  Which of the two is less wrong is a measurement, not a deduction. */
    if (s->jitter_mode == GU_JITTER_CANCEL)
        s->desc.flags |= FFX_FSR2_ENABLE_MOTION_VECTORS_JITTER_CANCELLATION;
    s->desc.fpMessage = fsr2_msg;

    err = ffxFsr2ContextCreate(&s->fsr2, &s->desc);
    if (err != FFX_OK) {
        av_log(ctx, AV_LOG_ERROR, "ffxFsr2ContextCreate failed (%d)\n", (int)err);
        return AVERROR_EXTERNAL;
    }
    s->fsr2_ready = 1;

    av_log(ctx, AV_LOG_WARNING,
           "fsr2 %dx%d -> %dx%d DEGRADED: motion vectors are NVOFA optical flow, "
           "depth is %s, jitter is %s, reactive mask is %s. FSR2 is a renderer "
           "algorithm; recorded video cannot supply any of these properly. "
           "Expect ghosting and no true super-resolution.\n",
           inlink->w, inlink->h, s->out_w, s->out_h,
           s->depth_mode == GU_DEPTH_FLAT ? "a flat constant" :
           s->depth_mode == GU_DEPTH_MODEL ? "a monocular estimate" :
                                             "a flow-stabilised monocular estimate",
           s->jitter_mode == GU_JITTER_ZERO   ? "zero" :
           s->jitter_mode == GU_JITTER_HALTON ? "a Halton sequence that does not "
                                                "describe the recording" :
           s->jitter_mode == GU_JITTER_CANCEL ? "measured, cancelled out of the MVs" :
                                                "measured global phase correlation",
           s->react_mode == GU_REACT_FLOW ? "forward/backward flow inconsistency" : "absent");
    return 0;
}

static int filter_frame(AVFilterLink *inlink, AVFrame *in)
{
    AVFilterContext *ctx = inlink->dst;
    AVFilterLink *outlink = ctx->outputs[0];
    FSR2Context *s = ctx->priv;
    AVFrame *out;
    FfxFsr2DispatchDescription dp;
    VkCommandBufferBeginInfo bi = { .sType = VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO };
    VkSubmitInfo si = { .sType = VK_STRUCTURE_TYPE_SUBMIT_INFO };
    const float *R, *G, *B;
    float *dst;
    int rls, gls, bls, x, y, ret;

    if (!s->fsr2_ready) {
        av_frame_free(&in);
        return AVERROR(EINVAL);
    }

    if ((ret = gu_inputs_frame(ctx, &s->g, in)) < 0) {
        av_frame_free(&in);
        return ret;
    }

    out = ff_get_video_buffer(outlink, outlink->w, outlink->h);
    if (!out) {
        av_frame_free(&in);
        return AVERROR(ENOMEM);
    }
    av_frame_copy_props(out, in);

    R = (const float *)in->data[2]; G = (const float *)in->data[0]; B = (const float *)in->data[1];
    rls = in->linesize[2] / 4; gls = in->linesize[0] / 4; bls = in->linesize[1] / 4;

    dst = (float *)s->color.host;
    for (y = 0; y < inlink->h; y++)
        for (x = 0; x < inlink->w; x++) {
            size_t k = ((size_t)y * inlink->w + x) * 4;
            dst[k]     = R[(size_t)y * rls + x];
            dst[k + 1] = G[(size_t)y * gls + x];
            dst[k + 2] = B[(size_t)y * bls + x];
            dst[k + 3] = 1.0f;
        }
    memcpy(s->depth.host,    s->g.depth,    (size_t)inlink->w * inlink->h * sizeof(float));
    memcpy(s->reactive.host, s->g.reactive, (size_t)inlink->w * inlink->h * sizeof(float));

    /* FSR2's motion vectors point from a pixel in the CURRENT frame to where
     * that pixel was in the PREVIOUS one.  gu_inputs produces previous ->
     * current, so it is negated here.  Units are render-resolution pixels,
     * hence motionVectorScale = {1,1}. */
    dst = (float *)s->mv.host;
    for (y = 0; y < inlink->h; y++)
        for (x = 0; x < inlink->w; x++) {
            size_t k = (size_t)y * inlink->w + x;
            dst[k * 2]     = -s->g.flow[k * 2];
            dst[k * 2 + 1] = -s->g.flow[k * 2 + 1];
        }

    vkResetFences(s->dev, 1, &s->fence);
    vkResetCommandBuffer(s->cmd, 0);
    bi.flags = VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;
    vkBeginCommandBuffer(s->cmd, &bi);
    cmd_upload(s->cmd, &s->color);
    cmd_upload(s->cmd, &s->depth);
    cmd_upload(s->cmd, &s->mv);
    if (s->react_mode == GU_REACT_FLOW)
        cmd_upload(s->cmd, &s->reactive);
    barrier(s->cmd, s->out.img, VK_IMAGE_LAYOUT_UNDEFINED, VK_IMAGE_LAYOUT_GENERAL,
            0, VK_ACCESS_SHADER_WRITE_BIT);

    memset(&dp, 0, sizeof(dp));
    dp.commandList = ffxGetCommandListVK(s->cmd);
    dp.color = ffxGetTextureResourceVK(&s->fsr2, s->color.img, s->color.view,
                                       inlink->w, inlink->h, s->color.fmt, NULL,
                                       FFX_RESOURCE_STATE_COMPUTE_READ);
    dp.depth = ffxGetTextureResourceVK(&s->fsr2, s->depth.img, s->depth.view,
                                       inlink->w, inlink->h, s->depth.fmt, NULL,
                                       FFX_RESOURCE_STATE_COMPUTE_READ);
    dp.motionVectors = ffxGetTextureResourceVK(&s->fsr2, s->mv.img, s->mv.view,
                                               inlink->w, inlink->h, s->mv.fmt, NULL,
                                               FFX_RESOURCE_STATE_COMPUTE_READ);
    if (s->react_mode == GU_REACT_FLOW)
        dp.reactive = ffxGetTextureResourceVK(&s->fsr2, s->reactive.img, s->reactive.view,
                                              inlink->w, inlink->h, s->reactive.fmt, NULL,
                                              FFX_RESOURCE_STATE_COMPUTE_READ);
    dp.output = ffxGetTextureResourceVK(&s->fsr2, s->out.img, s->out.view,
                                        s->out_w, s->out_h, s->out.fmt, NULL,
                                        FFX_RESOURCE_STATE_UNORDERED_ACCESS);

    /* Only the SUB-PIXEL residual belongs in jitterOffset: FSR2's contract puts
     * the integer part, and all local motion, in the motion vector texture,
     * which is where the flow field already carries it.  Handing FSR2 the whole
     * measured offset would double-count it. */
    dp.jitterOffset.x = s->g.jitter_x - nearbyintf(s->g.jitter_x);
    dp.jitterOffset.y = s->g.jitter_y - nearbyintf(s->g.jitter_y);
    dp.motionVectorScale.x = 1.0f;
    dp.motionVectorScale.y = 1.0f;
    dp.renderSize.width  = inlink->w;
    dp.renderSize.height = inlink->h;
    dp.enableSharpening  = s->sharpness > 0.0f;
    dp.sharpness         = s->sharpness;
    dp.frameTimeDelta    = 1000.0f / 24.0f;
    dp.preExposure       = 1.0f;
    dp.reset             = s->g.frame_index <= 1;
    dp.cameraNear        = 0.1f;
    dp.cameraFar         = 1000.0f;
    dp.cameraFovAngleVertical = 1.0471975f;   /* 60 degrees: there is no real one */
    dp.viewSpaceToMetersFactor = 1.0f;

    if (ffxFsr2ContextDispatch(&s->fsr2, &dp) != FFX_OK) {
        av_log(ctx, AV_LOG_ERROR, "ffxFsr2ContextDispatch failed\n");
        vkEndCommandBuffer(s->cmd);
        av_frame_free(&in); av_frame_free(&out);
        return AVERROR_EXTERNAL;
    }

    cmd_download(s->cmd, &s->out, VK_IMAGE_LAYOUT_GENERAL);
    vkEndCommandBuffer(s->cmd);

    si.commandBufferCount = 1;
    si.pCommandBuffers = &s->cmd;
    if (vkQueueSubmit(s->queue, 1, &si, s->fence) != VK_SUCCESS ||
        vkWaitForFences(s->dev, 1, &s->fence, VK_TRUE, UINT64_MAX) != VK_SUCCESS) {
        av_log(ctx, AV_LOG_ERROR, "Vulkan submit failed\n");
        av_frame_free(&in); av_frame_free(&out);
        return AVERROR_EXTERNAL;
    }

    {
        const float *src = (const float *)s->out.host;
        float *oR = (float *)out->data[2], *oG = (float *)out->data[0],
              *oB = (float *)out->data[1];
        int ols_r = out->linesize[2] / 4, ols_g = out->linesize[0] / 4,
            ols_b = out->linesize[1] / 4;
        for (y = 0; y < s->out_h; y++)
            for (x = 0; x < s->out_w; x++) {
                size_t k = ((size_t)y * s->out_w + x) * 4;
                oR[(size_t)y * ols_r + x] = src[k];
                oG[(size_t)y * ols_g + x] = src[k + 1];
                oB[(size_t)y * ols_b + x] = src[k + 2];
            }
    }

    av_frame_free(&in);
    return ff_filter_frame(outlink, out);
}

static av_cold void uninit(AVFilterContext *ctx)
{
    fsr2_teardown(ctx->priv);
}

static const AVFilterPad fsr2_inputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .filter_frame = filter_frame,
    },
};

static const AVFilterPad fsr2_outputs[] = {
    {
        .name         = "default",
        .type         = AVMEDIA_TYPE_VIDEO,
        .config_props = config_output,
    },
};

const FFFilter ff_vf_fsr2 = {
    .p.name        = "fsr2",
    .p.description = NULL_IF_CONFIG_SMALL("AMD FSR2 temporal upscale (DEGRADED: "
                                          "synthesised motion vectors, depth and jitter)"),
    .p.priv_class  = &fsr2_class,
    .priv_size     = sizeof(FSR2Context),
    .uninit        = uninit,
    FILTER_INPUTS(fsr2_inputs),
    FILTER_OUTPUTS(fsr2_outputs),
    FILTER_PIXFMTS_ARRAY(pixel_fmts),
};
