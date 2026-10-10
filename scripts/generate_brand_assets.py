"""Generates every app icon and splash image from the supplied logo, branding/logo-source.webp.

Run from the repository root:  python scripts/generate_brand_assets.py   (Python 3 with Pillow)

The logo is used as supplied; nothing is redrawn. The only processing is:
- the white margin around the rounded logo tile is made transparent (anti-aliased edge kept, nothing cropped);
- the tile is scaled with Lanczos resampling and centred, never stretched (aspect ratio kept);
- where a platform masks the icon (Android adaptive/round icons, PWA maskable, iOS), the whole tile is placed
  inside the platform's safe zone on the tile's own dark teal, so no Bengali text or artwork is cut off.
"""
from collections import deque
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / 'branding' / 'logo-source.webp'
RES = ROOT / 'android' / 'app' / 'src' / 'main' / 'res'
PUBLIC = ROOT / 'public'

# Dark teal of the tile's lower edge: the background around the tile wherever one is needed.
BG = (6, 33, 42)


def tile() -> Image.Image:
    """The logo tile with its white surround made transparent, cropped to the tile."""
    src = Image.open(SOURCE).convert('RGB')
    w, h = src.size
    px = src.load()
    light = lambda p: min(p) >= 236  # noqa: E731
    # Exterior = near-white pixels connected to the image border (the tile's own light artwork is enclosed by its
    # dark edge, so it is never reached).
    outside = bytearray(w * h)
    queue = deque()
    for x in range(w):
        for y in (0, h - 1):
            queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            queue.append((x, y))
    while queue:
        x, y = queue.popleft()
        i = y * w + x
        if outside[i] or not light(px[x, y]):
            continue
        outside[i] = 1
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not outside[ny * w + nx]:
                queue.append((nx, ny))
    out = Image.new('RGBA', (w, h))
    op = out.load()
    edge = sum(BG)
    for y in range(h):
        for x in range(w):
            i = y * w + x
            r, g, b = px[x, y]
            if outside[i]:
                op[x, y] = (0, 0, 0, 0)
                continue
            near = any(outside[(y + dy) * w + (x + dx)] for dx in (-2, -1, 0, 1, 2) for dy in (-2, -1, 0, 1, 2) if 0 <= x + dx < w and 0 <= y + dy < h)
            if near:
                # Anti-aliased edge: blend of white and the tile edge. Recover the coverage and un-blend from white.
                a = max(0.0, min(1.0, (765 - (r + g + b)) / (765 - edge)))
                if a <= 0.02:
                    op[x, y] = (0, 0, 0, 0)
                    continue
                un = lambda c: int(max(0, min(255, round((c - (1 - a) * 255) / a))))  # noqa: E731
                op[x, y] = (un(r), un(g), un(b), int(round(a * 255)))
            else:
                op[x, y] = (r, g, b, 255)
    return out.crop(out.getbbox())


def fit(t: Image.Image, box: int) -> Image.Image:
    """Scales the tile so its longer side is `box` pixels (aspect ratio kept)."""
    s = box / max(t.size)
    return t.resize((max(1, round(t.width * s)), max(1, round(t.height * s))), Image.LANCZOS)


def place(canvas: Image.Image, t: Image.Image, box: int) -> Image.Image:
    f = fit(t, box)
    canvas.alpha_composite(f, ((canvas.width - f.width) // 2, (canvas.height - f.height) // 2))
    return canvas


def transparent(size: int, scale: float, t: Image.Image) -> Image.Image:
    return place(Image.new('RGBA', (size, size), (0, 0, 0, 0)), t, round(size * scale))


def on_bg(size: int, scale: float, t: Image.Image) -> Image.Image:
    return place(Image.new('RGBA', (size, size), BG + (255,)), t, round(size * scale))


def round_icon(size: int, t: Image.Image) -> Image.Image:
    # 4x supersampled circle on the tile colour; the tile fits inside the circle with its artwork intact.
    big = size * 4
    img = on_bg(big, 0.86, t)
    mask = Image.new('L', (big, big), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, big - 1, big - 1), fill=255)
    out = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def splash(w: int, h: int, t: Image.Image) -> Image.Image:
    img = Image.new('RGBA', (w, h), BG + (255,))
    return place(img, t, round(min(w, h) * 0.5)).convert('RGB')


def main() -> None:
    t = tile()
    # Android launcher icons (legacy square and round), per density.
    for d, px in {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}.items():
        transparent(px, 0.96, t).save(RES / f'mipmap-{d}' / 'ic_launcher.png')
        round_icon(px, t).save(RES / f'mipmap-{d}' / 'ic_launcher_round.png')
        # Adaptive foreground: 108dp layer; the tile spans 64dp, inside the 66dp safe circle every mask keeps.
        fg = 108 * px // 48
        transparent(fg, 64 / 108, t).save(RES / f'mipmap-{d}' / 'ic_launcher_foreground.png')
    # Capacitor splash images (same sizes as before).
    for folder in sorted(RES.glob('drawable*')):
        f = folder / 'splash.png'
        if f.exists():
            w, h = Image.open(f).size
            splash(w, h, t).save(f)
    # PWA and browser icons.
    transparent(192, 0.96, t).save(PUBLIC / 'pwa-192.png')
    transparent(512, 0.96, t).save(PUBLIC / 'pwa-512.png')
    on_bg(512, 0.78, t).save(PUBLIC / 'pwa-maskable-512.png')  # whole tile inside the 80% maskable safe zone
    on_bg(180, 0.86, t).convert('RGB').save(PUBLIC / 'apple-touch-icon.png')  # iOS rounds opaque icons itself
    transparent(64, 1.0, t).save(PUBLIC / 'favicon.png')
    print('Background colour #%02X%02X%02X' % BG)


if __name__ == '__main__':
    main()
