"""
Фото раздевалки: коврики «как новые» и ровно по линии коридора.
Берём текстуру самих ковриков, чистим её (без тёмных пятен, ровный цвет), укладываем
два прямых коврика по перспективе коридора, а открывшийся пол дорисовываем по соседним пикселям.
Запуск: python scripts/fix-rugs.py  → public/img/lockers-v2.webp, lockers-v2-640.webp
"""
import os
import cv2
import numpy as np

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
src = cv2.imread(os.path.join(ROOT, 'docs', 'photos', 'lockers.jpg'))
img = src.copy()
H, W = img.shape[:2]

# коврики на исходном фото (по сетке координат): дальний и ближний
old_back = np.float32([[517, 653], [641, 656], [645, 757], [476, 754]])
old_front = np.float32([[486, 753], [651, 756], [654, 964], [398, 964]])

# точка схода коридора (по правому краю ковриков) и прямые линии новых ковриков
VP = np.array([631.0, 430.0])
def on_line(x_bottom, y):
    return x_bottom + (VP[0] - x_bottom) * (964 - y) / (964 - VP[1])
LX, RX = 396.0, 654.0
def quad(y0, y1):
    return np.float32([[on_line(LX, y0), y0], [on_line(RX, y0), y0], [on_line(RX, y1), y1], [on_line(LX, y1), y1]])
new_back = quad(656, 750)
new_front = quad(762, 966)


def rectify(q, w, h):
    M = cv2.getPerspectiveTransform(q, np.float32([[0, 0], [w, 0], [w, h], [0, h]]))
    return cv2.warpPerspective(src, M, (w, h), flags=cv2.INTER_CUBIC)


def clean(tex):
    """Чистая текстура: убрать тёмные пятна и серость, выровнять цвет, сохранить ворс."""
    lab = cv2.cvtColor(tex, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A, B = cv2.split(lab)
    base = cv2.GaussianBlur(L, (0, 0), 18)                  # общее освещение
    detail = L - base                                        # ворс
    detail = np.clip(detail, -22, 24)                        # самые тёмные пятна срезаем, ворс оставляем
    L2 = np.full_like(L, float(np.median(L)) + 7) + detail * 1.05  # ровный, чуть светлее тон + ворс
    A2 = A * 0.5 + float(np.median(A)) * 0.5 + 2              # розовый ровнее, без серых пятен
    B2 = B * 0.5 + float(np.median(B)) * 0.5
    out = cv2.merge([np.clip(L2, 0, 255), np.clip(A2, 0, 255), np.clip(B2, 0, 255)]).astype(np.uint8)
    return cv2.cvtColor(out, cv2.COLOR_LAB2BGR)


def inset(q, d):
    """Четырёхугольник, сжатый к центру на d пикселей: в текстуру не попадает кромка и пол."""
    c0 = q.mean(axis=0)
    return np.float32([p + (c0 - p) / np.linalg.norm(c0 - p) * d for p in q])


tex_front = clean(rectify(inset(old_front, 14), 320, 420))
tex_back = clean(rectify(inset(old_back, 12), 320, 200))

# 1) убираем старые коврики и розовую тапочку у скамейки: дорисовываем пол
mask = np.zeros((H, W), np.uint8)
for q in (old_back, old_front):
    cv2.fillConvexPoly(mask, q.astype(np.int32), 255)
cv2.rectangle(mask, (640, 655), (664, 680), 255, -1)        # тапочка
mask = cv2.dilate(mask, np.ones((7, 7), np.uint8))
floor = cv2.inpaint(img, mask, 9, cv2.INPAINT_TELEA)

# 2) мягкая тень под ковриками
shadow = np.zeros((H, W), np.float32)
for q in (new_back, new_front):
    cv2.fillConvexPoly(shadow, (q + np.float32([2, 3])).astype(np.int32), 1.0)
shadow = cv2.GaussianBlur(shadow, (0, 0), 3) * 0.10
floor = (floor.astype(np.float32) * (1 - shadow[..., None])).astype(np.uint8)

# 3) кладём чистые коврики по новым прямым линиям
out = floor.copy()
for tex, q in ((tex_back, new_back), (tex_front, new_front)):
    h, w = tex.shape[:2]
    M = cv2.getPerspectiveTransform(np.float32([[0, 0], [w, 0], [w, h], [0, h]]), q)
    warped = cv2.warpPerspective(tex, M, (W, H), flags=cv2.INTER_CUBIC)
    m = np.zeros((H, W), np.float32)
    cv2.fillConvexPoly(m, q.astype(np.int32), 1.0)
    # ворсистый край: мягкая граница с лёгким шумом, а не ровная линия
    rng = np.random.default_rng(7)
    m = cv2.GaussianBlur(m, (0, 0), 1.4)
    edge = (m > 0.02) & (m < 0.98)
    m[edge] = np.clip(m[edge] * (0.75 + 0.5 * rng.random(int(edge.sum()))), 0, 1)
    m = m[..., None]
    out = (warped * m + out * (1 - m)).astype(np.uint8)

cv2.imwrite(os.path.join(ROOT, 'docs', 'photos', 'lockers-v2.jpg'), out, [cv2.IMWRITE_JPEG_QUALITY, 93])
rgb = cv2.cvtColor(out, cv2.COLOR_BGR2RGB)
from PIL import Image
im = Image.fromarray(rgb)
im.save(os.path.join(ROOT, 'public', 'img', 'lockers-v2.webp'), 'WEBP', quality=80, method=6)
im.resize((640, round(H * 640 / W)), Image.LANCZOS).save(os.path.join(ROOT, 'public', 'img', 'lockers-v2-640.webp'), 'WEBP', quality=78, method=6)
print('ok', im.size)
