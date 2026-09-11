import os
import sys
import json
import subprocess
import time

def run_action(action_payload):
    script_path = os.path.join(os.path.dirname(__file__), 'tools', 'desktop_control.py')
    
    print(f"Executing: {action_payload['action']}")
    result = subprocess.run(
        [sys.executable, script_path, json.dumps(action_payload)],
        capture_output=True,
        text=True
    )
    
    print(f"Stdout: {result.stdout.strip()}")
    if result.stderr:
        print(f"Stderr: {result.stderr.strip()}")
        
    if result.returncode != 0:
        raise RuntimeError(f"Action {action_payload['action']} failed with return code {result.returncode}")
        
    print("-" * 40)
    try:
        return json.loads(result.stdout.strip())
    except Exception:
        return {}
    
def test_safe_movement():
    print("Testing safe mouse movement...")
    run_action({"action": "move", "x": 100, "y": 100, "duration": 0.1})
    run_action({"action": "move", "x": 200, "y": 100, "duration": 0.1})
    run_action({"action": "move", "x": 200, "y": 200, "duration": 0.1})
    run_action({"action": "move", "x": 100, "y": 200, "duration": 0.1})
    print("Safe movement test complete.")

def test_coordinate_precheck_and_reliable_click():
    print("Testing coordinate pre-check and reliable click with explicit dwell time...")
    res = run_action({"action": "click", "x": 150, "y": 150, "duration": 0.1, "dwell_ms": 50})
    assert res.get("coordinate_verified") is True, "Expected coordinate_verified to be True"
    cursor = res.get("cursor", {})
    assert abs(cursor.get("x", 0) - 150) <= 3, f"Cursor x out of range: {cursor.get('x')}"
    assert abs(cursor.get("y", 0) - 150) <= 3, f"Cursor y out of range: {cursor.get('y')}"
    print("Coordinate pre-check and reliable click test complete.")

def test_type_and_hotkey():
    print("Testing type and hotkey (opening run dialog, typing notepad, and closing)...")
    
    # Win+R to open Run dialog
    run_action({"action": "hotkey", "keys": ["win", "r"]})
    time.sleep(0.5)
    
    # Type notepad
    run_action({"action": "type", "text": "notepad"})
    time.sleep(0.5)
    
    # Press Escape to close it (so we don't actually open notepad)
    run_action({"action": "press", "key": "esc"})
    
    print("Type and hotkey test complete.")

if __name__ == '__main__':
    print("Starting Desktop Control standalone tests...")
    try:
        test_safe_movement()
        test_coordinate_precheck_and_reliable_click()
        test_type_and_hotkey()
        print("All tests passed successfully.")
    except Exception as e:
        print(f"Tests failed: {e}")
        sys.exit(1)
