#!/usr/bin/env python3
"""
OS-Level Mouse Execution Controller for Windows (Win32 Native API).
Provides low-latency, Per-Monitor DPI-aware absolute coordinate cursor execution
without heavy external dependencies.
"""

import sys
import json
import time
import math
from datetime import datetime, timezone

# Ensure Win32 API availability
if sys.platform != 'win32':
    raise OSError("os_mouse_controller requires a Windows environment (Win32 API).")

import ctypes
from ctypes import wintypes

# Win32 Constants
INPUT_MOUSE = 0
MOUSEEVENTF_MOVE = 0x0001
MOUSEEVENTF_LEFTDOWN = 0x0002
MOUSEEVENTF_LEFTUP = 0x0004
MOUSEEVENTF_RIGHTDOWN = 0x0008
MOUSEEVENTF_RIGHTUP = 0x0010
MOUSEEVENTF_MIDDLEDOWN = 0x0020
MOUSEEVENTF_MIDDLEUP = 0x0040
MOUSEEVENTF_WHEEL = 0x0800
MOUSEEVENTF_ABSOLUTE = 0x8000
WHEEL_DELTA = 120

SM_CXSCREEN = 0
SM_CYSCREEN = 1

# Structures for SendInput
class MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]

class INPUT_I(ctypes.Union):
    _fields_ = [("mi", MOUSEINPUT)]

class INPUT(ctypes.Structure):
    _fields_ = [
        ("type", wintypes.DWORD),
        ("ii", INPUT_I)
    ]

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

def init_environment():
    """
    Initializes desktop thread attachment and Per-Monitor DPI Awareness v2.
    Ensures absolute screen pixel mapping matches screenshots exactly.
    """
    # 1. Attach calling thread to the interactive desktop
    try:
        hdesk = user32.OpenDesktopW('default', 0, False, 0x10000000)
        if hdesk:
            user32.SetThreadDesktop(hdesk)
    except Exception:
        pass

    # 2. Set Per-Monitor DPI Awareness v2
    try:
        shcore = ctypes.windll.shcore
        # PROCESS_PER_MONITOR_DPI_AWARE_V2 = 2
        shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass

init_environment()

def get_display_info():
    """
    Returns native screen resolution, system DPI, and DPI scale factor.
    """
    width = user32.GetSystemMetrics(SM_CXSCREEN)
    height = user32.GetSystemMetrics(SM_CYSCREEN)
    
    dpi = 96
    try:
        dpi = user32.GetDpiForSystem()
    except Exception:
        pass
    
    dpi_scale = round(dpi / 96.0, 2)
    
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    
    return {
        "width": width,
        "height": height,
        "dpi": dpi,
        "dpi_scale": dpi_scale,
        "scale_percent": int(round(dpi_scale * 100)),
        "cursor": [pt.x, pt.y]
    }

def get_cursor_pos():
    pt = wintypes.POINT()
    user32.GetCursorPos(ctypes.byref(pt))
    return pt.x, pt.y

def send_mouse_input(flags, mouse_data=0, dx=0, dy=0):
    inp = INPUT()
    inp.type = INPUT_MOUSE
    inp.ii.mi.dx = dx
    inp.ii.mi.dy = dy
    inp.ii.mi.mouseData = mouse_data
    inp.ii.mi.dwFlags = flags
    inp.ii.mi.time = 0
    inp.ii.mi.dwExtraInfo = 0
    
    res = user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))
    return res == 1

def move_to(x, y, smooth=True, duration=0.15):
    """
    Moves the cursor to physical screen coordinates (x, y).
    If smooth is True, interpolates with cubic ease-out.
    """
    target_x = int(round(x))
    target_y = int(round(y))
    
    info = get_display_info()
    # Clamp to monitor boundaries
    target_x = max(0, min(target_x, info["width"] - 1))
    target_y = max(0, min(target_y, info["height"] - 1))
    
    start_x, start_y = get_cursor_pos()
    dx = target_x - start_x
    dy = target_y - start_y
    dist = math.hypot(dx, dy)
    
    if not smooth or dist < 6 or duration <= 0:
        user32.SetCursorPos(target_x, target_y)
        time.sleep(0.01)
        cur_x, cur_y = get_cursor_pos()
        return [cur_x, cur_y]
    
    # 60fps micro-stepping with cubic ease-out
    steps = max(10, min(int(duration * 60), 30))
    step_sleep = duration / steps
    
    for i in range(1, steps + 1):
        t = i / steps
        # Cubic ease-out: f(t) = 1 - (1 - t)^3
        ease = 1.0 - math.pow(1.0 - t, 3)
        curr_step_x = int(round(start_x + dx * ease))
        curr_step_y = int(round(start_y + dy * ease))
        user32.SetCursorPos(curr_step_x, curr_step_y)
        time.sleep(step_sleep)
    
    user32.SetCursorPos(target_x, target_y)
    time.sleep(0.01)
    cur_x, cur_y = get_cursor_pos()
    return [cur_x, cur_y]

def click(x=None, y=None, button="left", count=1, dwell_ms=50, smooth=True):
    """
    Executes single or double click with physical dwell time.
    """
    executed_pos = None
    if x is not None and y is not None:
        executed_pos = move_to(x, y, smooth=smooth)
    else:
        executed_pos = list(get_cursor_pos())
    
    button_lower = button.lower()
    if button_lower == 'right':
        down_flag = MOUSEEVENTF_RIGHTDOWN
        up_flag = MOUSEEVENTF_RIGHTUP
    elif button_lower == 'middle':
        down_flag = MOUSEEVENTF_MIDDLEDOWN
        up_flag = MOUSEEVENTF_MIDDLEUP
    else:
        down_flag = MOUSEEVENTF_LEFTDOWN
        up_flag = MOUSEEVENTF_LEFTUP
    
    dwell_sec = max(0.01, dwell_ms / 1000.0)
    
    for c in range(count):
        if c > 0:
            time.sleep(0.06)  # Inter-click delay for double click
        send_mouse_input(down_flag)
        time.sleep(dwell_sec)
        send_mouse_input(up_flag)
    
    return executed_pos

