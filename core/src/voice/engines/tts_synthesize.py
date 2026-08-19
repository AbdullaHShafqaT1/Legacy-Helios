import sys
import os
import argparse
import pyttsx3

def main():
    parser = argparse.ArgumentParser(description="TTS offline synthesizer")
    parser.add_argument("text", type=str, help="Text to speak aloud or synthesize")
    parser.add_argument("--wav", type=str, help="Optional output path to save WAV file")
    parser.add_argument("--rate", type=int, default=175, help="Speech synthesis rate (words per minute)")
    args = parser.parse_args()

    text = args.text
    out_path = args.wav

    print(f"TTS STARTING: {text}", flush=True)

    try:
        try:
            engine = pyttsx3.init()
            # Configure speech rate
            engine.setProperty('rate', args.rate)
            
            if out_path:
                out_dir = os.path.dirname(out_path)
                if out_dir and not os.path.exists(out_dir):
                    os.makedirs(out_dir, exist_ok=True)
                    
                engine.save_to_file(text, out_path)
                engine.runAndWait()
                # Explicit clean up of COM references to prevent SAPI5 deadlock
                del engine
            else:
                engine.say(text)
                engine.runAndWait()
                del engine
                
            print("TTS FINISHED", flush=True)
            sys.exit(0)
        except Exception as init_err:
            print(f"TTS native engine initialization failed: {init_err}. Executing dry-run/dummy-file fallback.", file=sys.stderr, flush=True)
            if out_path:
                import wave
                out_dir = os.path.dirname(out_path)
                if out_dir and not os.path.exists(out_dir):
                    os.makedirs(out_dir, exist_ok=True)
                with wave.open(out_path, 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    # Write 1 second of silence
                    w.writeframes(b'\x00' * 32000)
            print("TTS FINISHED (FALLBACK)", flush=True)
            sys.exit(0)
    except Exception as e:
        print(f"TTS fatal error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
