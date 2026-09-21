#!/usr/bin/env python3
"""Generate FSR2 Vulkan shader permutation headers without FidelityFX_SC.exe.

The upstream FidelityFX-FSR2 build calls tools/sc/FidelityFX_SC.exe, a Windows
binary, to compile each pass GLSL into every permutation and emit a
<pass>_permutations.h that vk/shaders/ffx_fsr2_shaders_vk.cpp includes.
This does the same job with glslangValidator plus SPIR-V reflection.
"""
import os, subprocess, sys, struct, hashlib, json

# Paths come from argv or the environment so this is not tied to one machine:
#   gen_perm.py <fsr2-checkout>/src/ffx-fsr2-api/shaders <output-dir>
SRC  = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("FSR2_SHADERS", "")
OUT  = sys.argv[2] if len(sys.argv) > 2 else os.environ.get("FSR2_PERM_OUT", "")
GLSL = os.environ.get("GLSLANG", "glslangValidator")

if not SRC or not OUT:
    sys.exit("usage: gen_perm.py <fsr2>/src/ffx-fsr2-api/shaders <output-dir>\n"
             "       (or set FSR2_SHADERS and FSR2_PERM_OUT)")

PASSES = [
    "ffx_fsr2_tcr_autogen_pass",
    "ffx_fsr2_autogen_reactive_pass",
    "ffx_fsr2_accumulate_pass",
    "ffx_fsr2_compute_luminance_pyramid_pass",
    "ffx_fsr2_depth_clip_pass",
    "ffx_fsr2_lock_pass",
    "ffx_fsr2_reconstruct_previous_depth_pass",
    "ffx_fsr2_rcas_pass",
]

BASE_DEFS = [
    ("FFX_GPU", "1"), ("FFX_GLSL", "1"),
    ("FFX_FSR2_OPTION_UPSAMPLE_SAMPLERS_USE_DATA_HALF", "0"),
    ("FFX_FSR2_OPTION_ACCUMULATE_SAMPLERS_USE_DATA_HALF", "0"),
    ("FFX_FSR2_OPTION_REPROJECT_SAMPLERS_USE_DATA_HALF", "1"),
    ("FFX_FSR2_OPTION_POSTPROCESSLOCKSTATUS_SAMPLERS_USE_DATA_HALF", "0"),
    ("FFX_FSR2_OPTION_UPSAMPLE_USE_LANCZOS_TYPE", "2"),
]

# bit order MUST match POPULATE_PERMUTATION_KEY in ffx_fsr2_shaders_vk.cpp
KEYBITS = [
    "FFX_FSR2_OPTION_REPROJECT_USE_LANCZOS_TYPE",
    "FFX_FSR2_OPTION_HDR_COLOR_INPUT",
    "FFX_FSR2_OPTION_LOW_RESOLUTION_MOTION_VECTORS",
    "FFX_FSR2_OPTION_JITTERED_MOTION_VECTORS",
    "FFX_FSR2_OPTION_INVERTED_DEPTH",
    "FFX_FSR2_OPTION_APPLY_SHARPENING",
    "FFX_HALF",
]

# ---------------------------------------------------------------- SPIR-V reflect
SC_UNIFORM_CONSTANT, SC_UNIFORM = 0, 2
DEC_DESCRIPTOR_SET, DEC_BINDING = 34, 33

