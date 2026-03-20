/**
 * ============================================================
 *  SLOP BLOCK — Service Worker (Manifest V3)
 *  Bridges the Chrome Extension frontend ↔ Python FastAPI backend
 * ============================================================
 *
 *  Responsibilities:
 *  1. Manage extension lifecycle (install, activate)
 *  2. Maintain filter mode state across tabs
 *  3. Route messages from content scripts to the FastAPI backend
 *  4. Cache analysis results to avoid redundant API calls
 *  5. Handle network errors gracefully (offline fallback)
 * ============================================================
 */

// ─── Constants ───────────────────────────────────────────────────────────────

const SW_VERSION = "1.0.0";
const BACKEND_URL = "http://127.0.0.1:8000"; // FastAPI server (uvicorn)

/**
 * Five filtering modes as defined in the Slop Block spec.
 * Each mode controls what gets sent to the backend and how
 * aggressively content is filtered.
 */
const FILTER_MODES = {
  NO_AI: {
    id: "NO_AI",
    label: "🚫 No AI",
    description: "Block all detected AI-generated content",
    aggressiveness: 1.0,
  },
  QUALITY_ONLY: {
    id: "QUALITY_ONLY",
    label: "✨ Quality Only",
    description: "Only show high-confidence human content",
    aggressiveness: 0.8,
  },
  BALANCED: {
    id: "BALANCED",
    label: "⚖️ Balanced",
    description: "Moderate filtering with warnings on suspected AI",
    aggressiveness: 0.5,
  },
  LABEL_ONLY: {
    id: "LABEL_ONLY",
    label: "🏷️ Label Only",
    description: "Show all content but label AI-generated posts",
    aggressiveness: 0.2,
  },
  OFF: {
    id: "OFF",
    label: "⭕ Off",
    description: "Disable all filtering",
    aggressiveness: 0.0,
  },
};

// Default state on fresh install
const DEFAULT_STATE = {
  mode: "BALANCED",
  version: SW_VERSION,
  installedAt: null,
  stats: {
    totalScanned: 0,
    totalBlocked: 0,
    totalLabelled: 0,
  },
};

// In-memory analysis cache: imageUrl → { result, timestamp }
// Avoids hitting the backend for the same image twice per session
const analysisCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Lifecycle: Install ───────────────────────────────────────────────────────

self.addEventListener("install", (event) => {
  console.log(`[SlopBlock SW] Installing v${SW_VERSION}...`);

  event.waitUntil(
    (async () => {
      // Persist default state into chrome.storage.local on first install
      const existing = await chrome.storage.local.get("slopBlockState");
      if (!existing.slopBlockState) {
        await chrome.storage.local.set({
          slopBlockState: {
            ...DEFAULT_STATE,
            installedAt: new Date().toISOString(),
          },
        });
        console.log("[SlopBlock SW] ✅ Default state initialised.");
      }

      // Skip the waiting phase so the new SW activates immediately
      await self.skipWaiting();
    })()
  );
});

// ─── Lifecycle: Activate ──────────────────────────────────────────────────────

self.addEventListener("activate", (event) => {
  console.log(`[SlopBlock SW] Activating v${SW_VERSION}...`);

  event.waitUntil(
    (async () => {
      // Take control of all open tabs right away (no reload needed)
      await self.clients.claim();
      console.log("[SlopBlock SW] ✅ Controlling all clients.");
    })()
  );
});

