// Node wrapper around input-server.ps1: real Windows cursor movement,
// real mouse clicks, and real keystrokes.
//
// One long-lived PowerShell process, not one spawn per action: a click is
// ~20 cursor moves, and paying process-start cost per move would make the
// motion stutter badly on camera.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "input-server.ps1");

export class OsInput {
  constructor() {
    this.proc = null;
    this.queue = [];
    this.buffer = "";
  }

  async start() {
    this.proc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk) => this._onData(chunk));
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (chunk) => process.stderr.write(`[input-server] ${chunk}`));
    this.proc.on("exit", (code) => {
      const err = new Error(`input server exited with code ${code}`);
      while (this.queue.length) this.queue.shift().reject(err);
    });
    // Add-Type compiles the P/Invoke shim on first use; wait it out here
    // rather than having the first real click absorb the delay.
    await this.send("PING");
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === "") continue;
      const pending = this.queue.shift();
      if (!pending) continue;
      if (line.startsWith("ERR")) pending.reject(new Error(`input server: ${line}`));
      else pending.resolve(line);
    }
  }

  send(command) {
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(`${command}\n`);
    });
  }

  moveTo(x, y) {
    return this.send(`MOVE ${Math.round(x)} ${Math.round(y)}`);
  }

  /** Bring the browser window to the foreground.
   *
   * Every other method here sends *real* OS input, which Windows delivers to
   * whatever window is foreground rather than to the one the harness has a
   * Playwright handle on. If an editor or a terminal has focus when a beat
   * runs, the click lands there and the keystrokes are typed there. Call this
   * before anything that depends on real input reaching the page. */
  focus() {
    return this.send("FOCUS");
  }

  async click() {
    await this.send("DOWN");
    await new Promise((r) => setTimeout(r, 45 + Math.random() * 55));
    await this.send("UP");
  }

  type(text) {
    return this.send(`TYPE ${Buffer.from(text, "utf-8").toString("base64")}`);
  }

  /** Set the real Windows clipboard to `text` and send a real Ctrl+V.
   *
   * Used for anything that is impractical to key in character by character
   * on camera, such as an absolute file path in a native dialog's file-name
   * box - a person would paste that too, not type it out. */
  paste(text) {
    return this.send(`PASTE ${Buffer.from(text, "utf-8").toString("base64")}`);
  }

  key(name) {
    return this.send(`KEY ${name}`);
  }

  waitForDialog(timeoutMs = 15000) {
    return this.send(`WAITDLG ${timeoutMs}`);
  }

  waitForDialogGone(timeoutMs = 15000) {
    return this.send(`WAITNODLG ${timeoutMs}`);
  }

  async stop() {
    if (!this.proc) return;
    this.proc.stdin.end();
    await new Promise((resolve) => this.proc.on("exit", resolve));
    this.proc = null;
  }
}
