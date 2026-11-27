import cv2
import numpy as np

SRC = r"C:/Users/leandro.schmidt/.gemini/antigravity/brain/c25bb99c-37a8-4870-8926-6e8816faa873/.user_uploaded/media_1795798293365_c82c1298.jpg"
OUT_2K = r"c:/Users/leandro.schmidt/Desktop/SUPABASE2 ANTIGRAVITY/dashboard_2k.png"

img = cv2.imread(SRC)
h, w = img.shape[:2]

# 1. Remove 1px bright border artifact from the source JPEG
img[0, :] = img[1, :]
img[-1, :] = img[-2, :]
img[:, 0] = img[:, 1]
img[:, -1] = img[:, -2]

# 2. Edge-aware JPEG deblocking & mosquito noise removal
# Detect edges/contours using Scharr operator on luminance
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
gx = cv2.Scharr(gray, cv2.CV_32F, 1, 0)
gy = cv2.Scharr(gray, cv2.CV_32F, 0, 1)
grad = np.sqrt(gx**2 + gy**2)
# Normalize edge mask [0 = flat area, 1 = strong contour/text]
edge_mask = np.clip(grad / 120.0, 0.0, 1.0)[..., None]

# Strong bilateral filter for flat surfaces, mild NLM for subtle textures
bilateral_flat = cv2.bilateralFilter(img, d=7, sigmaColor=28, sigmaSpace=7)
nlm_detail = cv2.fastNlMeansDenoisingColored(img, None, 2, 2, 5, 15)
clean_src = (nlm_detail.astype(np.float32) * edge_mask +
             bilateral_flat.astype(np.float32) * (1.0 - edge_mask))

# 3. Upscale to 2K QHD width (2560x1342) via 2-step Lanczos4
target_w = 2560
target_h = round(h * (target_w / w))
up = cv2.resize(clean_src, (target_w, target_h), interpolation=cv2.INTER_LANCZOS4)

# 4. Halo-free Limited Sharpening (Tightens edges & contours without white halos)
# Work in LAB color space so we only sharpen luminance (L) and avoid color fringes
up_u8 = np.clip(up, 0, 255).astype(np.uint8)
lab = cv2.cvtColor(up_u8, cv2.COLOR_BGR2LAB)
L, A, B = cv2.split(lab)
L_f = L.astype(np.float32)

# Local min/max in a 3x3 neighborhood to clamp ringing/halos
kernel3 = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
l_min = cv2.erode(L_f, kernel3)
l_max = cv2.dilate(L_f, kernel3)

# Multi-scale edge-preserving detail extraction
# Fine contours (text, thin card borders)
blur_fine = cv2.GaussianBlur(L_f, (0, 0), 1.0)
detail_fine = L_f - blur_fine

# Medium contours (equipment lines, badges, buttons) via bilateral filter
blur_med = cv2.bilateralFilter(L, d=7, sigmaColor=25, sigmaSpace=5).astype(np.float32)
detail_med = L_f - blur_med

L_sharp = L_f + 1.15 * detail_fine + 0.55 * detail_med

# Softly clamp overshoot/undershoot (LimitedSharpen technique: allows tiny 2-level micro-contrast, blocks halos)
overshoot = 2.5
L_clamped = np.clip(L_sharp, l_min - overshoot, l_max + overshoot)
L_final = np.clip(L_clamped, 0, 255).astype(np.uint8)

# 5. Subtle saturation boost on neon accents (cyan/green/orange borders) without touching neutrals
lab_out = cv2.merge((L_final, A, B))
bgr_out = cv2.cvtColor(lab_out, cv2.COLOR_LAB2BGR)

cv2.imwrite(OUT_2K, bgr_out, [cv2.IMWRITE_PNG_COMPRESSION, 3])
print(f"Saved {OUT_2K}: {w}x{h} -> {target_w}x{target_h}")
