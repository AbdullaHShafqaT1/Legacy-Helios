import sys
import json
import time
import pyautogui
import pydirectinput
import pygetwindow as gw

# Setup PyAutoGUI fail-safes
pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.15

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
        # Some Windows environments throw on activate if already active or minimized improperly
        win.restore()
        win.activate()
        
    time.sleep(1) # Wait for window to come to foreground
    
    # Assumption for this macro: We tab to fields or they have known hotkeys.
    # Since we can't introspect easily, let's simulate a known sequence of tabs 
    # to reach the URL field, type it, tab to workspace, type it, tab to start.
    # For now, we will just use a generic 'select all and replace' if we assume focus starts at the URL
    
    # Let's say: 
    # 1. Ctrl+L or click to focus URL (assuming it's a web interface or has a shortcut)
    # 2. Type URL
    # 3. Tab to Workspace
    # 4. Type Workspace
    # 5. Tab to "Start" and press Enter.
    
    # We will simulate exactly what a user might do if focus is reset:
    # Here we just use an assumption of Tab navigation for the UI.
    # In a real scenario, computer vision would click the exact fields.
    
    print("Activating CloudCode oversight macro. Ensure UI is in expected start state.")
    
    # To keep it generic but functional, let's just emit the keys.
    # A true integration might use vision connector to find the fields.
    # For now, we'll do:
    # Tab to URL field (assuming it's 1 tab away from default focus)
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
        
    try:
        payload = json.loads(sys.argv[1])
        action = payload.get('action')
        
        if not action:
            raise ValueError("No action specified in payload")
            
        if action == 'move':
            x, y = payload['x'], payload['y']
            duration = payload.get('duration', 0.2)
            pyautogui.moveTo(x, y, duration=duration)
            
        elif action == 'click':
            x, y = payload.get('x'), payload.get('y')
            clicks = payload.get('clicks', 1)
            button = payload.get('button', 'left')
            if x is not None and y is not None:
                pyautogui.click(x=x, y=y, clicks=clicks, button=button)
            else:
                pyautogui.click(clicks=clicks, button=button)
                
        elif action == 'doubleclick':
            x, y = payload.get('x'), payload.get('y')
            if x is not None and y is not None:
                pyautogui.doubleClick(x=x, y=y)
            else:
                pyautogui.doubleClick()
                
        elif action == 'rightclick':
            x, y = payload.get('x'), payload.get('y')
            if x is not None and y is not None:
                pyautogui.rightClick(x=x, y=y)
            else:
                pyautogui.rightClick()
                
        elif action == 'drag':
            x, y = payload['x'], payload['y']
            duration = payload.get('duration', 0.2)
            button = payload.get('button', 'left')
            pyautogui.dragTo(x, y, duration=duration, button=button)
            
        elif action == 'scroll':
            amount = payload['amount']
            pyautogui.scroll(amount)
            
        elif action == 'type':
            text = payload['text']
            interval = payload.get('interval', 0.02)
            pyautogui.typewrite(text, interval=interval)
            
        elif action == 'press':
            key = payload['key']
            pyautogui.press(key)
            
        elif action == 'hotkey':
            keys = payload['keys']
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
            
        print(json.dumps({"status": "SUCCESS", "message": f"Executed {action}"}))
        sys.exit(0)
        
    except Exception as e:
        print(json.dumps({"status": "FAILED", "error": str(e)}))
        sys.exit(1)

if __name__ == '__main__':
    main()
