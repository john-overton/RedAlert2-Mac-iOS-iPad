#!/usr/bin/env python3
"""Convert a retail Windows icon to a macOS icon without altering the artwork."""
import pathlib
import struct
import subprocess
import sys
import tempfile

source, destination = map(pathlib.Path, sys.argv[1:])
data = source.read_bytes()
reserved, kind, count = struct.unpack_from('<HHH', data)
if reserved != 0 or kind != 1:
    raise ValueError(f'Not an ICO file: {source}')
images = []
for i in range(count):
    width, height, _, _, _, depth, size, offset = struct.unpack_from('<BBBBHHII', data, 6 + i * 16)
    payload = data[offset:offset + size]
    if payload.startswith(b'\x89PNG\r\n\x1a\n'):
        images.append(((width or 256) * (height or 256), depth, payload))
with tempfile.TemporaryDirectory(prefix='ra2-icon-') as temporary:
    root = pathlib.Path(temporary)
    png = root / 'source.png'
    if images:
        # Retail ICOs have several color depths; prefer the largest, richest PNG.
        png.write_bytes(max(images, key=lambda image: image[:2])[2])
    else:
        subprocess.run(['sips', '-s', 'format', 'png', str(source), '--out', str(png)], check=True, stdout=subprocess.DEVNULL)
    iconset = root / 'AppIcon.iconset'
    iconset.mkdir()
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            target = iconset / f'icon_{size}x{size}{"@2x" if scale == 2 else ""}.png'
            subprocess.run(['sips', '-z', str(size * scale), str(size * scale), str(png), '--out', str(target)], check=True, stdout=subprocess.DEVNULL)
    subprocess.run(['iconutil', '-c', 'icns', str(iconset), '-o', str(destination)], check=True)
print(f'App icon: {source.name} -> {destination}')
