#!/usr/bin/env python3
"""
Automated PDF Generator for SPOTR Visual Field Manual.
Renders docs/user_manual.html into docs/USER_MANUAL.pdf via headless Chrome or Edge.
"""
import os
import shutil
import subprocess
import sys
from pathlib import Path

DOCS_DIR = Path(__file__).resolve().parent
HTML_PATH = DOCS_DIR / "user_manual.html"
PDF_PATH = DOCS_DIR / "USER_MANUAL.pdf"

BROWSER_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    shutil.which("google-chrome"),
    shutil.which("chromium"),
    shutil.which("msedge"),
]


def find_browser() -> str | None:
    for cand in BROWSER_CANDIDATES:
        if cand and os.path.isfile(cand):
            return cand
    return None


def main() -> int:
    if not HTML_PATH.is_file():
        print(f"[!] Missing source HTML: {HTML_PATH}")
        return 1

    browser = find_browser()
    if not browser:
        print("[!] Could not find Chrome, Chromium, or Edge for headless PDF export.")
        return 1

    file_url = HTML_PATH.as_uri()
    cmd = [
        browser,
        "--headless=new",
        "--disable-gpu",
        "--no-pdf-header-footer",
        f"--print-to-pdf={PDF_PATH}",
        file_url,
    ]
    print(f"[*] Generating {PDF_PATH.name} using {browser}...")
    res = subprocess.run(cmd, capture_output=True, text=True)
    if res.returncode != 0 or not PDF_PATH.is_file() or PDF_PATH.stat().st_size < 10_000:
        print(f"[!] PDF generation failed (exit={res.returncode}):\n{res.stderr}")
        return 1

    size_kb = PDF_PATH.stat().st_size / 1024
    print(f"[OK] Regenerated {PDF_PATH} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
