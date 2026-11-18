"""
Фото раздевалки: коврики ровно по линии коридора и посвежее.
Берём настоящие пиксели каждого коврика и перспективно «выпрямляем» их в ровный прямоугольник
по линиям коридора. Новые коврики чуть шире и полностью накрывают старые, поэтому пол и скамейки
не дорисовываются (раньше из-за этого были мыльные пятна). Пол дорисовывается только в тонких
щелях в пару пикселей и под розовой тапочкой у скамейки, точно по её контуру.
Запуск: python scripts/fix-rugs.py  → public/img/lockers-v2.webp, lockers-v2-640.webp
"""
import os
import cv2
import numpy as np
from PIL import Image

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
src = cv2.imread(os.path.join(ROOT, 'docs', 'photos', 'lockers.jpg'))
H, W = src.shape[:2]

# коврики на исходном фото (по сетке координат)
old_back = np.float32([[517, 653], [641, 656], [645, 757], [476, 754]])
old_front = np.float32([[486, 753], [651, 756], [654, 964], [398, 964]])

# точка схода коридора; края новых ковриков идут по линиям к ней
VP = np.array([631.0, 430.0])
def x_at(x_bottom, y):
    return x_bottom + (VP[0] - x_bottom) * (964 - y) / (964 - VP[1])
def quad(lx, rx, y0, y1):
    return np.float32([[x_at(lx, y0), y0], [x_at(rx, y0), y0], [x_at(rx, y1), y1], [x_at(lx, y1), y1]])
new_back = quad(366, 661, 651, 756)    # накрывает старый дальний коврик целиком
new_front = quad(398, 661, 755, 968)   # и ближний; коврики встык, как на исходном фото


def inset(q, d):
    """Четырёхугольник, сжатый к центру на d пикселей: в текстуру не попадают кромка и пол."""
    c0 = q.mean(axis=0)
    return np.float32([p + (c0 - p) / np.linalg.norm(c0 - p) * d for p in q])


def freshen(img, mask):
    """Мягко освежить ворс: высветлить тёмные пятна и пыль, не трогая сам рисунок ворса."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L, A, B = cv2.split(lab)
    local = cv2.GaussianBlur(L, (0, 0), 10)
    dark = np.minimum(L - local, 0)                    # только то, что темнее окружения
    L = L - dark * 0.45 + 6                            # пятна светлее, весь коврик чуть светлее
    A = A * 0.8 + float(np.median(A[mask > 0])) * 0.2 + 1.5   # розовый ровнее, без серых пятен
    B = B * 0.8 + float(np.median(B[mask > 0])) * 0.2
    out = cv2.merge([np.clip(L, 0, 255), np.clip(A, 0, 255), np.clip(B, 0, 255)]).astype(np.uint8)
    return cv2.cvtColor(out, cv2.COLOR_LAB2BGR)


out = src.copy()

# 1) розовая тапочка у скамейки: маска строго по цвету, дорисовка маленьким радиусом
box = (628, 645, 672, 690)
hsv = cv2.cvtColor(src, cv2.COLOR_BGR2HSV)
pink = cv2.inRange(hsv, (140, 60, 120), (179, 255, 255)) | cv2.inRange(hsv, (0, 60, 120), (8, 255, 255))
slipper = np.zeros((H, W), np.uint8)
slipper[box[1]:box[3], box[0]:box[2]] = pink[box[1]:box[3], box[0]:box[2]]
slipper = cv2.dilate(slipper, np.ones((3, 3), np.uint8), iterations=2)

# 2) щели, где старый коврик выглядывает из-под нового (пара пикселей)
old_mask = np.zeros((H, W), np.uint8)
new_mask = np.zeros((H, W), np.uint8)
for q in (old_back, old_front):
    cv2.fillConvexPoly(old_mask, q.astype(np.int32), 255)
for q in (new_back, new_front):
    cv2.fillConvexPoly(new_mask, q.astype(np.int32), 255)
slivers = cv2.bitwise_and(old_mask, cv2.bitwise_not(cv2.erode(new_mask, np.ones((3, 3), np.uint8))))
out = cv2.inpaint(out, cv2.bitwise_or(slivers, slipper), 3, cv2.INPAINT_TELEA)

# 3) лёгкая тень под ковриками
shadow = np.zeros((H, W), np.float32)
for q in (new_back, new_front):
    cv2.fillConvexPoly(shadow, (q + np.float32([2, 3])).astype(np.int32), 1.0)
shadow = cv2.GaussianBlur(shadow, (0, 0), 3) * 0.08
out = (out.astype(np.float32) * (1 - shadow[..., None])).astype(np.uint8)

# 4) настоящие коврики, выпрямленные по линиям коридора
rng = np.random.default_rng(7)
for old, new in ((old_back, new_back), (old_front, new_front)):
    M = cv2.getPerspectiveTransform(inset(old, 5), new)
    warped = cv2.warpPerspective(src, M, (W, H), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REFLECT)
    m = np.zeros((H, W), np.float32)
    cv2.fillConvexPoly(m, new.astype(np.int32), 1.0)
    warped = freshen(warped, (m > 0).astype(np.uint8))
    m = cv2.GaussianBlur(m, (0, 0), 1.1)
    edge = (m > 0.02) & (m < 0.98)
    m[edge] = np.clip(m[edge] * (0.8 + 0.4 * rng.random(int(edge.sum()))), 0, 1)   # ворсистый край
    m = m[..., None]
    out = (warped * m + out * (1 - m)).astype(np.uint8)

# 5) стык ковриков: ближний чуть наезжает на дальний — тонкая мягкая тень по краю
seam = np.zeros((H, W), np.float32)
y = 755
cv2.line(seam, (int(x_at(398, y)) + 2, y), (int(x_at(661, y)) - 2, y), 1.0, 3)
seam = cv2.GaussianBlur(seam, (0, 0), 1.6) * 0.28
out = (out.astype(np.float32) * (1 - seam[..., None])).astype(np.uint8)

cv2.imwrite(os.path.join(ROOT, 'docs', 'photos', 'lockers-v2.jpg'), out, [cv2.IMWRITE_JPEG_QUALITY, 93])
im = Image.fromarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB))
im.save(os.path.join(ROOT, 'public', 'img', 'lockers-v3.webp'), 'WEBP', quality=82, method=6)
im.resize((640, round(H * 640 / W)), Image.LANCZOS).save(os.path.join(ROOT, 'public', 'img', 'lockers-v3-640.webp'), 'WEBP', quality=80, method=6)
print('ok', im.size, 'щели:', int((slivers > 0).sum()), 'тапочка:', int((slipper > 0).sum()))
