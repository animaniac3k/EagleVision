# EagleVision — USB Camera & Overlay System

An installable Progressive Web App (PWA) designed for the **Lenovo IdeaPad Duet 3** (ChromeOS / Android) and desktop/laptop systems to view, magnify, superimpose open-center reticles or custom guides, highlight localized micro-changes via a shake-rejecting heatmap, record a configurable native-resolution in-memory video buffer, and control the entire interface hands-free with a **5-Button Bluetooth Scrolling Ring**.

## Key Features
- **Unified Top-Left Toolbar**: Settings Toggle, PiP Zoom Window Toggle (POI target icon), Superimposed Overlay On/Off Toggle, Localized Micro-Change Heatmap Toggle, Stream Telemetry HUD Toggle, and the Whole-Image Zoom Stepper (`−` / `1.0x` / `+` / `1:1`).
- **Movable & Corner-Resizable Digital Zoom Window (PiP)**: Paired with a decoupled, hideable ROI Target Crosshair.
- **Open-Center Crosshair & Custom Image Overlay**: Unobstructed `64×64px` center gap with inner bracket ticks (and no circular ring) plus custom PNG/SVG/WebP image loading (`LOAD IMG`).
- **Localized Micro-Change Heatmap**: Highlights subtle localized changes in high-contrast thermal/radar colors while automatically rejecting global camera shake (`>18%` simultaneous frame change), with adjustable **Sensitivity (`10%–95%`)** and **Display Duration (`0.5s–10.0s`)**.
- **Native-Resolution Configurable In-Memory Ring Buffer**: Adjustable **Duration (`5s–60s`)** and **Frame Rate (`5–30 FPS`)** in RAM with a live **Memory Budget Meter** (`USED` vs. `EST` vs. `FREE MB`).
- **One-Tap Auto-Saving Instant Replay & Fullscreen Stored Video Player**: Instant 60fps RAM replay that automatically saves clips to IndexedDB, plus a 100% fullscreen archive player with a floating GUI overlay, `0.5x` slow-motion, `STEP +1` frame advance, and native-resolution `.webm` export.
- **Interface Appearance & Global Opacity**: 6 tactical color swatches + 2D color picker (`HSL` engine) and a **Global Interface Opacity (`15%–100%`)** slider to fade all floating UI elements in and out together.
- **5-Button Bluetooth Scrolling Ring Remote**: Full hands-free control (`AIM ROI`, `ZOOM`, `TOOLS`, and `PLAYER` modes + double-click Instant Replay) with built-in button calibration in Settings.

## Documentation & Architecture Infographic
- **Technical Plan & Specification**: [`docs/project_plan.txt`](./docs/project_plan.txt)
- **System Architecture Infographic (SVG)**: [`docs/architecture_infographic.svg`](./docs/architecture_infographic.svg)
- **Interactive Architecture Infographic (HTML)**: [`docs/architecture_infographic.html`](./docs/architecture_infographic.html)

## Running Portably (From a USB Stick or Local Folder)

### 1. One-Click Launch on Windows
Double-click **`start_eaglevision.bat`**. It starts a lightweight local HTTP server on port `8080` and opens `http://localhost:8080` in your default browser.

### 2. Command Line (Windows / macOS / Linux / ChromeOS Linux)
```bash
python -m http.server 8080
```
Then open **`http://localhost:8080`** in Chrome or Edge.

### 3. Install as a Standalone Offline App (PWA)
While viewing `http://localhost:8080` in Chrome or Edge, click the **Install EagleVision** icon in the address bar. Once installed, EagleVision runs as a standalone app window and works **100% offline** via its built-in Service Worker (`sw.js`).
