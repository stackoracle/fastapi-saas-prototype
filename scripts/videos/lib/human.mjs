// Human-like interaction, driven through the real Windows cursor and
// keyboard (lib/os-input.mjs) rather than Playwright's virtual input.
//
// This is what makes the recording look like a person: Playwright's
// page.mouse dispatches events straight into the renderer, so on a screen
// capture the pointer never moves while the page reacts by itself. Here the
// actual OS cursor travels to the target on an eased path, presses, and
// releases, exactly as a hand would.
//
// Page coordinates (what boundingBox returns, already adjusted for scroll)
// are not screen coordinates: the browser's own chrome offsets the content
// area within the window. That offset is measured at runtime by calibrate()
// rather than derived from outerWidth/innerWidth arithmetic, which is a
// guess about border and tab-strip sizes that varies by Windows version and
// browser build. Calibration asks the page directly where it saw the
// pointer, so it is exact by construction.

let input = null;
let offsetX = 0;
let offsetY = 0;

// Vertical strip at the bottom of the viewport the caption bar occupies, plus
// margin. Nothing is clicked inside it.
const CAPTION_CLEARANCE = 160;

/** Called once by the orchestrator, before any interaction. */
export function useInput(osInput) {
  input = osInput;
}

/** Measure the content area's position on screen by moving the real cursor
 * to known screen points and asking the page where it saw them. */
