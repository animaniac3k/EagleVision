# SPOTR ChromeOS Platform Deployment

ChromeOS (such as the Lenovo IdeaPad Duet 3) supports two primary deployment pathways:

1. **Android APK Deployment (Recommended for Wi-Fi RTSP & Standalone use)**:
   - Installs the standalone APK built from `platforms/android/`.
   - Runs directly in ChromeOS with full window resizing, offline functionality, and integrated RTSP streaming gateway.

2. **Standalone PWA (Browser-native for UVC USB Cameras)**:
   - If using USB scopes/webcams only, SPOTR installs directly from Chrome browser as a PWA with zero background server required.
   - Operates 100% offline via `core/sw.js`.