// ─── Message Router ───────────────────────────────────────────────────────────
/**
 * All communication between content scripts / popup and the SW
 * goes through chrome.runtime.sendMessage → this handler.
 *
 * Message shapes:
 *   { type: "PING" }
 *   { type: "GET_MODE" }
 *   { type: "SET_MODE", mode: "NO_AI" }
 *   { type: "ANALYSE_IMAGE", imageUrl: "https://..." }
 *   { type: "ANALYSE_TEXT",  text: "...", postId: "..." }
 *   { type: "GET_STATS" }
 *   { type: "RESET_STATS" }
 *   { type: "CHECK_BACKEND" }
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // We must return true to keep the message channel open for async replies
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((err) => {
      console.error("[SlopBlock SW] Message handler error:", err);
      sendResponse({ success: false, error: err.message });
    });

  return true; // ← critical for async sendResponse
});

async function handleMessage(message, sender) {
  const { type } = message;

  switch (type) {
    // ── Health check ────────────────────────────────────────
    case "PING":
      return { success: true, pong: true, version: SW_VERSION };

    // ── Get current filter mode ──────────────────────────────
    case "GET_MODE": {
      const state = await getState();
      return {
        success: true,
        mode: state.mode,
        modeDetails: FILTER_MODES[state.mode],
      };
    }

    // ── Set filter mode ──────────────────────────────────────
    case "SET_MODE": {
      const { mode } = message;
      if (!FILTER_MODES[mode]) {
        return { success: false, error: `Unknown mode: ${mode}` };
      }
      await setState({ mode });
      // Notify all content scripts about the mode change
      await broadcastToTabs({ type: "MODE_CHANGED", mode });
      return { success: true, mode, modeDetails: FILTER_MODES[mode] };
    }

    // ── Analyse an image via backend ViT + C2PA ──────────────
    case "ANALYSE_IMAGE": {
      const { imageUrl } = message;
      if (!imageUrl) return { success: false, error: "No imageUrl provided" };

      const state = await getState();
      if (state.mode === "OFF") {
        return { success: true, skipped: true, reason: "Filter mode is OFF" };
      }

      const result = await analyseImage(imageUrl, state.mode);
      await updateStats(result);
      return { success: true, ...result };
    }

    // ── Analyse post text via backend NLP ────────────────────
    case "ANALYSE_TEXT": {
      const { text, postId } = message;
      if (!text) return { success: false, error: "No text provided" };

      const state = await getState();
      if (state.mode === "OFF") {
        return { success: true, skipped: true, reason: "Filter mode is OFF" };
      }

      const result = await analyseText(text, postId, state.mode);
      await updateStats(result);
      return { success: true, ...result };
    }

    // ── Stats ────────────────────────────────────────────────
    case "GET_STATS": {
      const state = await getState();
      return { success: true, stats: state.stats };
    }

    case "RESET_STATS": {
      await setState({
        stats: { totalScanned: 0, totalBlocked: 0, totalLabelled: 0 },
      });
      return { success: true };
    }

    // ── Backend health check ─────────────────────────────────
    case "CHECK_BACKEND": {
      const healthy = await checkBackendHealth();
      return { success: true, backendOnline: healthy };
    }

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ─── Backend Communication ────────────────────────────────────────────────────

/**
 * Sends an image URL to the FastAPI /analyse/image endpoint.
 * The Python backend will:
 *   1. Download the image
 *   2. Check C2PA metadata for provenance signatures
 *   3. Run ViT pixel analysis for AI-generation fingerprints
 *   4. Calculate Numpy entropy / noise patterns
 * Returns a verdict object.
 */
async function analyseImage(imageUrl, mode) {
  // Check in-memory cache first
  const cached = getCached(imageUrl);
  if (cached) {
    console.log("[SlopBlock SW] 📦 Cache hit for:", imageUrl);
    return { ...cached, fromCache: true };
  }

  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/analyse/image`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_url: imageUrl, mode }),
      },
      8000 // 8 second timeout
    );

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();
    // Cache the result
    setCached(imageUrl, result);
    return result;
  } catch (err) {
    console.warn("[SlopBlock SW] ⚠️ Image analysis failed:", err.message);
    return {
      verdict: "UNKNOWN",
      confidence: 0,
      error: err.message,
      fallback: true,
    };
  }
}

/**
 * Sends post text to the FastAPI /analyse/text endpoint.
 * The Python backend will run NLP-based AI-text detection.
 */
async function analyseText(text, postId, mode) {
  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/analyse/text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, post_id: postId, mode }),
      },
      5000 // 5 second timeout
    );

    if (!response.ok) {
      throw new Error(`Backend error: ${response.status}`);
    }

    return await response.json();
  } catch (err) {
    console.warn("[SlopBlock SW] ⚠️ Text analysis failed:", err.message);
    return {
      verdict: "UNKNOWN",
      confidence: 0,
      error: err.message,
      fallback: true,
    };
  }
}

/**
 * Pings the FastAPI /health endpoint.
 * Content scripts can call CHECK_BACKEND before attempting analysis.
 */
async function checkBackendHealth() {
  try {
    const response = await fetchWithTimeout(
      `${BACKEND_URL}/health`,
      { method: "GET" },
      3000
    );
    return response.ok;
  } catch {
    return false;
  }
}

// ─── Utility: Fetch with Timeout ──────────────────────────────────────────────

/**
 * Wraps fetch() with an AbortController timeout.
 * Prevents the SW from hanging indefinitely if the backend is slow.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ─── Utility: State Management ────────────────────────────────────────────────

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

  if (result.verdict === "AI_GENERATED" || result.verdict === "BLOCKED") {
    stats.totalBlocked += 1;
  } else if (result.verdict === "SUSPECTED" || result.verdict === "LABELLED") {
    stats.totalLabelled += 1;
  }

  await setState({ stats });
}

// ─── Utility: In-Memory Cache ─────────────────────────────────────────────────

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

// ─── Utility: Broadcast to Tabs ───────────────────────────────────────────────

/**
 * Sends a message to all active extension clients (content scripts).
 * Used to push mode changes without requiring a page reload.
 */
async function broadcastToTabs(message) {
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((client) => client.postMessage(message));

  // Also try chrome.tabs for content scripts
  try {
    const tabs = await chrome.tabs.query({ active: true });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, message).catch(() => {
        // Silently ignore tabs without content scripts
      });
    }
  } catch (err) {
    console.warn("[SlopBlock SW] broadcastToTabs minor error:", err.message);
  }
}

// ─── Utility: Deep Merge ──────────────────────────────────────────────────────

function deepMerge(target, source) {
  const output = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key])
    ) {
      output[key] = deepMerge(target[key] || {}, source[key]);
    } else {
      output[key] = source[key];
    }
  }
  return output;
}

// ─── Done ─────────────────────────────────────────────────────────────────────

console.log(`[SlopBlock SW] 🛡️ Service Worker v${SW_VERSION} loaded.`);
