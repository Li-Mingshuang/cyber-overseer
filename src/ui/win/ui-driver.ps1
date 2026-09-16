<#
 赛博监工 · Windows 拟人驱动

 这是"模拟人类"通道的底层执行者：列窗口、看主人是否在休息、抢焦点、点输入框、
 打字/粘贴、按回车、读剪贴板、读 UIA 元素。所有命令都是**独立的一次进程调用**，
 输入输出都是 JSON（UTF-8），便于 Node 侧零依赖调用。

 用法：
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ui-driver.ps1 -Command idle
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ui-driver.ps1 -Command list-windows
   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ui-driver.ps1 -Command focus -Json '{"hwnd":123}'

 设计要点（都是踩过坑换来的）：
   - 全程输出 **单个 JSON 对象**，Node 侧只做 JSON.parse，不解析人类文字；
   - 强制 UTF-8 输出，否则中文在中文 Windows 上会变成乱码；
   - SendInput 走 KEYEVENTF_UNICODE，所以中文/emoji 不需要输入法；
   - `focus` 用 AttachThreadInput 绕过前台窗口锁（Windows 会拒绝后台进程抢焦点），
     并**回读**当前前台窗口确认抢到了——没抢到就绝不继续打字。
#>
param(
  [Parameter(Mandatory = $true)][string]$Command,
  [string]$Json = '{}'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$script:Payload = @{}
if ($Json -and $Json.Trim().Length -gt 0) {
  try { $script:Payload = $Json | ConvertFrom-Json } catch { $script:Payload = @{} }
}

function Out-Json($object) {
  $json = $object | ConvertTo-Json -Depth 8 -Compress
  if ($null -eq $json) { $json = 'null' }
  [Console]::Out.WriteLine($json)
}

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$cs = @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class CW {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int nMax);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int nMax);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  // 注意：GetWindowThreadProcessId 的返回值是**线程 id**，进程 id 在 out 参数里。
  // 用错会把线程号当进程号去查进程（拿到空 process 名），这里显式提供一个正确的取法。
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  public static uint PidOf(IntPtr hWnd) { uint p; GetWindowThreadProcessId(hWnd, out p); return p; }
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
  [DllImport("kernel32.dll")] public static extern uint GetTickCount();
  public static long IdleMs() {
    LASTINPUTINFO li = new LASTINPUTINFO();
    li.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref li)) return -1;
    return (long)((uint)GetTickCount() - li.dwTime);
  }

  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; public static int Size { get { return Marshal.SizeOf(typeof(INPUT)); } } }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL, wParamH; }

  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

  public static uint TypeUnicode(string text) {
    List<INPUT> list = new List<INPUT>();
    foreach (char c in text) {
      INPUT down = new INPUT(); down.type = 1; down.U.ki.wScan = (ushort)c; down.U.ki.dwFlags = 4;
      INPUT up = new INPUT(); up.type = 1; up.U.ki.wScan = (ushort)c; up.U.ki.dwFlags = 4 | 2;
      list.Add(down); list.Add(up);
    }
    if (list.Count == 0) return 0;
    return SendInput((uint)list.Count, list.ToArray(), INPUT.Size);
  }

  public static uint Combo(ushort vk, bool ctrl, bool shift, bool alt) {
    List<INPUT> list = new List<INPUT>();
    if (ctrl) list.Add(Vk(0x11, false));
    if (shift) list.Add(Vk(0x10, false));
    if (alt) list.Add(Vk(0x12, false));
    list.Add(Vk(vk, false));
    list.Add(Vk(vk, true));
    if (alt) list.Add(Vk(0x12, true));
    if (shift) list.Add(Vk(0x10, true));
    if (ctrl) list.Add(Vk(0x11, true));
    return SendInput((uint)list.Count, list.ToArray(), INPUT.Size);
  }

  static INPUT Vk(ushort vk, bool up) {
    INPUT i = new INPUT(); i.type = 1; i.U.ki.wVk = vk; i.U.ki.dwFlags = up ? 2u : 0u; return i;
  }

  public static uint ClickAt(int x, int y, bool doubleClick) {
    SetCursorPos(x, y);
    INPUT down = new INPUT(); down.type = 0; down.U.mi.dwFlags = 2;
    INPUT up = new INPUT(); up.type = 0; up.U.mi.dwFlags = 4;
    SendInput(1, new INPUT[] { down }, INPUT.Size);
    System.Threading.Thread.Sleep(40);
    SendInput(1, new INPUT[] { up }, INPUT.Size);
    if (doubleClick) {
      System.Threading.Thread.Sleep(60);
      SendInput(1, new INPUT[] { down }, INPUT.Size);
      System.Threading.Thread.Sleep(40);
      SendInput(1, new INPUT[] { up }, INPUT.Size);
    }
    return 2;
  }

  public static bool ForceForeground(IntPtr hWnd) {
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, IntPtr.Zero);
    uint myThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != myThread) attached = AttachThreadInput(myThread, fgThread, true);
    if (IsIconic(hWnd)) ShowWindow(hWnd, 9);
    BringWindowToTop(hWnd);
    SetForegroundWindow(hWnd);
    if (attached) AttachThreadInput(myThread, fgThread, false);
    // 回读确认：抢焦点可能被系统拒绝，必须验证
    return GetForegroundWindow() == hWnd;
  }

  public static string WindowTitle(IntPtr h) {
    StringBuilder sb = new StringBuilder(1024); GetWindowText(h, sb, sb.Capacity); return sb.ToString();
  }
  public static string WindowClass(IntPtr h) {
    StringBuilder sb = new StringBuilder(512); GetClassName(h, sb, sb.Capacity); return sb.ToString();
  }

  public static string[] Windows(bool visibleOnly, bool titlesOnly) {
    List<string> r = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (visibleOnly && !IsWindowVisible(h)) return true;
      string title = WindowTitle(h);
      if (titlesOnly && title.Length == 0) return true;
      uint pid = PidOf(h);
      RECT rc; GetWindowRect(h, out rc);
      r.Add(h.ToInt64() + "\u0001" + pid + "\u0001" + WindowClass(h) + "\u0001" + rc.Left + "," + rc.Top + "," + rc.Right + "," + rc.Bottom + "\u0001" + (IsIconic(h) ? "1" : "0") + "\u0001" + title);
      return true;
    }, IntPtr.Zero);
    return r.ToArray();
  }
}
'@
Add-Type -TypeDefinition $cs

