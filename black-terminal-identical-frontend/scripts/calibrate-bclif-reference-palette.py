#!/usr/bin/env python3
"""Derive the public BCLIF reference LUT and non-identifying visual metrics.

The source screenshot stays local. Only the 256-entry color ramp, aggregate
metrics and the source SHA-256 are written into the repository.
"""
from __future__ import annotations

import argparse
import colorsys
import hashlib
import json
import math
from collections import Counter
from pathlib import Path
from PIL import Image

ANCHORS = [
    (0.000, "#350044"), (0.060, "#44065C"), (0.140, "#411061"),
    (0.240, "#3D1E68"), (0.350, "#392D6F"), (0.460, "#353C76"),
    (0.560, "#2F527F"), (0.650, "#2B6288"), (0.730, "#26778B"),
    (0.800, "#218E85"), (0.865, "#26A57B"), (0.920, "#51BD5D"),
    (0.965, "#85CC42"), (0.992, "#BFD92B"), (1.000, "#F0E705"),
]


def clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def srgb_to_linear(value: float) -> float:
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def linear_to_srgb(value: float) -> float:
    return 12.92 * value if value <= 0.0031308 else 1.055 * value ** (1 / 2.4) - 0.055


def hex_rgb(value: str) -> tuple[float, float, float]:
    return tuple(int(value[index:index + 2], 16) / 255 for index in (1, 3, 5))


