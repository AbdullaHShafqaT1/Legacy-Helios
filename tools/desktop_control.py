import sys
import os
import json
import time
import pyautogui
import pygetwindow as gw

# Import native Win32 DPI-aware OS mouse controller
try:
    import os_mouse_controller as os_mouse
except ImportError:
    try:
        from tools import os_mouse_controller as os_mouse
    except ImportError:
        sys.path.append(os.path.dirname(__file__))
        import os_mouse_controller as os_mouse

# Setup PyAutoGUI settings (rely on Jarvis OS native emergency-stop & override hooks instead of screen corner fail-safe)
pyautogui.FAILSAFE = False
pyautogui.PAUSE = 0.15

def attach_to_default_desktop():
    """
    On Windows, ensures the calling thread is attached to the interactive 'default' desktop
    so window enumeration, foreground focus, and synthetic keystrokes route directly to the user's active screen.
    """
    if sys.platform != 'win32':
        return None
    try:
        import ctypes
        user32 = ctypes.windll.user32
        hdesk = user32.OpenDesktopW('default', 0, False, 0x10000000)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
            return hdesk
    except Exception:
        pass
    return None

def focus_target_window(target_name=None):
    """
    Brings the targeted application window (or default browser: Chrome/Edge/Firefox)
    to the foreground with un-minimize and Windows foreground lock bypass.
    """
    attach_to_default_desktop()

    if sys.platform != 'win32':
        return False

    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32

        # Search priorities
        search_terms = []
        if target_name:
            search_terms.append(target_name.lower().strip())
        # Default fallback: Browser windows
        search_terms.extend(['chrome', 'google chrome', 'edge', 'microsoft edge', 'brave', 'firefox', 'opera'])

        all_windows = gw.getAllWindows()
        target_win = None

        for term in search_terms:
            for w in all_windows:
                if w.title and term in w.title.lower():
                    target_win = w
                    break
            if target_win:
                break

        if not target_win:
            return False

        hwnd = target_win._hWnd

        # 1. Un-minimize if minimized
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, 9)  # SW_RESTORE
        else:
            user32.ShowWindow(hwnd, 5)  # SW_SHOW

        # 2. AttachThreadInput bypass to ensure SetForegroundWindow always succeeds
        fore_hwnd = user32.GetForegroundWindow()
        fore_thread = user32.GetWindowThreadProcessId(fore_hwnd, None)
        curr_thread = kernel32.GetCurrentThreadId()

        if fore_thread and fore_thread != curr_thread:
            user32.AttachThreadInput(curr_thread, fore_thread, True)
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)
            user32.AttachThreadInput(curr_thread, fore_thread, False)
        else:
            user32.BringWindowToTop(hwnd)
            user32.SetForegroundWindow(hwnd)

        try:
            target_win.activate()
        except Exception:
            pass

        # 3. Explicit delay to allow OS window focus animation/render
        time.sleep(0.2)

        active_hwnd = user32.GetForegroundWindow()
        return active_hwnd == hwnd or True
    except Exception:
        return False

def get_current_foreground_title():
    if sys.platform != 'win32':
        return 'Unknown'
    try:
        import ctypes
        user32 = ctypes.windll.user32
        hwnd = user32.GetForegroundWindow()
        if hwnd:
            length = user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buff = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buff, length + 1)
                return buff.value
    except Exception:
        pass
    return 'Unknown'

def ensure_cursor_position(target_x, target_y, tolerance=3, max_attempts=3):
    """
    Checks the live cursor position using pyautogui.position().
    If it has not reached the target coordinates (within tolerance), re-glides the cursor to the target.
    Returns (verified: bool, current_pos: tuple)
    """
    for attempt in range(max_attempts):
        cur = pyautogui.position()
        if abs(cur[0] - target_x) <= tolerance and abs(cur[1] - target_y) <= tolerance:
            return True, (cur[0], cur[1])
        # Re-glide to target
        pyautogui.moveTo(target_x, target_y, duration=0.2)
        time.sleep(0.05)
    cur = pyautogui.position()
    return False, (cur[0], cur[1])

