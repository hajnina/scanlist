#!/usr/bin/env python3
"""Generate the PWA icons in public/ (card C2).

Why a script: icons are binary and the design should be reproducible. Run it after changing the
palette/shape:

    python3 scripts/make-icons.py

Design follows references/bonsai-ui/STYLE_GUIDE.md §6 (solid #10261C-like dark background, simple
glyph, no icon library): a teal rounded square, three "list" bars and a check. The maskable variant
is full-bleed and keeps the glyph inside the 80% safe circle. No external assets, no fonts.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

PUBLIC = Path(__file__).resolve().parent.parent / "public"
SS = 4  # supersampling factor, then downscale for clean edges

BG = (0, 107, 95, 255)  # light primary, #006B5F
BAR = (241, 255, 251, 255)  # near-white
CHECK = (116, 248, 228, 255)  # primary container, #74F8E4


def draw_icon(size: int, *, maskable: bool) -> Image.Image:
    canvas = size * SS
    image = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    if maskable:
        draw.rectangle((0, 0, canvas, canvas), fill=BG)
        # Safe zone: keep the glyph inside the middle 76% (Android masks up to a circle).
        scale, offset = 0.72, 0.14
    else:
        draw.rounded_rectangle(
            (0, 0, canvas, canvas), radius=int(canvas * 0.22), fill=BG
        )
        scale, offset = 1.0, 0.0

    def p(frac: float) -> float:
        return canvas * (offset + frac * scale)

    def length(frac: float) -> float:
        return canvas * frac * scale

    # Three list bars, left-aligned, decreasing width.
    bar_height = length(0.062)
    for index, (top, width) in enumerate(((0.30, 0.36), (0.45, 0.30), (0.60, 0.22))):
        x0, y0 = p(0.22), p(top)
        draw.rounded_rectangle(
            (x0, y0, x0 + length(width), y0 + bar_height),
            radius=bar_height / 2,
            fill=BAR,
        )

    # Check mark, bottom-right, drawn over the third bar's free space.
    stroke = max(int(length(0.075)), 2)
    points = [(p(0.46), p(0.735)), (p(0.575), p(0.815)), (p(0.80), p(0.575))]
    draw.line(points, fill=CHECK, width=stroke, joint="curve")
    for x, y in (points[0], points[-1]):
        draw.ellipse((x - stroke / 2, y - stroke / 2, x + stroke / 2, y + stroke / 2), fill=CHECK)

    return image.resize((size, size), Image.LANCZOS)


def main() -> None:
    PUBLIC.mkdir(parents=True, exist_ok=True)
    for name, size, maskable in (
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-maskable-512.png", 512, True),
    ):
        draw_icon(size, maskable=maskable).save(PUBLIC / name, optimize=True)
        print(f"wrote {PUBLIC / name}")


if __name__ == "__main__":
    main()
