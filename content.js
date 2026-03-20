// content.js — Slop Block

function main() {
  console.log("Slop Block is running!");
  // all our code will go inside here
}

// This line runs main() only after the full page has loaded
window.addEventListener("load", main);

function findPosts() {
  // Each site wraps posts differently — we try all of them
  const selectors = [
    "article",                        // Twitter/X and many news sites
    "[data-testid='tweet']",          // Twitter specific
    ".feed-shared-update-v2",         // LinkedIn
    "._a6-p",                         // Instagram post caption
    ".userContent",                   // Facebook (older)
  ];

  let posts = [];

  for (const selector of selectors) {
    const found = document.querySelectorAll(selector);
    if (found.length > 0) {
      posts = [...posts, ...found]; // add all found elements to our list
    }
  }

  console.log(`Found ${posts.length} posts on this page`);
  return posts;
}

function extractContent(postElement) {
  // Get all the text inside this post
  const text = postElement.innerText || postElement.textContent || "";

  // Get all image URLs inside this post
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
  const { text, imageUrls } = extractContent(postElement);

  // Check text
  if (text.length > 30) {
    const textResult = await window.SlopDetector.analyzeContent({
      type: "text",
      data: text
    });

    if (textResult.isSlop) {
      flagPost(postElement, textResult.score);
      return; // no need to check image if text is already slop
    }
  }

  // Check first image (if any)
  if (imageUrls.length > 0) {
    const imageResult = await window.SlopDetector.analyzeContent({
      type: "image",
      data: imageUrls[0]
    });

    if (imageResult.isSlop) {
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

  // Add a warning label on top
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

  // Small delay to let the page's JavaScript fully render posts
  await new Promise(resolve => setTimeout(resolve, 2000));

  const posts = findPosts();

  for (const post of posts) {
    await processPost(post);
  }
}

window.addEventListener("load", main);
