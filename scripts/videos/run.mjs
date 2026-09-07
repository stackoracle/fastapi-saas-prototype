// Records the single portfolio demo video for Agentic RAG against a local
// dev instance of the app (see ../../PORTFOLIO.md). One continuous take,
// one output file - not a milestone-style set of clips.
//
// Captures the real desktop (ffmpeg gdigrab) rather than Playwright's own
// video recorder so the fullscreen, chrome-less browser window - and the
// real Windows mouse pointer - are exactly what ends up in frame. Mouse and
// keyboard input is real OS input (lib/os-input.mjs), driven along eased,
// human-shaped paths (lib/human.mjs), not Playwright's synthetic input:
// page.mouse dispatches straight into the renderer, so on a screen capture
// the pointer would never actually move while the page reacts on its own.
//
//   node run.mjs                 dry run, no capture, useful while editing beats
//   node run.mjs --record        capture to ../../demo/video/agentic-rag-demo.mp4

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { installOverlay, setCaption } from "./lib/overlay.mjs";
import { OsInput } from "./lib/os-input.mjs";
import { useInput, calibrate, humanClick, humanType, keepAwake, pause, readingPause } from "./lib/human.mjs";
import { uploadThroughDialog } from "./lib/upload.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const BASE_URL = "http://127.0.0.1:8000";

const ACCOUNT = { email: "demo@agentic-rag.io", password: "DemoPass123!" };
const PDF_PATH = path.join(REPO_ROOT, "output", "sample-privacy-policy-template.pdf");
const DATASET_PATH = path.join(HERE, "fixtures", "demo-eval-subset.jsonl");
const OUTPUT_PATH = path.join(REPO_ROOT, "demo", "video", "agentic-rag-demo.mp4");

const SCREEN = { width: 1920, height: 1080 };
const RECORD = process.argv.includes("--record");

async function ensureAccount() {
  const res = await fetch(`${BASE_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ACCOUNT),
  });
  if (res.ok || res.status === 400) return; // 400 = already registered
  const body = await res.text().catch(() => "");
  throw new Error(`Could not prepare demo account: ${res.status} ${body}`);
}

/** Point each file dialog at its folder once, before recording starts.
 *
 * Windows opens a common file dialog in whatever directory it was last used
 * in, which on a fresh browser profile is the user's home folder - putting a
 * directory listing full of personal folder names (.ssh, .aws, work, ...) on
 * screen the moment either dialog opens. It has to actually complete an Open
 * in the target folder to be remembered; navigating there and cancelling
 * does not update the last-used directory. So this logs in over the API,
 * opens each dialog once for real, and clears the token again afterward so
 * the recorded take's own login beat is genuine. */
async function primeFileDialogs(page, input) {
  console.log("Priming file dialog folders...");
  const loginRes = await fetch(`${BASE_URL}/auth/jwt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ACCOUNT.email, password: ACCOUNT.password }).toString(),
  });
  if (!loginRes.ok) throw new Error(`Priming login failed: ${loginRes.status}`);
  const { access_token } = await loginRes.json();

  await page.goto(`${BASE_URL}/login-ui`, { waitUntil: "networkidle" });
  await page.evaluate((token) => window.localStorage.setItem("agentic_rag_jwt", token), access_token);

  await page.goto(`${BASE_URL}/documents-ui`, { waitUntil: "networkidle" });
  await uploadThroughDialog(page, input, page.locator("#pdfInput"), PDF_PATH, { afterMs: 200 });

  await page.goto(`${BASE_URL}/evaluations-create-ui`, { waitUntil: "networkidle" });
  await humanClick(page, page.locator("#uploadDatasetBtn"));
  await uploadThroughDialog(page, input, page.locator("#datasetFileInput"), DATASET_PATH, { afterMs: 200 });

  // Back to a logged-out state so the recorded take's own login beat is real.
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(`${BASE_URL}/login-ui`, { waitUntil: "networkidle" });
}

class ScreenRecorder {
  constructor(outputPath) {
    this.outputPath = outputPath;
    this.proc = null;
  }