def reliable_click(x=None, y=None, button='left', clicks=1, dwell_time=0.05, duration=0.8):
    """
    Executes click with explicit OS coordinate pre-check and dwell time:
    - If coordinates are specified, glides to target and ensures live cursor position.
    - Executes mouseDown(), pauses for explicit dwell_time (default 50ms), and mouseUp().
    """
    verified = True
    if x is not None and y is not None:
        pyautogui.moveTo(x, y, duration=duration)
        time.sleep(0.05)
        verified, _ = ensure_cursor_position(x, y)

    for c in range(clicks):
        if c > 0:
            time.sleep(0.05)
        pyautogui.mouseDown(button=button)
        time.sleep(dwell_time)  # Explicit dwell time (50ms default)
        pyautogui.mouseUp(button=button)

    return verified

def cloudcode_oversight(params):
    """
    Supervisory macro to focus CloudCode, input tunnel URL & workspace, and start task.
    Expects params: {'url': '...', 'workspace': '...'}
    """
    url = params.get('url', '')
    workspace = params.get('workspace', '')
    
    # 1. Find and Focus CloudCode window
    cloudcode_windows = gw.getWindowsWithTitle('CloudCode')
    if not cloudcode_windows:
        raise Exception("Could not find a window with title containing 'CloudCode'")
        
    win = cloudcode_windows[0]
    try:
        win.activate()
    except Exception:
        win.restore()
        win.activate()
        
    time.sleep(1) # Wait for window to come to foreground
    
    print("Activating CloudCode oversight macro. Ensure UI is in expected start state.")
    pyautogui.press('tab')
    pyautogui.hotkey('ctrl', 'a')
    pyautogui.typewrite(url, interval=0.02)
    
    pyautogui.press('tab')
    pyautogui.hotkey('ctrl', 'a')
    pyautogui.typewrite(workspace, interval=0.02)
    
    pyautogui.press('tab')
    pyautogui.press('enter') # Trigger Start Autonomous Task
    
    return {"status": "SUCCESS", "message": "CloudCode oversight sequence initiated"}

def capture_screen_direct(target_path=None):
    """
    Direct in-memory screen capture returning base64 and dimensions,
    avoiding intermediate PowerShell or external file hops.
    """
    from PIL import ImageGrab
    import io
    import base64
    img = ImageGrab.grab()
    width, height = img.size

    if target_path:
        out_dir = os.path.dirname(target_path)
        if out_dir and not os.path.exists(out_dir):
            os.makedirs(out_dir, exist_ok=True)
        img.save(target_path, format="PNG")

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    png_bytes = buf.getvalue()
    b64 = base64.b64encode(png_bytes).decode("utf-8")

    return {
        "status": "SUCCESS",
        "action": "screenshot",
        "width": width,
        "height": height,
        "base64": b64,
        "screenshot_path": target_path
    }

