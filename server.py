#!/usr/bin/env python3
"""
SPOTR Windows/Desktop Server Proxy Entrypoint.
Delegates to platforms/windows/server.py to maintain backward compatibility.
"""
import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(BASE_DIR, "platforms", "windows", "server.py")
WINDOWS_DIR = os.path.join(BASE_DIR, "platforms", "windows")

if __name__ == "__main__":
    if os.path.exists(TARGET):
        with open(TARGET, "rb") as f:
            code = compile(f.read(), TARGET, "exec")
            exec(code, {"__name__": "__main__", "__file__": TARGET})
    else:
        print(f"[!] Error: Target server script not found at {TARGET}")
        sys.exit(1)
else:
    if WINDOWS_DIR not in sys.path:
        sys.path.insert(0, WINDOWS_DIR)
    import importlib.util
    spec = importlib.util.spec_from_file_location("win_server", TARGET)
    _mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(_mod)
    globals().update({k: getattr(_mod, k) for k in dir(_mod) if not k.startswith("__")})
