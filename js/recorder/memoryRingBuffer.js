/**
 * Native-Resolution Configurable In-Memory Frame Ring Buffer
 *
 * Captures frames at the camera stream's native resolution (e.g. 1920×1080)
 * and stores only compressed JPEG ArrayBuffers in RAM.
 * Supports user-adjustable duration (seconds) and frame rate (FPS) with live
 * RAM usage and available memory budget reporting.
 */
import { appState, updateState } from '../state.js';

let frameRing = []; // Array of { timestampMs, jpegBuffer, width, height }
let totalBytes = 0;
let captureInterval = null;
let captureCanvas = null;
let captureCtx = null;
let encodingInProgress = false;
let currentVideoEl = null;

/**
 * Estimates the maximum safe RAM budget (in MB) for in-memory video buffering
 * on the current device/browser.
 */
export function getAvailableMemoryBudgetMB() {
  if (performance && performance.memory && performance.memory.jsHeapSizeLimit) {
    const freeHeapBytes = Math.max(
      128 * 1024 * 1024,
      performance.memory.jsHeapSizeLimit - (performance.memory.usedJSHeapSize || 0)
    );
    // Use up to 40% of remaining JS heap (capped between 128 MB and 768 MB)
    return Math.round(Math.min(768, Math.max(128, (freeHeapBytes * 0.4) / (1024 * 1024))));
  }
  const deviceGB = navigator.deviceMemory || 4;
  return Math.round(Math.min(768, Math.max(150, deviceGB * 90)));
}

/**
 * Estimates how many MB of RAM the configured (bufferMaxSeconds × bufferTargetFps)
 * will consume at the current stream resolution.
 */
export function getEstimatedBufferMB() {
  const totalTargetFrames = appState.bufferMaxSeconds * appState.bufferTargetFps;
  if (frameRing.length > 0) {
    const avgBytes = totalBytes / frameRing.length;
    return Number(((avgBytes * totalTargetFrames) / (1024 * 1024)).toFixed(1));
  }
  // Fallback estimate based on pixel count (~0.055 bytes per pixel for JPEG q=0.84)
  const pixels = (appState.streamWidth || 1920) * (appState.streamHeight || 1080);
  const estFrameBytes = pixels * 0.055;
  return Number(((estFrameBytes * totalTargetFrames) / (1024 * 1024)).toFixed(1));
}

export function startMemoryBuffer(videoEl) {
  if (videoEl) {
    currentVideoEl = videoEl;
  }
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (!appState.bufferEnabled || !currentVideoEl) return;

  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas');
    captureCtx = captureCanvas.getContext('2d');
  }

  const targetFps = Math.max(5, Math.min(30, appState.bufferTargetFps || 15));
  const intervalMs = Math.round(1000 / targetFps);

  captureInterval = setInterval(() => {
    if (!appState.bufferEnabled || appState.replayActive || encodingInProgress) return;
    if (!currentVideoEl || currentVideoEl.readyState < 2) return;

    const nativeW = currentVideoEl.videoWidth || appState.streamWidth || 1920;
    const nativeH = currentVideoEl.videoHeight || appState.streamHeight || 1080;

    if (captureCanvas.width !== nativeW || captureCanvas.height !== nativeH) {
      captureCanvas.width = nativeW;
      captureCanvas.height = nativeH;
    }

    encodingInProgress = true;
    const capturedAt = performance.now();

    try {
      captureCtx.drawImage(currentVideoEl, 0, 0, nativeW, nativeH);
      captureCanvas.toBlob(
        async (blob) => {
          try {
            if (!blob || !appState.bufferEnabled) return;
            const jpegBuffer = await blob.arrayBuffer();

            frameRing.push({
              timestampMs: capturedAt,
              jpegBuffer,
              width: nativeW,
              height: nativeH
            });
            totalBytes += jpegBuffer.byteLength;

            const maxSec = Math.max(5, Math.min(60, appState.bufferMaxSeconds || 20));
            const maxFrames = maxSec * targetFps;
            const cutoff = capturedAt - maxSec * 1000;
            const maxBudgetBytes = getAvailableMemoryBudgetMB() * 1024 * 1024;

            while (
              frameRing.length > maxFrames ||
              (frameRing.length > 2 && frameRing[0].timestampMs < cutoff) ||
              (frameRing.length > 2 && totalBytes > maxBudgetBytes)
            ) {
              const old = frameRing.shift();
              totalBytes = Math.max(0, totalBytes - old.jpegBuffer.byteLength);
            }

            const spanSec =
              frameRing.length > 1
                ? Math.min(maxSec, (frameRing[frameRing.length - 1].timestampMs - frameRing[0].timestampMs) / 1000)
                : frameRing.length > 0
                  ? Number((1 / targetFps).toFixed(1))
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
        0.84
      );
    } catch {
      encodingInProgress = false;
    }
  }, intervalMs);
}

/**
 * Updates the capture timer when the user changes FPS or Duration in Settings
 * without discarding already-buffered frames in RAM.
 */
export function updateMemoryBufferConfig() {
  if (appState.bufferEnabled && currentVideoEl) {
    startMemoryBuffer(currentVideoEl);
  }
}

export function stopMemoryBuffer() {
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  frameRing = [];
  totalBytes = 0;
  encodingInProgress = false;
  updateState({ bufferedSeconds: 0, bufferBytes: 0 });
}

export async function snapshotMemoryBuffer() {
  if (!frameRing.length) return null;

  const firstTs = frameRing[0].timestampMs;
  const lastTs = frameRing[frameRing.length - 1].timestampMs;
  const maxSec = appState.bufferMaxSeconds || 20;
  const durationSec = Math.max(0.5, Math.min(maxSec, (lastTs - firstTs) / 1000));
  const lastFrame = frameRing[frameRing.length - 1];

  const jpegFrames = frameRing.map((f) => f.jpegBuffer.slice(0));

  return {
    jpegFrames,
    fps: appState.bufferTargetFps || 15,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: totalBytes,
    width: lastFrame.width || appState.streamWidth || 1920,
    height: lastFrame.height || appState.streamHeight || 1080
  };
}
