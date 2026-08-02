#!/usr/bin/env node

/**
 * ═══════════════════════════════════════════════════════════════════
 *  Google Flow Image Automator
 * ═══════════════════════════════════════════════════════════════════
 *
 * Reads prompts from prompts.txt (one per line), generates images
 * on Google Flow, and downloads each as 2K upscaled.
 *
 * SETUP (one time):
 *   1. Close Chrome fully
 *   2. Relaunch with:
 *        /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *          --remote-debugging-port=9222 \
 *          --user-data-dir="$HOME/Projects/chromeHelper/.chrome-profile"
 *   3. Log into Google and open a Flow project at:
 *        https://labs.google/fx/tools/flow
 *
 * RUN:
 *   node run.js                    — process all prompts
 *   node run.js --start 5          — resume from prompt #5
 *   node run.js --timeout 300      — wait up to 300s per generation
 */

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const os = require("os");

// ── Paths ─────────────────────────────────────────────────────────
const ROOT = __dirname;
const PROMPTS_FILE = path.join(ROOT, "prompts.txt");
const DOWNLOADS_DIR = path.join(ROOT, "downloads");

// ── CLI Args ──────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const START_INDEX = parseInt(getArg("start", "1"));
const DELAY = parseInt(getArg("delay", "5"));
const GEN_TIMEOUT = parseInt(getArg("timeout", "180")) * 1000;
const PROJECT_ID = getArg("project", null);
const SKIP_DOWNLOAD = process.argv.includes("--skip-download") || process.argv.includes("--no-download");

// ── Helpers ───────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createNewProject(page, forceNew = false) {
  if (PROJECT_ID && !forceNew) {
    console.log(`    🏠 Navigating to project: ${PROJECT_ID}`);
    await page.goto(`https://labs.google/fx/tools/flow/project/${PROJECT_ID}`, { waitUntil: "networkidle2", timeout: 30000 });
    await sleep(3000);
    // Wait for the prompt textbox to appear
    const startGenTime = Date.now();
    for (let i = 0; i < 10; i++) {
      const box = await page.$('[contenteditable][role="textbox"]');
      if (Date.now() - startGenTime > GEN_TIMEOUT) {
        throw new Error("Generation timeout");
      }
      if (box) {
        console.log("    ✅ Editor ready!");
        const currentUrl = page.url();
        const uuidMatch = currentUrl.match(/project\/([a-zA-Z0-9-]+)/);
        if (uuidMatch) {
          console.log(`    🔗 New Project UUID: ${uuidMatch[1]}`);
          console.log(`       (Save this UUID to run the download script later!)`);
        }
        return;
      }
      await sleep(1000);
    }
    return;
  }

  // Navigate to Flow homepage
  console.log("    🏠 Going to Flow homepage...");
  await page.goto("https://labs.google/fx/tools/flow", { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(3000);

  // Click "+ New project" button
  console.log("    ➕ Creating new project...");
  const clicked = await page.evaluate(() => {
    for (const btn of document.querySelectorAll("button")) {
      if (btn.textContent.toLowerCase().includes("new project")) {
        btn.click();
        return true;
      }
    }
    return false;
  });

  if (!clicked) {
    console.log("    ⚠️  'New project' button not found, trying to continue...");
    return;
  }

  // Wait for URL to change to /project/ (new project loading)
  console.log("    ⏳ Waiting for project to load...");
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const url = page.url();
    if (url.includes("/project/")) {
      console.log("    ✅ Project loaded:", url.slice(-50));
      break;
    }
  }

  // Wait for the prompt textbox to appear
  for (let i = 0; i < 10; i++) {
    const box = await page.$('[contenteditable][role="textbox"]');
    if (box) {
      console.log("    ✅ Editor ready!");
      const currentUrl = page.url();
      const uuidMatch = currentUrl.match(/project\/([a-zA-Z0-9-]+)/);
      if (uuidMatch) {
        console.log(`    🔗 New Project UUID: ${uuidMatch[1]}`);
        console.log(`       (Save this UUID to run the download script later!)`);
      }
      return;
    }
    await sleep(1000);
  }
  console.log("    ⚠️  Editor textbox not found, will retry later.");
}

async function waitForInput(page, retries = 5) {
  for (let i = 0; i < retries; i++) {
    const box = await page.$('[contenteditable][role="textbox"]');
    if (box) return box;
    console.log(`    ⏳ Waiting for prompt input... (${i + 1}/${retries})`);
    await sleep(2000);
  }
  return null;
}

async function countGeneratedImages(page) {
  return page.evaluate(() =>
    document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]').length
  );
}

