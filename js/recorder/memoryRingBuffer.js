/**
 * 20-Second Rolling In-Memory Frame Ring Buffer
 *
 * Captures compressed JPEG frames + GPU ImageBitmaps at 15 FPS into a circular
 * RAM array (capped at 20.0 seconds = 300 frames, ~5 MB total in RAM).
 *
 * Why a Frame Ring Buffer instead of raw MediaRecorder chunks:
 * 1. Instant Replay & Saved Video Viewer play back via a 60fps Canvas clock with
 *    100% deterministic playback, instant frame-accurate scrubbing, and zero
 *    Chromium WebM "Duration: Infinity" codec stalls.
 * 2. Powers real-time Temporal Compare (Chrono-Ghost & Change-Radar Delta) by
 *    providing O(1) lookup of the exact video frame from N seconds ago.
 */
import { appState, updateState } from '../state.js';

const BUFFER_FPS = 15;
const MAX_BUFFER_SECONDS = 20;
const MAX_FRAMES = BUFFER_FPS * MAX_BUFFER_SECONDS; // 300 frames
const CAPTURE_W = 854;
const CAPTURE_H = 480;

let frameRing = []; // Array of { timestampMs, jpegBuffer, bitmap }
let totalBytes = 0;
let captureInterval = null;
let captureCanvas = null;
let captureCtx = null;
let encodingInProgress = false;

export function startMemoryBuffer(videoEl) {
  stopMemoryBuffer();
  if (!appState.bufferEnabled) return;

  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas');
    captureCanvas.width = CAPTURE_W;
    captureCanvas.height = CAPTURE_H;
    captureCtx = captureCanvas.getContext('2d');
  }

  captureInterval = setInterval(() => {
    if (!appState.bufferEnabled || appState.replayActive || encodingInProgress) return;
    if (!videoEl || videoEl.readyState < 2) return;

    encodingInProgress = true;
    const capturedAt = performance.now();

    try {
      captureCtx.drawImage(videoEl, 0, 0, CAPTURE_W, CAPTURE_H);
      captureCanvas.toBlob(
        async (blob) => {
          try {
            if (!blob || !appState.bufferEnabled) return;
            const [jpegBuffer, bitmap] = await Promise.all([
              blob.arrayBuffer(),
              createImageBitmap(blob)
            ]);

            frameRing.push({
              timestampMs: capturedAt,
              jpegBuffer,
              bitmap
            });
            totalBytes += jpegBuffer.byteLength;

            // Evict frames older than 20 seconds (or exceeding MAX_FRAMES)
            const cutoff = capturedAt - MAX_BUFFER_SECONDS * 1000;
            while (frameRing.length > MAX_FRAMES || (frameRing.length > 2 && frameRing[0].timestampMs < cutoff)) {
              const old = frameRing.shift();
              totalBytes = Math.max(0, totalBytes - old.jpegBuffer.byteLength);
              if (old.bitmap && old.bitmap.close) {
                old.bitmap.close();
              }
            }

            const spanSec =
              frameRing.length > 1
                ? Math.min(MAX_BUFFER_SECONDS, (frameRing[frameRing.length - 1].timestampMs - frameRing[0].timestampMs) / 1000)
                : frameRing.length > 0
                  ? 0.1
                  : 0;

            updateState({
              bufferedSeconds: Number(spanSec.toFixed(1)),
              bufferBytes: totalBytes
            });
          } finally {
            encodingInProgress = false;
          }
        },
        'image/jpeg',
        0.82
      );
    } catch {
      encodingInProgress = false;
    }
  }, Math.round(1000 / BUFFER_FPS));
}

export function stopMemoryBuffer() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  frameRing.forEach((f) => {
    if (f.bitmap && f.bitmap.close) {
      f.bitmap.close();
    }
  });
  frameRing = [];
  totalBytes = 0;
  encodingInProgress = false;
  updateState({ bufferedSeconds: 0, bufferBytes: 0 });
}

/**
 * Returns the ImageBitmap from `delaySec` seconds ago for Temporal Compare
 * (Chrono-Ghost & Change-Radar Delta modes).
 */
export function getDelayedFrameBitmap(delaySec) {
  if (!frameRing.length) return null;
  const now = frameRing[frameRing.length - 1].timestampMs;
  const targetTime = now - delaySec * 1000;

  // Binary search or reverse scan for closest frame
  for (let i = frameRing.length - 1; i >= 0; i--) {
    if (frameRing[i].timestampMs <= targetTime) {
      return frameRing[i].bitmap;
    }
  }
  return frameRing[0].bitmap;
}

/**
 * Takes an instant snapshot of the current 20-second RAM frame ring buffer.
 */
export async function snapshotMemoryBuffer() {
  if (!frameRing.length) return null;

  const firstTs = frameRing[0].timestampMs;
  const lastTs = frameRing[frameRing.length - 1].timestampMs;
  const durationSec = Math.max(0.5, Math.min(MAX_BUFFER_SECONDS, (lastTs - firstTs) / 1000));

  // Clone JPEG ArrayBuffers and decode independent ImageBitmaps for the replay player
  const jpegFrames = frameRing.map((f) => f.jpegBuffer.slice(0));
  const bitmaps = await Promise.all(
    jpegFrames.map((buf) => createImageBitmap(new Blob([buf], { type: 'image/jpeg' })))
  );

  return {
    jpegFrames,
    bitmaps,
    fps: BUFFER_FPS,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: totalBytes,
    width: CAPTURE_W,
    height: CAPTURE_H
  };
}