  async start() {
    this.proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-f", "gdigrab",
        "-framerate", "25",
        "-draw_mouse", "1",
        "-i", "desktop",
        "-video_size", `${SCREEN.width}x${SCREEN.height}`,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-pix_fmt", "yuv420p",
        "-crf", "20",
        this.outputPath,
      ],
      { stdio: ["pipe", "ignore", "pipe"] }
    );
    this.stderr = "";
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    this.exited = new Promise((resolve) => this.proc.on("exit", resolve));
    await pause(1000);
  }

  async stop() {
    if (!this.proc) return;
    this.proc.stdin.write("q");
    const code = await this.exited;
    this.proc = null;
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}:\n${this.stderr.slice(-1500)}`);
    }
  }
}

async function beat(page, text, action, { holdMs = 1800, title = false } = {}) {
  await setCaption(page, text, { title });
  if (action) await action();
  await readingPause(holdMs);
}

async function main() {
  console.log("Preparing demo account...");
  await ensureAccount();

  if (RECORD) await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });

  const browser = await chromium.launch({
    headless: false,
    args: ["--start-maximized", "--disable-infobars", "--hide-crash-restore-bubble"],
  });
  browser.on("disconnected", () => console.error("  ! browser DISCONNECTED event fired"));
  const context = await browser.newContext({ viewport: null });
  await installOverlay(context);
  context.setDefaultTimeout(30000);
  const page = await context.newPage();
  page.on("crash", () => console.error("  ! page CRASH event fired"));
  page.on("close", () => console.error("  ! page CLOSE event fired"));
  page.on("console", (msg) => {
    if (msg.type() === "error") console.error(`  ! page console error: ${msg.text()}`);
  });
  page.on("pageerror", (err) => console.error(`  ! page pageerror: ${err.message}`));

  // Maximized, not true fullscreen: the capture is the whole desktop either
  // way (ffmpeg gdigrab -i desktop), and forcing CDP fullscreen was a likely
  // source of the Chromium disconnects seen recording this way - a maximized
  // window is a plainer, more stable state, and calibrate() below measures
  // whatever chrome/tab-strip offset it leaves rather than assuming zero.
  //
  // --start-maximized alone is a request, not a guarantee (some Windows
  // configurations start it merely large, not truly maximized), so this
  // asks the OS window manager directly and confirms the resulting state.
  const session = await context.newCDPSession(page);
  const { windowId } = await session.send("Browser.getWindowForTarget");
  await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "maximized" } });
  const { bounds } = await session.send("Browser.getWindowBounds", { windowId });
  if (bounds.windowState !== "maximized") {
    throw new Error(`Browser window did not reach the maximized state (got "${bounds.windowState}").`);
  }
  console.log("  browser window state: maximized");
  await page.waitForTimeout(1200);

  const input = new OsInput();
  await input.start();
  useInput(input);
  // Real input goes to the foreground window, so the browser has to own it
  // before anything is calibrated or clicked.
  await input.focus();
  await calibrate(page);
  await primeFileDialogs(page, input);
  await input.focus();

  const recorder = RECORD ? new ScreenRecorder(OUTPUT_PATH) : null;
  if (recorder) await recorder.start();

  try {
    await beat(
      page,
      "Agentic RAG — a bounded tool-calling agent over your own documents, with a retrieval evaluation harness built in.",
      async () => {
        await page.goto(`${BASE_URL}/login-ui`, { waitUntil: "networkidle" });
      },
      { holdMs: 2600, title: true }
    );

    await beat(page, "Every document is owned by a user, and every JWT-authenticated request is scoped to that ownership.", async () => {
      await humanType(page, page.locator("#email"), ACCOUNT.email);
      await humanType(page, page.locator("#password"), ACCOUNT.password);
    });

    await beat(page, "Logging in — JWT stored client-side, refreshed transparently by the shared auth client.", async () => {
      await humanClick(page, page.locator("#loginBtn"));
      await page.waitForURL(/\/ask-ui/, { timeout: 15000 });
    });

    await beat(page, "Documents — ingest text or PDF. Each upload is chunked, embedded, and indexed into Chroma under this user's doc_id.", async () => {
      await Promise.all([
        page.waitForURL(/\/documents-ui/, { timeout: 15000 }),
        humanClick(page, page.locator('a[href="/documents-ui"]')),
      ]);
      await page.waitForLoadState("networkidle");
    });

    let newDocId = null;
    await beat(
      page,
      "Uploading a 17-page privacy policy PDF — fixed-window chunking, page-aware citations, rapidfuzz de-duplication of repeated headers/footers.",
      async () => {
        await uploadThroughDialog(page, input, page.locator("#pdfInput"), PDF_PATH);
        const [response] = await Promise.all([
          page.waitForResponse((res) => res.url().includes("/rag/ingest/pdf") && res.request().method() === "POST"),
          humanClick(page, page.locator("#ingestPdfBtn")),
        ]);
        const payload = await response.json();
        newDocId = payload.doc_id;
        await page.waitForTimeout(400);
      },
      { holdMs: 2600 }
    );

    await beat(page, "Ask — the agent refines the question, checks the semantic cache, then runs a bounded tool-calling loop over the retriever.", async () => {
      // The documents table's own per-row "Ask" link already carries this
      // doc_id, so this follows the same path a person would click.
      await Promise.all([
        page.waitForURL(/\/ask-ui\?doc_id=/, { timeout: 15000 }),
        humanClick(page, page.locator(`a[href$="doc_id=${newDocId}"]`).first()),
      ]);
      await page.waitForLoadState("networkidle");
    });

    const question = "How does the policy define Personal Data under GDPR, and what legal bases does it list for processing it?";
    await beat(page, `"${question}"`, async () => {
      await humanType(page, page.locator("#question"), question);
    });

    await beat(
      page,
      "Every factual line in the answer must end in a citation tag, or the agent refuses instead of guessing.",
      async () => {
        await Promise.all([
          page.waitForResponse((res) => res.url().includes("/agent/ask") && res.request().method() === "POST"),
          humanClick(page, page.locator("#askBtn")),
        ]);
        await page.waitForFunction(() => document.getElementById("meta").textContent.includes("status="), null, { timeout: 30000 });
      },
      { holdMs: 3400 }
    );

    await beat(page, "Evaluation — score the whole pipeline against a labeled dataset.", async () => {
      await Promise.all([
        page.waitForURL(/\/evaluations-ui/, { timeout: 15000 }),
        humanClick(page, page.locator('a[href="/evaluations-ui"]')),
      ]);
      await page.waitForLoadState("networkidle");
    });

    await beat(
      page,
      "Hit@k, Recall@k, Precision@k, MRR, plus an LLM judge that scores whether the retrieved context was even sufficient to answer.",
      async () => {
        await Promise.all([
          page.waitForURL(/\/evaluations-create-ui/, { timeout: 15000 }),
          humanClick(page, page.locator('a[href="/evaluations-create-ui"]').first()),
        ]);
        await page.waitForLoadState("networkidle");
      }
    );

    await beat(page, "Uploading a small labeled JSONL dataset for a quick live run.", async () => {
      await humanClick(page, page.locator("#uploadDatasetBtn"));
      await uploadThroughDialog(page, input, page.locator("#datasetFileInput"), DATASET_PATH);
    });

    await beat(page, "Targeting the document we just ingested, k=12, LLM judge enabled.", async () => {
      await page.locator("#documentSelect").selectOption({ value: newDocId });
      await page.locator("#kInput").fill("12");
      await page.waitForTimeout(300);
    });

    await beat(
      page,
      "Starting the run — it processes in the background; this page polls it live every 5 seconds.",
      async () => {
        await Promise.all([
          page.waitForURL(/\/evaluations\/.+\/ui$/, { timeout: 15000 }),
          humanClick(page, page.locator("#startEvalBtn")),
        ]);
        await page.waitForTimeout(600);
      },
      { holdMs: 2400 }
    );

    await beat(
      page,
      "Live progress: processed / total cases, and the running metric averages update as each case finishes.",
      async () => {
        // A plain page.waitForFunction here would leave the real OS cursor
        // and keyboard silent for a minute or more while the run processes
        // in the background - long enough on some Windows configurations
        // for the display to idle-lock mid-recording. A tiny, imperceptible
        // cursor twitch every few seconds keeps the session alive without
        // touching anything on the page.
        const deadline = Date.now() + 120000;
        for (;;) {
          const status = await page
            .evaluate(() => (document.getElementById("runStatusBadge")?.textContent || "").trim())
            .catch(() => "");
          if (status === "completed") break;
          if (Date.now() > deadline) throw new Error("Timed out waiting for the evaluation run to complete.");
          await keepAwake();
          await pause(3000);
        }
      },
      { holdMs: 2200 }
    );

    await beat(
      page,
      "Completed — grouped Hit@k / Recall@k / MRR / context-relevance, a full per-case table, and one-click rerun of just the failed cases.",
      async () => {
        await page.mouse.wheel(0, 500);
        await pause(400);
      },
      { holdMs: 2600 }
    );

    // Re-focus after the long completion wait: a notification or the OS
    // reclaiming attention during an idle stretch would otherwise send the
    // next real click and keystrokes somewhere other than the browser.
    await input.focus();

    await beat(page, "Every case drills into its retrieved chunks, matched keywords/phrases, and the judge's own explanation.", async () => {
      const firstRow = page.locator("#casesBody button[data-case-id]").first();
      await humanClick(page, firstRow);
      await page.waitForSelector("#caseDrawer.is-open");
    }, { holdMs: 3200 });

    await beat(
      page,
      "Agentic RAG — a hand-rolled agent loop, document-scoped retrieval, semantic caching, and a retrieval evaluator with an LLM judge built on top of a plain FastAPI + Postgres/pgvector backend.",
      async () => {
        await humanClick(page, page.locator("#closeDrawerBtn"));
      },
      { holdMs: 3200, title: true }
    );
  } catch (err) {
    console.error("\nFAILED");
    console.error(`url: ${page.url()}`);
    const bodyText = await page.locator("body").innerText().catch(() => "(unreadable)");
    console.error(`body (first 500): ${bodyText.slice(0, 500).replace(/\s+/g, " ")}`);
    throw err;
  } finally {
    await setCaption(page, "");
    if (recorder) await recorder.stop();
    await browser.close();
    await input.stop();
  }

  console.log("\nDone.", RECORD ? `Video written to ${OUTPUT_PATH}` : "(dry run, nothing recorded)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
