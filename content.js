// content.js — Slop Block

let currentMode = "BALANCED";

// Get the current filter mode from SW when content script loads
chrome.runtime.sendMessage({ type: "GET_MODE" }, (response) => {
  if (response?.success) currentMode = response.mode;
});

// Listen for mode changes pushed from SW (when user changes mode in popup)
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "MODE_CHANGED") {
    currentMode = message.mode;
  }
});

function findPosts() {
  const selectors = [
    "article",
    "[data-testid='tweet']",
    ".feed-shared-update-v2",
    "._a6-p",
    ".userContent",
  ];

  let posts = [];
  for (const selector of selectors) {
    const found = document.querySelectorAll(selector);
    if (found.length > 0) {
      posts = [...posts, ...found];
    }
  }

  console.log(`Found ${posts.length} posts on this page`);
  return posts;
}

function extractContent(postElement) {
  const text = postElement.innerText || postElement.textContent || "";

  const imageElements = postElement.querySelectorAll("img");
  const imageUrls = [];
  for (const img of imageElements) {
    if (img.src && img.src.startsWith("http")) {
      imageUrls.push(img.src);
    }
  }

  return { text, imageUrls };
}

async function processPost(postElement) {
  // Skip if already processed or mode is off
  if (postElement.dataset.slopBlockProcessed) return;
  if (currentMode === "OFF") return;
  postElement.dataset.slopBlockProcessed = "true";

  const { text, imageUrls } = extractContent(postElement);

  // Check text — send to SW which forwards to detector.py
  if (text.length > 30) {
    const textResult = await chrome.runtime.sendMessage({
      type: "ANALYSE_TEXT",
      text,
      postId: crypto.randomUUID(),
    });

    if (textResult?.isSlop) {
      flagPost(postElement, textResult.score);
      return; // no need to check image if text is already slop
    }
  }

  // Check first image — send to SW which forwards to detector.py
  if (imageUrls.length > 0) {
    const imageResult = await chrome.runtime.sendMessage({
      type: "ANALYSE_IMAGE",
      imageUrl: imageUrls[0],
    });

    if (imageResult?.isSlop) {
      flagPost(postElement, imageResult.score);
    }
  }
}

function flagPost(postElement, score) {
  const percentage = Math.round(score * 100);
  console.log(`Slop detected! Score: ${percentage}%`);

  // Option A: Hide it completely
  // postElement.style.display = "none";

  // Option B: Blur it and show a warning banner (friendlier for demo!)
  postElement.style.filter = "blur(4px)";
  postElement.style.position = "relative";
  postElement.style.opacity = "0.5";

  const warning = document.createElement("div");
  warning.innerText = `⚠️ Possible AI Slop (${percentage}% confidence)`;
  warning.style.cssText = `
    position: absolute;
    top: 8px;
    left: 8px;
    background: #ff4444;
    color: white;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: bold;
    z-index: 9999;
    cursor: pointer;
  `;

  // Clicking the warning un-blurs the post
  warning.addEventListener("click", () => {
    postElement.style.filter = "none";
    postElement.style.opacity = "1";
    warning.remove();
  });

  postElement.appendChild(warning);
}

async function main() {
  console.log("Slop Block is running!");

  await new Promise(resolve => setTimeout(resolve, 2000));

  const posts = findPosts();
  for (const post of posts) {
    await processPost(post);
  }

  // MutationObserver — catches new posts as user scrolls
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.matches?.("article, [data-testid='tweet']")) {
          processPost(node);
        }
        node.querySelectorAll?.("article, [data-testid='tweet']").forEach(processPost);
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

window.addEventListener("load", main);
