# EagleVision — USB Camera & Overlay System

An installable Progressive Web App (PWA) designed for the **Lenovo IdeaPad Duet 3** (ChromeOS / Android) and desktop/laptop systems to view, magnify, superimpose reticles, perform real-time temporal comparisons, and record a rolling 20-second in-memory video buffer from USB cameras.

## Documentation & Architecture Infographic
- **Technical Plan & Specification**: [`docs/project_plan.txt`](./docs/project_plan.txt)
- **System Architecture Infographic (SVG)**: [`docs/architecture_infographic.svg`](./docs/architecture_infographic.svg)
- **Interactive Architecture Infographic (HTML)**: [`docs/architecture_infographic.html`](./docs/architecture_infographic.html)

## Running Portably (From a USB Stick or Local Folder)

### 1. One-Click Launch on Windows
Double-click **`start_eaglevision.bat`**. It will start a lightweight local HTTP server on port `8080` and automatically open `http://localhost:8080` in your default browser.

### 2. Command Line (Windows / macOS / Linux / ChromeOS Linux)
```bash
python -m http.server 8080
```
Then open **`http://localhost:8080`** in Chrome or Edge.

### 3. Install as a Standalone Offline App (PWA)
While viewing `http://localhost:8080` in Chrome or Edge, click the **Install EagleVision** icon in the address bar. Once installed, EagleVision runs as a standalone app window and works **100% offline** via its built-in Service Worker (`sw.js`).