def reflect(blob):
    w = struct.unpack("<%dI" % (len(blob) // 4), blob)
    assert w[0] == 0x07230203, "not spirv"
    names, dset, bind = {}, {}, {}
    ptr, img, structs, samplers, variables = {}, {}, set(), set(), []
    i = 5
    while i < len(w):
        word = w[i]; op = word & 0xFFFF; ln = word >> 16
        if ln == 0: break
        o = w[i:i+ln]
        if op == 5:                                   # OpName
            raw = b"".join(struct.pack("<I", x) for x in o[2:])
            names[o[1]] = raw.split(b"\0")[0].decode("utf-8", "replace")
        elif op == 71:                                # OpDecorate
            if o[2] == DEC_DESCRIPTOR_SET: dset[o[1]] = o[3]
            elif o[2] == DEC_BINDING:      bind[o[1]] = o[3]
        elif op == 25:                                # OpTypeImage
            img[o[1]] = o[7]                          # Sampled: 1 sampled, 2 storage
        elif op == 26:                                # OpTypeSampler
            samplers.add(o[1])
        elif op == 30:                                # OpTypeStruct
            structs.add(o[1])
        elif op == 32:                                # OpTypePointer
            ptr[o[1]] = (o[2], o[3])                  # (storage class, pointee)
        elif op == 59:                                # OpVariable
            variables.append((o[1], o[2], o[3]))      # (result type, id, storage class)
        i += ln
    storage, sampled, ubo = [], [], []
    for rtype, vid, sc in variables:
        if dset.get(vid) != 1:                        # set 0 is the two static samplers
            continue
        if rtype not in ptr: continue
        pointee = ptr[rtype][1]
        nm, bd = names.get(vid, ""), bind.get(vid, 0)
        if pointee in img:
            (sampled if img[pointee] == 1 else storage).append((nm, bd))
        elif pointee in structs and sc == SC_UNIFORM:
            ubo.append((nm, bd))
        elif pointee in samplers:
            pass
    return (sorted(storage, key=lambda x: x[1]),
            sorted(sampled, key=lambda x: x[1]),
            sorted(ubo,     key=lambda x: x[1]))

# ---------------------------------------------------------------- compile
def compile_perm(pass_name, defs, tmp):
    cmd = [GLSL, "--target-env", "vulkan1.1", "-S", "comp", "-e", "main", "-Os",
           "-I" + SRC, "-o", tmp]
    for k, v in BASE_DEFS: cmd += ["-D%s=%s" % (k, v)]
    for k, v in defs:      cmd += ["-D%s=%s" % (k, v)]
    cmd.append(os.path.join(SRC, pass_name + ".glsl"))
    r = subprocess.run(cmd, capture_output=True)
    if r.returncode != 0:
        return None, r.stdout.decode() + r.stderr.decode()
    return open(tmp, "rb").read(), None

def carr(name, vals):
    if not vals: return "static const char* %s[] = { 0 };\n" % name
    return "static const char* %s[] = { %s };\n" % (name, ", ".join('"%s"' % v for v in vals))

def barr(name, vals):
    if not vals: return "static const uint32_t %s[] = { 0 };\n" % name
    return "static const uint32_t %s[] = { %s };\n" % (name, ", ".join(str(v) for v in vals))

def main():
    os.makedirs(OUT, exist_ok=True)
    tmp = "/tmp/perm.spv"
    report = {}
    for p in PASSES:
        half = (p != "ffx_fsr2_compute_luminance_pyramid_pass")
        nbits = 7 if half else 6
        nperm = 1 << nbits
        blobs, table, order = {}, [], []
        fails = 0
        for idx in range(nperm):
            defs = []
            for b in range(nbits):
                defs.append((KEYBITS[b], "1" if (idx >> b) & 1 else "0"))
            spv, err = compile_perm(p, defs, tmp)
            if spv is None:
                fails += 1
                if half and (idx >> 6) & 1:
                    table.append(-1)          # patched below to the FFX_HALF=0 twin
                    continue
                print("FATAL %s idx=%d\n%s" % (p, idx, err[:2000])); sys.exit(1)
            h = hashlib.sha1(spv).hexdigest()
            if h not in blobs:
                blobs[h] = (len(order), spv)
                order.append(h)
            table.append(blobs[h][0])
        # fp16 permutations that would not compile fall back to their fp16=0 twin
        for idx in range(nperm):
            if table[idx] == -1:
                table[idx] = table[idx & ~(1 << 6)]
        report[p] = dict(unique=len(order), perms=nperm, fp16_fallback=fails)
        with open(os.path.join(OUT, p + "_permutations.h"), "w") as f:
            f.write("// generated, do not edit - see fsr2gen/gen_perm.py\n#pragma once\n")
            f.write("#include <stdint.h>\n\n")
            for n, h in enumerate(order):
                spv = blobs[h][1]
                f.write("static const uint8_t g_%s_permutation_%d_data[] = {\n" % (p, n))
                f.write(",".join(str(b) for b in spv))
                f.write("};\n")
                st, sa, ub = reflect(spv)
                f.write(carr("g_%s_permutation_%d_storage_names"   % (p, n), [x[0] for x in st]))
                f.write(barr("g_%s_permutation_%d_storage_bind"    % (p, n), [x[1] for x in st]))
                f.write(carr("g_%s_permutation_%d_sampled_names"   % (p, n), [x[0] for x in sa]))
                f.write(barr("g_%s_permutation_%d_sampled_bind"    % (p, n), [x[1] for x in sa]))
                f.write(carr("g_%s_permutation_%d_ubo_names"       % (p, n), [x[0] for x in ub]))
                f.write(barr("g_%s_permutation_%d_ubo_bind"        % (p, n), [x[1] for x in ub]))
                f.write("\n")
            # key
            f.write("typedef union %s_PermutationKey {\n    struct {\n" % p)
            for b in range(nbits):
                f.write("        uint32_t %s : 1;\n" % KEYBITS[b])
            f.write("    };\n    uint32_t index;\n} %s_PermutationKey;\n\n" % p)
            f.write("typedef struct %s_PermutationInfo {\n"
                    "    const uint8_t*  blobData;\n    uint32_t        blobSize;\n"
                    "    uint32_t        numStorageImageResources;\n"
                    "    uint32_t        numSampledImageResources;\n"
                    "    uint32_t        numUniformBufferResources;\n"
                    "    const char**    storageImageResourceNames;\n"
                    "    const uint32_t* storageImageResourceBindings;\n"
                    "    const char**    sampledImageResourceNames;\n"
                    "    const uint32_t* sampledImageResourceBindings;\n"
                    "    const char**    uniformBufferResourceNames;\n"
                    "    const uint32_t* uniformBufferResourceBindings;\n"
                    "} %s_PermutationInfo;\n\n" % (p, p))
            f.write("static const uint32_t g_%s_IndirectionTable[] = {\n%s\n};\n\n"
                    % (p, ",".join(str(t) for t in table)))
            f.write("static const %s_PermutationInfo g_%s_PermutationInfo[] = {\n" % (p, p))
            for n, h in enumerate(order):
                spv = blobs[h][1]
                st, sa, ub = reflect(spv)
                f.write("    { g_%s_permutation_%d_data, %d, %d, %d, %d, "
                        "g_%s_permutation_%d_storage_names, g_%s_permutation_%d_storage_bind, "
                        "g_%s_permutation_%d_sampled_names, g_%s_permutation_%d_sampled_bind, "
                        "g_%s_permutation_%d_ubo_names, g_%s_permutation_%d_ubo_bind },\n"
                        % (p, n, len(spv), len(st), len(sa), len(ub),
                           p, n, p, n, p, n, p, n, p, n, p, n))
            f.write("};\n")
        print("%-46s %3d perms -> %2d unique blobs, fp16 fallbacks %d"
              % (p, nperm, len(order), fails))
    json.dump(report, open(os.path.join(OUT, "report.json"), "w"), indent=1)

main()
