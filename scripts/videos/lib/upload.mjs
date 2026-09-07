// Choosing a file the way a person does it: click the file input, let the
// real Windows "Open" dialog appear, paste the path into the file-name box,
// press Enter.
//
// Deliberately NOT page.setInputFiles(), which sets the input's files
// directly and never opens a dialog: the picker is a step a viewer expects
// to see. Playwright only suppresses the native dialog when a
// 'filechooser' listener is attached, so as long as nothing registers one,
// clicking the input with real OS input opens the real dialog.
//
// The path is pasted (real clipboard + real Ctrl+V), not typed character by
// character: a person copies an absolute path into a file-name box rather
// than keying it in, and it removes any chance of a dropped or mistyped
// character in a path that has to resolve exactly.

import { humanClick, pause } from "./human.mjs";

export async function uploadThroughDialog(page, input, fileLocator, fullPath, { afterMs = 500 } = {}) {
  await humanClick(page, fileLocator);
  // The dialog is an OS window, so waiting on it means asking Windows, not
  // the page.
  await input.waitForDialog(15000);
  // A beat before pasting, so the dialog is visibly open on camera and has
  // settled focus into the File name box.
  await pause(900);
  await input.paste(fullPath);
  await pause(500);
  await input.key("ENTER");
  await input.waitForDialogGone(15000);
  await pause(afterMs);
}