function Get-ClipboardText {
  for ($i = 0; $i -lt 3; $i++) {
    try { return [System.Windows.Forms.Clipboard]::GetText() } catch { Start-Sleep -Milliseconds 120 }
  }
  try { return (Get-Clipboard -Raw) } catch { return '' }
}

function Set-ClipboardText([string]$text) {
  for ($i = 0; $i -lt 5; $i++) {
    try {
      [System.Windows.Forms.Clipboard]::SetText($text)
      return $true
    } catch {
      Start-Sleep -Milliseconds 120
    }
  }
  try { Set-Clipboard -Value $text; return $true } catch { return $false }
}

function Format-Window([IntPtr]$h) {
  $rc = [CW+RECT]::new()
  [void][CW]::GetWindowRect($h, [ref]$rc)
  $procId = [CW]::PidOf($h)
  $proc = ''
  try { $proc = (Get-Process -Id $procId -ErrorAction Stop).ProcessName } catch { }
  return [pscustomobject]@{
    hwnd    = $h.ToInt64()
    pid     = [int]$procId
    process = $proc
    class   = [CW]::WindowClass($h)
    title   = [CW]::WindowTitle($h)
    rect    = @($rc.Left, $rc.Top, $rc.Right, $rc.Bottom)
    width   = $rc.Right - $rc.Left
    height  = $rc.Bottom - $rc.Top
  }
}

Add-Type -AssemblyName System.Windows.Forms

