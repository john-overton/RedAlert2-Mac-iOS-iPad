#!/usr/bin/env python3
"""Extract the retail Windows icon's artwork to a PNG for the Linux launcher.

Same ICO parsing as build-macos-icon.py, without sips/iconutil: the largest
PNG member is written out unchanged. Retail ICOs that only carry BMP members
are converted through Pillow when it is installed.
"""
import io
import pathlib
import struct
import sys

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
destination.parent.mkdir(parents=True, exist_ok=True)
if images:
    # Retail ICOs have several color depths; prefer the largest, richest PNG.
    destination.write_bytes(max(images, key=lambda image: image[:2])[2])
else:
    try:
        from PIL import Image
    except ImportError:
        sys.exit(f'{source.name} has no PNG members and Pillow is not installed (pacman -S python-pillow).')
    with Image.open(io.BytesIO(data)) as ico:
        largest = max(ico.info.get('sizes', {ico.size}))
        ico.size = largest
        ico.load()
        ico.convert('RGBA').save(destination, 'PNG')
print(f'App icon: {source.name} -> {destination}')
