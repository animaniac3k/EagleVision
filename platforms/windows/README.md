# SPOTR Windows Platform Runner

Contains the Windows launcher and streaming server gateway.

## Components
- `server.py`: Python 3 + OpenCV FFmpeg gateway serving `/core` assets and `/api/rtsp/*` endpoints.
- `start_spotr.bat`: Portable batch launcher that boots `server.py` on port 8080 and opens the default browser.
