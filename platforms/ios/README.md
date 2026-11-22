# SPOTR on iOS / iPadOS

> **Current Status:** There is currently no compiled native Swift/Xcode wrapper in this directory. iOS and iPadOS devices are supported via **Safari PWA** and the **Windows/Desktop LAN Gateway**.

## How to Use SPOTR on iPhone / iPad
1. **Built-in Camera / Offline Reticle & Replay (Standalone PWA):**
   - Serve SPOTR over HTTPS (or local LAN) and choose **Share → Add to Home Screen** in Safari.
2. **Wi-Fi RTSP / Bresser Scopes via Desktop LAN Gateway:**
   - On a Windows, macOS, or Linux laptop connected to the same Wi-Fi network, launch the SPOTR gateway in LAN mode:
     ```bash
     python3 server.py 8080 --lan
     ```
     *(On Windows, run `start_spotr.bat --lan`.)*
   - On your iPad/iPhone, open Safari and navigate to `http://<laptop-lan-ip>:8080`.
   - Open **Setup → Camera → Wi-Fi / RTSP** — SPOTR automatically routes RTSP streams through the laptop's gateway.
