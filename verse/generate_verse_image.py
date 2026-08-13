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

ВАЖНО: светлая подложка АВТОМАТИЧЕСКИ подстраивается по высоте под
конкретное изречение — короткие тексты получают компактную подложку,
длинные — подложку побольше (вплоть до почти всей нижней части листа).
Если даже максимально большая подложка не вмещает текст — размер шрифта
чуть уменьшается (но не текста ради экономии места, а только как
подстраховка на случай очень длинных изречений).

Чёрный фон вокруг листа — прозрачный (плавное затухание к рваным краям).

Результат: RGBA PNG в исходном размере листа. Отправляется в Telegram через
send_photo — прозрачность при этом теряется (Telegram сжимает фото в JPEG,
углы станут белыми), это осознанный выбор: photo, в отличие от document и
sticker, открывается на весь экран с приближением текста и не обрамляется
рамкой файла.
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
SAFE_TOP = 480                 # подложка никогда не заходит выше — не перекрывает Будду
MAX_PANEL_BOTTOM = 1480        # подложка никогда не заходит ниже — не вылезает за лист
TITLE_Y = 500

MAX_FONT_SIZE = 44             # стартовый (обычный) размер текста изречения
MIN_FONT_SIZE = 30             # подстраховка для очень длинных изречений — меньше уже некрасиво

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


def _layout_content(en_text, ru_text, draw, content_width, font_size):
    """Считает, сколько места (по высоте) займёт текст при данном размере шрифта."""
    f_en = ImageFont.truetype(F_EN, font_size)
    f_ru = ImageFont.truetype(F_RU, font_size)
    en_lines = _wrap(en_text, f_en, content_width, draw)
    ru_lines = _wrap(ru_text, f_ru, content_width, draw)
    line_h = int(font_size * 1.18)

    block_h = (
        len(en_lines) * line_h
        + 22                      # отступ перед разделителем
        + 2                       # сама линия-разделитель
        + 30                      # отступ после разделителя
        + len(ru_lines) * line_h
        + 26                      # отступ перед подписью страницы
        + 24                      # высота строки подписи страницы
    )
    return f_en, f_ru, en_lines, ru_lines, line_h, block_h


