const puppeteer = require("puppeteer-core");
const path = require("path");

const DOWNLOADS_DIR = path.join(__dirname, "downloads");

function getArg(name, defaultVal) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : defaultVal;
}
const PROJECT_ID = getArg("project", null);

if (!PROJECT_ID) {
  console.error("Please provide a project ID with --project <UUID>");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run() {
  console.log(`\n🚀 Starting bulk download for project: ${PROJECT_ID}\n`);

  // Connect to Chrome
  const browserURL = "http://127.0.0.1:9222";
  let browser;
  try {
    browser = await puppeteer.connect({ browserURL, defaultViewport: null });
  } catch (err) {
    console.error("❌ Could not connect to Chrome. Is it running with --remote-debugging-port=9222?");
    process.exit(1);
  }

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("labs.google"));
  if (!page) page = pages[0];

  // Set download folder
  const client = await browser.target().createCDPSession();
  await client.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS_DIR,
    eventsEnabled: true
  });

  const targetUrl = `https://labs.google/fx/tools/flow/project/${PROJECT_ID}`;
  console.log(`Navigating to ${targetUrl}...`);
  await page.goto(targetUrl, { waitUntil: "networkidle2", timeout: 30000 });
  await sleep(5000);

  // Re-set download behavior after navigation
  const dlClient = await browser.target().createCDPSession();
  await dlClient.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: DOWNLOADS_DIR,
    eventsEnabled: true
  });

  // Find total number of images
  const totalImages = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]')).length;
  });

  if (totalImages === 0) {
    console.log("⚠️ No images found in this project.");
    process.exit(0);
  }

  console.log(`📸 Found ${totalImages} images in project. Starting download...\n`);

  for (let i = 0; i < totalImages; i++) {
    console.log(`[${i + 1}/${totalImages}] Downloading image...`);
    
    // Get fresh position (DOM might have shifted after navigation/scrolling)
    const imgPos = await page.evaluate((idx) => {
      const imgs = Array.from(document.querySelectorAll('img[src*="media.getMediaUrlRedirect"]'));
      if (idx >= imgs.length) return null;
      const target = imgs[idx];
      target.scrollIntoView({ behavior: 'instant', block: 'center' });
      const r = target.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, i);

    if (!imgPos) {
       console.log("  ⚠️ Image not found, skipping.");
       continue;
    }

    // Click to open detail view
    await page.mouse.click(imgPos.x, imgPos.y);
    await sleep(2500);

    // Find Download button
    const dlPos = await page.evaluate(() => {
      for (const b of document.querySelectorAll("button")) {
        if (b.textContent.toLowerCase().includes("download")) {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    });

    if (dlPos) {
      // Click download button to open menu
      await page.mouse.click(dlPos.x, dlPos.y);
      await sleep(1500);

      // Find and select 2K (or fallback to 1K)
      const optionPos = await page.evaluate(() => {
        for (const item of document.querySelectorAll("[role='menuitem']")) {
          const text = item.textContent.toLowerCase();
          if (text.includes("2k") || text.includes("upscaled") || text.includes("max")) {
            const r = item.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent };
          }
        }
        for (const item of document.querySelectorAll("[role='menuitem']")) {
          if (item.textContent.toLowerCase().includes("1k")) {
            const r = item.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, text: item.textContent };
          }
        }
        return null;
      });

      if (optionPos) {
        console.log(`  ✅ Selected ${optionPos.text}`);
        await page.mouse.click(optionPos.x, optionPos.y);
        await sleep(8000); // Wait for upscale and download
      } else {
        console.log("  ⚠️ Download options not found.");
      }
    } else {
      console.log("  ⚠️ Download button not found.");
    }

    // Escape detail view and return to main canvas
    if (page.url().includes("/edit/")) {
      const projectUrl = page.url().split("/edit/")[0];
      await page.goto(projectUrl, { waitUntil: "networkidle2" });
      await sleep(3000); // Give DOM time to rebuild images list
    }
  }

  console.log("\n🎉 All downloads finished!");
  process.exit(0);
}

run().catch(err => {
  console.error("Fatal Error:", err);
  process.exit(1);
});
