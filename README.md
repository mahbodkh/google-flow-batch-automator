# Google Flow Automator

A robust Puppeteer automation script to batch-generate and download images from Google Flow. Designed for both human users and autonomous AI agents.

## 🤖 For AI Agents & LLMs
If you are an AI agent orchestrating this tool, follow these specific operational rules:
1. **Pre-requisite:** You must ensure `prompts.txt` exists in the root directory before invoking the start command. Each line in `prompts.txt` represents one generation task.
2. **Workflow A (Speed Optimized):** Run `npm run start -- --skip-download`. Once the process exits successfully, extract the Project UUID from the stdout. Then run `npm run download -- --project <UUID>`.
3. **Workflow B (Sync Mode):** Run `npm run start` without `--skip-download`. Images will be downloaded synchronously into `./downloads/` after each generation.
4. **State Management:** The script automatically handles Google Flow timeouts and UI errors by creating a fresh project and retrying the exact prompt. Do not attempt to manually retry inside your own agent loop unless the node process crashes with a non-zero exit code.
5. **Output Directory:** All downloaded files are saved to `${__dirname}/downloads/`. Ensure you check this path for the final artifacts.

---

## 🛠 Installation

```bash
# 1. Clone or initialize the repository
git clone https://github.com/mahbodkh/google-flow-batch-automator.git
cd google-flow-batch-automator

# 2. Install dependencies (Puppeteer)
npm install

# 3. Setup your prompts
cp prompts.sample.txt prompts.txt
# Edit prompts.txt to contain one prompt per line
```

## 🚀 CLI Commands & Usage

### 1. Batch Generation
Iterates through `prompts.txt` and drives a Chrome instance to enter prompts and wait for image generation.

**Basic Run:**
```bash
npm run start
```

**Fast Mode (Skip downloading during generation):**
```bash
npm run start -- --skip-download
```

**Resume from a specific prompt in a specific project:**
```bash
npm run start -- --start 8 --project <PROJECT_UUID> --skip-download
```

### 2. Bulk Downloading
If you skipped downloading during generation, use this command to download all images from a specific project in 2K resolution.

```bash
npm run download -- --project <PROJECT_UUID>
```

## ⚙️ Arguments & Flags

The following flags can be passed to the `start` script (ensure you use `--` before passing flags via npm):

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--start` | `Integer` | `1` | Line index in `prompts.txt` to start generating from. |
| `--delay` | `Integer` | `5` | Sleep duration (in seconds) between generating prompts. |
| `--timeout` | `Integer` | `180` | Maximum wait time (in seconds) for a single image generation. |
| `--project` | `String` | `null` | A Google Flow project UUID. If provided, the script will append to this project. |
| `--skip-download` | `Boolean` | `false` | If present, skips the download phase during generation. |

## ⚠️ Known Behaviors & Edge Cases
- **Radix UI Interactions:** The script uses simulated mouse pointer events (`page.mouse.click`) because standard `.click()` events are intercepted and ignored by the underlying Radix UI components. Do not change these to standard DOM clicks.
- **Download Behavior:** Uses `Browser.setDownloadBehavior` to enforce `./downloads/` as the target directory, bypassing the OS default.
- **Recovery Mode:** If generation stalls, the script forcefully navigates to the base project URL or creates a new project to clear the tainted UI state.
