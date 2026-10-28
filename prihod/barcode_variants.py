# Варианты фото для zbar: серое с контрастом, увеличенное, повороты.
# Использование: barcode_variants.py in.jpg out_dir  → out_dir/v1.png …
import sys
from PIL import Image, ImageOps

src, out = sys.argv[1], sys.argv[2]
img = Image.open(src)
img = ImageOps.exif_transpose(img).convert('L')
variants = []
base = ImageOps.autocontrast(img, cutoff=1)
variants.append(base)
w, h = base.size
if max(w, h) < 2400:
    k = 2400 / max(w, h)
    variants.append(base.resize((int(w * k), int(h * k)), Image.LANCZOS))
variants.append(base.rotate(90, expand=True))
variants.append(base.rotate(270, expand=True))
variants.append(base.rotate(180, expand=True))
variants.append(base.point(lambda p: 255 if p > 128 else 0))
for i, v in enumerate(variants, 1):
    v.save(f'{out}/v{i}.png')
print(len(variants))
