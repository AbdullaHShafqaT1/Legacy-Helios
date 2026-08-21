Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Signature = @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public class InputHook {
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;

    private static HookProc _keyboardProc;
    private static HookProc _mouseProc;
    private static IntPtr _keyboardHookId = IntPtr.Zero;
    private static IntPtr _mouseHookId = IntPtr.Zero;

    private static int _lastX = -1;
    private static int _lastY = -1;
    private static int _moveThreshold = 10;

    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    public static event Action<string> OnGenuineInput;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT {
        public int x;
        public int y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSLLHOOKSTRUCT {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KBDLLHOOKSTRUCT {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    public static bool Start(int threshold) {
        _moveThreshold = threshold;
        _keyboardProc = KeyboardHookCallback;
        _mouseProc = MouseHookCallback;

        using (Process curProcess = Process.GetCurrentProcess())
        using (ProcessModule curModule = curProcess.MainModule) {
            IntPtr hModule = GetModuleHandle(curModule.ModuleName);
            _keyboardHookId = SetWindowsHookEx(WH_KEYBOARD_LL, _keyboardProc, hModule, 0);
            _mouseHookId = SetWindowsHookEx(WH_MOUSE_LL, _mouseProc, hModule, 0);
        }

        if (_keyboardHookId == IntPtr.Zero || _mouseHookId == IntPtr.Zero) {
            return false;
        }

        return true;
    }

    public static void Stop() {
        if (_keyboardHookId != IntPtr.Zero) {
            UnhookWindowsHookEx(_keyboardHookId);
        }
        if (_mouseHookId != IntPtr.Zero) {
            UnhookWindowsHookEx(_mouseHookId);
        }
        Application.Exit();
    }

    private static IntPtr KeyboardHookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            KBDLLHOOKSTRUCT kb = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(KBDLLHOOKSTRUCT));
            bool isInjected = (kb.flags & 0x10) != 0 || (kb.flags & 0x02) != 0;
            if (!isInjected) {
                if (OnGenuineInput != null) {
                    OnGenuineInput("KEY:" + kb.vkCode);
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    private static IntPtr MouseHookCallback(int nCode, IntPtr wParam, IntPtr lParam) {
        if (nCode >= 0) {
            MSLLHOOKSTRUCT ms = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            bool isInjected = (ms.flags & 0x01) != 0 || (ms.flags & 0x02) != 0;
            if (!isInjected) {
                if (wParam == (IntPtr)0x0200) { // WM_MOUSEMOVE
                    int dx = Math.Abs(ms.pt.x - _lastX);
                    int dy = Math.Abs(ms.pt.y - _lastY);
                    if (_lastX != -1 && (dx > _moveThreshold || dy > _moveThreshold)) {
                        if (OnGenuineInput != null) {
                            OnGenuineInput("MOUSE_MOVE");
                        }
                    }
                    _lastX = ms.pt.x;
                    _lastY = ms.pt.y;
                } else {
                    if (OnGenuineInput != null) {
                        OnGenuineInput("MOUSE_CLICK");
                    }
                }
            }
        }
        return CallNextHookEx(IntPtr.Zero, nCode, wParam, lParam);
    }

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);
}
"@

Add-Type -TypeDefinition $Signature -ReferencedAssemblies "System.Windows.Forms", "System.Drawing" -ErrorAction SilentlyContinue

[InputHook]::add_OnGenuineInput({
    param($type)
    Write-Output "OVERRIDE:$type"
})

$threshold = 10
if ($args[0]) {
    $threshold = [int]$args[0]
}

$success = [InputHook]::Start($threshold)
if (-not $success) {
    Write-Error "ERROR: Hook installation failed."
    exit 1
}

Write-Output "HOOK_ACTIVE"

[System.Windows.Forms.Application]::Run()