async function waitForGeneration(page, prevImgCount) {
  const start = Date.now();
  let stableCount = 0;

  while (Date.now() - start < GEN_TIMEOUT) {
    await sleep(2000);
    const elapsed = Math.round((Date.now() - start) / 1000);

    const status = await page.evaluate((prev) => {
      const imgs = document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]');
      const count = imgs.length;

      // Check for success text in agent panel
      const success = !!Array.from(document.querySelectorAll("p, span, div")).find(el => {
        const t = el.textContent || "";
        return t.includes("successfully generated") || t.includes("I have created") ||
          t.includes("Here is") || t.includes("here's the") || t.includes("I've generated") ||
          t.includes("Here are");
      });

      // Check for failure
      const failed = !!Array.from(document.querySelectorAll("span, div")).find(el => {
        const t = el.textContent?.trim();
        const r = el.getBoundingClientRect();
        return t === "Failed" && r.width > 0 && r.width < 200;
      });

      return { count, success, failed, newImgs: count > prev };
    }, prevImgCount);

    process.stdout.write(`\r    ⏳ ${elapsed}s — images: ${status.count} (was ${prevImgCount})    `);

    if (status.newImgs && status.success) {
      console.log(`\n    ✅ Generation complete!`);
      return true;
    }

    if (status.newImgs) {
      stableCount++;
      if (stableCount > 5) {
        console.log(`\n    ✅ New images detected.`);
        return true;
      }
    }
  }

  console.log(`\n    ⏰ Timeout.`);
  throw new Error("Generation timed out");
}

async function downloadImage(page) {
  console.log("    🔍 Opening detail view for download...");
  const imgPos = await page.evaluate(() => {
    const imgs = Array.from(document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]'));
    if (imgs.length === 0) return null;
    const target = imgs[imgs.length - 1];
    const r = target.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });

  if (!imgPos) {
    console.log("    ⚠️  No image found in grid.");
    return false;
  }

  // Click to open detail view
  await page.mouse.click(imgPos.x, imgPos.y);
  await sleep(2500);

  // Find Download button in detail view
  const dlPos = await page.evaluate(() => {
    for (const b of document.querySelectorAll("button")) {
      if (b.textContent.toLowerCase().includes("download")) {
        const r = b.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });

  if (!dlPos) {
    console.log("    ⚠️  Could not find Download button in detail view!");
    return false;
  }

  console.log("    📥 Clicking Download menu...");
  await page.mouse.click(dlPos.x, dlPos.y);
  await sleep(1500);

  // Find 2K option
  const optionPos = await page.evaluate(() => {
    for (const item of document.querySelectorAll("[role='menuitem']")) {
      const text = item.textContent.toLowerCase();
      if (text.includes("2k") || text.includes("upscaled") || text.includes("max")) {
        const r = item.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent };
      }
    }
    // Fallback to 1K if 2K not found
    for (const item of document.querySelectorAll("[role='menuitem']")) {
      if (item.textContent.toLowerCase().includes("1k")) {
        const r = item.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent };
      }
    }
    return null;
  });

  if (optionPos) {
    console.log(`    ✅ Selecting option: ${optionPos.text}`);
    await page.mouse.click(optionPos.x, optionPos.y);
    await sleep(8000); // Wait for upscale and download
    return true;
  }

  console.log("    ⚠️  Menu items not found!");
  return false;
}

// ── Auto-Launch Chrome ────────────────────────────────────────────
function getChromePath() {
  const platform = os.platform();
  if (platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  } else if (platform === "win32") {
    const paths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      (process.env.LOCALAPPDATA || "") + "\\Google\\Chrome\\Application\\chrome.exe"
    ];
    for (const p of paths) {
      if (fs.existsSync(p)) return p;
    }
    return "chrome.exe";
  } else {
    return "google-chrome"; // Linux fallback
  }
}

async function connectOrLaunchChrome() {
  try {
    return await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
  } catch {
    console.log("    🚀 Chrome not running. Launching automatically...");
    const chromePath = getChromePath();
    const profilePath = path.join(ROOT, ".chrome-profile");
    
    const child = spawn(chromePath, [
      "--remote-debugging-port=9222",
      `--user-data-dir=${profilePath}`,
      "--no-first-run",
      "--no-default-browser-check"
    ], {
      detached: true,
      stdio: "ignore"
    });
    
    child.unref(); // detach
    
    for (let i = 0; i < 10; i++) {
      await sleep(1000);
      try {
        return await puppeteer.connect({ browserURL: "http://127.0.0.1:9222", defaultViewport: null });
      } catch (e) {}
    }
    throw new Error("Failed to connect to Chrome after launching.");
  }
}

