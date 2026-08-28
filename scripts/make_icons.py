"""Regenerate the web icons. Run from the project root:

    python scripts/make_icons.py
"""

import os
import sys

from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "audioy", "web")
ASSETS = os.path.join(ROOT, "assets")

PAPER = (245, 243, 238, 255)
INK = (22, 21, 15, 255)


def draw(size):
    # Draw large and downsample; PIL has no antialiasing on shapes.
    scale = 4
    big = size * scale
    img = Image.new("RGBA", (big, big), PAPER)
    d = ImageDraw.Draw(img)

    pad = big // 12
    d.ellipse([pad, pad, big - pad - 1, big - pad - 1],
              outline=INK, width=max(2, big // 22))

    bar_w = big // 13
    gap = bar_w * 2
    heights = (big * 0.22, big * 0.42, big * 0.29)
    x = big / 2 - (bar_w * 3 + gap * 2) / 2
    for h in heights:
        d.rectangle([x, big / 2 - h / 2, x + bar_w, big / 2 + h / 2], fill=INK)
        x += bar_w + gap

    return img.resize((size, size), Image.LANCZOS)


def main():
    if not os.path.isdir(OUT):
        sys.exit("cannot find {}".format(OUT))
    for size in (180, 192, 512):
        path = os.path.join(OUT, "icon-{}.png".format(size))
        draw(size).save(path, format="PNG")
        print("wrote", path)

    # the executable's icon
    os.makedirs(ASSETS, exist_ok=True)
    ico = os.path.join(ASSETS, "audioY.ico")
    draw(256).save(ico, format="ICO",
                   sizes=[(16, 16), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("wrote", ico)


if __name__ == "__main__":
    main()
