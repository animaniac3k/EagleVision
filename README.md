# SPOTR — Tactical Camera & Scope Overlay System

An installable Progressive Web App (PWA) and native Android/ChromeOS app (`platforms/android`) with a high-performance Python 3 RTSP streaming gateway (`server.py`), designed for the **Lenovo IdeaPad Duet 3** (ChromeOS / Android), Android tablets/phones, and desktop/laptop systems (Windows / macOS / Linux). SPOTR provides real-time digital magnification, First Focal Plane (FFP) graduated reticle overlays, consolidated micro-motion detection with 1:1 synced studio voice callouts, rolling in-memory instant replay, and hands-free control via **DualShock 4 / DualSense**, **8BitDo Micro**, and **Bluetooth Scrolling Rings**.

---

## Key Features

- **Multi-Source Camera Ingestion**:
  - **UVC USB Scopes & Webcams**: Driverless 1080p/4K @ 60 FPS capture via HTML5 `getUserMedia` (plus native Android libuvc bridge via `UsbUvcSessionManager.kt`).
  - **Bresser Full HD Wi-Fi Eyepiece Camera**: Automatic UDP wake proxy (`/api/rtsp/wake` to port 65534) and selectable `ch0` (1080p) / `ch1` (540p) streams.
  - **Custom RTSP / ONVIF IP Cameras**: Sub-millisecond push-event frame distribution via Python OpenCV (`server.py`) or Android `MediaCodec` (`RtspSessionManager.kt`).
  - **Built-In Test Signal**: Calibrated 1080p test pattern for offline reticle and detection testing.

- **High-Performance 60 FPS Compositor & Digital Loupe**:
  - Desynchronized Canvas 2D contexts (`{ alpha: false, desynchronized: true }`) with GPU hardware promotion and `touch-action: none`.
  - **Main-Screen `Aim Loupe`**: One-tap button on the Live dock snaps the draggable/resizable Picture-in-Picture Digital Loupe (`1.5x–12.0x`) directly onto the latest detected hit.

- **Parametric Reticle Engine & Per-Screen Toggles**:
  - **First Focal Plane (FFP) Lock**: Reticle subtensions and click spacing scale proportionally with digital zoom.
  - **4 Center Aiming Symbols** (`Empty`, `Dot`, `Cross`, `Chevron`), up to 30 clicks/arm, configurable gap, concentric rings, and custom image upload.
  - **Independent Reticle Defaults**: Always customizable on Live (`overlayEnabled`), **OFF by default in Playback**, and **ON by default on the Hits map**.

- **Consolidated 20Hz Detection Engine (Hits + Voice Synced 1:1)**:
  - Single detection pipeline drives **Spatial Hit Pins**, **Voice Callouts**, **Timeline Markers**, and optional **Hit Auto-Save** from the exact same confirmed event.
  - **Multi-Hit / Large-Area Gate (`Max Hit Area`)**: Suppresses detection when simultaneous motion exceeds a customizable percentage of the screen (default **`5%` / `1/20th`**), plus **`Min Hit Size`** (`1–20` cells) and **`>18%` global shake re-anchor**.
  - **Auto-Save Clip on Hit**: **OFF by default** in Setup → Detection & Voice to prevent recorder spam (15s+ cooldown when enabled).

- **Unified Instant Replay, Playback & Spatial Hits Map (Screen 2)**:
  - **Instant Replay (`LIVE BUFFER`)**: Pressing **Replay** pauses ring-buffer capture (`currentScreen !== 'live'`), snapshots the rolling RAM buffer (`5s–60s @ 5–30 FPS`), and opens Unified Playback without auto-saving—tap **`Save Clip`** only when you want to keep it.
  - **Playback Tools**: `0.5x` slow-motion, `-1 / +1` frame stepping, event markers, `Reticle: OFF/ON`, `.webm` export, and PNG snapshot.
  - **Spatial Hits Map**: Clean numbered pins (no popup text clutter), **`Hits: ON/OFF`** to inspect target marks underneath, **`👁 Masks (N)`** visual toggle, **`✎ Edit Masks`** drag-draw & confirmed **`Clear All`**, and **`Re-Zero`** (re-anchors background and clears hit pins/log).

- **Hands-Free Controller Support**:
  - **Sony DualShock 4 / DualSense (WebHID)** with capacitive touchpad virtual mouse, `L2`/`R2` click-drag, **8BitDo Micro (K-Mode)**, and **Bluetooth Ring / Remote** calibration in Setup → Controllers.

---

## Documentation & Visual Guides

- **Visual User Manual (HTML)**: [`docs/user_manual.html`](./docs/user_manual.html)
- **Printable User Manual (PDF)**: [`docs/USER_MANUAL.pdf`](./docs/USER_MANUAL.pdf)
- **Technical Architecture Document**: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Architecture Infographic**: [`docs/architecture_infographic.html`](./docs/architecture_infographic.html) | [`docs/architecture_infographic.svg`](./docs/architecture_infographic.svg)
- **Technical Specification**: [`docs/project_plan.txt`](./docs/project_plan.txt)

---

## Running & Building

- **Windows**: Double-click **`start_spotr.bat`** (starts `server.py` on port `8080` and opens `http://localhost:8080`).
- **macOS / Linux / ChromeOS**: Run `python server.py 8080` and open `http://localhost:8080`.
- **Android APK**: Run **`build_android_apk.bat`** (syncs `core/` into `platforms/android/app/src/main/assets/core` and builds `app-debug.apk`).
