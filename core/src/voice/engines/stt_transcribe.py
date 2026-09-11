import sys
import os
import argparse
import json
import math
import numpy as np
from scipy.io import wavfile

# Suppress PyGame/PyTorch warnings
os.environ["WERKZEUG_RUN_MAIN"] = "true"

def load_audio_without_ffmpeg(path, target_sr=16000):
    sr, y = wavfile.read(path)
    # Convert stereo to mono
    if len(y.shape) > 1:
        y = y.mean(axis=1)
    
    # Normalize to float32 between [-1.0, 1.0]
    if y.dtype == np.int16:
        y = y.astype(np.float32) / 32767.0
    elif y.dtype == np.int32:
        y = y.astype(np.float32) / 2147483647.0
    elif y.dtype == np.uint8:
        y = (y.astype(np.float32) - 128.0) / 128.0
    else:
        y = y.astype(np.float32)

    # Resample to target_sr using linear interpolation
    if sr != target_sr:
        duration = len(y) / sr
        num_samples = int(duration * target_sr)
        y = np.interp(
            np.linspace(0, len(y) - 1, num_samples),
            np.arange(len(y)),
            y
        ).astype(np.float32)

    return y

def main():
    parser = argparse.ArgumentParser(description="Whisper local STT transcriber")
    parser.add_argument("--wav", type=str, default="", help="Path to input WAV file")
    parser.add_argument("--stdin-pcm", action="store_true", help="Read raw 16-bit PCM buffer from stdin")
    parser.add_argument("--duration", type=int, default=5, help="Microphone record duration in seconds")
    parser.add_argument("--force-failure", action="store_true", help="Force model load failure for diagnostics testing")
    parser.add_argument("--test-mock", action="store_true", help="Return mock transcription for test harness")
    parser.add_argument("--model-path", type=str, default="tiny", help="Path or version of Whisper model")
    parser.add_argument("--input-device", type=str, default="", help="Audio input device name/index")
    parser.add_argument("--sample-rate", type=int, default=16000, help="Audio stream sample rate")
    args = parser.parse_args()

    force_fail = args.force_failure or (os.environ.get("FORCE_STT_FAILURE") == "true")

    if force_fail:
        err_msg = (
            "Whisper STT model failed to initialize: forced failure flag set. "
            "Diagnostics: Check FORCE_STT_FAILURE env or --force-failure argument. "
            "Action: Remove force-failure flag or inspect test harness."
        )
        print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
        raise RuntimeError(err_msg)

    if args.test_mock:
        print(json.dumps({"text": "test transcription", "confidence": 1.0}), flush=True)
        sys.exit(0)

    # Load whisper model
    try:
        import whisper
        model = whisper.load_model(args.model_path)
    except Exception as e:
        err_msg = (
            f"Whisper STT model failed to load '{args.model_path}': {e}. "
            "Diagnostics: whisper module import or model weights load failed. "
            "Action: Run 'pip install openai-whisper torch' and verify network/disk access for Whisper model cache."
        )
        print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
        raise RuntimeError(err_msg) from e

    audio_array = None

    if args.stdin_pcm:
        # Read raw PCM bytes directly from stdin pipe
        raw_bytes = sys.stdin.buffer.read()
        if not raw_bytes or len(raw_bytes) == 0:
            err_msg = "No PCM audio bytes received on stdin pipe."
            print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
            raise ValueError(err_msg)

        int16_data = np.frombuffer(raw_bytes, dtype=np.int16)
        if len(int16_data) == 0:
            err_msg = "Received empty int16 PCM buffer."
            print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
            raise ValueError(err_msg)

        audio_array = int16_data.astype(np.float32) / 32767.0
        if args.sample_rate != 16000:
            duration = len(audio_array) / args.sample_rate
            num_samples = int(duration * 16000)
            audio_array = np.interp(
                np.linspace(0, len(audio_array) - 1, num_samples),
                np.arange(len(audio_array)),
                audio_array
            ).astype(np.float32)

    elif args.wav:
        if not os.path.exists(args.wav):
            err_msg = f"Audio WAV file not found: {args.wav}"
            print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
            raise FileNotFoundError(err_msg)
        audio_array = load_audio_without_ffmpeg(args.wav, target_sr=16000)

    else:
        # Record from microphone
        try:
            import sounddevice as sd
            sample_rate = args.sample_rate
            device = None
            if args.input_device:
                try:
                    device = int(args.input_device)
                except ValueError:
                    device = args.input_device
            recording = sd.rec(int(args.duration * sample_rate), samplerate=sample_rate, channels=1, dtype='float32', device=device)
            sd.wait()
            audio_array = recording.flatten()
            if sample_rate != 16000:
                duration = len(audio_array) / sample_rate
                num_samples = int(duration * 16000)
                audio_array = np.interp(
                    np.linspace(0, len(audio_array) - 1, num_samples),
                    np.arange(len(audio_array)),
                    audio_array
                ).astype(np.float32)
        except Exception as e:
            err_msg = f"Microphone recording failed: {e}. Diagnostics: Check audio input device connection and permissions."
            print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
            raise RuntimeError(err_msg) from e

    try:
        result = model.transcribe(audio_array, fp16=False)
        segments = result.get('segments', [])
        if segments:
            logprobs = [seg.get('avg_logprob', -0.1) for seg in segments]
            avg_logprob = sum(logprobs) / len(logprobs)
            confidence = min(1.0, max(0.0, math.exp(avg_logprob)))
        else:
            confidence = 1.0

        text = result.get("text", "").strip()
        output = {
            "text": text,
            "confidence": round(confidence, 4)
        }
        print(json.dumps(output), flush=True)
        sys.exit(0)
    except Exception as e:
        err_msg = (
            f"Whisper STT inference failed on audio tensor: {e}. "
            f"Diagnostics: Audio tensor length={len(audio_array)} samples, Dtype={audio_array.dtype}. "
            "Action: Verify audio input has non-zero amplitude and GPU/CPU has sufficient memory."
        )
        print(json.dumps({"error": err_msg}), file=sys.stderr, flush=True)
        raise RuntimeError(err_msg) from e

if __name__ == "__main__":
    main()
