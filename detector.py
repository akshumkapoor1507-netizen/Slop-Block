from transformers import pipeline
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
import requests
import io
import cv2
import numpy as np
from pydantic import BaseModel
from typing import Optional

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["POST", "GET"],
    allow_headers=["Content-Type"],
)

# models load once at startup — never inside a function
print("Loading models...")
detector = pipeline("image-classification", model="umm-maybe/AI-image-detector")
deepfake_detector = pipeline(
    "image-classification",
    model="dima806/deepfake_vs_real_image_detection"
)
face_cascade = cv2.CascadeClassifier(
    cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
)
print("Models loaded.")


class ImageRequest(BaseModel):
    image_url: str
    mode: Optional[str] = "BALANCED"

class TextRequest(BaseModel):
    text: str
    post_id: Optional[str] = None
    mode: Optional[str] = "BALANCED"


# mirrors FILTER_MODES in service-worker.js — higher = easier to trigger a block
AGGRESSIVENESS = {
    "NO_AI":        1.0,
    "QUALITY_ONLY": 0.8,
    "BALANCED":     0.5,
    "LABEL_ONLY":   0.2,
    "OFF":          0.0,
}


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/analyse/image")
async def analyse_image(request: ImageRequest):
    print(f"Analysing image: {request.image_url} | mode: {request.mode}")

    aggr = AGGRESSIVENESS.get(request.mode, 0.5)

    if aggr == 0.0:
        return {"verdict": "SKIPPED", "confidence": 0}

    try:
        response = requests.get(request.image_url, timeout=10)
        response.raise_for_status()
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=400, detail=f"Could not download image: {e}")

    try:
        image = Image.open(io.BytesIO(response.content)).convert("RGB")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not read image: {e}")

    ai_results = detector(image)
    ai_top = ai_results[0]
    ai_score = ai_top["score"] if ai_top["label"] == "artificial" else 0

    # high aggressiveness = lower threshold = easier to block
    threshold = 1.0 - (aggr * 0.3)

    if request.mode == "LABEL_ONLY":
        return {
            "verdict": "SUSPECTED" if ai_score > 0.5 else "CLEAN",
            "confidence": round(ai_score, 4),
            "reasons": ["Possibly AI generated"] if ai_score > 0.5 else [],
        }

    slop_score = 0
    reasons = []

    if ai_score > 0:
        slop_score += ai_score * 50

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

    # only run deepfake check if a face is present — saves processing time
    fake_score = 0
    img_gray_arr = np.array(image.convert("L"))
    faces = face_cascade.detectMultiScale(
        img_gray_arr, scaleFactor=1.1, minNeighbors=5, minSize=(30, 30)
    )
    if len(faces) > 0:
        fake_results = deepfake_detector(image)
        fake_score = next(
            (r["score"] for r in fake_results if r["label"] == "fake"), 0
        )

    verdict = "CLEAN"

    if ai_score > threshold:
        verdict = "AI_GENERATED"
        reasons.append(f"AI generated ({round(ai_score * 100)}% confidence)")
    elif slop_score >= 50 * aggr:
        verdict = "SUSPECTED"
        reasons.append(f"Low quality content (slop score: {round(slop_score)})")

    if fake_score > 0.80:
        verdict = "AI_GENERATED"
        reasons.append(f"Deepfake detected ({round(fake_score * 100)}% confidence)")

    return {
        "verdict": verdict,
        "confidence": round(max(ai_score, fake_score), 4),
        "reasons": reasons,
    }


@app.post("/analyse/text")
async def analyse_text(request: TextRequest):
    print(f"Analysing text | mode: {request.mode}")

    aggr = AGGRESSIVENESS.get(request.mode, 0.5)

    if aggr == 0.0:
        return {"verdict": "SKIPPED", "confidence": 0}

    spam_phrases = [
        # english engagement bait
        "type amen", "share if you agree", "99% won't",
        "comment yes", "watch till the end", "tag someone",
        "like if you", "repost this", "only real ones",
        "follow for follow", "dm me", "drop a",

        # hinglish / hindi engagement bait
        "jai shree ram", "jai mata di", "comment karo",
        "share karo", "like karo", "tag karo",
        "sabse pehle", "sirf sachche log", "follow back guaranteed",
        "free mein", "ghar baithe", "lakh rupaye",

        # whatsapp forward culture
        "forward karo", "10 logon ko bhejo", "nahi bheja toh",
        "ye message", "chain mat todo", "good morning",

        # religion / emotional bait common in india
        "bhagwan", "allah ka banda", "waheguru",
        "99% log nahi", "sirf 1%", "ek baar zaroor",

        # get rich / giveaway bait
        "iphone jeetne ka", "free recharge", "paytm karo",
        "giveaway", "winner", "selected you",

        # cricket / bollywood bait
        "virat kohli", "rohit sharma", "shah rukh khan",
        "salman khan", "comment your team", "india vs",
    ]

    text_lower = request.text.lower()
    matches = [p for p in spam_phrases if p in text_lower]

    # BALANCED needs 2+ matches, NO_AI needs only 1
    required_matches = max(1, round(3 - (aggr * 2)))

    if len(matches) >= required_matches:
        return {
            "verdict": "SUSPECTED",
            "confidence": round(min(len(matches) / 3, 1.0), 4),
            "reasons": [f"Spam language detected: {', '.join(matches)}"],
            "isSlop": True,
            "score": min(len(matches) / 3, 1.0),
        }

    return {
        "verdict": "CLEAN",
        "confidence": 0,
        "reasons": [],
        "isSlop": False,
        "score": 0,
    }
