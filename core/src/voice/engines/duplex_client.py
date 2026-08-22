import sys
import os
import asyncio
import queue
import json
import io
import wave
import numpy as np
import sounddevice as sd
import websockets

# Audio config
SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 1600  # 100ms chunks

input_queue = asyncio.Queue()
output_queue = queue.Queue()
active_playback = True
loop = None

def audio_in_callback(indata, frames, time, status):
    if status:
        print(f"Input status: {status}", file=sys.stderr)
    # Convert input float32 array to 16-bit PCM bytes
    pcm_data = (indata[:, 0] * 32767.0).astype(np.int16).tobytes()
    if loop:
        loop.call_soon_threadsafe(input_queue.put_nowait, pcm_data)

def audio_out_callback(outdata, frames, time, status):
    global active_playback
    if status:
        print(f"Output status: {status}", file=sys.stderr)
    
    bytes_needed = frames * 2  # 2 bytes per sample
    data = b""
    
    if active_playback:
        while len(data) < bytes_needed and not output_queue.empty():
            try:
                data += output_queue.get_nowait()
            except queue.Empty:
                break
    
    if len(data) < bytes_needed:
        data += b'\x00' * (bytes_needed - len(data))
    
    outdata[:, 0] = np.frombuffer(data, dtype=np.int16).astype(np.float32) / 32768.0

async def mic_sender(websocket):
    while True:
        data = await input_queue.get()
        await websocket.send(data)

async def ws_receiver(websocket):
    global active_playback
    async for message in websocket:
        if isinstance(message, str):
            try:
                payload = json.loads(message)
                if payload.get("event") == "interrupt":
                    print("\n🛑 Barge-in: User interruption detected. Halting playback...", flush=True)
                    active_playback = False
                    # Drain output playback queue
                    while not output_queue.empty():
                        try:
                            output_queue.get_nowait()
                        except queue.Empty:
                            break
            except Exception as e:
                print(f"Error parsing control message: {e}", file=sys.stderr)
        else:
            # Binary response: WAV file data
            print("🔊 Received audio response reply. Playing...", flush=True)
            active_playback = True
            try:
                with wave.open(io.BytesIO(message), 'rb') as wav:
                    params = wav.getparams()
                    frames = wav.readframes(params.nframes)
                    
                    # Queue audio frames in 1600-sample blocks
                    chunk_size = 3200  # 1600 samples * 2 bytes
                    for i in range(0, len(frames), chunk_size):
                        output_queue.put(frames[i:i+chunk_size])
            except Exception as e:
                print(f"Error processing output response: {e}", file=sys.stderr)

async def run_client():
    global loop
    loop = asyncio.get_running_loop()
    
    port = os.environ.get("JARVIS_DUPLEX_PORT", "8085")
    uri = f"ws://localhost:{port}"
    print(f"Connecting to Duplex Audio Server at {uri}...")
    
    try:
        async with websockets.connect(uri) as websocket:
            print("Connected! Streaming audio duplex...")
            
            input_stream = sd.InputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                callback=audio_in_callback,
                blocksize=BLOCK_SIZE,
                dtype='float32'
            )
            output_stream = sd.OutputStream(
                samplerate=SAMPLE_RATE,
                channels=CHANNELS,
                callback=audio_out_callback,
                blocksize=BLOCK_SIZE,
                dtype='float32'
            )
            
            with input_stream, output_stream:
                print("Audio streaming active. Speak and listen. Press Ctrl+C to stop.")
                await asyncio.gather(
                    mic_sender(websocket),
                    ws_receiver(websocket)
                )
    except Exception as e:
        print(f"WebSocket client execution failed: {e}", file=sys.stderr)

if __name__ == "__main__":
    try:
        asyncio.run(run_client())
    except KeyboardInterrupt:
        print("\nClient shut down.")
