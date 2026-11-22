# SPOTR Windows / Desktop Platform Runner (`v0.62.0`)

Contains the portable launcher and Python 3 + OpenCV RTSP streaming gateway.

## Components
- **`server.py`:** Serves `../../core` static PWA assets (with directory listing disabled) and `/api/rtsp/*` endpoints with `TCP_NODELAY`, coalesced MJPEG writes, monotonic frame sequencing, client refcounting, and strict `rtsp://` + private-IP wake validation.
- **`start_spotr.bat`:** Portable launcher that starts `server.py` on port `8080` and opens `http://localhost:8080`.

## Security & LAN Mode (iOS / iPad Gateway)
- By default, `server.py` binds strictly to **`127.0.0.1:8080`** (localhost only).
- To stream an RTSP camera to an **iPad or iPhone** on the same Wi-Fi network, launch with `--lan` (or set `SPOTR_BIND_HOST=0.0.0.0`):
  ```bat
  start_spotr.bat --lan
  ```
  Then open `http://<your-laptop-lan-ip>:8080` in Safari on your iOS/iPadOS device.

## Dependencies
- Python 3.10+
- Optional (for RTSP/Bresser Wi-Fi cameras): `pip install opencv-python`