def drag_and_drop(x1, y1, x2, y2, smooth=True, duration=0.2):
    """
    Drags from (x1, y1) and drops at (x2, y2).
    """
    move_to(x1, y1, smooth=False)
    time.sleep(0.05)
    
    send_mouse_input(MOUSEEVENTF_LEFTDOWN)
    time.sleep(0.05)
    
    end_pos = move_to(x2, y2, smooth=smooth, duration=duration)
    time.sleep(0.05)
    
    send_mouse_input(MOUSEEVENTF_LEFTUP)
    time.sleep(0.02)
    return end_pos

def scroll(direction="up", amount=1):
    """
    Scrolls vertical mouse wheel by given amount of notches.
    """
    amt = int(amount)
    if amt <= 0:
        amt = 1
    
    delta = WHEEL_DELTA * amt if direction.lower() == 'up' else -WHEEL_DELTA * amt
    send_mouse_input(MOUSEEVENTF_WHEEL, mouse_data=delta)
    time.sleep(0.02)
    return list(get_cursor_pos())

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "status": "FAILED",
            "error": "Missing action or payload JSON parameter"
        }))
        sys.exit(1)

def execute_command(payload: dict) -> dict:
    action = payload.get("action", "").lower()
    timestamp = datetime.now(timezone.utc).isoformat()
    display_info = get_display_info()
    
    if action == "info" or action == "display_info":
        return {
            "status": "SUCCESS",
            "action": "display_info",
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "move" or action == "mouse_move":
        x = payload["x"]
        y = payload["y"]
        smooth = payload.get("smooth", True)
        duration = payload.get("duration", 0.15)
        pos = move_to(x, y, smooth=smooth, duration=duration)
        return {
            "status": "SUCCESS",
            "action": "mouse_move",
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "click" or action == "mouse_click":
        x = payload.get("x")
        y = payload.get("y")
        button = payload.get("button", "left")
        click_type = payload.get("click_type")
        
        count = payload.get("count", 1)
        if click_type == "double" or payload.get("clicks") == 2:
            count = 2
        elif click_type == "right":
            button = "right"
            count = 1
            
        dwell_ms = payload.get("dwell_ms", 50)
        smooth = payload.get("smooth", True)
        
        pos = click(x=x, y=y, button=button, count=count, dwell_ms=dwell_ms, smooth=smooth)
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": button,
            "count": count,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "doubleclick" or action == "double_click":
        x = payload.get("x")
        y = payload.get("y")
        dwell_ms = payload.get("dwell_ms", 50)
        pos = click(x=x, y=y, button="left", count=2, dwell_ms=dwell_ms)
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": "left",
            "count": 2,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "rightclick" or action == "right_click":
        x = payload.get("x")
        y = payload.get("y")
        dwell_ms = payload.get("dwell_ms", 50)
        pos = click(x=x, y=y, button="right", count=1, dwell_ms=dwell_ms)
        return {
            "status": "SUCCESS",
            "action": "mouse_click",
            "button": "right",
            "count": 1,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "drag" or action == "mouse_drag" or action == "drag_and_drop":
        x1 = payload.get("start_x", payload.get("x1", payload.get("x")))
        y1 = payload.get("start_y", payload.get("y1", payload.get("y")))
        x2 = payload.get("end_x", payload.get("x2", payload.get("to_x")))
        y2 = payload.get("end_y", payload.get("y2", payload.get("to_y")))
        
        if x1 is None or y1 is None or x2 is None or y2 is None:
            raise ValueError("Drag requires start_x, start_y, end_x, end_y coordinates")
            
        smooth = payload.get("smooth", True)
        duration = payload.get("duration", 0.2)
        pos = drag_and_drop(x1, y1, x2, y2, smooth=smooth, duration=duration)
        return {
            "status": "SUCCESS",
            "action": "mouse_drag",
            "start": [x1, y1],
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    elif action == "scroll" or action == "mouse_scroll":
        direction = payload.get("direction", "up")
        amount = payload.get("amount", 2)
        pos = scroll(direction=direction, amount=amount)
        return {
            "status": "SUCCESS",
            "action": "mouse_scroll",
            "direction": direction,
            "amount": amount,
            "executed_at": pos,
            "cursor": pos,
            "display": display_info,
            "timestamp": timestamp
        }
        
    else:
        raise ValueError(f"Unknown mouse action: {action}")

def main():
    if len(sys.argv) < 2:
        print(json.dumps({
            "status": "FAILED",
            "error": "No action payload provided in sys.argv[1]",
            "timestamp": datetime.now(timezone.utc).isoformat()
        }))
        sys.exit(1)

    try:
        raw_arg = sys.argv[1].strip()
        payload = json.loads(raw_arg)
        result = execute_command(payload)
        print(json.dumps(result))
        sys.exit(0)
    except Exception as err:
        print(json.dumps({
            "status": "FAILED",
            "error": str(err),
            "timestamp": datetime.now(timezone.utc).isoformat()
        }))
        sys.exit(1)

if __name__ == '__main__':
    main()
