// The caption bar drawn into the page, burned into the recording as real
// page content.
//
// There is deliberately no synthetic cursor here: the recording is a real
// screen capture (ffmpeg gdigrab with -draw_mouse 1), and the pointer on
// screen is the real Windows cursor driven by lib/os-input.mjs. Drawing a
// second, fake one would put two pointers in frame.
//
// Injected via addInitScript so the bar is recreated on every navigation,
// and so its text survives a page load rather than blanking mid-sentence.

const PAGE_SCRIPT = `
(() => {
  const CSS = \`
    #__demo_caption__ {
      position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
      background: rgba(15, 23, 32, 0.88); color: #f5f7fb;
      font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
      font-size: 21px; line-height: 1.45; padding: 20px 60px;
      box-sizing: border-box; border-top: 1px solid rgba(255,255,255,0.16);
      pointer-events: none; white-space: pre-wrap; text-align: center;
    }
    #__demo_caption__.title { font-size: 31px; font-weight: 600; padding: 46px 40px; }
    #__demo_caption__:empty { display: none; }
  \`;

  function build() {
    if (!document.documentElement) return;
    if (!document.getElementById("__demo_style__")) {
      const style = document.createElement("style");
      style.id = "__demo_style__";
      style.textContent = CSS;
      (document.head || document.documentElement).appendChild(style);
    }
    if (!document.getElementById("__demo_caption__")) {
      const caption = document.createElement("div");
      caption.id = "__demo_caption__";
      let stored = { text: "", title: false };
      try {
        stored = JSON.parse(sessionStorage.getItem("__demo_caption__") || "{}");
      } catch {}
      caption.textContent = stored.text || "";
      if (stored.title) caption.classList.add("title");
      document.documentElement.appendChild(caption);
    }
  }

  window.__demo_build__ = build;
  window.__demo_setCaption__ = (text, title) => {
    build();
    try {
      sessionStorage.setItem("__demo_caption__", JSON.stringify({ text, title }));
    } catch {}
    const el = document.getElementById("__demo_caption__");
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("title", Boolean(title));
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", build);
  } else {
    build();
  }
})();
`;

/** Register on a context so every page and navigation gets the caption bar. */
export async function installOverlay(context) {
  await context.addInitScript(PAGE_SCRIPT);
}

async function ensure(page) {
  const present = await page.evaluate(() => typeof window.__demo_build__ === "function").catch(() => false);
  if (!present) await page.evaluate(PAGE_SCRIPT).catch(() => {});
}

export async function setCaption(page, text, { title = false } = {}) {
  await ensure(page);
  await page.evaluate(([text, title]) => window.__demo_setCaption__(text, title), [text, title]).catch(() => {});
}
