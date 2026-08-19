import os
import pyttsx3

fixtures = {
    "jarvis_wake.wav": "Hey Jarvis",
    "refactor_task.wav": "submit a task to refactor the database",
    "yes_approved.wav": "yes, approved",
    "garbage.wav": "bzzzt pssst crrrk"
}

fixtures_dir = os.path.dirname(__file__)
if not fixtures_dir:
    fixtures_dir = "core/test/fixtures"
os.makedirs(fixtures_dir, exist_ok=True)

print("Starting programmatic audio fixtures generation...", flush=True)

for filename, text in fixtures.items():
    out_path = os.path.join(fixtures_dir, filename)
    print(f"Generating fixture: {filename} -> '{text}'", flush=True)
    
    engine = pyttsx3.init()
    engine.setProperty('rate', 130) # Slower and clearer for neural nets
    engine.save_to_file(text, out_path)
    engine.runAndWait()
    del engine

print("All audio fixtures generated successfully.", flush=True)
