import sys
import os
import argparse
import pyttsx3

def main():
    parser = argparse.ArgumentParser(description="TTS offline synthesizer")
    parser.add_argument("text", type=str, help="Text to speak aloud or synthesize")
    parser.add_argument("--wav", type=str, help="Optional output path to save WAV file")
    parser.add_argument("--rate", type=int, default=175, help="Speech synthesis rate (words per minute)")
    parser.add_argument("--force-failure", action="store_true", help="Force synthesis failure for testing")
    parser.add_argument("--output-device", type=str, default="", help="Audio output device name or ID")
    parser.add_argument("--ci-fallback", action="store_true", help="Allow silent WAV fallback in headless CI environments")
    args = parser.parse_args()

    text = args.text
    out_path = args.wav

    force_fail = args.force_failure or (os.environ.get("FORCE_TTS_FAILURE") == "true")
    if force_fail:
        print("TTS forced failure activated.", file=sys.stderr, flush=True)
        sys.exit(1)

    print(f"TTS STARTING: {text}", flush=True)

    try:
        try:
            engine = pyttsx3.init()
            
            # Configure voice selection if output device name matches any installed voice
            if args.output_device:
                voices = engine.getProperty('voices')
                for voice in voices:
                    if args.output_device.lower() in voice.name.lower() or args.output_device.lower() in voice.id.lower():
                        engine.setProperty('voice', voice.id)
                        break

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
            # Reconciled TTS Fallback:
            # Only generate silent dummy file if we are writing a WAV file AND --ci-fallback is explicitly passed.
            # In all other cases (live speaker output, or real developer setup), exit with 1 to fail loud and trigger console text fallback.
            if out_path and (args.ci_fallback or os.environ.get("JARVIS_CI_FALLBACK") == "true"):
                print(f"TTS engine initialization failed: {init_err}. Executing CI wav fallback.", file=sys.stderr, flush=True)
                import wave
                out_dir = os.path.dirname(out_path)
                if out_dir and not os.path.exists(out_dir):
                    os.makedirs(out_dir, exist_ok=True)
                with wave.open(out_path, 'wb') as w:
                    w.setnchannels(1)
                    w.setsampwidth(2)
                    w.setframerate(16000)
                    w.writeframes(b'\x00' * 32000)
                print("TTS FINISHED (FALLBACK)", flush=True)
                sys.exit(0)
            else:
                print(f"TTS engine initialization failed: {init_err}. Propagating failure.", file=sys.stderr, flush=True)
                sys.exit(1)
    except Exception as e:
        print(f"TTS fatal error: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

if __name__ == "__main__":
    main()
