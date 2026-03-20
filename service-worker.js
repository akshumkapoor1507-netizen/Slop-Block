const SW_VERSION = "1.0.0";
const BACKEND_URL = "http://127.0.0.1:8000"; // ← must match your uvicorn port

const FILTER_MODES = {
  NO_AI:        { id: "NO_AI",        label: "🚫 No AI",       aggressiveness: 1.0 },
  QUALITY_ONLY: { id: "QUALITY_ONLY", label: "✨ Quality Only", aggressiveness: 0.8 },
  BALANCED:     { id: "BALANCED",     label: "⚖️ Balanced",     aggressiveness: 0.5 },
  LABEL_ONLY:   { id: "LABEL_ONLY",   label: "🏷️ Label Only",  aggressiveness: 0.2 },
  OFF:          { id: "OFF",          label: "⭕ Off",           aggressiveness: 0.0 },
};

// Confidence threshold per mode — above this = isSlop: true
const SLOP_THRESHOLDS = {
  NO_AI:        0.3,
  QUALITY_ONLY: 0.4,
  BALANCED:     0.5,
  LABEL_ONLY:   0.6,
  OFF:          1.1, // never triggers
};

const DEFAULT_STATE = {
  mode: "BALANCED",
  version: SW_VERSION,
  installedAt: null,
  stats: { totalScanned: 0, totalBlocked: 0, totalLabelled: 0 },
};

// In-memory cache — avoids hitting the backend for the same image twice
const analysisCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Install ──────────────────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const existing = await chrome.storage.local.get("slopBlockState");
      if (!existing.slopBlockState) {
        await chrome.storage.local.set({
          slopBlockState: { ...DEFAULT_STATE, installedAt: new Date().toISOString() },
        });
      }
      await self.skipWaiting();
    })()
  );
});

// ─── Activate ─────────────────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim(); // take control of all open tabs immediately
    })()
  );
});

// ─── Message Router ───────────────────────────────────────────────────────────
// return true is required to keep the channel open for async replies

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => sendResponse({ success: false, error: err.message }));
  return true;
});

async function handleMessage(message) {
  const { type } = message;

  switch (type) {
    case "PING":
      return { success: true, pong: true, version: SW_VERSION };

    case "GET_MODE": {
      const state = await getState();
      return { success: true, mode: state.mode, modeDetails: FILTER_MODES[state.mode] };
    }

    case "SET_MODE": {
      const { mode } = message;
      if (!FILTER_MODES[mode]) return { success: false, error: `Unknown mode: ${mode}` };
      await setState({ mode });
      await broadcastToTabs({ type: "MODE_CHANGED", mode });
      return { success: true, mode, modeDetails: FILTER_MODES[mode] };
    }

    case "ANALYSE_IMAGE": {
      const { imageUrl } = message;
      if (!imageUrl) return { success: false, error: "No imageUrl provided" };
      const state = await getState();
      if (state.mode === "OFF") return { success: true, isSlop: false, score: 0, skipped: true };
      const result = await analyseImage(imageUrl, state.mode);
      await updateStats(result);
      return { success: true, ...result };
    }

    case "ANALYSE_TEXT": {
      const { text, postId } = message;
      if (!text) return { success: false, error: "No text provided" };
      const state = await getState();
      if (state.mode === "OFF") return { success: true, isSlop: false, score: 0, skipped: true };
      const result = await analyseText(text, postId, state.mode);
      await updateStats(result);
      return { success: true, ...result };
    }

    case "GET_STATS": {
      const state = await getState();
      return { success: true, stats: state.stats };
    }

    case "RESET_STATS": {
      await setState({ stats: { totalScanned: 0, totalBlocked: 0, totalLabelled: 0 } });
      return { success: true };
    }

    case "CHECK_BACKEND": {
      const healthy = await checkBackendHealth();
      return { success: true, backendOnline: healthy };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ─── Backend Calls ────────────────────────────────────────────────────────────

async function analyseImage(imageUrl, mode) {
  const cached = getCached(imageUrl);
  if (cached) return { ...cached, fromCache: true };

  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/analyse/image`, // ← must match your detector.py route
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl, mode }), // ← must match your Pydantic model
      },
      8000
    );
    if (!response.ok) throw new Error(`Backend error: ${response.status}`);

    const raw = await response.json();
    // Convert detector.py's { verdict, confidence } → { isSlop, score } for content.js
    const result = toSlopResult(raw, mode);
    setCached(imageUrl, result);
    return result;
  } catch (err) {
    return { isSlop: false, score: 0, error: err.message, fallback: true };
  }
}

async function analyseText(text, postId, mode) {
  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/analyse/text`, // ← must match your detector.py route
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, post_id: postId, mode }), // ← must match your Pydantic model
      },
      5000
    );
    if (!response.ok) throw new Error(`Backend error: ${response.status}`);

    const raw = await response.json();
    // Convert detector.py's { verdict, confidence } → { isSlop, score } for content.js
    return toSlopResult(raw, mode);
  } catch (err) {
    return { isSlop: false, score: 0, error: err.message, fallback: true };
  }
}

async function checkBackendHealth() {
  try {
    const response = await fetchWithTimeout(`${BACKEND_URL}/health`, { method: "GET" }, 3000);
    return response.ok;
  } catch {
    return false;
  }
}

// Converts { verdict, confidence } from detector.py into { isSlop, score }
// that content.js expects (textResult.isSlop / textResult.score)
function toSlopResult(raw, mode) {
  const score = raw.confidence ?? 0;
  const threshold = SLOP_THRESHOLDS[mode] ?? 0.5;
  const isSlop = raw.verdict === "AI_GENERATED" || raw.verdict === "SUSPECTED" || score >= threshold;
  return { isSlop, score, verdict: raw.verdict, signals: raw.signals };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Prevents the SW from hanging if the backend is slow or offline
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getState() {
  const data = await chrome.storage.local.get("slopBlockState");
  return data.slopBlockState || DEFAULT_STATE;
}

async function setState(partial) {
  const current = await getState();
  const updated = deepMerge(current, partial);
  await chrome.storage.local.set({ slopBlockState: updated });
  return updated;
}

async function updateStats(result) {
  const state = await getState();
  const stats = { ...state.stats };
  stats.totalScanned += 1;
  if (result.isSlop) stats.totalBlocked += 1;
  await setState({ stats });
}

function getCached(key) {
  const entry = analysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    analysisCache.delete(key);
    return null;
  }
  return entry.result;
}

function setCached(key, result) {
  analysisCache.set(key, { result, timestamp: Date.now() });
}

async function broadcastToTabs(message) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => client.postMessage(message));
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  } catch {}
}

function deepMerge(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === "object" && !Array.isArray(source[key])) {
      output[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}
