# Long-running OS-level input server for the recording harness.
#
# Playwright's page.mouse/page.keyboard dispatch synthetic events straight
# into the renderer: the real Windows cursor never moves, so a screen
# recording shows a frozen pointer while the page reacts on its own. And the
# native file-open dialog is a separate OS window that Playwright cannot
# touch at all. Both need real input, which is what this provides.
#
# Reads one command per line on stdin, prints OK (or ERR <message>) per
# command so the caller can await each one in order.
#
#   MOVE <x> <y>      move the real cursor to screen coordinates
#   DOWN | UP         left mouse button
#   TYPE <base64>     type UTF-8 text (base64 to survive the line protocol)
#   PASTE <base64>    set the clipboard to UTF-8 text, then send Ctrl+V
#   KEY <ENTER|ESC|TAB>
#   WAITDLG <ms>      wait until a native dialog window exists
#   WAITNODLG <ms>    wait until no native dialog window exists
#   PING

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;

public class OsInput {
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

    // Whether a modal window has taken the foreground away from the browser.
    //
    // This used to look for class #32770, the classic Win32 dialog class. The
    // file picker on this machine no longer reports it (Windows 11 serves a
    // newer common dialog), so the wait timed out while the dialog sat open on
    // screen. Matching on the *title* is no better: it is localized.
    //
    // What is true regardless of Windows version or language is that clicking
    // "Choose file" moves the foreground off the browser, and dismissing the
    // picker gives it back. The harness drives one browser on a machine given
    // over to the recording, so "foreground is no longer the browser" is a
    // sound reading of "the picker is up".
    public static bool DialogPresent() {
        IntPtr fg = GetForegroundWindow();
        if (fg == IntPtr.Zero || !IsWindowVisible(fg)) return false;
        var cls = new System.Text.StringBuilder(256);
        GetClassName(fg, cls, 256);
        return cls.ToString() != BROWSER_CLASS;
    }

    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();

    // The policy AttachThreadInput is working around in the first place:
    // Windows normally refuses a foreground switch from a process the user
    // did not just interact with, timed by this setting (SPI_SETFOREGROUND-
    // LOCKTIMEOUT = 0x2001). Zeroing it for this session removes the refusal
    // at the source rather than only retrying around it. Per-session (HKCU,
    // no SPIF_UPDATEINIFILE), so it does not touch the machine's or the
    // user's permanent setting.
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SystemParametersInfo(uint uiAction, uint uiParam, uint pvParam, uint fWinIni);