switch ($Command.ToLowerInvariant()) {
  'idle' {
    Out-Json @{ ok = $true; idleMs = [CW]::IdleMs() }
  }

  'list-windows' {
    $visibleOnly = if ($null -ne $script:Payload.visibleOnly) { [bool]$script:Payload.visibleOnly } else { $true }
    $wanted = @([CW]::Windows($visibleOnly, $true))
    $items = @()
    foreach ($line in $wanted) {
      $parts = $line -split ([char]1)
      $h = [IntPtr][int64]$parts[0]
      $proc = ''
      try { $proc = (Get-Process -Id ([int]$parts[1]) -ErrorAction Stop).ProcessName } catch { }
      $rect = $parts[3] -split ','
      $items += [pscustomobject]@{
        hwnd    = [int64]$parts[0]
        pid     = [int]$parts[1]
        process = $proc
        class   = $parts[2]
        rect    = @([int]$rect[0], [int]$rect[1], [int]$rect[2], [int]$rect[3])
        width   = [int]$rect[2] - [int]$rect[0]
        height  = [int]$rect[3] - [int]$rect[1]
        minimized = ($parts[4] -eq '1')
        title   = $parts[5]
      }
    }
    Out-Json @{ ok = $true; windows = $items }
  }

  'window' {
    $h = [IntPtr][int64]$script:Payload.hwnd
    if (-not [CW]::IsWindow($h)) { Out-Json @{ ok = $false; error = 'invalid hwnd' }; break }
    Out-Json @{ ok = $true; window = (Format-Window $h) }
  }

  'foreground' {
    $h = [CW]::GetForegroundWindow()
    Out-Json @{ ok = $true; window = (Format-Window $h) }
  }

  'focus' {
    $h = [IntPtr][int64]$script:Payload.hwnd
    if (-not [CW]::IsWindow($h)) { Out-Json @{ ok = $false; error = 'invalid hwnd' }; break }
    $ok = [CW]::ForceForeground($h)
    Start-Sleep -Milliseconds 120
    $fg = [CW]::GetForegroundWindow()
    Out-Json @{ ok = $ok; focused = ($fg -eq $h); foreground = (Format-Window $fg); target = (Format-Window $h) }
  }

  'click' {
    $x = [int]$script:Payload.x
    $y = [int]$script:Payload.y
    [void][CW]::ClickAt($x, $y, [bool]$script:Payload.double)
    Out-Json @{ ok = $true; x = $x; y = $y }
  }

  'type' {
    $text = [string]$script:Payload.text
    $n = [CW]::TypeUnicode($text)
    Out-Json @{ ok = ($n -eq ($text.Length * 2)); sent = $n; expected = ($text.Length * 2) }
  }

  'key' {
    $vk = [int]$script:Payload.vk
    $n = [CW]::Combo([uint16]$vk, [bool]$script:Payload.ctrl, [bool]$script:Payload.shift, [bool]$script:Payload.alt)
    Out-Json @{ ok = $true; sent = $n }
  }

  'read-clipboard' {
    $text = Get-ClipboardText
    Out-Json @{ ok = $true; text = $text; length = ($text | Measure-Object -Character).Characters }
  }

  'write-clipboard' {
    $text = [string]$script:Payload.text
    $ok = Set-ClipboardText $text
    Out-Json @{ ok = $ok; length = $text.Length }
  }

  'paste' {
    # 把文本写进剪贴板再 Ctrl+V：比逐字符打字可靠（长文本/中文/换行都稳）
    $text = [string]$script:Payload.text
    $restoreText = [string]$script:Payload.restoreText
    $ok = Set-ClipboardText $text
    if (-not $ok) { Out-Json @{ ok = $false; error = 'clipboard write failed' }; break }
    Start-Sleep -Milliseconds 150
    $n = [CW]::Combo(0x56, $true, $false, $false)
    Start-Sleep -Milliseconds 250
    if ($script:Payload.restore -eq $true) { [void](Set-ClipboardText $restoreText) }
    Out-Json @{ ok = $true; sent = $n }
  }

  'uia-elements' {
    $h = [IntPtr][int64]$script:Payload.hwnd
    $max = if ($script:Payload.max) { [int]$script:Payload.max } else { 200 }
    $maxDepth = if ($script:Payload.maxDepth) { [int]$script:Payload.maxDepth } else { 24 }
    $kinds = if ($script:Payload.kinds) { @($script:Payload.kinds) } else { @('Edit', 'Document', 'Text') }
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($el, 0))
    $items = New-Object System.Collections.ArrayList
    $count = 0
    while ($stack.Count -gt 0 -and $count -lt $max) {
      $item = $stack.Pop()
      $node = $item[0]; $depth = [int]$item[1]
      $count++
      $ct = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      $value = $null
      if ($kinds -contains $ct) {
        try {
          $vp = $node.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $value = $vp.Current.Value
        } catch { }
      }
      $rect = $node.Current.BoundingRectangle
      if (($kinds -contains $ct) -and -not $rect.IsEmpty -and $rect.Width -gt 0) {
        [void]$items.Add([pscustomobject]@{
            depth     = $depth
            kind      = $ct
            name      = $node.Current.Name
            class     = $node.Current.ClassName
            id        = $node.Current.AutomationId
            focusable = $node.Current.IsKeyboardFocusable
            enabled   = $node.Current.IsEnabled
            rect      = @([int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height)
            value     = $value
          })
      }
      if ($depth -lt $maxDepth) {
        try {
          $child = $walker.GetFirstChild($node)
          while ($null -ne $child) {
            $stack.Push(@($child, $depth + 1))
            $child = $walker.GetNextSibling($child)
          }
        } catch { }
      }
    }
    Out-Json @{ ok = $true; nodes = $count; elements = @($items) }
  }

  'uia-focus-element' {
    # 用 UIA 直接聚焦某个输入元素（比点坐标更可靠；Chromium 上常不支持，故有坐标兜底）
    $h = [IntPtr][int64]$script:Payload.hwnd
    $nameMatch = [string]$script:Payload.nameMatch
    $el = [System.Windows.Automation.AutomationElement]::FromHandle($h)
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $stack = New-Object System.Collections.Stack
    $stack.Push(@($el, 0))
    $found = $null
    $count = 0
    while ($stack.Count -gt 0 -and $count -lt 400) {
      $item = $stack.Pop(); $node = $item[0]; $depth = [int]$item[1]
      $count++
      $ct = $node.Current.ControlType.ProgrammaticName -replace 'ControlType\.', ''
      if (($ct -eq 'Edit' -or $ct -eq 'Document') -and $node.Current.IsKeyboardFocusable) {
        if ([string]::IsNullOrEmpty($nameMatch) -or $node.Current.Name -match $nameMatch) { $found = $node; break }
      }
      if ($depth -lt 24) {
        try {
          $child = $walker.GetFirstChild($node)
          while ($null -ne $child) { $stack.Push(@($child, $depth + 1)); $child = $walker.GetNextSibling($child) }
        } catch { }
      }
    }
    if ($null -eq $found) { Out-Json @{ ok = $false; error = 'no focusable edit/document element' }; break }
    try {
      $found.SetFocus()
      $rect = $found.Current.BoundingRectangle
      Out-Json @{ ok = $true; rect = @([int]$rect.X, [int]$rect.Y, [int]$rect.Width, [int]$rect.Height); name = $found.Current.Name }
    } catch { Out-Json @{ ok = $false; error = $_.Exception.Message } }
  }

  'whoami-window' {
    # 光标下是哪个窗口（用于确认点击目标）
    $p = [CW+POINT]::new()
    [void][CW]::GetCursorPos([ref]$p)
    $h = [CW]::WindowFromPoint($p)
    $root = [CW]::GetAncestor($h, 2)
    Out-Json @{ ok = $true; x = $p.X; y = $p.Y; underCursor = (Format-Window $h); root = (Format-Window $root) }
  }

  default {
    Out-Json @{ ok = $false; error = "unknown command: $Command" }
  }
}