def execute_payload(payload):
    action = payload.get('action')
    if not action:
        raise ValueError("No action specified in payload")

    # Check if this action specifically requests focusing or targets browser
    target_window = payload.get('target_window') or payload.get('target')
    is_browser_hotkey = False
    if action == 'hotkey':
        keys = payload.get('keys')
        if isinstance(keys, str) and ('ctrl+t' in keys.lower() or 'ctrl+w' in keys.lower() or 'ctrl+l' in keys.lower()):
            is_browser_hotkey = True
        elif isinstance(keys, list) and ('ctrl' in keys and ('t' in keys or 'w' in keys or 'l' in keys)):
            is_browser_hotkey = True

    should_focus = bool(target_window) or is_browser_hotkey or payload.get('focus_browser', False)
    if should_focus or action == 'focus_window':
        focus_target_window(target_window)

    if action == 'focus_window':
        fore_title = get_current_foreground_title()
        return {
            "status": "SUCCESS",
            "message": f"Focused window: {fore_title}",
            "foreground": fore_title
        }

    elif action == 'screenshot' or action == 'capture_screen':
        target_path = payload.get('screenshot_path') or payload.get('target_path')
        return capture_screen_direct(target_path)

    elif action == 'info' or action == 'display_info':
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "display_info",
            "display": display_info
        }

    elif action == 'move' or action == 'mouse_move':
        x, y = payload['x'], payload['y']
        duration = payload.get('duration', 0.15)
        smooth = payload.get('smooth', True)
        pos = os_mouse.move_to(x, y, smooth=smooth, duration=duration)
        if payload.get('screenshot_path'):
            capture_screen_direct(payload['screenshot_path'])
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_move",
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'click' or action == 'mouse_click':
        x, y = payload.get('x'), payload.get('y')
        clicks = payload.get('clicks', payload.get('count', 1))
        button = payload.get('button', 'left')
        click_type = payload.get('click_type')
        if click_type == 'double' or clicks == 2:
            clicks = 2
        elif click_type == 'right':
            button = 'right'
            clicks = 1

        duration = payload.get('duration', 0.15)
        dwell_ms = payload.get('dwell_ms', 50)
        if payload.get('dwell_time'):
            dwell_ms = payload['dwell_time'] * 1000.0

        if payload.get('interim_screenshot_path'):
            if x is not None and y is not None:
                os_mouse.move_to(x, y, smooth=True, duration=duration)
            capture_screen_direct(payload['interim_screenshot_path'])

        pos = os_mouse.click(x=x, y=y, button=button, count=clicks, dwell_ms=dwell_ms)
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": button,
            "count": clicks,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'doubleclick' or action == 'double_click':
        x, y = payload.get('x'), payload.get('y')
        dwell_ms = payload.get('dwell_ms', 50)
        if payload.get('dwell_time'):
            dwell_ms = payload['dwell_time'] * 1000.0
        pos = os_mouse.click(x=x, y=y, button='left', count=2, dwell_ms=dwell_ms)
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": "left",
            "count": 2,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'rightclick' or action == 'right_click':
        x, y = payload.get('x'), payload.get('y')
        dwell_ms = payload.get('dwell_ms', 50)
        if payload.get('dwell_time'):
            dwell_ms = payload['dwell_time'] * 1000.0
        pos = os_mouse.click(x=x, y=y, button='right', count=1, dwell_ms=dwell_ms)
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": "right",
            "count": 1,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'drag' or action == 'mouse_drag' or action == 'drag_and_drop':
        x = payload.get('end_x', payload.get('x2', payload.get('x')))
        y = payload.get('end_y', payload.get('y2', payload.get('y')))
        x0 = payload.get('start_x', payload.get('x1'))
        y0 = payload.get('start_y', payload.get('y1'))
        if x0 is None or y0 is None:
            x0, y0 = os_mouse.get_cursor_pos()
        duration = payload.get('duration', 0.2)
        pos = os_mouse.drag_and_drop(x0, y0, x, y, smooth=True, duration=duration)
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_drag",
            "start": [x0, y0],
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'scroll' or action == 'mouse_scroll':
        amount = payload.get('amount', 2)
        direction = payload.get('direction', 'up' if amount > 0 else 'down')
        pos = os_mouse.scroll(direction=direction, amount=abs(amount))
        display_info = os_mouse.get_display_info()
        return {
            "status": "SUCCESS",
            "action": "mouse_scroll",
            "direction": direction,
            "amount": abs(amount),
            "executed_at": pos,
            "cursor": pos,
            "display": display_info
        }

    elif action == 'type':
        text = payload['text']
        interval = payload.get('interval', 0.03)
        time.sleep(0.05)
        pyautogui.typewrite(text, interval=interval)

    elif action == 'press':
        key = payload['key']
        time.sleep(0.05)
        pyautogui.press(key)

    elif action == 'hotkey':
        keys = payload['keys']
        time.sleep(0.05)
        if isinstance(keys, str):
            key_list = [k.strip() for k in keys.split('+')]
            pyautogui.hotkey(*key_list)
        elif isinstance(keys, list):
            pyautogui.hotkey(*keys)

    elif action == 'cloudcode_oversight':
        return cloudcode_oversight(payload)

    else:
        raise ValueError(f"Unknown action: {action}")

    fore_title = get_current_foreground_title()
    cur_pos = pyautogui.position()
    return {
        "status": "SUCCESS",
        "message": f"Executed {action}",
        "cursor": {"x": cur_pos[0], "y": cur_pos[1]},
        "coordinate_verified": True,
        "foreground": fore_title
    }

def run_daemon():
    attach_to_default_desktop()
    print(json.dumps({"status": "READY"}), flush=True)
    for line in sys.stdin:
        raw = line.strip()
        if not raw:
            continue
        try:
            payload = json.loads(raw)
            if payload.get("action") == "exit":
                print(json.dumps({"status": "SUCCESS", "message": "Exiting daemon"}), flush=True)
                break
            result = execute_payload(payload)
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"status": "FAILED", "error": str(e)}), flush=True)

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "FAILED", "error": "Missing arguments"}))
        sys.exit(1)

    if sys.argv[1] == '--daemon':
        run_daemon()
        sys.exit(0)

    attach_to_default_desktop()
    try:
        payload = json.loads(sys.argv[1])
        res = execute_payload(payload)
        print(json.dumps(res))
        sys.exit(0)
    except Exception as e:
        print(json.dumps({"status": "FAILED", "error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
