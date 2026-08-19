import sys
import os

print("Starting speech models pre-download...", flush=True)

try:
    import openwakeword.utils
    print("Downloading openWakeWord models...", flush=True)
    openwakeword.utils.download_models()
    print("openWakeWord models download completed.", flush=True)
except Exception as e:
    print(f"Error downloading openWakeWord models: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

try:
    import whisper
    print("Downloading Whisper 'tiny' model...", flush=True)
    whisper.load_model("tiny")
    print("Whisper 'tiny' model download completed.", flush=True)
except Exception as e:
    print(f"Error downloading Whisper model: {e}", file=sys.stderr, flush=True)
    sys.exit(1)

print("All speech models downloaded and cached successfully.", flush=True)
sys.exit(0)
