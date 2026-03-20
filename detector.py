from transformers import pipeline
from fastapi import FastAPI, HTTPException
from PIL import Image
import requests
import io
import cv2
import numpy as np
from pydantic import BaseModel
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["POST"],
    allow_headers=["Content-Type"],
)

print("Loading models...")
detector = pipeline("image-classification", model="umm-maybe/AI-image-detector")
deepfake_detector = pipeline(
    "image-classification", model="dima806/deepfake_vs_real_image_detection"
)
face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
print("Models loaded.")


class ImageRequest(BaseModel):
    url: str
    no_ai: bool = True
    quality: bool = False
    no_spam: bool = False
    no_fakes: bool = False


@app.post("/scan")
async def scan_image(request: ImageRequest):
    print(f"Downloading image from: {request.url}")

    # download
    try:
        response = requests.get(request.url, timeout=10)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Could not download image: {e}")

    # convert to PIL
    try:
        image = Image.open(io.BytesIO(response.content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read image: {e}")

    block = False
    reasons = []

    # NO AI
    if request.no_ai:
        results = detector(image)
        top = results[0]
        if top["label"] == "artificial" and top["score"] > 0.85:
            block = True
            reasons.append(f"AI generated ({round(top['score'] * 100)}% confidence)")

    # NO SPAM
    if request.no_spam:
        spam_signals = 0

        ai_results = detector(image)
        ai_top = ai_results[0]
        if ai_top["label"] == "artificial" and ai_top["score"] > 0.75:
            spam_signals += 1

        img_array = np.array(image.convert("L"))
        sharpness = cv2.Laplacian(img_array, cv2.CV_64F).var()
        if sharpness < 100:
            spam_signals += 1

        img_hsv = np.array(image.convert("RGB"))
        img_hsv = cv2.cvtColor(img_hsv, cv2.COLOR_RGB2HSV)
        avg_saturation = img_hsv[:, :, 1].mean()
        if avg_saturation > 180:
            spam_signals += 1

        if spam_signals >= 2:
            block = True
            reasons.append(f"Spam: {spam_signals}/3 spam signals detected")

    # QUALITY
    if request.quality:
        slop_score = 0

        quality_ai = detector(image)
        quality_top = quality_ai[0]
        if quality_top["label"] == "artificial":
            slop_score += quality_top["score"] * 50

        width, height = image.size
        total_pixels = width * height
        if total_pixels < 90000:
            slop_score += 20
        elif total_pixels < 250000:
            slop_score += 10

        img_gray = np.array(image.convert("L"))
        sharpness = cv2.Laplacian(img_gray, cv2.CV_64F).var()
        if sharpness < 50:
            slop_score += 25
        elif sharpness < 150:
            slop_score += 10

        img_array = np.array(image.convert("L")).astype(float)
        noise = np.std(
            img_array - cv2.GaussianBlur(img_array.astype(np.uint8), (5, 5), 0)
        )
        if noise > 8:
            slop_score += 15

        if slop_score >= 50:
            block = True
            reasons.append(f"Low quality content (slop score: {round(slop_score)})")

    # NO FAKES
    if request.no_fakes:
        img_gray = np.array(image.convert("L"))
        faces = face_cascade.detectMultiScale(
            img_gray, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
        )

        if len(faces) > 0:
            print(f"Found {len(faces)} face(s), running deepfake check...")
            fake_results = deepfake_detector(image)
            fake_score = next(
                (r["score"] for r in fake_results if r["label"] == "fake"), 0
            )
            if fake_score > 0.80:
                block = True
                reasons.append(
                    f"Deepfake detected ({round(fake_score * 100)}% confidence)"
                )
        else:
            print("No faces found, skipping deepfake check")

    return {
        "block": block,
        "reasons": reasons,
    }
