# SPOTR Android / ChromeOS APK Project

Builds the standalone Android package (`.apk`) for Android tablets, phones, and ChromeOS devices.

## Subsystems
- **WebView Interface Shell**: Hosts the `/core` HTML5/Canvas desynchronized GUI with hardware acceleration.
- **Embedded Gateway Server**: Local background service handling static assets, UDP wake proxy (`/api/rtsp/wake`), and RTSP-to-MJPEG frame distribution (`/api/rtsp/stream`).
