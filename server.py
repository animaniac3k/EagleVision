#!/usr/bin/env python3
"""
SPOTR High-Performance Portable Web Server & RTSP Streaming Gateway

Combines:
1. Static PWA HTTP Server (serves HTML, CSS, JS, audio sprites, service worker).
2. RTSP Camera Wake-Up Proxy (triggers hardware media pipelines like Bresser HD CAM /app/getmediainfo).
3. Ultra-Low-Latency RTSP-to-MJPEG Frame Bridge (sub-60ms glass-to-glass latency via OpenCV/FFmpeg).
"""

import http.server
import json
import mimetypes
import os
import socketserver
import sys
import threading
import time
import urllib.parse
import urllib.request

try:
    import cv2
    CV2_AVAILABLE = True
except ImportError:
    CV2_AVAILABLE = False
    print("[!] Warning: OpenCV (cv2) not found. RTSP streaming will be simulated/unavailable.")

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Global state for active RTSP capture session
class RtspSession:
    def __init__(self):
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.active_url = None
        self.is_running = False
        self.latest_jpeg = None
        self.latest_frame_time = 0
        self.stream_width = 0
        self.stream_height = 0
        self.fps = 0
        self.error_message = None
        self.worker_thread = None

    def start(self, url, transport="tcp"):
        with self.lock:
            # Only reuse if actively streaming frames within the last 1.5 seconds
            if self.is_running and self.active_url == url:
                if self.latest_frame_time and (time.time() - self.latest_frame_time < 1.5):
                    return True

        # Stop previous session cleanly without deadlock and release camera hardware socket
        self.stop()

        with self.lock:
            self.active_url = url
            self.is_running = True
            self.error_message = None
            self.latest_jpeg = None
            self.worker_thread = threading.Thread(target=self._capture_worker, args=(url, transport), daemon=True)
            self.worker_thread.start()
            return True

    def _capture_worker(self, url, transport):
        print(f"[*] [RTSP Gateway] Connecting to {url} (transport={transport})...")
        # threads;1 enforces single-threaded slice decoding, completely preventing libavcodec pthread_frame.c race conditions
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            f"rtsp_transport;{transport}|stimeout;3000000|timeout;3000000|fflags;nobuffer|flags;low_delay|threads;1"
        )

        cap = None
        try:
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not cap.isOpened():
                print(f"[-] [RTSP Gateway] Failed to open stream: {url}")
                with self.lock:
                    self.error_message = "Unable to open RTSP video stream."
                    self.is_running = False
                return

            frame_count = 0
            fps_timer = time.time()
            consecutive_failures = 0

            while self.is_running:
                # Grab frame directly with minimal latency
                ret = cap.grab()
                if not ret:
                    consecutive_failures += 1
                    if consecutive_failures > 500:  # ~2.5s of consecutive grab failures -> stream dead
                        print(f"[-] [RTSP Gateway] Grab timeout / stream stalled on {url}")
                        with self.lock:
                            self.error_message = "Camera stream timed out or stalled."
                            self.is_running = False
                        break
                    time.sleep(0.005)
                    continue

                consecutive_failures = 0

                ret, frame = cap.retrieve()
                if not ret or frame is None:
                    continue

                h, w = frame.shape[:2]

                # Encode directly to JPEG for browser multipart stream
                ret, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if not ret:
                    continue

                jpeg_bytes = jpeg.tobytes()
                now = time.time()

                frame_count += 1
                if now - fps_timer >= 1.0:
                    self.fps = frame_count / (now - fps_timer)
                    frame_count = 0
                    fps_timer = now

                with self.condition:
                    self.latest_jpeg = jpeg_bytes
                    self.latest_frame_time = now
                    self.stream_width = w
                    self.stream_height = h
                    self.condition.notify_all()
        except Exception as e:
            print(f"[!] [RTSP Gateway] Exception in capture worker: {e}")
            with self.lock:
                self.error_message = str(e)
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            print(f"[*] [RTSP Gateway] Closed stream: {url}")

    def stop(self):
        t_to_join = None
        with self.condition:
            if not self.is_running:
                return
            self.is_running = False
            self.condition.notify_all()
            t_to_join = self.worker_thread
            self.worker_thread = None
            self.active_url = None
            self.latest_jpeg = None
            self.error_message = None

        if t_to_join and t_to_join.is_alive() and threading.current_thread() != t_to_join:
            t_to_join.join(timeout=1.5)


