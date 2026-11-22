#!/usr/bin/env python3
"""
SPOTR High-Performance Portable Web Server & RTSP Streaming Gateway

Combines:
1. Static PWA HTTP Server (serves HTML, CSS, JS, audio sprites, service worker).
2. RTSP Camera Wake-Up Proxy (triggers hardware media pipelines like Bresser HD CAM /app/getmediainfo).
3. Ultra-Low-Latency RTSP-to-MJPEG Frame Bridge (sub-60ms glass-to-glass latency via OpenCV/FFmpeg).
"""

import http.server
import ipaddress
import json
import mimetypes
import os
import re
import socket
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

PORT = 8080
BIND_HOST = os.environ.get("SPOTR_BIND_HOST", "127.0.0.1").strip() or "127.0.0.1"
BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# Auto-detect web assets directory (supports both platforms/windows/ and root execution)
if os.path.isdir(os.path.join(BASE_DIR, "core")):
    WEB_DIR = os.path.join(BASE_DIR, "core")
elif os.path.isdir(os.path.abspath(os.path.join(BASE_DIR, "..", "..", "core"))):
    WEB_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "..", "core"))
elif os.path.isdir(os.path.abspath(os.path.join(BASE_DIR, "..", "core"))):
    WEB_DIR = os.path.abspath(os.path.join(BASE_DIR, "..", "core"))
else:
    WEB_DIR = BASE_DIR

_VALID_HOST_RE = re.compile(r"^[A-Za-z0-9.-]{1,128}$")
_VALID_PATH_RE = re.compile(r"^/[A-Za-z0-9._/~-]{0,200}$")
_ALLOWED_TRANSPORTS = frozenset(("tcp", "udp"))


def is_safe_local_host(host: str) -> bool:
    """Permit only private, link-local, or loopback hosts for camera wake proxy."""
    if not host or not _VALID_HOST_RE.match(host):
        return False
    try:
        ip_obj = ipaddress.ip_address(host)
        return ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_loopback
    except ValueError:
        try:
            resolved = socket.gethostbyname(host)
            ip_obj = ipaddress.ip_address(resolved)
            return ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_loopback
        except Exception:
            return False


def is_valid_rtsp_url(url: str) -> bool:
    if not url or any(c in url for c in ("\r", "\n", "\x00", "|")):
        return False
    parsed = urllib.parse.urlparse(url)
    return parsed.scheme.lower() == "rtsp" and bool(parsed.hostname)