    // Chromium's top-level window class. Matching on the class rather than the
    // title avoids depending on the page's <title>, which changes every beat.
    const string BROWSER_CLASS = "Chrome_WidgetWin_1";
    const int SW_RESTORE = 9;

    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr ProcessId);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    // Explorer's own way of activating a window (Alt-Tab uses it). Not in the
    // documented set, but stable since XP and it succeeds in the one case
    // SetForegroundWindow will not: a handoff from a process the user has not
    // just clicked on, which is every process in an unattended recording.
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

    // Windows only lets the *current* foreground process hand focus away, so a
    // bare SetForegroundWindow from a background script is ignored and the
    // ALT-press trick only helps a process already in the input queue.
    //
    // Attaching this thread's input state to the foreground window's thread is
    // the documented way across that boundary: for as long as they are
    // attached the two share a focus state, so the call is no longer coming
    // from "some background process". Detached again immediately, because
    // leaving them attached makes both windows respond to each other's input.
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder buf, int n);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder buf, int n);

    // Whether this window belongs to the Chromium *Playwright launched*, told
    // apart by the executable it was started from.
    //
    // The class name alone is not enough, and that cost a take: BROWSER_CLASS
    // is Chromium's, and Edge, Slack, Teams, Discord and VS Code are all
    // Chromium. On a machine with any of them open, EnumWindows hands back
    // whichever sits highest in the Z-order, the harness tries to focus
    // somebody's mail client, and the run dies reporting that Windows refused
    // the foreground, which points at the wrong problem entirely.
    static bool IsLaunchedBrowser(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        try {
            var path = System.Diagnostics.Process.GetProcessById((int)pid).MainModule.FileName;
            return path != null && path.IndexOf("ms-playwright", StringComparison.OrdinalIgnoreCase) >= 0;
        } catch {
            // A process we may not open (elevated, or gone since EnumWindows
            // listed it) is not ours by definition.
            return false;
        }
    }

    // Chromium keeps several windows of this class alive, most of them hidden
    // helpers. FindWindow returns whichever the window manager lists first,
    // which is usually one of those, and focusing a hidden window silently
    // fails. Pick the visible one that has a title instead: that is the frame
    // the user (and the recording) actually sees.
    //
    // Two passes: the browser this harness launched, and only if there is no
    // such window, any Chromium frame at all. The fallback keeps a developer
    // driving their own already-open browser working, which is how the earlier
    // milestones were recorded.
    public static IntPtr FindVisibleBrowser() {
        IntPtr ours = IntPtr.Zero;
        IntPtr any = IntPtr.Zero;
        EnumWindows(delegate(IntPtr h, IntPtr l) {
            if (!IsWindowVisible(h)) return true;
            if (GetWindowTextLength(h) == 0) return true;
            var cls = new System.Text.StringBuilder(256);
            GetClassName(h, cls, 256);
            if (cls.ToString() != BROWSER_CLASS) return true;
            if (any == IntPtr.Zero) any = h;
            if (IsLaunchedBrowser(h)) { ours = h; return false; }
            return true;
        }, IntPtr.Zero);
        return ours != IntPtr.Zero ? ours : any;
    }

    const ushort VK_MENU = 0x12;

    static void TapAlt() {
        var down = new INPUT { type = INPUT_KEYBOARD };
        down.u.ki.wVk = VK_MENU;
        var up = new INPUT { type = INPUT_KEYBOARD };
        up.u.ki.wVk = VK_MENU;
        up.u.ki.dwFlags = KEYEVENTF_KEYUP;
        Send(new INPUT[] { down, up });
        System.Threading.Thread.Sleep(40);
    }

    public static string TitleOf(IntPtr h) {
        var sb = new System.Text.StringBuilder(512);
        GetWindowText(h, sb, 512);
        return sb.ToString();
    }

    public static string ProcessOf(IntPtr h) {
        uint pid;
        GetWindowThreadProcessId(h, out pid);
        try {
            var p = System.Diagnostics.Process.GetProcessById((int)pid);
            return p.ProcessName + " " + p.MainModule.FileName;
        } catch { return "pid " + pid + " (unreadable)"; }
    }

    public static bool FocusBrowser() {
        IntPtr h = FindVisibleBrowser();
        if (h == IntPtr.Zero) return false;
        if (GetForegroundWindow() == h) return true;

        IntPtr fg = GetForegroundWindow();
        uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
        uint ourThread = GetCurrentThreadId();
        bool attached = fgThread != ourThread && AttachThreadInput(ourThread, fgThread, true);
        try {
            ShowWindow(h, SW_RESTORE);
            BringWindowToTop(h);
            SetForegroundWindow(h);
            // A real keystroke puts this thread in the input queue, which is
            // the condition SetForegroundWindow actually tests. ALT alone is
            // inert: pressed and released with no window expecting it, it
            // opens nothing and types nothing.
            if (GetForegroundWindow() != h) {
                TapAlt();
                SetForegroundWindow(h);
            }
            // And the one that works when the handoff is refused outright.
            if (GetForegroundWindow() != h) {
                SwitchToThisWindow(h, true);
            }
        } finally {
            if (attached) AttachThreadInput(ourThread, fgThread, false);
        }
        System.Threading.Thread.Sleep(150);
        return GetForegroundWindow() == h;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    public struct INPUT_UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT { public uint type; public INPUT_UNION u; }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint INPUT_MOUSE = 0;
    const uint INPUT_KEYBOARD = 1;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    static void Send(INPUT[] inputs) {
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void MouseDown() {
        INPUT[] i = new INPUT[1];
        i[0].type = INPUT_MOUSE;
        i[0].u.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        Send(i);
    }

    public static void MouseUp() {
        INPUT[] i = new INPUT[1];
        i[0].type = INPUT_MOUSE;
        i[0].u.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        Send(i);
    }

    // Unicode injection, so characters a file path needs (backslash, dot,
    // hyphen, underscore) never depend on the active keyboard layout the way
    // a virtual-key scancode would.
    public static void TypeChar(char c) {
        INPUT[] i = new INPUT[2];
        i[0].type = INPUT_KEYBOARD;
        i[0].u.ki.wVk = 0;
        i[0].u.ki.wScan = (ushort)c;
        i[0].u.ki.dwFlags = KEYEVENTF_UNICODE;
        i[1] = i[0];
        i[1].u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        Send(i);
    }

    public static void KeyVk(ushort vk) {
        INPUT[] i = new INPUT[2];
        i[0].type = INPUT_KEYBOARD;
        i[0].u.ki.wVk = vk;
        i[1] = i[0];
        i[1].u.ki.dwFlags = KEYEVENTF_KEYUP;
        Send(i);
    }

    const ushort VK_CONTROL = 0x11;
    const ushort VK_V = 0x56;

    // Ctrl+V as one held chord (Ctrl down, V down, V up, Ctrl up) rather than
    // two independent KeyVk calls, which would release Ctrl before V ever
    // goes down and paste nothing.
    public static void CtrlV() {
        INPUT[] i = new INPUT[4];
        i[0].type = INPUT_KEYBOARD; i[0].u.ki.wVk = VK_CONTROL;
        i[1].type = INPUT_KEYBOARD; i[1].u.ki.wVk = VK_V;
        i[2].type = INPUT_KEYBOARD; i[2].u.ki.wVk = VK_V; i[2].u.ki.dwFlags = KEYEVENTF_KEYUP;
        i[3].type = INPUT_KEYBOARD; i[3].u.ki.wVk = VK_CONTROL; i[3].u.ki.dwFlags = KEYEVENTF_KEYUP;
        Send(i);
    }
}
"@

# 0x2001 = SPI_SETFOREGROUNDLOCKTIMEOUT (not read from the class: it is a
# private const there, scoped to the P/Invoke signatures that use it).
[void][OsInput]::SystemParametersInfo(0x2001, 0, 0, 0)

$VK = @{ "ENTER" = 0x0D; "ESC" = 0x1B; "TAB" = 0x09 }

# How long to hold before the *next* keystroke after typing $ch.
#
# A flat Get-Random range (the previous approach) is technically randomized
# but every key gets the same hard-edged distribution, so on camera the
# rhythm still reads as machine-generated: no lull between words, no slowing
# for punctuation, no occasional stall. This models the three things that
# actually make typing look like a hand on a keyboard:
#   - a bell-curve base interval (Box-Muller) instead of a uniform one, since
#     real keystroke gaps cluster around a typical speed rather than spreading
#     evenly across the range;
#   - extra time at word and sentence boundaries, where a person is actually
#     composing the next chunk rather than moving a finger;
#   - a rare longer hesitation, the way attention drifts mid-sentence.
function Get-KeystrokeDelayMs([char]$ch) {
    $u1 = Get-Random -Minimum 0.0001 -Maximum 1.0
    $u2 = Get-Random -Minimum 0.0001 -Maximum 1.0
    $gauss = [Math]::Sqrt(-2.0 * [Math]::Log($u1)) * [Math]::Cos(2.0 * [Math]::PI * $u2)
    $delay = 65 + ($gauss * 22)

    if ($ch -eq ' ') {
        $delay += Get-Random -Minimum 30 -Maximum 90
    } elseif ($ch -match '[.,!?;:]') {
        $delay += Get-Random -Minimum 60 -Maximum 160
    }

    if ((Get-Random -Minimum 0.0 -Maximum 1.0) -lt 0.04) {
        $delay += Get-Random -Minimum 220 -Maximum 480
    }

    return [int]([Math]::Max(25, [Math]::Min($delay, 650)))
}

while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    $line = $line.Trim()
    if ($line -eq "") { continue }

    try {
        $parts = $line.Split(" ", 2)
        switch ($parts[0]) {
            "MOVE" {
                $xy = $parts[1].Split(" ")
                [void][OsInput]::SetCursorPos([int]$xy[0], [int]$xy[1])
            }
            "DOWN" { [OsInput]::MouseDown() }
            "UP"   { [OsInput]::MouseUp() }
            "TYPE" {
                $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
                foreach ($ch in $text.ToCharArray()) {
                    [OsInput]::TypeChar($ch)
                    Start-Sleep -Milliseconds (Get-KeystrokeDelayMs $ch)
                }
            }
            "PASTE" {
                # Set-Clipboard rather than [System.Windows.Forms.Clipboard]:
                # the latter requires an STA thread, which this console host
                # is not, and throws a threading exception on every call.
                $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[1]))
                Set-Clipboard -Value $text
                Start-Sleep -Milliseconds 120
                [OsInput]::CtrlV()
            }
            "KEY" {
                $name = $parts[1].Trim().ToUpper()
                if (-not $VK.ContainsKey($name)) { throw "Unknown key: $name" }
                # [uint16], not [ushort]: the C# alias is not a PowerShell
                # type accelerator, and the cast fails when the switch body
                # is compiled rather than where it is written.
                [OsInput]::KeyVk([uint16]$VK[$name])
            }
            "WAITDLG" {
                $deadline = (Get-Date).AddMilliseconds([int]$parts[1])
                while (-not [OsInput]::DialogPresent()) {
                    if ((Get-Date) -gt $deadline) { throw "Timed out waiting for the file dialog to open" }
                    Start-Sleep -Milliseconds 60
                }
            }
            "WAITNODLG" {
                $deadline = (Get-Date).AddMilliseconds([int]$parts[1])
                while ([OsInput]::DialogPresent()) {
                    if ((Get-Date) -gt $deadline) { throw "Timed out waiting for the file dialog to close" }
                    Start-Sleep -Milliseconds 60
                }
            }
            "FOCUS" {
                # Real input goes to whichever window Windows considers
                # foreground, not to the window the harness means. If anything
                # else owns the foreground when a beat clicks, the click lands
                # there instead: the file dialog never opens, and keystrokes
                # meant for it are typed into someone else's window.
                #
                # The AttachThreadInput handoff can lose a race against
                # whatever else just changed the foreground window (a window
                # manager animation settling, the process that launched this
                # one reclaiming it) and fail on the first try even though
                # nothing is actually wrong. A few quick retries clear that
                # without masking a real "no browser window" failure, which
                # does not get any more true by waiting.
                $focused = $false
                for ($attempt = 1; $attempt -le 5 -and -not $focused; $attempt++) {
                    $focused = [OsInput]::FocusBrowser()
                    if (-not $focused -and $attempt -lt 5) { Start-Sleep -Milliseconds 300 }
                }
                if (-not $focused) {
                    # Say which half failed. "Could not focus" on its own is the
                    # same message whether the window was never found or was
                    # found and Windows refused the handoff, and those have
                    # completely different fixes.
                    $h = [OsInput]::FindVisibleBrowser()
                    if ($h -eq [IntPtr]::Zero) {
                        throw "No visible browser window found (class Chrome_WidgetWin_1)"
                    }
                    # Name the window and the process, because "refused the
                    # foreground" is the same sentence whether it is a timing
                    # race or the harness aiming at the wrong Chromium window
                    # entirely, and the second is what actually happens on a
                    # machine with Edge or Slack open.
                    $title = [OsInput]::TitleOf($h)
                    $owner = [OsInput]::ProcessOf($h)
                    throw "Windows refused the foreground after 5 attempts. Target was '$title' ($owner)"
                }
                Start-Sleep -Milliseconds 250
            }
            "PING" { }
            default { throw "Unknown command: $($parts[0])" }
        }
        [Console]::Out.WriteLine("OK")
    }
    catch {
        [Console]::Out.WriteLine("ERR $($_.Exception.Message -replace '\r?\n', ' ')")
    }
    [Console]::Out.Flush()
}