def linear_rgb(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    return tuple(srgb_to_linear(channel) for channel in rgb)


def oklab(rgb: tuple[float, float, float]) -> tuple[float, float, float]:
    r, g, b = linear_rgb(rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l_, m_, s_ = math.copysign(abs(l) ** (1 / 3), l), math.copysign(abs(m) ** (1 / 3), m), math.copysign(abs(s) ** (1 / 3), s)
    return (
        0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
        1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
        0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    )


def base_color(position: float) -> tuple[float, float, float]:
    right = next((index for index, (stop, _) in enumerate(ANCHORS) if stop >= position), len(ANCHORS) - 1)
    left = max(0, right - 1)
    lo_t, lo_hex = ANCHORS[left]
    hi_t, hi_hex = ANCHORS[right]
    amount = 0 if hi_t == lo_t else clamp((position - lo_t) / (hi_t - lo_t))
    lo, hi = linear_rgb(hex_rgb(lo_hex)), linear_rgb(hex_rgb(hi_hex))
    mixed = tuple(lo[index] + (hi[index] - lo[index]) * amount for index in range(3))
    return tuple(clamp(linear_to_srgb(channel)) for channel in mixed)


def distance(left: tuple[float, float, float], right: tuple[float, float, float]) -> float:
    return sum((left[index] - right[index]) ** 2 for index in range(3))


def percentile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    position = clamp(q) * (len(values) - 1)
    lower = int(position)
    upper = min(len(values) - 1, lower + 1)
    fraction = position - lower
    return values[lower] + (values[upper] - values[lower]) * fraction


def rgb_hex(rgb: tuple[float, float, float]) -> str:
    return "#" + "".join(f"{round(clamp(channel) * 255):02X}" for channel in rgb)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("image", type=Path)
    parser.add_argument("--spec", type=Path, required=True)
    parser.add_argument("--typescript", type=Path, required=True)
    args = parser.parse_args()

    source_bytes = args.image.read_bytes()
    image = Image.open(args.image).convert("RGBA")
    width, height = image.size
    pixels = list(image.getdata())
    stride = max(1, len(pixels) // 500_000)
    sampled = [pixel for pixel in pixels[::stride] if pixel[3] >= 250]
    histogram: Counter[tuple[int, int, int]] = Counter(
        ((r >> 3) << 3, (g >> 3) << 3, (b >> 3) << 3)
        for r, g, b, _ in sampled
    )

    base = [base_color(index / 255) for index in range(256)]
    base_lab = [oklab(color) for color in base]
    buckets: list[list[tuple[tuple[float, float, float], int]]] = [[] for _ in range(256)]
    for (r, g, b), count in histogram.items():
        rgb = (r / 255, g / 255, b / 255)
        saturation = colorsys.rgb_to_hsv(*rgb)[1]
        value = max(rgb)
        if saturation < 0.18 or value < 0.07:
            continue
        lab = oklab(rgb)
        nearest = min(range(256), key=lambda index: distance(lab, base_lab[index]))
        # Reject magenta/red candle strokes from the reference capture; the
        # calibration target is the thermal field, never foreground price ink.
        if nearest < 170 and r > b * 1.12:
            continue
        if distance(lab, base_lab[nearest]) <= 0.035:
            buckets[nearest].append((rgb, count))

    calibrated: list[tuple[float, float, float]] = []
    for index, fallback in enumerate(base):
        neighborhood = [
            item
            for bucket_index in range(max(0, index - 3), min(256, index + 4))
            for item in buckets[bucket_index]
        ]
        if not neighborhood:
            calibrated.append(fallback)
            continue
        total = sum(count for _, count in neighborhood)
        observed_linear = tuple(
            sum(linear_rgb(rgb)[channel] * count for rgb, count in neighborhood) / total
            for channel in range(3)
        )
        observed = tuple(clamp(linear_to_srgb(channel)) for channel in observed_linear)
        # The formal anchors preserve monotonic topology; the screenshot tunes
        # local chroma/value without importing any source pixel geometry.
        mix = 0.32
        calibrated.append(tuple(fallback[channel] * (1 - mix) + observed[channel] * mix for channel in range(3)))

    # Preserve exact endpoint semantics and smooth local histogram noise.
    calibrated[0] = hex_rgb(ANCHORS[0][1])
    calibrated[-1] = hex_rgb(ANCHORS[-1][1])
    for _ in range(4):
        calibrated = [
            calibrated[index] if index in (0, 255) else tuple(
                calibrated[index - 1][channel] * 0.2
                + calibrated[index][channel] * 0.6
                + calibrated[index + 1][channel] * 0.2
                for channel in range(3)
            )
            for index in range(256)
        ]

    values = [colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)[2] for r, g, b, _ in sampled]
    mapped_counts = [0] * 256
    for (r, g, b), count in histogram.items():
        lab = oklab((r / 255, g / 255, b / 255))
        nearest = min(range(256), key=lambda index: distance(lab, base_lab[index]))
        mapped_counts[nearest] += count
    mapped_total = max(1, sum(mapped_counts))
    families = {
        "purple": sum(mapped_counts[:143]) / mapped_total,
        "blueCyan": sum(mapped_counts[143:211]) / mapped_total,
        "green": sum(mapped_counts[211:252]) / mapped_total,
        "yellow": sum(mapped_counts[252:]) / mapped_total,
    }
    lut = [rgb_hex(color) for color in calibrated]
    spec = {
        "contract": "BCLIF_REFERENCE_THERMAL_CALIBRATION_V1",
        "sourceSha256": hashlib.sha256(source_bytes).hexdigest(),
        "sourceDimensions": {"width": width, "height": height},
        "sourceCommitted": False,
        "method": "OKLab nearest-path histogram calibration over the formal III-C6 anchors",
        "interpolation": "linear-light sRGB",
        "entries": 256,
        "missingDataColor": "#05020B",
        "brightness": {
            "p10": round(percentile(values, 0.10), 6),
            "median": round(percentile(values, 0.50), 6),
            "p90": round(percentile(values, 0.90), 6),
            "maximum": round(max(values, default=0), 6),
        },
        "referencePaletteOccupancy": {key: round(value * 100, 6) for key, value in families.items()},
        "lut": lut,
    }
    args.spec.parent.mkdir(parents=True, exist_ok=True)
    args.typescript.parent.mkdir(parents=True, exist_ok=True)
    args.spec.write_text(json.dumps(spec, indent=2) + "\n")
    bytes_list = ", ".join(str(int(color[index:index + 2], 16)) for color in lut for index in (1, 3, 5))
    ts = (
        "/* Generated by scripts/calibrate-bclif-reference-palette.py. */\n"
        f"export const BCLIF_REFERENCE_LUT_SOURCE_SHA256 = \"{spec['sourceSha256']}\";\n"
        f"export const BCLIF_REFERENCE_LUT_HEX = {json.dumps(lut)} as const;\n"
        f"export const BCLIF_REFERENCE_LUT_RGB = new Uint8Array([{bytes_list}]);\n"
    )
    args.typescript.write_text(ts)


if __name__ == "__main__":
    main()
