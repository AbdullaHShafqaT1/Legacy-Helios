import sys
import os
import argparse
from openwakeword.model import Model

def main():
    parser = argparse.ArgumentParser(description="openWakeWord local wake word detector")
    parser.add_argument("--wav", type=str, help="Path to input WAV file")
    parser.add_argument("--threshold", type=float, default=0.1, help="Wake word sensitivity threshold")
    args = parser.parse_args()

    # Load openWakeWord model using ONNX runtime
    try:
        model = Model(wakeword_models=["jarvis"], inference_framework="onnx")
    except Exception as e:
        print(f"Error loading openWakeWord model: {e}", file=sys.stderr)
        sys.exit(1)

    chunk_size = 1280
    sample_rate = 16000

    if args.wav:
        # File mode using built-in predict_clip which handles linear resampling and windowing internally
        try:
            predictions = model.predict_clip(args.wav)
            detected = False
            for p in predictions:
                for key, prob in p.items():
                    if "jarvis" in key.lower() and prob >= args.threshold:
                        detected = True
                        break
            if detected:
                print("WAKE_WORD_DETECTED", flush=True)
            sys.exit(0)
        except Exception as e:
            print(f"File mode error: {e}", file=sys.stderr)
            sys.exit(1)
    else:
        # Microphone mode
        try:
            import sounddevice as sd
            
            # Callback function to process live stream
            def callback(indata, frames, time, status):
                if status:
                    print(f"Status: {status}", file=sys.stderr)
                audio_chunk = indata[:, 0]
                prediction = model.predict(audio_chunk)
                for key, prob in prediction.items():
                    if "jarvis" in key.lower() and prob >= args.threshold:
                        print("WAKE_WORD_DETECTED", flush=True)
            
            # Start streaming
            with sd.InputStream(samplerate=sample_rate, channels=1, dtype='float32', blocksize=chunk_size, callback=callback):
                print("Continuous listening started...", file=sys.stderr, flush=True)
                while True:
                    sd.sleep(100)
        except Exception as e:
            print(f"Microphone mode error: {e}", file=sys.stderr)
            sys.exit(1)

if __name__ == "__main__":
    main()
