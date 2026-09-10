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
    
def test_safe_movement():
    print("Testing safe mouse movement...")
    run_action({"action": "move", "x": 100, "y": 100, "duration": 0.1})
    run_action({"action": "move", "x": 200, "y": 100, "duration": 0.1})
    run_action({"action": "move", "x": 200, "y": 200, "duration": 0.1})
    run_action({"action": "move", "x": 100, "y": 200, "duration": 0.1})
    print("Safe movement test complete.")

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
        test_type_and_hotkey()
        print("All tests passed successfully.")
    except Exception as e:
        print(f"Tests failed: {e}")
        sys.exit(1)
