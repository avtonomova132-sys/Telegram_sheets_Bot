"""Вырезает горизонтальную полосу фото накладной и увеличивает её.
Использование: python3 crop.py in.jpg out.jpg y0 y1  (y0, y1 — доли высоты 0..1)"""
import sys
from PIL import Image, ImageOps

src, dst, y0, y1 = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
im = ImageOps.exif_transpose(Image.open(src)).convert('RGB')
w, h = im.size
band = im.crop((0, int(max(0, y0) * h), w, int(min(1, y1) * h)))
scale = 2 if w < 2400 else 1
if scale > 1:
    band = band.resize((band.width * scale, band.height * scale), Image.LANCZOS)
band.save(dst, 'JPEG', quality=92)
