# SPOTR — Tactical Camera & Scope Overlay System

An installable Progressive Web App (PWA) with a high-performance Python 3 RTSP streaming gateway, designed for the **Lenovo IdeaPad Duet 3** (ChromeOS / Android) and desktop/laptop systems (Windows / macOS / Linux). SPOTR provides real-time digital magnification, First Focal Plane (FFP) graduated reticle overlays, decoupled micro-change thermal motion detection, studio female voice synthesis, rolling in-memory video recording, and hands-free control via **Sony DualShock 4 / DualSense** controllers and **5-Button Bluetooth Scrolling Rings**.

---

## Key Features

- **Dual Camera Ingestion Pipeline**:
  - **UVC USB Scopes & Webcams**: Driverless 1080p/4K @ 60 FPS capture via HTML5 `getUserMedia` with automatic hot-plug renegotiation.
  - **Bresser Full HD Wi-Fi Eyepiece Camera**: Automatic UDP wake proxy (`/api/rtsp/wake` to port 65534) and selectable Anyka DSP streams: **1080p optics (`ch0`)** and **540p high-speed (`ch1`)**.
  - **Custom RTSP / ONVIF IP Cameras**: Sub-millisecond push-event frame distribution via Python OpenCV FFmpeg bridge (`server.py`).
  - **Synthetic Test Pattern Card**: Calibrated test card with hash lines to verify compositor and reticle calibration without a physical camera connected.

- **High-Performance Compositor (60 FPS)**:
  - Desynchronized Canvas 2D contexts (`{ alpha: false, desynchronized: true }`) with GPU hardware promotion (`translateZ(0)`, `contain: strict`) and `touch-action: none` gesture suppression for zero input latency.
  - Real-time CSS GPU filter matrix (brightness, contrast, saturation, inversion, grayscale).

- **Parametric Reticle Engine & Quick Drawer**:
  - **First Focal Plane (FFP) Lock**: Reticle subtensions and tick spacing scale in lockstep with whole-image digital zoom, keeping mil/MOA angular values accurate.
  - **4 Center Aiming Symbols**: `Empty` (unobstructed window), `Dot` (precision center dot), `Cross` (mini-crosshair), and `Chevron` (inverted-V caret).
  - **Customizable Geometry**: Up to 30 clicks per arm, SVG pixel spacing, center POI gap, brackets, major tick intervals, tick number labels, and concentric range rings.
  - **6 Tactical Color Themes**: Emerald Teal, Amber Gold, High-Vis White, Night Blue, Ruby Red, and Amethyst.
  - **Live Reticle Quick Drawer**: Instant drawer on the live view for rapid in-field adjustments.

- **Decoupled 20Hz Micro-Change Heatmap Engine**:
  - Independent 50ms evaluation loop decouples heavy frame diffing from the 60 FPS render pipeline.
  - **Global Camera-Shake Gate**: Automatically rejects motion exceeding 18% of the frame (wind buffeting, recoil, tripod bumps).
  - Dirty-checking state machine eliminates zero-op canvas redraws when the scene is static.
  - Adjustable **Sensitivity (`10%–95%`)** and **Display Duration (`0.5s–10.0s` up to infinity $\infty$)**.

- **High-Fidelity Studio Voice Synthesizer & Speech Engine**:
  - Web Audio API player (`voiceAudioEngine.js`) scheduling studio-recorded female voice clips (`voice-sprite.mp3`) with zero delay.
  - Automatic fallback to browser `SpeechSynthesisUtterance`.
  - Vocalizes target clock angle ($1$ to $12$ o'clock) and graduated reticle click distance: e.g., *"Detection! 11 o'clock, 3 clicks"*.

- **Dual-Source In-Memory Ring Buffer (Zero Disk Writes)**:
  - Rolling circular RAM queue storing **5s to 60s @ 5–30 FPS** in native camera resolution from either USB `<video>` or RTSP `getRtspCanvas()`.
  - Real-time **Memory Budget Meter** (`USED` vs. `EST` vs. `FREE MB`) with automatic OOM protection.

- **Instant Replay & Stored Video Player**:
  - **0.5x Slow-Motion Toggle**: Dedicated slow-mo playback for forensic bullet trajectory and impact analysis.
  - **Dual-Direction Frame Stepping**: `STEP -1` and `STEP +1` buttons for frame-by-frame precision.
  - **Rapid Per-Video Deletion**: Individual red trash can icon on each clip card in the drawer for rapid one-tap deletion without loading the full video.
  - **IndexedDB Video Archive**: Background auto-save upon replay trigger and standalone `.webm` export.

- **Hands-Free Controller Support**:
  - **Sony DualShock 4 / DualSense (WebHID)**: Capacitive trackpad drives a virtual mouse cursor; `L2` triggers click & drag; `R2` triggers right-click; thumbsticks steer ROI and pan with non-linear acceleration.
  - **5-Button Bluetooth Scrolling Ring**: Remote finger-ring control with interactive button calibrator in Settings.

---

## Documentation & Architecture

- **Technical Architecture Document**: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Visual User Manual (Print & Landscape)**: [`docs/user_manual.html`](./docs/user_manual.html)
- **Technical Plan & Subsystems Specification**: [`docs/project_plan.txt`](./docs/project_plan.txt)
- **Interactive Architecture Infographic (HTML)**: [`docs/architecture_infographic.html`](./docs/architecture_infographic.html)
- **System Architecture Infographic (Vector SVG)**: [`docs/architecture_infographic.svg`](./docs/architecture_infographic.svg)

---

## Running Portably

### 1. One-Click Launch on Windows
Double-click **`start_spotr.bat`**. It boots the Python OpenCV streaming gateway (`server.py`) on port `8080` and opens `http://localhost:8080` in your default browser.

### 2. Command Line (Windows / macOS / Linux / ChromeOS Terminal)
```bash
python server.py 8080
```
Then navigate to **`http://localhost:8080`** in Chrome, Edge, or Brave.

*(Note: If running without OpenCV installed, `python -m http.server 8080` can be used for standard UVC USB cameras).*

### 3. Install as a Standalone Offline App (PWA)
1. Open `http://localhost:8080` in Chrome or Edge.
2. Click the **Install SPOTR** icon in the address bar (or "Add to Home Screen" on Android / ChromeOS).
3. Once installed, SPOTR launches as a standalone application window and operates **100% offline** via its built-in Service Worker (`sw.js`).
