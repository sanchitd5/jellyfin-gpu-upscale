/* MSVC-ism shims so the FidelityFX-FSR2 Vulkan backend compiles with g++.
   Our file, no AMD or Microsoft code in it. */
#pragma once
#include <cstddef>
#include <cstring>
#include <cwchar>
#include <locale>
#include <codecvt>
#ifndef _countof
#define _countof(a) (sizeof(a)/sizeof((a)[0]))
#endif
static inline int wcscpy_s(wchar_t *d, size_t n, const wchar_t *s)
{
    size_t l = wcslen(s);
    if (!d || !n) return 1;
    if (l + 1 > n) { d[0] = 0; return 1; }
    wmemcpy(d, s, l + 1);
    return 0;
}
template <size_t N> static inline int wcscpy_s(wchar_t (&d)[N], const wchar_t *s)
{
    return wcscpy_s(d, N, s);
}
