# SPOTR Android / ChromeOS APK Project (`v0.63.1` / `versionCode 66`)

Builds the standalone Android package (`com.spotr.tactical`) for Android tablets, phones, and ChromeOS devices (including **Lenovo IdeaPad Duet 3**).

## Subsystems
- **WebView Shell (`MainActivity.kt`):** Hosts the synced `/core` PWA from `http://127.0.0.1:8080`, enforces `FLAG_KEEP_SCREEN_ON`, acquires a low-latency `WifiLock`, automatically binds to no-internet camera Wi-Fi hotspots (e.g., Bresser `192.168.0.1`) on Android 10+ even when cellular data is active, and pauses background capture on `onPause()`.
- **Embedded Local Gateway (`SpotrServer.kt`):** Local NanoHTTPD server on `127.0.0.1:8080` using chunked APK asset streaming, local-origin CORS, and SSRF-hardened `/api/rtsp/*` + `/api/uvc/*` endpoints.
- **Native RTSP Engine (`RtspClient.kt`, `RtpVideoDepacketizer.kt`, `MediaCodecJpegDecoder.kt`, `RtspSessionManager.kt`):** TCP/UDP RTSP with RFC 2617 Digest auth, RFC 2435 MJPEG-over-RTP header synthesis, H.264/H.265 hardware `MediaCodec` decoding with automatic software fallback for ChromeOS ARCVM, fast semi-planar NV21 bulk UV copy, and bounded auto-reconnect.
- **Native USB UVC Engine (`UsbUvcSessionManager.kt`):** Synchronized `libuvc` hotplug capture with USB permission flow and NV21→JPEG streaming.

## Building
- **Requirements:** Java 21 (Android Studio JBR is detected automatically) and Android SDK 35.
- **Windows:** Run `build_android_apk.bat` from the repository root (`build_android_apk.bat --no-pause` for CI/scripting).
- **Gradle directly:**
  ```bash
  cd platforms/android
  ./gradlew assembleDebug
  ```
  `preBuild` automatically runs `syncCoreAssets` to mirror `../../core` into `app/src/main/assets/core`.