# Global state for active RTSP capture session
class RtspSession:
    def __init__(self):
        self.lock = threading.Lock()
        self.condition = threading.Condition(self.lock)
        self.active_url = None
        self.is_running = False
        self.latest_jpeg = None
        self.latest_frame_seq = 0
        self.latest_frame_time = 0.0
        self.stream_width = 0
        self.stream_height = 0
        self.fps = 0.0
        self.error_message = None
        self.worker_thread = None
        self.encode_paused = False
        self.session_id = 0
        self.active_clients = 0

    def set_encode_paused(self, paused):
        with self.lock:
            self.encode_paused = bool(paused)

    def start(self, url, transport="tcp"):
        clean_transport = transport if transport in _ALLOWED_TRANSPORTS else "tcp"
        now = time.monotonic()
        with self.lock:
            # Only reuse if actively streaming frames within the last 1.5 seconds
            if self.is_running and self.active_url == url:
                if self.latest_frame_time and (now - self.latest_frame_time < 1.5):
                    return self.session_id

        # Stop previous session cleanly without deadlock and release camera hardware socket
        self.stop()

        with self.lock:
            self.session_id += 1
            sid = self.session_id
            self.active_url = url
            self.is_running = True
            self.error_message = None
            self.latest_jpeg = None
            self.latest_frame_seq = 0
            self.latest_frame_time = 0.0
            self.stream_width = 0
            self.stream_height = 0
            self.fps = 0.0
            self.encode_paused = False
            self.active_clients = 0
            self.worker_thread = threading.Thread(
                target=self._capture_worker,
                args=(sid, url, clean_transport),
                daemon=True
            )
            self.worker_thread.start()
            return sid

    def register_client(self, sid):
        with self.lock:
            if self.session_id == sid and self.is_running:
                self.active_clients += 1

    def unregister_client(self, sid):
        should_stop = False
        with self.lock:
            if self.session_id == sid:
                self.active_clients = max(0, self.active_clients - 1)
                should_stop = (self.active_clients == 0)
        if should_stop:
            self.stop(expected_session_id=sid)

    def _capture_worker(self, sid, url, transport):
        print(f"[*] [RTSP Gateway] Connecting to {url} (transport={transport})...")
        # threads;1 enforces single-threaded slice decoding, preventing libavcodec pthread_frame race conditions
        # Use FFmpeg-compatible timeout option without conflicting stimeout+timeout keys
        os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
            f"rtsp_transport;{transport}|timeout;3000000|fflags;nobuffer|flags;low_delay|threads;1"
        )

        cap = None
        try:
            cap = cv2.VideoCapture(url, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

            if not cap.isOpened():
                print(f"[-] [RTSP Gateway] Failed to open stream: {url}")
                with self.condition:
                    if self.session_id == sid:
                        self.error_message = "Unable to open RTSP video stream."
                        self.is_running = False
                        self.condition.notify_all()
                return

            frame_count = 0
            fps_timer = time.monotonic()
            consecutive_failures = 0

            while True:
                with self.lock:
                    if not self.is_running or self.session_id != sid:
                        break
                    paused = self.encode_paused

                ret = cap.grab()
                if not ret:
                    consecutive_failures += 1
                    if consecutive_failures > 500:  # ~2.5s of consecutive grab failures -> stream dead
                        print(f"[-] [RTSP Gateway] Grab timeout / stream stalled on {url}")
                        with self.condition:
                            if self.session_id == sid:
                                self.error_message = "Camera stream timed out or stalled."
                                self.is_running = False
                                self.condition.notify_all()
                        break
                    time.sleep(0.005)
                    continue

                consecutive_failures = 0

                if paused:
                    time.sleep(0.015)
                    continue

                ret, frame = cap.retrieve()
                if not ret or frame is None:
                    continue

                h, w = frame.shape[:2]

                # Encode directly to JPEG for browser multipart stream
                ret, jpeg = cv2.imencode('.jpg', frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if not ret:
                    continue

                jpeg_bytes = jpeg.tobytes()
                now = time.monotonic()

                frame_count += 1
                updated_fps = None
                if now - fps_timer >= 1.0:
                    updated_fps = frame_count / (now - fps_timer)
                    frame_count = 0
                    fps_timer = now

                with self.condition:
                    if self.session_id != sid or not self.is_running:
                        break
                    self.latest_jpeg = jpeg_bytes
                    self.latest_frame_seq += 1
                    self.latest_frame_time = now
                    self.stream_width = w
                    self.stream_height = h
                    if updated_fps is not None:
                        self.fps = updated_fps
                    self.condition.notify_all()
        except Exception as e:
            print(f"[!] [RTSP Gateway] Exception in capture worker: {e}")
            with self.condition:
                if self.session_id == sid:
                    self.error_message = str(e)
                    self.is_running = False
                    self.condition.notify_all()
        finally:
            if cap is not None:
                try:
                    cap.release()
                except Exception:
                    pass
            with self.condition:
                if self.session_id == sid:
                    self.is_running = False
                    self.condition.notify_all()
            print(f"[*] [RTSP Gateway] Closed stream: {url}")

    def stop(self, expected_session_id=None):
        t_to_join = None
        with self.condition:
            if expected_session_id is not None and expected_session_id != self.session_id:
                return
            if not self.is_running:
                if expected_session_id is None:
                    self.error_message = None
                return
            self.is_running = False
            self.active_clients = 0
            self.condition.notify_all()
            t_to_join = self.worker_thread
            self.worker_thread = None
            self.active_url = None
            self.latest_jpeg = None
            self.error_message = None

        if t_to_join and t_to_join.is_alive() and threading.current_thread() != t_to_join:
            t_to_join.join(timeout=1.5)


rtsp_session = RtspSession()


class SPOTRServer(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = (os.name != 'nt')


class SPOTRRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Handles static PWA files and SPOTR RTSP Gateway API endpoints."""

    # Eliminate 40-200ms Nagle + Delayed-ACK stalls per MJPEG frame on Windows
    disable_nagle_algorithm = True

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    def _allowed_origin(self):
        origin = self.headers.get("Origin", "").strip()
        if BIND_HOST == "0.0.0.0":
            return origin or "*"
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            return origin
        return f"http://localhost:{PORT}"

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', self._allowed_origin())
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()

    def list_directory(self, path):
        self.send_error(403, "Directory listing is disabled")
        return None

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

        # 3b. API: Android UVC probe stub (avoids 404 noise on desktop gateways)
        elif path == '/api/uvc/list':
            self.send_json_response(200, {"supported": False, "cameras": []})
            return

        # 4. Standard Static File Serving (HTML, JS, CSS, MP3)
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == '/api/rtsp/stop':
            rtsp_session.stop()
            self.send_json_response(200, {"success": True, "message": "RTSP stream stopped"})
            return
        if parsed.path == '/api/rtsp/pause':
            query = urllib.parse.parse_qs(parsed.query)
            paused_raw = query.get('paused', ['1'])[0].strip().lower()
            paused = paused_raw in ('1', 'true')
            rtsp_session.set_encode_paused(paused)
            self.send_json_response(200, {"success": True, "paused": paused})
            return
        self.send_error(404, "Endpoint not found")

    def handle_rtsp_wake(self, query):
        """Wakes camera media pipeline via HTTP trigger (e.g. Bresser getmediainfo)."""
        ip = query.get('ip', ['192.168.0.1'])[0].strip()
        trigger_path = query.get('path', ['/app/getmediainfo'])[0].strip()
        if not trigger_path.startswith('/'):
            trigger_path = '/' + trigger_path

        if not is_safe_local_host(ip) or not _VALID_PATH_RE.match(trigger_path) or '..' in trigger_path:
            self.send_json_response(400, {
                "success": False,
                "ip": ip,
                "error": "Invalid local camera IP or wake path.",
                "message": "Only local/private network camera addresses are permitted."
            })
            return

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
                raw_text = resp.read().decode('utf-8', errors='ignore')
                try:
                    data = json.loads(raw_text)
                except json.JSONDecodeError:
                    data = {"raw": raw_text}

            declared_rtsp = data.get("info", {}).get("rtsp") if isinstance(data, dict) and isinstance(data.get("info"), dict) else None

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
        now = time.monotonic()
        with rtsp_session.lock:
            data = {
                "available": CV2_AVAILABLE,
                "opencvVersion": cv2.__version__ if CV2_AVAILABLE else None,
                "isStreaming": rtsp_session.is_running,
                "activeUrl": rtsp_session.active_url,
                "width": rtsp_session.stream_width,
                "height": rtsp_session.stream_height,
                "fps": round(rtsp_session.fps, 1),
                "lastFrameSecAgo": round(now - rtsp_session.latest_frame_time, 2) if rtsp_session.latest_frame_time else None,
                "error": rtsp_session.error_message
            }
        self.send_json_response(200, data)

    def handle_rtsp_stream(self, query):
        """Streams continuous multipart/x-mixed-replace JPEG frames to the browser."""
        if not CV2_AVAILABLE:
            self.send_json_response(500, {"success": False, "error": "OpenCV is not available on this server."})
            return

        url = query.get('url', [''])[0].strip()
        transport = query.get('transport', ['tcp'])[0].strip().lower()

        if not is_valid_rtsp_url(url):
            self.send_json_response(400, {"success": False, "error": "Missing or invalid 'url' query parameter (must be rtsp://)."})
            return

        if transport not in _ALLOWED_TRANSPORTS:
            self.send_json_response(400, {"success": False, "error": "Invalid 'transport' parameter (must be 'tcp' or 'udp')."})
            return

        # Start background RTSP worker for this URL
        session_id = rtsp_session.start(url, transport)

        # Wait up to 4.5s for initial frame
        deadline = time.monotonic() + 4.5
        with rtsp_session.condition:
            while (
                rtsp_session.session_id == session_id
                and rtsp_session.is_running
                and rtsp_session.latest_jpeg is None
                and not rtsp_session.error_message
            ):
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                rtsp_session.condition.wait(timeout=min(remaining, 0.1))

            if rtsp_session.latest_jpeg is None:
                err_msg = rtsp_session.error_message or "Timed out waiting for initial RTSP video frame."
                rtsp_session.stop(expected_session_id=session_id)
                self.send_json_response(500, {"success": False, "error": err_msg})
                return

        # Send HTTP Multipart Stream Headers
        self.send_response(200)
        self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Connection', 'close')
        self.end_headers()

        rtsp_session.register_client(session_id)
        last_sent_seq = 0
        try:
            while True:
                jpeg_bytes = None
                with rtsp_session.condition:
                    rtsp_session.condition.wait_for(
                        lambda: (
                            not rtsp_session.is_running
                            or rtsp_session.session_id != session_id
                            or rtsp_session.latest_frame_seq > last_sent_seq
                        ),
                        timeout=0.05
                    )
                    if not rtsp_session.is_running or rtsp_session.session_id != session_id:
                        break
                    if rtsp_session.latest_jpeg is not None and rtsp_session.latest_frame_seq > last_sent_seq:
                        jpeg_bytes = rtsp_session.latest_jpeg
                        last_sent_seq = rtsp_session.latest_frame_seq

                if jpeg_bytes:
                    header = (
                        b'--frame\r\n'
                        b'Content-Type: image/jpeg\r\n'
                        b'Content-Length: ' + str(len(jpeg_bytes)).encode('ascii') + b'\r\n\r\n'
                    )
                    # Single coalesced write prevents fragmented TCP packets
                    self.wfile.write(header + jpeg_bytes + b'\r\n')
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as e:
            print(f"[!] [RTSP Gateway] Client disconnected: {e}")
        finally:
            print("[*] [RTSP Gateway] Client disconnected, updating RTSP session refcount...")
            rtsp_session.unregister_client(session_id)

    def send_json_response(self, code, obj):
        data = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def parse_cli_args(argv):
    global PORT, BIND_HOST
    for arg in argv[1:]:
        if arg == "--lan":
            BIND_HOST = "0.0.0.0"
        elif arg.startswith("--host="):
            BIND_HOST = arg.split("=", 1)[1].strip() or "127.0.0.1"
        elif arg.isdigit():
            PORT = int(arg)


def run_server():
    mimetypes.init()
    mimetypes.add_type('application/javascript', '.js')
    mimetypes.add_type('application/javascript', '.mjs')
    mimetypes.add_type('application/manifest+json', '.webmanifest')
    mimetypes.add_type('audio/mpeg', '.mp3')
    mimetypes.add_type('image/svg+xml', '.svg')
    mimetypes.add_type('image/webp', '.webp')
    mimetypes.add_type('image/x-icon', '.ico')
    mimetypes.add_type('font/woff2', '.woff2')

    with SPOTRServer((BIND_HOST, PORT), SPOTRRequestHandler) as httpd:
        print("============================================================")
        print("  SPOTR PORTABLE SERVER & RTSP STREAMING GATEWAY")
        print("============================================================")
        print(f"[*] Bind Address:      {BIND_HOST}:{PORT}")
        print(f"[*] Local Web App:     http://localhost:{PORT}")
        if BIND_HOST == "0.0.0.0":
            print(f"[*] LAN Mode:          ENABLED (accessible from phones/iPads on local Wi-Fi)")
        print(f"[*] Serving Root:      {WEB_DIR}")
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
    parse_cli_args(sys.argv)
    run_server()
