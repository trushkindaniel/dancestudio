"""
Статичная карта проезда для блока «Как нас найти»: склеивает фрагменты OpenStreetMap
(данные © участники OpenStreetMap, лицензия ODbL) и рисует метку зала.
Картинка хранится на нашем сервере, поэтому браузер посетителя к OpenStreetMap не обращается.
Запуск один раз: python scripts/build-map.py  → public/img/map.webp и map-640.webp
"""
import io
import math
import os
import time
import urllib.request

from PIL import Image, ImageDraw, ImageFilter

LAT, LON = 54.993439, 73.356270     # Омск, ул. Фрунзе, 1 к4
Z = 17
W, H = 1280, 760                     # итоговый размер (в 2 раза больше блока на сайте)
POINT = (0.62, 0.60)                 # где на картинке будет метка (левый верх занят подписью)
UA = 'arenda-zala-55-static-map/1.0 (one-time render for a small business site)'
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')


def to_px(lat, lon, z):
    n = 256 * 2 ** z
    x = (lon + 180) / 360 * n
    lr = math.radians(lat)
    y = (1 - math.log(math.tan(lr) + 1 / math.cos(lr)) / math.pi) / 2 * n
    return x, y


px, py = to_px(LAT, LON, Z)
left, top = px - W * POINT[0], py - H * POINT[1]
tx0, ty0 = int(left // 256), int(top // 256)
tx1, ty1 = int((left + W) // 256), int((top + H) // 256)

canvas = Image.new('RGB', ((tx1 - tx0 + 1) * 256, (ty1 - ty0 + 1) * 256), 'white')
for tx in range(tx0, tx1 + 1):
    for ty in range(ty0, ty1 + 1):
        req = urllib.request.Request(f'https://tile.openstreetmap.org/{Z}/{tx}/{ty}.png', headers={'User-Agent': UA})
        with urllib.request.urlopen(req, timeout=30) as r:
            tile = Image.open(io.BytesIO(r.read())).convert('RGB')
        canvas.paste(tile, ((tx - tx0) * 256, (ty - ty0) * 256))
        time.sleep(0.2)  # бережно к серверам OSM

ox, oy = left - tx0 * 256, top - ty0 * 256
img = canvas.crop((round(ox), round(oy), round(ox) + W, round(oy) + H))

# метка: капля в цвете сайта с белой точкой и мягкой тенью
mx, my = W * POINT[0], H * POINT[1]
shadow = Image.new('RGBA', img.size, (0, 0, 0, 0))
ImageDraw.Draw(shadow).ellipse((mx - 26, my - 8, mx + 26, my + 8), fill=(40, 25, 20, 110))
img = Image.alpha_composite(img.convert('RGBA'), shadow.filter(ImageFilter.GaussianBlur(6)))
d = ImageDraw.Draw(img)
r = 30
cx, cy = mx, my - 62
d.polygon([(cx - r * 0.86, cy + r * 0.5), (cx + r * 0.86, cy + r * 0.5), (mx, my)], fill=(156, 90, 106))
d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(156, 90, 106), outline=(255, 251, 247), width=5)
d.ellipse((cx - 11, cy - 11, cx + 11, cy + 11), fill=(255, 251, 247))
img = img.convert('RGB')

out = os.path.join(ROOT, 'public', 'img')
img.save(os.path.join(out, 'map.webp'), 'WEBP', quality=82, method=6)
img.resize((640, round(H * 640 / W)), Image.LANCZOS).save(os.path.join(out, 'map-640.webp'), 'WEBP', quality=80, method=6)
print('тайлов:', (tx1 - tx0 + 1) * (ty1 - ty0 + 1), 'размер:', img.size)
