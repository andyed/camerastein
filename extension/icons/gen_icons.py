"""
SlideGest icon + OG image generator.
Logo: carousel horizontal stack with z-index depth and left/right arrows
conveying slide advance/rewind.

Outputs:
  icon-16.png, icon-48.png, icon-128.png  — extension icons
  github-social-1280x640.png              — OG social preview
"""

from PIL import Image, ImageDraw, ImageFont
import os, math

# ── Colors ──────────────────────────────────────────────────────────────────
BG = (10, 10, 15)
ACCENT = (100, 180, 230)       # cool blue (matches camerastein)
ACCENT_DIM = (65, 115, 150)
TEXT_CREAM = (230, 228, 210)

FONT_PATHS = [
    '/System/Library/Fonts/Helvetica.ttc',
    '/System/Library/Fonts/SFCompact.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
]

def find_font(size, bold=True):
    for p in FONT_PATHS:
        if os.path.exists(p):
            idx = 1 if (bold and p.endswith('.ttc')) else 0
            return ImageFont.truetype(p, size, index=idx)
    return ImageFont.load_default()


def luminance(rgb):
    r, g, b = [c / 255.0 for c in rgb]
    r = r / 12.92 if r <= 0.03928 else ((r + 0.055) / 1.055) ** 2.4
    g = g / 12.92 if g <= 0.03928 else ((g + 0.055) / 1.055) ** 2.4
    b = b / 12.92 if b <= 0.03928 else ((b + 0.055) / 1.055) ** 2.4
    return 0.2126 * r + 0.7152 * g + 0.0722 * b

def contrast_ratio(fg, bg):
    l1, l2 = luminance(fg), luminance(bg)
    if l1 < l2: l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def draw_carousel(draw, cx, cy, scale=1.0):
    """Draw a horizontal carousel stack with z-index depth.
    Center card is front/bright, flanking cards recede with perspective."""

    # Card dimensions at this scale — landscape (slides are wider than tall)
    card_w = int(80 * scale)
    card_h = int(52 * scale)
    card_r = max(2, int(6 * scale))
    gap = int(20 * scale)         # horizontal spacing between card centers
    depth_offset = int(12 * scale)  # vertical offset for receding cards

    # 5 cards: far-left, left, center, right, far-right
    cards = [
        {'dx': -2 * gap, 'dy': depth_offset * 2, 'scale': 0.65, 'brightness': 0.20},
        {'dx': -1 * gap, 'dy': depth_offset,     'scale': 0.80, 'brightness': 0.40},
        {'dx': 0,         'dy': 0,                'scale': 1.00, 'brightness': 1.00},
        {'dx': 1 * gap,  'dy': depth_offset,      'scale': 0.80, 'brightness': 0.40},
        {'dx': 2 * gap,  'dy': depth_offset * 2,  'scale': 0.65, 'brightness': 0.20},
    ]

    # Draw back-to-front (painter's algorithm)
    draw_order = [0, 4, 1, 3, 2]
    for idx in draw_order:
        c = cards[idx]
        s = c['scale']
        b = c['brightness']
        cw = int(card_w * s)
        ch = int(card_h * s)
        x = cx + c['dx'] - cw // 2
        y = cy + c['dy'] - ch // 2

        # Card fill — brighter for center
        fill = tuple(int(comp * b) for comp in ACCENT)
        # Ensure minimum contrast for non-center cards
        outline = tuple(min(255, int(comp * max(b, 0.5))) for comp in ACCENT)

        draw.rounded_rectangle([x, y, x + cw, y + ch], radius=card_r,
                               fill=fill, outline=outline, width=max(1, int(scale)))

        # Slide content on center card — title bar + body block
        if idx == 2:
            # Title bar (wide, top third)
            title_h = max(3, int(8 * scale))
            title_w = int(cw * 0.7)
            title_x = x + int(cw * 0.1)
            title_y = y + int(ch * 0.22)
            title_color = tuple(min(255, int(comp * 0.5)) for comp in ACCENT)
            draw.rounded_rectangle([title_x, title_y, title_x + title_w, title_y + title_h],
                                   radius=max(1, int(2 * scale)), fill=title_color)
            # Body block (shorter, below title)
            body_h = max(2, int(4 * scale))
            body_w = int(cw * 0.45)
            body_x = x + int(cw * 0.1)
            body_y = title_y + title_h + max(2, int(5 * scale))
            body_color = tuple(min(255, int(comp * 0.3)) for comp in ACCENT)
            draw.rounded_rectangle([body_x, body_y, body_x + body_w, body_y + body_h],
                                   radius=1, fill=body_color)