def generate_verse_image(verse_number: int) -> Image.Image:
    with open(VERSES_PATH, encoding="utf-8") as f:
        verses = json.load(f)
    verse = next(v for v in verses if v["number"] == verse_number)

    base = Image.open(TEMPLATE_PATH).convert("RGB")
    W, H = base.size
    arr = np.array(base).astype(np.float32)

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

    # --- подпись серии на естественном фоне, рядом с Буддой ---
    f_series_bold = ImageFont.truetype(F_SERIES_BOLD, 46)
    f_series_italic = ImageFont.truetype(F_SERIES_ITALIC, 26)
    f_series_bold_small = ImageFont.truetype(F_SERIES_BOLD, 38)
    _draw_tracked(draw, (SERIES_CENTER_X, SERIES_LINE1_Y), "MAITREYA'S", f_series_bold, INK, tracking=5, anchor_center=True)
    part1 = "teachings for "
    part2 = "ASANGA"
    w1 = draw.textlength(part1, font=f_series_italic)
    w2 = sum(draw.textlength(ch, font=f_series_bold_small) for ch in part2) + 3 * (len(part2) - 1)
    total_w = w1 + w2
    start_x = SERIES_CENTER_X - total_w / 2
    draw.text((start_x, SERIES_LINE2_Y), part1, font=f_series_italic, fill=INK, anchor="la")
    _draw_tracked(draw, (start_x + w1, SERIES_LINE2_Y - 4), part2, f_series_bold_small, INK, tracking=3, anchor_center=False)

    # --- считаем, сколько места нужно тексту, и подбираем размер подложки ---
    content_left = SAFE_LEFT + 15
    content_right = SAFE_RIGHT - 15
    content_width = content_right - content_left
    content_start_y = TITLE_Y + 100

    en_text = verse["en"]
    ru_text = verse["ru"]

    font_size = MAX_FONT_SIZE
    while True:
        f_en, f_ru, en_lines, ru_lines, line_h, block_h = _layout_content(
            en_text, ru_text, draw, content_width, font_size
        )
        needed_bottom = content_start_y + block_h
        if needed_bottom <= MAX_PANEL_BOTTOM or font_size <= MIN_FONT_SIZE:
            break
        font_size -= 1  # текст длинный — подложке уже некуда расти, чуть уменьшаем шрифт

    # подложка растёт под конкретное изречение, но не меньше короткого дефолта
    # и не больше отведённого места на листе
    panel_bottom = max(950, min(needed_bottom + 40, MAX_PANEL_BOTTOM))

    # --- светлая подложка нужного размера ---
    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pdraw = ImageDraw.Draw(panel)
    pad = 40
    pdraw.rounded_rectangle(
        [SAFE_LEFT - pad, SAFE_TOP - pad, SAFE_RIGHT + pad, panel_bottom + pad],
        radius=18, fill=(240, 224, 192, 205),
    )
    panel = panel.filter(ImageFilter.GaussianBlur(18))

    # доп. плавное затухание низа подложки — чтобы светлая часть "таяла"
    # обратно в коричневый цвет листа, а не обрывалась ровным краем
    fade_h = 130
    fade_top = panel_bottom + pad - fade_h
    fade_bottom = panel_bottom + pad + 40
    panel_arr = np.array(panel).astype(np.float32)
    ys = np.arange(H)
    fade_mult = np.ones(H, dtype=np.float32)
    in_fade = (ys >= fade_top) & (ys <= fade_bottom)
    fade_mult[in_fade] = np.clip(1 - (ys[in_fade] - fade_top) / (fade_bottom - fade_top), 0, 1)
    fade_mult[ys > fade_bottom] = 0
    panel_arr[:, :, 3] = panel_arr[:, :, 3] * fade_mult[:, None]
    panel = Image.fromarray(panel_arr.astype(np.uint8), mode="RGBA")

    img = Image.alpha_composite(img, panel)
    draw = ImageDraw.Draw(img)

    f_title = ImageFont.truetype(F_TITLE, 38)
    f_eyebrow = ImageFont.truetype(F_EYEBROW, 22)
    f_src = ImageFont.truetype(F_SRC, 20)
    f_watermark = ImageFont.truetype(F_WATERMARK, 20)

    center_x = W / 2

    _draw_tracked(draw, (center_x, TITLE_Y), "UTTARATANTRA", f_title, INK, tracking=6, anchor_center=True)

    eyebrow_text = f"VERSE {verse['number']} · ИЗРЕЧЕНИЕ {verse['number']}"
    draw.text((center_x, TITLE_Y + 48), eyebrow_text, font=f_eyebrow, fill=INK_SOFT, anchor="ma")

    source_text = f"UTTARATANTRA · PAGE {verse['page']}"

    y = content_start_y
    for line in en_lines:
        draw.text((center_x, y), line, font=f_en, fill=INK, anchor="ma")
        y += line_h
    y += 22
    draw.line([(center_x - 50, y), (center_x + 50, y)], fill=INK_SOFT, width=2)
    y += 30
    for line in ru_lines:
        draw.text((center_x, y), line, font=f_ru, fill=INK, anchor="ma")
        y += line_h
    y += 26
    draw.text((center_x, y), source_text, font=f_src, fill=INK_SOFT, anchor="ma")

    watermark_y = min(panel_bottom + 90, H - 60)
    _draw_tracked(draw, (145, watermark_y), "Uttaratantra", f_watermark, INK_FAINT, tracking=3, anchor_center=False)

    return img


if __name__ == "__main__":
    import sys

    verse_number = int(sys.argv[1]) if len(sys.argv) > 1 else 1
    out_path = sys.argv[2] if len(sys.argv) > 2 else "test_output.png"

    img = generate_verse_image(verse_number)
    img.save(out_path)
    print(f"OK, saved {out_path}")
