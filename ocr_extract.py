import json
import sys
from pathlib import Path

from PIL import Image, ImageOps, ImageEnhance
from paddleocr import PaddleOCR


OCR = PaddleOCR(use_angle_cls=True, lang="en")


def ocr_lines(image_path: Path):
    result = OCR.ocr(str(image_path), cls=True) or []
    lines = []
    if not result:
        return lines
    for page in result:
        if not page:
            continue
        for line in page:
            if not line or len(line) < 2:
                continue
            text = line[1][0] if line[1] else ""
            score = float(line[1][1]) if line[1] and len(line[1]) > 1 else 0.0
            if text:
                lines.append({"text": text, "score": score})
    return lines


def build_variants(src_path: Path):
    img = Image.open(src_path).convert("RGB")
    variants = [src_path]

    w, h = img.size
    crop = img.crop((int(w * 0.18), int(h * 0.24), int(w * 0.82), int(h * 0.84)))
    crop_path = src_path.with_name(src_path.stem + "_crop.jpg")
    crop.save(crop_path, quality=92)
    variants.append(crop_path)

    mono = ImageOps.grayscale(crop)
    mono = ImageEnhance.Contrast(mono).enhance(1.8)
    mono = mono.point(lambda p: 255 if p > 165 else 0 if p < 105 else p)
    mono_path = src_path.with_name(src_path.stem + "_mono.png")
    mono.save(mono_path)
    variants.append(mono_path)

    return variants


def main():
    if len(sys.argv) < 2:
      raise SystemExit("image path required")

    src_path = Path(sys.argv[1])
    variants = build_variants(src_path)
    seen = set()
    merged = []
    try:
        for variant in variants:
            for item in ocr_lines(variant):
                key = item["text"].strip()
                if not key or key in seen:
                    continue
                seen.add(key)
                merged.append(item)
    finally:
        for variant in variants[1:]:
            if variant.exists():
                variant.unlink()

    print(json.dumps({"lines": merged}))


if __name__ == "__main__":
    main()