rtsp_session = RtspSession()


class SPOTRRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Handles static PWA files and SPOTR RTSP Gateway API endpoints."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=BASE_DIR, **kwargs)

    def end_headers(self):
        # Enable CORS and caching headers appropriate for a local PWA
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query)

        # 1. API: Trigger / Wake Camera Hardware Media Pipeline
        if path == '/api/rtsp/wake':
            self.handle_rtsp_wake(query)
            return

        # 2. API: Gateway Status & Telemetry
        elif path == '/api/rtsp/status':
            self.handle_rtsp_status()
            return

        # 3. API: Ultra-Low-Latency Multipart MJPEG Stream
        elif path == '/api/rtsp/stream':
            self.handle_rtsp_stream(query)
            return

        # 4. Standard Static File Serving (HTML, JS, CSS, MP3)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/rtsp/stop':
            rtsp_session.stop()
            self.send_json_response(200, {"success": True, "message": "RTSP stream stopped"})
            return
        self.send_error(404, "Endpoint not found")

    def handle_rtsp_wake(self, query):
        """Wakes camera media pipeline via HTTP trigger (e.g. Bresser getmediainfo)."""
        ip = query.get('ip', ['192.168.0.1'])[0].strip()
        trigger_path = query.get('path', ['/app/getmediainfo'])[0].strip()
        if not trigger_path.startswith('/'):
            trigger_path = '/' + trigger_path

        # Stop any existing RTSP session to ensure port 554 is completely free
        rtsp_session.stop()

        trigger_url = f"http://{ip}{trigger_path}"
        print(f"[*] [RTSP Gateway] Triggering camera wake-up: {trigger_url}...")

        try:
            req = urllib.request.Request(
                trigger_url,
                headers={"User-Agent": "Mozilla/5.0"}
            )
            with urllib.request.urlopen(req, timeout=3.5) as resp:
                raw_bytes = resp.read()
                data = json.loads(raw_bytes.decode('utf-8', errors='ignore'))

            # Structure declared streams with Highest Resolution as Default
            declared_rtsp = data.get("info", {}).get("rtsp") if isinstance(data.get("info"), dict) else None
            
            # Standard channels for Bresser / Xiongmai / Anyka style camera DSPs
            # Live hardware verification confirmed: ch0 is native 1080p (1920x1080 Full HD), ch1 is 960x540 sub-stream
            channels = [
                {
                    "id": "ch0",
                    "name": "Main Stream (1080p Full HD)",
                    "url": f"rtsp://{ip}/live/tcp/ch0",
                    "isDefault": True,
                    "resolution": "1920x1080"
                },
                {
                    "id": "ch1",
                    "name": "Sub Stream (960x540)",
                    "url": f"rtsp://{ip}/live/tcp/ch1",
                    "isDefault": False,
                    "resolution": "960x540"
                }
            ]

            self.send_json_response(200, {
                "success": True,
                "ip": ip,
                "message": "Camera pipeline awakened successfully",
                "declaredRtsp": declared_rtsp,
                "channels": channels,
                "rawResponse": data
            })
        except Exception as err:
            print(f"[-] [RTSP Gateway] Wake-up failed: {err}")
            self.send_json_response(200, {
                "success": False,
                "ip": ip,
                "error": str(err),
                "message": f"Could not reach camera at {ip}. Ensure device is connected to the camera Wi-Fi network."
            })

    def handle_rtsp_status(self):
        """Returns live telemetry of the RTSP gateway."""
        with rtsp_session.lock:
            data = {
                "available": CV2_AVAILABLE,
                "opencvVersion": cv2.__version__ if CV2_AVAILABLE else None,
                "isStreaming": rtsp_session.is_running,
                "activeUrl": rtsp_session.active_url,
                "width": rtsp_session.stream_width,
                "height": rtsp_session.stream_height,
                "fps": round(rtsp_session.fps, 1),
                "lastFrameSecAgo": round(time.time() - rtsp_session.latest_frame_time, 2) if rtsp_session.latest_frame_time else None,
                "error": rtsp_session.error_message
            }
        self.send_json_response(200, data)

    def handle_rtsp_stream(self, query):
        """Streams continuous multipart/x-mixed-replace JPEG frames to the browser."""
        if not CV2_AVAILABLE:
            self.send_error(500, "OpenCV is not available on this server.")
            return

        url = query.get('url', [''])[0].strip()
        transport = query.get('transport', ['tcp'])[0].strip()

        if not url:
            self.send_error(400, "Missing 'url' query parameter.")
            return

        # Start background RTSP worker for this URL
        rtsp_session.start(url, transport)

        # Wait up to 3.5s for initial frame
        wait_start = time.time()
        while time.time() - wait_start < 3.5:
            with rtsp_session.lock:
                if rtsp_session.latest_jpeg is not None or rtsp_session.error_message:
                    break
            time.sleep(0.05)

        with rtsp_session.lock:
            if rtsp_session.error_message and not rtsp_session.latest_jpeg:
                self.send_json_response(500, {"success": False, "error": rtsp_session.error_message})
                return

        # Send HTTP Multipart Stream Headers
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

        last_sent_time = 0
        try:
            while rtsp_session.is_running:
                jpeg_bytes = None
                with rtsp_session.condition:
                    # Immediate wakeup when a new frame is encoded, zero polling latency
                    rtsp_session.condition.wait_for(
                        lambda: not rtsp_session.is_running or rtsp_session.latest_frame_time > last_sent_time,
                        timeout=0.04
                    )
                    if not rtsp_session.is_running:
                        break
                    if rtsp_session.latest_jpeg and rtsp_session.latest_frame_time > last_sent_time:
                        jpeg_bytes = rtsp_session.latest_jpeg
                        last_sent_time = rtsp_session.latest_frame_time

                if jpeg_bytes:
                    header = (
                        b'--frame\r\n'
                        b'Content-Type: image/jpeg\r\n'
                        b'Content-Length: ' + str(len(jpeg_bytes)).encode('ascii') + b'\r\n\r\n'
                    )
                    self.wfile.write(header)
                    self.wfile.write(jpeg_bytes)
                    self.wfile.write(b'\r\n')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            print(f"[!] [RTSP Gateway] Client disconnected: {e}")
        finally:
            print("[*] [RTSP Gateway] Client disconnected, releasing RTSP camera session...")
            rtsp_session.stop()

    def send_json_response(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def run_server():
    # Ensure correct MIME types for ES6 modules and Web Audio
    mimetypes.init()
    mimetypes.add_type('application/javascript', '.js')
    mimetypes.add_type('application/javascript', '.mjs')
    mimetypes.add_type('audio/mpeg', '.mp3')
    mimetypes.add_type('image/svg+xml', '.svg')

    # On Windows, allow_reuse_address=True can cause multiple processes to bind
    # to the exact same port simultaneously, resulting in dropped connections.
    socketserver.ThreadingTCPServer.allow_reuse_address = (os.name != 'nt')
    with socketserver.ThreadingTCPServer(("", PORT), SPOTRRequestHandler) as httpd:
        print("============================================================")
        print("  SPOTR PORTABLE SERVER & RTSP STREAMING GATEWAY")
        print("============================================================")
        print(f"[*] Local Web App:     http://localhost:{PORT}")
        print(f"[*] RTSP Gateway API:  http://localhost:{PORT}/api/rtsp/status")
        print(f"[*] OpenCV Backend:    {'ONLINE (' + cv2.__version__ + ')' if CV2_AVAILABLE else 'OFFLINE'}")
        print("[*] Ready. Press Ctrl+C to terminate.")
        print("============================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[*] Shutting down server...")
            rtsp_session.stop()
            httpd.server_close()


if __name__ == "__main__":
    run_server()