def draw_arrows(draw, cx, cy, scale=1.0):
    """Draw left/right chevron arrows flanking the carousel."""
    arrow_size = int(14 * scale)
    arrow_thickness = max(2, int(3 * scale))
    offset_x = int(90 * scale)
    arrow_color = ACCENT

    # Left arrow <
    lx = cx - offset_x
    pts_l = [
        (lx + arrow_size // 2, cy - arrow_size),
        (lx - arrow_size // 2, cy),
        (lx + arrow_size // 2, cy + arrow_size),
    ]
    draw.line([pts_l[0], pts_l[1]], fill=arrow_color, width=arrow_thickness)
    draw.line([pts_l[1], pts_l[2]], fill=arrow_color, width=arrow_thickness)

    # Right arrow >
    rx = cx + offset_x
    pts_r = [
        (rx - arrow_size // 2, cy - arrow_size),
        (rx + arrow_size // 2, cy),
        (rx - arrow_size // 2, cy + arrow_size),
    ]
    draw.line([pts_r[0], pts_r[1]], fill=arrow_color, width=arrow_thickness)
    draw.line([pts_r[1], pts_r[2]], fill=arrow_color, width=arrow_thickness)


# ── Icon generator ─────────────────────────────────────────────────────────

def gen_icon(size, out_path):
    img = Image.new('RGBA', (size, size), BG + (255,))
    draw = ImageDraw.Draw(img)
    scale = size / 128.0
    cx, cy = size // 2, size // 2

    draw_carousel(draw, cx, cy, scale=scale)
    draw_arrows(draw, cx, cy, scale=scale)

    # Flatten
    final = Image.new('RGB', (size, size), BG)
    final.paste(img, (0, 0), img)
    final.save(out_path, 'PNG')
    print(f"  Saved: {out_path} ({size}x{size})")


# ── OG social preview ─────────────────────────────────────────────────────

def gen_social(out_path):
    W, H = 1280, 640
    img = Image.new('RGBA', (W, H), BG + (255,))
    draw = ImageDraw.Draw(img)

    # Subtle grid dots
    for gx in range(40, W, 80):
        for gy in range(40, H, 80):
            dx = abs(gx - W / 2) / (W / 2)
            dy = abs(gy - H / 2) / (H / 2)
            dist = math.sqrt(dx * dx + dy * dy)
            if dist > 0.5:
                alpha = max(0, int(18 * (1 - (dist - 0.5) / 0.5)))
                if alpha > 0:
                    color = tuple(int(c * alpha / 18) for c in ACCENT_DIM)
                    draw.ellipse([gx - 1, gy - 1, gx + 1, gy + 1], fill=color)

    # Carousel motif — centered, behind text
    draw_carousel(draw, W // 2, H // 2 + 30, scale=3.0)
    draw_arrows(draw, W // 2, H // 2 + 30, scale=3.0)

    # Title with dark knockout glow
    title_font = find_font(96, bold=True)
    title = "SlideGest"
    bbox = draw.textbbox((0, 0), title, font=title_font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]

    sub_font = find_font(32, bold=False)
    subtitle = "wave your hand to advance slides"
    sbbox = draw.textbbox((0, 0), subtitle, font=sub_font)
    sw = sbbox[2] - sbbox[0]
    sh = sbbox[3] - sbbox[1]

    gap = 20
    total_h = th + gap + sh
    ty = (H - total_h) // 2 - 30
    tx = (W - tw) // 2
    sx = (W - sw) // 2

    # Dark knockout behind title
    glow_bg = BG
    for ddx in range(-5, 6):
        for ddy in range(-5, 6):
            if ddx == 0 and ddy == 0:
                continue
            draw.text((tx + ddx, ty + ddy), title, fill=glow_bg, font=title_font)

    # Title glow
    glow = tuple(int(c * 0.3) for c in ACCENT)
    for ddx in range(-3, 4):
        for ddy in range(-3, 4):
            if ddx == 0 and ddy == 0:
                continue
            draw.text((tx + ddx, ty + ddy), title, fill=glow, font=title_font)
    draw.text((tx, ty), title, fill=ACCENT, font=title_font)

    # Subtitle with knockout
    sy = ty + th + gap
    for ddx in range(-4, 5):
        for ddy in range(-4, 5):
            if ddx == 0 and ddy == 0:
                continue
            draw.text((sx + ddx, sy + ddy), subtitle, fill=glow_bg, font=sub_font)
    draw.text((sx, sy), subtitle, fill=TEXT_CREAM, font=sub_font)

    # Flatten
    final = Image.new('RGB', (W, H), BG)
    final.paste(img, (0, 0), img)

    ratio = contrast_ratio(ACCENT, BG)
    print(f"  Title contrast: {ratio:.1f}:1 {'PASS' if ratio >= 3.0 else 'FAIL'}")

    final.save(out_path, 'PNG')
    print(f"  Saved: {out_path} ({W}x{H})")


# ── Main ───────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    out_dir = os.path.dirname(os.path.abspath(__file__))
    assets_dir = os.path.join(os.path.dirname(out_dir), 'assets')
    os.makedirs(assets_dir, exist_ok=True)

    print("Generating SlideGest icons + OG...")
    gen_icon(16, os.path.join(out_dir, 'icon-16.png'))
    gen_icon(48, os.path.join(out_dir, 'icon-48.png'))
    gen_icon(128, os.path.join(out_dir, 'icon-128.png'))
    gen_social(os.path.join(assets_dir, 'github-social-1280x640.png'))
    print("Done.")
