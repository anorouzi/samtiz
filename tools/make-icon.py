#!/usr/bin/env python3
"""Draws the app icon (512x423, the Smart Hub size) with 3x3 supersampling. Stdlib only.

Usage: python3 tools/make-icon.py app/icon.png
"""
import struct
import sys
import zlib

W, H, S = 512, 423, 3
BG_TOP, BG_BOT = (30, 33, 43), (15, 17, 21)
PINK_A, PINK_B = (255, 92, 122), (229, 56, 96)
WHITE = (255, 255, 255)
# Rounded "screen" rectangle and play triangle, in output pixel coordinates.
rx0, ry0, rx1, ry1, rr = 96, 72, 416, 300, 44
tx0, ty0, ty1, tx1 = 214, 128, 244, 318   # triangle: left x, top y, bottom y, tip x
cy = (ty0 + ty1) / 2


def in_rrect(x, y):
    if not (rx0 <= x <= rx1 and ry0 <= y <= ry1):
        return False
    cx = min(max(x, rx0 + rr), rx1 - rr)
    cyy = min(max(y, ry0 + rr), ry1 - rr)
    return (x - cx) ** 2 + (y - cyy) ** 2 <= rr * rr


def in_tri(x, y):
    if x < tx0 or x > tx1:
        return False
    half = (ty1 - ty0) / 2 * (tx1 - x) / (tx1 - tx0)
    return abs(y - cy) <= half


def in_stand(x, y):
    return (226 <= x <= 286 and 300 <= y <= 336) or (176 <= x <= 336 and 336 <= y <= 352)


def main(path):
    rows = []
    for py in range(H):
        row = bytearray([0])
        t = py / (H - 1)
        bg = tuple(int(BG_TOP[i] + (BG_BOT[i] - BG_TOP[i]) * t) for i in range(3))
        for px in range(W):
            acc = [0, 0, 0]
            for sy in range(S):
                for sx in range(S):
                    x = px + (sx + .5) / S
                    y = py + (sy + .5) / S
                    if in_rrect(x, y):
                        k = (x - rx0) / (rx1 - rx0)
                        c = WHITE if in_tri(x, y) else tuple(int(PINK_A[i] + (PINK_B[i] - PINK_A[i]) * k) for i in range(3))
                    elif in_stand(x, y):
                        c = (200, 60, 90)
                    else:
                        c = bg
                    acc[0] += c[0]; acc[1] += c[1]; acc[2] += c[2]
            n = S * S
            row += bytes((acc[0] // n, acc[1] // n, acc[2] // n))
        rows.append(bytes(row))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(b''.join(rows), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'icon.png')
