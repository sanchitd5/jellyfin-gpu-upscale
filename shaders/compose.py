#!/usr/bin/env python3
"""Builds the shader files the plugin points libplacebo at.

libplacebo takes a single custom_shader_path, but an mpv user-shader file may hold several //!HOOK
blocks, so the super-resolution pass and the sharpening pass are concatenated into one file and run
in the same Vulkan pass. FSRCNNX hooks LUMA (before scaling); CAS hooks MAIN (after scaling).
"""
import os
import sys

FSRCNNX = "/usr/share/jellyfin-shaders/FSRCNNX_x2_16-0-4-1.glsl"
OUT = "/usr/share/jellyfin-shaders"
LEVELS = {"low": 0.0, "medium": 0.45, "high": 1.0}

tmpl = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "cas.glsl.tmpl")).read()

for name, strength in LEVELS.items():
    cas = tmpl.replace("__SHARPNESS__", "%.2f" % strength)
    # sharpen only, for soft sources that do not need more pixels
    open(os.path.join(OUT, "CAS-%s.glsl" % name), "w").write(cas)
    # super-resolution followed by sharpening, in one pass
    open(os.path.join(OUT, "FSRCNNX_x2+CAS-%s.glsl" % name), "w").write(
        open(FSRCNNX).read() + "\n\n" + cas)
    print("wrote CAS-%s.glsl and FSRCNNX_x2+CAS-%s.glsl (strength %.2f)" % (name, name, strength))
