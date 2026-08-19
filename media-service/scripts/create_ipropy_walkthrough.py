"""Create a polished, vertical IPROPY property walkthrough from a photo folder.

Usage:
  PYTHONPATH=/private/tmp/ipropy-video-tools python3 scripts/create_ipropy_walkthrough.py B12-Greenfield-Colony
"""
from pathlib import Path
import sys

import imageio.v2 as imageio
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
PHOTO_DIR = ROOT / (sys.argv[1] if len(sys.argv) > 1 else "B12-Greenfield-Colony")
OUTPUT = ROOT / (sys.argv[2] if len(sys.argv) > 2 else str(PHOTO_DIR / "IPROPY-B12-Greenfield-Colony-walkthrough.mp4"))

WIDTH, HEIGHT, FPS = 1080, 1920, 30
SCENE_SECONDS, CROSSFADE_SECONDS, INTRO_SECONDS = 2.65, 0.45, 2.4
SERIF = "/System/Library/Fonts/Supplemental/Didot.ttc"
SANS = "/System/Library/Fonts/Supplemental/Arial.ttf"

def f(path, size):
    return ImageFont.truetype(path, size)

def draw_centered(draw, xy, text, font, fill, tracking=0):
    if not tracking:
        draw.text(xy, text, font=font, fill=fill, anchor="mm")
        return
    widths = [draw.textlength(char, font=font) for char in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = xy[0] - total / 2
    for char, width in zip(text, widths):
        draw.text((x, xy[1]), char, font=font, fill=fill, anchor="lm")
        x += width + tracking

def load_scene(path):
    image = ImageOps.exif_transpose(Image.open(path)).convert("RGB")
    # The photos are 9:16. Scale to cover with a little room for slow motion.
    scale = max(WIDTH / image.width, HEIGHT / image.height) * 1.10
    image = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
    return image

def animated_frame(image, progress, direction):
    max_x, max_y = max(0, image.width - WIDTH), max(0, image.height - HEIGHT)
    # A slow, restrained pan: no gimmicky motion and no fast digital zooms.
    if direction % 4 == 0:
        x, y = round(max_x * (0.22 + 0.56 * progress)), round(max_y * 0.36)
    elif direction % 4 == 1:
        x, y = round(max_x * 0.56), round(max_y * (0.60 - 0.46 * progress))
    elif direction % 4 == 2:
        x, y = round(max_x * (0.72 - 0.52 * progress)), round(max_y * 0.58)
    else:
        x, y = round(max_x * 0.40), round(max_y * (0.18 + 0.56 * progress))
    return image.crop((x, y, x + WIDTH, y + HEIGHT)).convert("RGBA")

def add_branding(frame):
    overlay = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    # A quiet vignette ensures the signature stays refined over bright or dark rooms.
    draw.rectangle((0, HEIGHT - 222, WIDTH, HEIGHT), fill=(5, 11, 22, 34))
    panel = (54, HEIGHT - 176, 373, HEIGHT - 72)
    draw.rounded_rectangle(panel, radius=10, fill=(7, 12, 23, 102))
    draw.text((83, HEIGHT - 144), "IPROPY", font=f(SERIF, 50), fill=(255, 252, 245, 245), anchor="lm")
    draw.line((83, HEIGHT - 112, 344, HEIGHT - 112), fill=(230, 209, 155, 220), width=2)
    draw.text((83, HEIGHT - 91), "BESPOKE LIVING", font=f(SANS, 15), fill=(230, 209, 155, 240), anchor="lm")
    # Light ownership mark, intentionally only one: the video itself retains the clear IPROPY signature.
    draw.text((WIDTH - 59, HEIGHT - 93), "PROPERTY SHOWCASE", font=f(SANS, 14), fill=(255, 255, 255, 132), anchor="rm")
    return Image.alpha_composite(frame, overlay).convert("RGB")

def intro_frame(progress):
    base = Image.new("RGB", (WIDTH, HEIGHT), (12, 20, 35))
    draw = ImageDraw.Draw(base)
    # Almost-black navy with an understated warm pool of light.
    glow = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-420, 460, 1500, 2380), fill=(151, 111, 45, 24))
    glow = glow.filter(ImageFilter.GaussianBlur(140))
    base = Image.alpha_composite(base.convert("RGBA"), glow)
    draw = ImageDraw.Draw(base)
    opacity = min(1, progress * 4, (1 - progress) * 5)
    alpha = round(255 * opacity)
    gold = (231, 209, 156, alpha)
    ivory = (255, 252, 245, alpha)
    draw.text((WIDTH // 2, 732), "A PRIVATE VIEWING", font=f(SANS, 20), fill=gold, anchor="mm")
    draw_centered(draw, (WIDTH // 2, 868), "IPROPY", f(SERIF, 132), ivory, tracking=11)
    draw.line((248, 974, 832, 974), fill=gold, width=2)
    draw.text((WIDTH // 2, 1047), "B12  •  GREENFIELD COLONY", font=f(SANS, 27), fill=ivory, anchor="mm")
    draw.text((WIDTH // 2, 1098), "BUILDER FLOOR", font=f(SANS, 19), fill=gold, anchor="mm")
    return base.convert("RGB")

photos = sorted(p for p in PHOTO_DIR.glob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"} and "-ipropy-watermarked" not in p.name.lower())
if not photos:
    raise SystemExit(f"No original JPG, JPEG, or PNG files found in {PHOTO_DIR}")

scenes = [load_scene(path) for path in photos]
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
writer = imageio.get_writer(OUTPUT, fps=FPS, codec="libx264", quality=8, pixelformat="yuv420p", macro_block_size=1)

for frame_number in range(round(INTRO_SECONDS * FPS)):
    writer.append_data(__import__("numpy").asarray(intro_frame(frame_number / max(1, round(INTRO_SECONDS * FPS) - 1))))

scene_frames = round(SCENE_SECONDS * FPS)
fade_frames = round(CROSSFADE_SECONDS * FPS)
for index, scene in enumerate(scenes):
    for frame_number in range(scene_frames):
        current = animated_frame(scene, frame_number / max(1, scene_frames - 1), index)
        if index < len(scenes) - 1 and frame_number >= scene_frames - fade_frames:
            amount = (frame_number - (scene_frames - fade_frames)) / max(1, fade_frames - 1)
            next_frame = animated_frame(scenes[index + 1], 0, index + 1)
            current = Image.blend(current, next_frame, amount)
        writer.append_data(__import__("numpy").asarray(add_branding(current)))

writer.close()
print(f"Created {OUTPUT}")
print(f"Photos used: {len(photos)} | Duration: approximately {(INTRO_SECONDS + len(photos) * SCENE_SECONDS):.0f} seconds")
