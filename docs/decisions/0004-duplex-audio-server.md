# ADR 0004: Continuous Duplex Audio Server Architecture

- **Status**: Accepted
- **Date**: 2026-08-22
- **Decided By**: Jarvis Architecture Team

---

## Context and Problem Statement

For Phase 14 (Continuous Real-Time Duplex Audio), the voice interaction layer must support hands-free, continuous turn-taking conversations and spoken barge-in interruptions (similar to Gemini Live) without forcing the user to wait for output playback completion or manually trigger wake words.

Key constraints include:
1.  **Isolation**: The duplex audio engine must not break or replace the existing offline local-first wake-word-activated CLI loops.
2.  **Safety**: Outbound audio streams must respect safety boundaries, and network sockets must not expose local system APIs to external network devices.
3.  **Portability**: The implementation must avoid Node-native audio hardware compilation errors across Windows, Linux, and macOS platforms.

---

## Decision

We implemented a WebSocket-based speech-to-speech loop managed by a dedicated `DuplexAudioServer`:
*   **Opt-in WebSocket Server**: The server binds strictly to the local loopback interface (`127.0.0.1`) on a configured port (default `8085`). It acts as a passive network endpoint, isolated from external network interfaces.
*   **Dual-thread Python Audio Client**: Users interact by running a helper Python script `duplex_client.py` using `sounddevice` for hardware capture/playback and `websockets` for communication. This avoids Node.js native compilation issues on the host.
*   **RMS Energy VAD & Barge-In**: The server continuously computes Root-Mean-Square (RMS) amplitude on incoming 16-bit PCM chunks. If amplitude exceeds `voiceDuplexInterruptThreshold` while the server is active, it halts processing and sends an `{ "event": "interrupt" }` control message to abort active client playback instantly.
*   **Speech Pipeline**: Integrates Whisper STT and pyttsx3 TTS using fast local subprocess execution, maintaining local-first, low-latency offline conversation loops.

---

## Rationale and Alternatives Considered

1.  **Node-native audio libraries (e.g. `node-speaker`, `node-microphone`)**:
    *   *Rejected*: Cross-compiling native audio bindings in Node.js across Windows, macOS, and Linux requires C++ compilers and introduces significant installation and CI/CD pipeline breakage risks.
2.  **WebRTC Audio Streams**:
    *   *Rejected*: WebRTC requires a signaling server, STUN/TURN server configuration, and complex ICE negotiation, introducing excessive architectural bloat for a local-first interface.
3.  **Local Loopback WebSocket + Python Helper (Chosen)**:
    *   *Accepted*: Leverages standard WebSocket protocols built into the Node environment, using Python's highly stable `sounddevice` libraries for hardware interaction. Restricting binding to `127.0.0.1` ensures complete isolation from external network traffic.

---

## Consequences and Trade-offs

*   **Offline Dependency Setup**: Running the python client requires Python packages (`sounddevice`, `scipy`, `websockets`) on the host machine.
*   **Port Collision Safeguards**: Since multiple tests call the `bootstrap()` entrypoint, `DuplexAudioServer.start()` is gated under `!process.env.VITEST` to prevent binding conflicts during concurrent test execution.
