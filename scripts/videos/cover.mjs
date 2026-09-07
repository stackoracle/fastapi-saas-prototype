// One-off script: capture a clean screenshot of the Ask Agent page with a
// real, populated answer for use as the portfolio cover image. Not part of
// the demo-video recorder - no overlay, no real OS input, just a plain
// headless screenshot.

import { chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "../..");
const BASE_URL = "http://127.0.0.1:8000";
const ACCOUNT = { email: "demo@agentic-rag.io", password: "DemoPass123!" };
const OUT = path.join(REPO_ROOT, "demo", "cover.png");

async function main() {
  const loginRes = await fetch(`${BASE_URL}/auth/jwt/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: ACCOUNT.email, password: ACCOUNT.password }).toString(),
  });
  const { access_token } = await loginRes.json();

  // A fresh document keeps the cover shot's citations/doc_id consistent
  // with what a viewer would actually see if they ran the same flow.
  const pdfBytes = await (await import("node:fs/promises")).readFile(
    path.join(REPO_ROOT, "output", "sample-privacy-policy-template.pdf")
  );
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "sample-privacy-policy-template.pdf");
  const ingestRes = await fetch(`${BASE_URL}/rag/ingest/pdf`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: form,
  });
  const { doc_id } = await ingestRes.json();

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/ask-ui?doc_id=${doc_id}`, { waitUntil: "networkidle" });
  await page.evaluate((t) => window.localStorage.setItem("agentic_rag_jwt", t), access_token);
  await page.reload({ waitUntil: "networkidle" });

  await page.locator("#question").fill(
    "How does the policy define Personal Data under GDPR, and what legal bases does it list for processing it?"
  );
  await Promise.all([
    page.waitForResponse((res) => res.url().includes("/agent/ask") && res.request().method() === "POST"),
    page.locator("#askBtn").click(),
  ]);
  await page.waitForFunction(() => document.getElementById("meta").textContent.includes("status="));
  await page.waitForTimeout(400);

  await page.screenshot({ path: OUT });
  await browser.close();
  console.log(`Cover screenshot written to ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
