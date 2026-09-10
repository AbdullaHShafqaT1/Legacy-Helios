import sys
import json
import time
import pyautogui
import pygetwindow as gw

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

def main():
    if len(sys.argv) < 2:
        print(json.dumps({"status": "FAILED", "error": "Missing JSON payload argument"}))
        sys.exit(1)

    # Ensure this process is attached to the user's interactive Windows desktop session
    attach_to_default_desktop()
        
    try:
        payload = json.loads(sys.argv[1])
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
            print(json.dumps({"status": "SUCCESS", "message": f"Focused window: {fore_title}", "foreground": fore_title}))
            sys.exit(0)

        elif action == 'move':
            x, y = payload['x'], payload['y']
            duration = payload.get('duration', 0.8)
            pyautogui.moveTo(x, y, duration=duration)
            
        elif action == 'click':
            x, y = payload.get('x'), payload.get('y')
            clicks = payload.get('clicks', 1)
            button = payload.get('button', 'left')
            duration = payload.get('duration', 0.8)
            if x is not None and y is not None:
                pyautogui.moveTo(x, y, duration=duration)
                time.sleep(0.1)
                pyautogui.click(clicks=clicks, button=button)
            else:
                pyautogui.click(clicks=clicks, button=button)
                
        elif action == 'doubleclick':
            x, y = payload.get('x'), payload.get('y')
            duration = payload.get('duration', 0.8)
            if x is not None and y is not None:
                pyautogui.moveTo(x, y, duration=duration)
                time.sleep(0.1)
                pyautogui.doubleClick()
            else:
                pyautogui.doubleClick()
                
        elif action == 'rightclick':
            x, y = payload.get('x'), payload.get('y')
            duration = payload.get('duration', 0.8)
            if x is not None and y is not None:
                pyautogui.moveTo(x, y, duration=duration)
                time.sleep(0.1)
                pyautogui.rightClick()
            else:
                pyautogui.rightClick()
                
        elif action == 'drag':
            x, y = payload['x'], payload['y']
            duration = payload.get('duration', 1.0)
            button = payload.get('button', 'left')
            pyautogui.dragTo(x, y, duration=duration, button=button)
            
        elif action == 'scroll':
            amount = payload['amount']
            pyautogui.scroll(amount)
            
        elif action == 'type':
            text = payload['text']
            interval = payload.get('interval', 0.03)
            # Small settling pause before typing
            time.sleep(0.1)
            pyautogui.typewrite(text, interval=interval)
            
        elif action == 'press':
            key = payload['key']
            time.sleep(0.1)
            pyautogui.press(key)
            
        elif action == 'hotkey':
            keys = payload['keys']
            # Settling pause after any window activation
            time.sleep(0.15)
            # keys might be a list or a plus-separated string like 'ctrl+w'
            if isinstance(keys, str):
                key_list = [k.strip() for k in keys.split('+')]
                pyautogui.hotkey(*key_list)
            elif isinstance(keys, list):
                pyautogui.hotkey(*keys)
                
        elif action == 'cloudcode_oversight':
            res = cloudcode_oversight(payload)
            print(json.dumps(res))
            sys.exit(0)
            
        else:
            raise ValueError(f"Unknown action: {action}")
            
        fore_title = get_current_foreground_title()
        print(json.dumps({"status": "SUCCESS", "message": f"Executed {action}", "foreground": fore_title}))
        sys.exit(0)
        
    except Exception as e:
        print(json.dumps({"status": "FAILED", "error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
