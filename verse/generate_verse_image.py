"""
Генерация ежедневной картинки-изречения Уттаратантры.

Слои сверху вниз:
  - "MAITREYA'S teachings for ASANGA" — подпись серии, на естественной
    (не подсвеченной) текстуре листа, рядом с изображением Будды, не
    перекрывает его
  - "UTTARATANTRA" — крупный заголовок книги (на светлой подложке)
  - номер изречения (EN + RU)
  - текст изречения на английском (первым, крупно, жирным)
  - текст изречения на русском (вторым, тем же крупным размером)
  - подпись страницы-источника
  - тонкий водяной знак "Uttaratantra" внизу слева

Светлая подложка начинается НИЖЕ изображения Будды, чтобы не перекрывать его.
Чёрный фон вокруг листа — прозрачный (плавное затухание к рваным краям).

Результат: RGBA PNG. Отправлять в Telegram ТОЛЬКО через send_document
(не send_photo!) — иначе Telegram сожмёт в JPEG и зальёт прозрачность белым.
"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import numpy as np
import json
import os

TEMPLATE_PATH = os.path.join(os.path.dirname(__file__), "template_palm_leaf.png")
VERSES_PATH = os.path.join(os.path.dirname(__file__), "verses.json")

FONT_DIR = "/usr/share/fonts/truetype/liberation/"
F_SERIES_BOLD = FONT_DIR + "LiberationSerif-Bold.ttf"
F_SERIES_ITALIC = FONT_DIR + "LiberationSerif-Italic.ttf"
F_TITLE = FONT_DIR + "LiberationSerif-Bold.ttf"
F_EYEBROW = FONT_DIR + "LiberationSerif-BoldItalic.ttf"
F_EN = FONT_DIR + "LiberationSerif-Bold.ttf"
F_RU = FONT_DIR + "LiberationSerif-BoldItalic.ttf"
F_SRC = FONT_DIR + "LiberationSerif-Bold.ttf"
F_WATERMARK = FONT_DIR + "LiberationSerif-Regular.ttf"

INK = (48, 30, 16, 255)
INK_SOFT = (82, 56, 32, 255)
INK_FAINT = (82, 56, 32, 140)

SAFE_LEFT, SAFE_RIGHT = 90, 935
SAFE_TOP, SAFE_BOTTOM = 480, 1400   # подложка начинается НИЖЕ Будды
TITLE_Y = 500

# подпись серии — на тёмной (естественной) части листа, справа от Будды
SERIES_CENTER_X = 565
SERIES_LINE1_Y = 175
SERIES_LINE2_Y = 250


def _wrap(text, font, max_width, draw):
    words = text.split()
    lines, cur = [], ""
    for w in words:
        test = (cur + " " + w).strip()
        if draw.textlength(test, font=font) <= max_width:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def _draw_tracked(draw, xy, text, font, fill, tracking=6, anchor_center=False):
    widths = [draw.textlength(ch, font=font) for ch in text]
    total_w = sum(widths) + tracking * (len(text) - 1)
    x, y = xy
    if anchor_center:
        x = x - total_w / 2
    for ch, w in zip(text, widths):
        draw.text((x, y), ch, font=font, fill=fill, anchor="la")
        x += w + tracking
    return total_w


def generate_verse_image(verse_number: int) -> Image.Image:
    with open(VERSES_PATH, encoding="utf-8") as f:
        verses = json.load(f)
    verse = next(v for v in verses if v["number"] == verse_number)

    base = Image.open(TEMPLATE_PATH).convert("RGB")
    W, H = base.size
    arr = np.array(base).astype(np.float32)

    # чёрный фон вокруг листа -> прозрачность
    lum = 0.299 * arr[:, :, 0] + 0.587 * arr[:, :, 1] + 0.114 * arr[:, :, 2]
    low, high = 8.0, 55.0
    alpha = np.clip((lum - low) / (high - low), 0, 1) * 255.0
    alpha = alpha.astype(np.uint8)
    rgba = np.dstack([arr.astype(np.uint8), alpha])
    img = Image.fromarray(rgba, mode="RGBA")
    a_img = Image.fromarray(alpha, mode="L").filter(ImageFilter.GaussianBlur(1.2))
    r, g, b, _ = img.split()
    img = Image.merge("RGBA", (r, g, b, a_img))
    draw = ImageDraw.Draw(img)

    # --- подпись серии на естественном фоне, рядом с Буддой (до подложки!) ---
    f_series_bold = ImageFont.truetype(F_SERIES_BOLD, 46)
    f_series_italic = ImageFont.truetype(F_SERIES_ITALIC, 26)
    f_series_bold_small = ImageFont.truetype(F_SERIES_BOLD, 38)
    _draw_tracked(draw, (SERIES_CENTER_X, SERIES_LINE1_Y), "MAITREYA'S", f_series_bold, INK, tracking=5, anchor_center=True)

    # вторая строка — смешанные размеры: "teachings for " (мельче) + "ASANGA" (крупно, жирно)
    part1 = "teachings for "
    part2 = "ASANGA"
    w1 = draw.textlength(part1, font=f_series_italic)
    w2 = sum(draw.textlength(ch, font=f_series_bold_small) for ch in part2) + 3 * (len(part2) - 1)
    total_w = w1 + w2
    start_x = SERIES_CENTER_X - total_w / 2
    draw.text((start_x, SERIES_LINE2_Y), part1, font=f_series_italic, fill=INK, anchor="la")
    _draw_tracked(draw, (start_x + w1, SERIES_LINE2_Y - 4), part2, f_series_bold_small, INK, tracking=3, anchor_center=False)

    # --- светлая подложка под основным текстом, НИЖЕ Будды ---
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(panel)
    pad = 40
    pdraw.rounded_rectangle(
        [SAFE_LEFT - pad, SAFE_TOP - pad, SAFE_RIGHT + pad, SAFE_BOTTOM + pad],
        radius=18, fill=(240, 224, 192, 205),
    )
    panel = panel.filter(ImageFilter.GaussianBlur(18))
    img = Image.alpha_composite(img, panel)
    draw = ImageDraw.Draw(img)

    f_title = ImageFont.truetype(F_TITLE, 38)
    f_eyebrow = ImageFont.truetype(F_EYEBROW, 22)
    f_en = ImageFont.truetype(F_EN, 44)
    f_ru = ImageFont.truetype(F_RU, 44)
    f_src = ImageFont.truetype(F_SRC, 20)
    f_watermark = ImageFont.truetype(F_WATERMARK, 20)

    center_x = W / 2

    _draw_tracked(draw, (center_x, TITLE_Y), "UTTARATANTRA", f_title, INK, tracking=6, anchor_center=True)

    eyebrow_text = f"VERSE {verse['number']} · ИЗРЕЧЕНИЕ {verse['number']}"
    draw.text((center_x, TITLE_Y + 48), eyebrow_text, font=f_eyebrow, fill=INK_SOFT, anchor="ma")

    en_text = verse["en"]
    ru_text = verse["ru"]
    source_text = f"UTTARATANTRA · PAGE {verse['page']}"

    content_left = SAFE_LEFT + 15
    content_right = SAFE_RIGHT - 15
    content_width = content_right - content_left

    en_lines = _wrap(en_text, f_en, content_width, draw)
    ru_lines = _wrap(ru_text, f_ru, content_width, draw)

    line_h_en, line_h_ru = 52, 52
    y = TITLE_Y + 100

    for line in en_lines:
        draw.text((center_x, y), line, font=f_en, fill=INK, anchor="ma")
        y += line_h_en
    y += 22
    draw.line([(center_x - 50, y), (center_x + 50, y)], fill=INK_SOFT, width=2)
    y += 30
    for line in ru_lines:
        draw.text((center_x, y), line, font=f_ru, fill=INK, anchor="ma")
        y += line_h_ru
    y += 26
    draw.text((center_x, y), source_text, font=f_src, fill=INK_SOFT, anchor="ma")

    _draw_tracked(draw, (145, 1500), "Uttaratantra", f_watermark, INK_FAINT, tracking=3, anchor_center=False)

    return img


if __name__ == "__main__":
    import sys

    verse_number = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    out_path = sys.argv[2] if len(sys.argv) > 2 else "test_output.png"

    img = generate_verse_image(verse_number)
    img.save(out_path)
    print(f"OK, saved {out_path}")
