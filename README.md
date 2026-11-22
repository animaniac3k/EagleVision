# SPOTR — Tactical Camera & Scope Overlay System (`v0.62.1`)

> **Repository Note:** The `EagleVision` repository hosts **SPOTR** (*Recon • Detect • Alert • Optical Precision*).

An offline-first Progressive Web App (PWA), native **Android & ChromeOS APK** (`platforms/android`, `versionCode 63`), and local **Python 3 + OpenCV RTSP gateway** (`platforms/windows/server.py`) engineered for reliable field use and slow/4 GB ARM tablets (such as the **Lenovo IdeaPad Duet 3**).

---

## Platform Support Matrix

| Platform | Status | Camera Sources | How to Run |
| :--- | :--- | :--- | :--- |
| **Windows 10 / 11** | Full Support | USB UVC (`getUserMedia`) + Wi-Fi RTSP / Bresser (`server.py` OpenCV) | Double-click [`start_spotr.bat`](./start_spotr.bat) |
| **Android / ChromeOS** | Full Support (Native APK) | Native USB UVC (`libuvc`) + Native RTSP (`MediaCodec` H.264/H.265/MJPEG) + Built-in cameras | Build via [`build_android_apk.bat`](./build_android_apk.bat) |
| **macOS / Linux** | Full Support | USB UVC (`getUserMedia`) + Wi-Fi RTSP (`server.py` OpenCV) | `python3 server.py 8080` → `http://localhost:8080` |
| **iOS / iPadOS** | PWA + Remote LAN Gateway | Built-in cameras (PWA) or RTSP via desktop gateway (`--lan`) | Run `start_spotr.bat --lan` on Windows/Mac, open LAN IP in Safari |

---

## Key Features (`v0.62.1`)

- **Clean Translucent Glass Live Workspace**:
  - **Bottom Control Dock:** Compact translucent glass dock (`Reticle · FFP`, `Hits | 🗑 | ⚙`, `Voice OFF/POI/POA`, `Loupe ON/AA/OFF`, `Zoom −/1.0x/+`, `Replay · 20s ▴`) keeping the sight picture unobstructed.
  - **Quiet Top-Left Controls:** Icon-only **Setup** (`⚙`) and **Clean View** (`👁`) pills that stay accessible even in Clean View mode.
  - **6 Tactical UI Themes + Custom Color Picker** with WCAG-computed button text contrast.

- **Multi-Source Camera Ingestion & Resilient Native Gateways**:
  - **USB UVC Scopes & Webcams:** Browser `getUserMedia` + native Android `libuvc` hotplug capture (`UsbUvcSessionManager.kt`).
  - **Bresser Wi-Fi (`192.168.0.1`) & ONVIF/RTSP Cameras:** Validated local wake proxy (`/api/rtsp/wake`), `ch0` (1080p) / `ch1` (540p) streams, RFC 2617 Digest auth, RFC 2435 MJPEG-over-RTP, Android 10+ no-internet camera Wi-Fi binding, `FLAG_KEEP_SCREEN_ON`, low-latency `WifiLock`, 4-step automatic exponential-backoff reconnect, and `TCP_NODELAY` coalesced writes on Windows.

- **Slow-Hardware & Battery Optimizations (Lenovo Duet 3 Ready)**:
  - Demand-driven compositor & gamepad loops (0% CPU when hidden, paused, or controller unplugged), USB `<video>` frame deduplication, lazy studio voice sprite decoding (saves 19–38 MB RAM when muted), `navigator.deviceMemory` RAM buffer caps (`<= 220 MB` on 4 GB tablets), and fast semi-planar NV21 UV bulk copy on Android.

- **Detection Calibration (Screen 6) & 1:1 Synced Voice**:
  - Live 1:1 thermal heatmap debug view, **1-Tap `✦ Auto-Tune`**, live noise-floor meter, draggable **Ignore Zones**, and 1:1 synced Hit Pin + Cartesian/clock-face Voice Callouts (`OFF → POI → POA`).

- **Unified Instant Replay & Spatial Hits Map (Screen 2)**:
  - **Playback Tab:** Unsaved `LIVE BUFFER (RAM)` review (`0.5x` slow-mo, `-1/+1` stepping, audio-peak CCTV scrubber, on-demand **Save Clip** to IndexedDB, `.webm` export with upfront save-file picker).
  - **Hits Map:** Synchronized `Reticle: ON/OFF` & `Hits: ON/OFF` toggles, hit timestamps, 1-tap **Re-Zero** & **Clear**, collapsible Hit Log drawer, and annotated PNG snapshot export.

- **Isolated Hands-Free Controllers**:
  - **DualShock 4 / DualSense (WebHID)** with touchpad virtual mouse, **8BitDo Micro (K-Mode)**, and **Bluetooth Ring (Isolated / OFF by default)** so a Ring never hijacks 8BitDo Micro or keyboard shortcuts.

---

## Documentation & Printable Field Guides

- **1-Page Printable Field Cheat Sheet (Laminate for Range Bag):** [`docs/field_cheat_sheet.html`](./docs/field_cheat_sheet.html)
- **Visual Field Manual (Responsive HTML + Low-Ink Print):** [`docs/user_manual.html`](./docs/user_manual.html)
- **Printable User Manual (PDF):** [`docs/USER_MANUAL.pdf`](./docs/USER_MANUAL.pdf) *(regenerate anytime via `python docs/build_manual_pdf.py`)*
- **Technical Architecture & API Reference:** [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- **Offline Architecture Infographic:** [`docs/architecture_infographic.html`](./docs/architecture_infographic.html) | [`docs/architecture_infographic.svg`](./docs/architecture_infographic.svg)

---

## Quick-Start by Device

- **Windows:** Double-click [`start_spotr.bat`](./start_spotr.bat) (binds `127.0.0.1:8080` by default; pass `--lan` to share over local Wi-Fi for iOS/iPad).
- **macOS / Linux / ChromeOS:** Run `python3 server.py 8080` (or `python3 server.py 8080 --lan`) and open `http://localhost:8080`.
- **Android / ChromeOS APK:** Run [`build_android_apk.bat`](./build_android_apk.bat) (auto-detects Android Studio JBR / JDK 21, syncs `core/` assets, and outputs `platforms/android/app/build/outputs/apk/debug/app-debug.apk`).