// ── Main ──────────────────────────────────────────────────────────
async function main() {
  // Validate prompts file
  if (!fs.existsSync(PROMPTS_FILE)) {
    console.error(`❌ Put your prompts in: ${PROMPTS_FILE} (one per line)`);
    process.exit(1);
  }

  const allPrompts = fs.readFileSync(PROMPTS_FILE, "utf8")
    .split("\n").map(l => l.trim()).filter(l => l.length > 0);

  if (allPrompts.length === 0) {
    console.error("❌ prompts.txt is empty.");
    process.exit(1);
  }

  fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

  console.log("╔══════════════════════════════════════════╗");
  console.log("║   Google Flow Image Automator            ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Prompts:    ${String(allPrompts.length).padEnd(28)}║`);
  console.log(`║  Starting:   #${String(START_INDEX).padEnd(26)}║`);
  if (PROJECT_ID) {
    console.log(`║  Project ID: ${String(PROJECT_ID).padEnd(26)}║`);
  }
  console.log(`║  Downloads:  ./downloads/                ║`);
  console.log("╚══════════════════════════════════════════╝\n");

  // Connect to Chrome or launch it
  const browser = await connectOrLaunchChrome();

  let pages = await browser.pages();
  let page = pages.find(p => p.url().includes("labs.google"));
  if (!page) {
    // Open a new tab to Flow
    page = await browser.newPage();
    await page.goto("https://labs.google/fx/tools/flow", { waitUntil: "networkidle2" });
    await sleep(3000);
  }

  // Set download folder
  const client = await browser.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS_DIR,
    eventsEnabled: true
  });

  console.log(`✅ Connected to Flow\n`);

  // Create a fresh project once at the start
  await createNewProject(page);

  // Re-set download behavior after navigation
  const dlClient = await browser.target().createCDPSession();
  await dlClient.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS_DIR,
    eventsEnabled: true
  });

  // Process prompts
  const prompts = allPrompts.slice(START_INDEX - 1);
  let successCount = 0;

  for (let i = 0; i < prompts.length; i++) {
    const num = START_INDEX + i;
    const prompt = prompts[i];

    console.log(`\n── [${num}/${allPrompts.length}] ${"─".repeat(56)}`);
    console.log(`   ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

    try {
      // If we're in the image detail view, go back to project
      if (page.url().includes("/edit/")) {
        console.log("    ⬅️ Exiting edit view...");
        const projectUrl = page.url().split("/edit/")[0];
        await page.goto(projectUrl, { waitUntil: "networkidle2" });
        await sleep(2000);
      }

      // Get input box (with retry)
      let inputBox = await waitForInput(page);
      if (!inputBox) {
        console.log("    ❌ Input not found. Reloading page...");
        await page.reload({ waitUntil: "networkidle2" });
        await sleep(5000);
        inputBox = await waitForInput(page);
        
        if (!inputBox) { 
          console.log("    ❌ Still no input. Creating a new project to recover...");
          await createNewProject(page, true);
          inputBox = await waitForInput(page);
          if (!inputBox) {
            console.log("    ❌ Recovery failed. Skipping.");
            continue; 
          }
        }
      }

      // Clear + type
      const box = await page.$('[contenteditable][role="textbox"]');
      await box.click();
      await sleep(300);
      await page.keyboard.down("Meta");
      await page.keyboard.press("a");
      await page.keyboard.up("Meta");
      await page.keyboard.press("Backspace");
      await sleep(200);
      await page.keyboard.type(prompt, { delay: 3 });
      await sleep(300);

      // Count images before
      const prevCount = await countGeneratedImages(page);

      // Submit
      console.log("    ⏎ Submitting...");
      await page.keyboard.press("Enter");

      // Wait for generation
      await waitForGeneration(page, prevCount);

      console.log(`    ✅ Generation complete!`);
      
      if (SKIP_DOWNLOAD) {
        console.log("    ⏭️  Skipping download (--skip-download)");
      } else {
        // Wait a few seconds for Google Flow to finalize the image rendering
        console.log("    ⏳ Waiting 8s for image rendering before downloading...");
        await sleep(8000);
        const downloaded = await downloadImage(page);
        if (downloaded) successCount++;
      }

      console.log(`    ⏸️  Waiting ${DELAY}s...`);
      await sleep(DELAY * 1000);

    } catch (err) {
      console.error(`    ❌ Error: ${err.message}`);
      console.log("    🔄 Recovering by creating a new project...");
      await createNewProject(page, true);
      await sleep(3000);
      i--; // Decrement i to retry this exact prompt!
    }
  }

  console.log(`\n\n${"═".repeat(50)}`);
  console.log(`🎉 Done! ${successCount}/${prompts.length} images downloaded.`);
  console.log(`📁 Check: ${DOWNLOADS_DIR}`);
  console.log(`${"═".repeat(50)}`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