export async function calibrate(page) {
  await page.evaluate(() => {
    if (window.__demo_mouseHooked__) return;
    window.__demo_mouseHooked__ = true;
    window.__demo_lastMouse__ = null;
    window.addEventListener(
      "mousemove",
      (event) => {
        window.__demo_lastMouse__ = { x: event.clientX, y: event.clientY };
      },
      true
    );
  });

  const samples = [];
  for (const [screenX, screenY] of [
    [600, 420],
    [1100, 640],
  ]) {
    await page.evaluate(() => {
      window.__demo_lastMouse__ = null;
    });
    // Two nudges: the first move can land before the listener is live, and a
    // move to the identical coordinate emits no second event.
    await input.moveTo(screenX - 3, screenY - 3);
    await pause(70);
    await input.moveTo(screenX, screenY);
    await pause(140);

    const seen = await page.evaluate(() => window.__demo_lastMouse__);
    if (!seen) throw new Error(`calibrate: page saw no pointer at screen ${screenX},${screenY}`);
    samples.push({ dx: screenX - seen.x, dy: screenY - seen.y });
  }

  const [a, b] = samples;
  if (Math.abs(a.dx - b.dx) > 2 || Math.abs(a.dy - b.dy) > 2) {
    throw new Error(
      `calibrate: offset is not constant (${JSON.stringify(a)} vs ${JSON.stringify(b)}). ` +
        "That means the page is scaled, so screen coordinates cannot be derived by translation alone."
    );
  }

  offsetX = Math.round((a.dx + b.dx) / 2);
  offsetY = Math.round((a.dy + b.dy) / 2);
  cursorX = 1100 - offsetX;
  cursorY = 640 - offsetY;
  console.log(`  calibrated: content area at screen offset ${offsetX},${offsetY}`);
  return { offsetX, offsetY };
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

export async function pause(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** A short "reading" pause, jittered so beats are not identically timed. */
export async function readingPause(baseMs = 1200) {
  await pause(rand(baseMs * 0.85, baseMs * 1.15));
}

// Where the cursor currently is, in PAGE coordinates. Tracked here because
// there is no cheap way to ask Windows mid-run and the path has to start
// somewhere.
let cursorX = 960;
let cursorY = 440;

/** Page coordinates to real screen coordinates. */
function toScreen(x, y) {
  return [x + offsetX, y + offsetY];
}

export function currentCursor() {
  return { x: cursorX, y: cursorY };
}

/** A sub-pixel real-cursor twitch, imperceptible on camera.
 *
 * During a long unattended wait (an evaluation run processing in the
 * background) nothing here sends any real input for a minute or more, which
 * on some Windows configurations is enough to let the display idle-lock or
 * sleep mid-recording. A screen capture cannot draw a locked or sleeping
 * desktop, so a silent multi-minute wait needs a reason for Windows to keep
 * treating the session as active. */
export async function keepAwake() {
  const [sx, sy] = toScreen(cursorX, cursorY);
  await input.moveTo(sx + 1, sy);
  await pause(60);
  await input.moveTo(sx, sy);
}

/** Cursor travel along an eased, slightly curved path.
 *
 * A straight constant-speed line is the giveaway of a script, so this uses
 * an ease-in-out profile (slow start, quick middle, settling arrival) and
 * bows the path sideways a little, the way a wrist movement arcs rather
 * than tracking a ruler. Step count scales with distance so a short hop and
 * a cross-screen sweep both take a plausible amount of time. */
export async function humanMoveTo(x, y) {
  const startX = cursorX;
  const startY = cursorY;
  const distance = Math.hypot(x - startX, y - startY);
  if (distance < 1) return;

  const steps = Math.max(12, Math.min(48, Math.round(distance / 22)));
  // Perpendicular bow, larger for longer travels, sign varying run to run.
  const bow = Math.min(46, distance * 0.11) * (Math.random() < 0.5 ? -1 : 1);
  const perpX = -(y - startY) / distance;
  const perpY = (x - startX) / distance;

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    // Ease in-out cubic.
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    // Sine arc: zero at both ends, maximum mid-travel.
    const arc = Math.sin(Math.PI * t) * bow;
    const jitter = i === steps ? 0 : rand(-1.2, 1.2);

    const cx = startX + (x - startX) * eased + perpX * arc + jitter;
    const cy = startY + (y - startY) * eased + perpY * arc + jitter;
    await input.moveTo(...toScreen(cx, cy));
    await pause(rand(7, 15));
  }

  // Settle: a person overshoots slightly and corrects, rather than landing
  // dead on the pixel first time.
  if (distance > 220 && Math.random() < 0.6) {
    await input.moveTo(...toScreen(x + rand(-4, 4), y + rand(-3, 3)));
    await pause(rand(30, 70));
    await input.moveTo(...toScreen(x, y));
  }

  cursorX = x;
  cursorY = y;
}

/** Move to an element and click it for real.
 *
 * The caption bar is fixed to the bottom of the viewport, so an element
 * scrolled to just above the fold can sit behind it. A real click lands on
 * whatever is topmost at those coordinates, so the caption would swallow it
 * silently; nudge the page until the target is clear of that strip. */
export async function humanClick(page, locator, options = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  await pause(rand(120, 260));

  const viewportHeight = await page.evaluate(() => window.innerHeight);
  let box = await locator.boundingBox();
  if (!box) throw new Error("humanClick: target has no bounding box (not visible?)");

  const captionTop = viewportHeight - CAPTION_CLEARANCE;
  if (box.y + box.height > captionTop) {
    await page.mouse.wheel(0, box.y + box.height - captionTop + 40);
    await pause(rand(260, 420));
    box = await locator.boundingBox();
    if (!box) throw new Error("humanClick: target vanished after scrolling clear of the caption");
  }

  // Aim somewhere plausible inside the control rather than its exact centre.
  const targetX = box.x + box.width / 2 + rand(-Math.min(7, box.width / 4), Math.min(7, box.width / 4));
  const targetY = box.y + box.height / 2 + rand(-Math.min(4, box.height / 4), Math.min(4, box.height / 4));

  await humanMoveTo(targetX, targetY);
  await pause(rand(90, 190));
  await input.click();
  await pause(options.afterMs ?? rand(180, 340));
}

/** Click into a field and type into it with the real keyboard.
 *
 * Verified afterwards: real keystrokes go wherever focus actually is, so if
 * the click missed, the text would land somewhere unintended and silently
 * corrupt the demo. On a mismatch this falls back to setting the value
 * through the page, which keeps a recording usable rather than wrong. */
export async function humanType(page, locator, text, options = {}) {
  await humanClick(page, locator);

  // Clear whatever is there, as a person would.
  await page.keyboard.press("ControlOrMeta+A").catch(() => {});
  await pause(rand(60, 130));
  await page.keyboard.press("Backspace").catch(() => {});
  await pause(rand(120, 220));

  await input.type(text);
  await pause(rand(150, 300));

  const actual = await locator.inputValue().catch(() => null);
  if (actual !== null && actual !== text) {
    console.warn(`  ! typed text landed as ${JSON.stringify(actual)}, expected ${JSON.stringify(text)}; correcting`);
    await locator.fill(text);
    await pause(200);
  }

  if (options.afterMs !== undefined) await pause(options.afterMs);
}

/** Smooth scroll, so the page does not jump between beats. */
export async function humanScroll(page, deltaY, steps = 14) {
  const chunk = deltaY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, chunk);
    await pause(rand(18, 38));
  }
  await pause(rand(200, 380));
}
