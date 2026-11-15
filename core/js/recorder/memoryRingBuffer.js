/**
 * Native-Resolution Configurable In-Memory Frame Ring Buffer
 *
 * Captures frames at the camera stream's native resolution (e.g. 1920×1080)
 * and stores only compressed JPEG ArrayBuffers in RAM.
 * For RTSP streams, ingests incoming JPEG frames directly with zero canvas
 * readback or double-JPEG re-encoding.
 */
import { appState, updateState } from '../state.js';
import { subscribeRtspJpegFrames } from '../camera/streamManager.js';
import { getSoundPeak, initSoundSampler } from '../audio/soundSampler.js';

let frameRing = []; // Array of { timestampMs, jpegBuffer, width, height, soundPeak }
let ringEvents = []; // Array of { timestampMs, type }
let totalBytes = 0;
let captureInterval = null;
let rtspUnsubscribe = null;
let captureCanvas = null;
let captureCtx = null;
let encodingInProgress = false;
let currentVideoEl = null;
let lastBufferStateUpdateTime = 0;
let lastRtspCaptureMs = 0;

/**
 * Records an external detection event (e.g. Micro-Change Heatmap target hit)
 * into the rolling in-memory timeline.
 */
export function recordEvent(type = 'event') {
  if (!appState.bufferEnabled) return;
  const now = performance.now();
  ringEvents.push({ timestampMs: now, type });
  const maxSec = Math.max(5, Math.min(60, appState.bufferMaxSeconds || 20));
  const cutoff = now - maxSec * 1000;
  ringEvents = ringEvents.filter((e) => e.timestampMs >= cutoff);
}

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

function appendFrameToRing(jpegBuffer, width, height, capturedAt, soundPeak, targetFps) {
  frameRing.push({
    timestampMs: capturedAt,
    jpegBuffer,
    width,
    height,
    soundPeak
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

  // Prune events outside rolling window
  ringEvents = ringEvents.filter((e) => e.timestampMs >= cutoff);

  const spanSec =
    frameRing.length > 1
      ? Math.min(maxSec, (frameRing[frameRing.length - 1].timestampMs - frameRing[0].timestampMs) / 1000)
      : frameRing.length > 0
        ? Number((1 / targetFps).toFixed(1))
        : 0;

  if (capturedAt - lastBufferStateUpdateTime >= 500) {
    lastBufferStateUpdateTime = capturedAt;
    updateState({
      bufferedSeconds: Number(spanSec.toFixed(1)),
      bufferBytes: totalBytes
    });
  }
}

export function startMemoryBuffer(videoEl) {
  if (videoEl) {
    currentVideoEl = videoEl;
  }
  if (captureInterval) {
    clearInterval(captureInterval);
    captureInterval = null;
  }
  if (rtspUnsubscribe) {
    rtspUnsubscribe();
    rtspUnsubscribe = null;
  }
  if (!appState.bufferEnabled || !currentVideoEl) return;

  // Initialize sound sampler if mic available
  initSoundSampler().catch(() => {});

  const targetFps = Math.max(5, Math.min(30, appState.bufferTargetFps || 15));
  const intervalMs = Math.round(1000 / targetFps);
  const minRtspIntervalMs = (1000 / targetFps) * 0.92;

  // Direct zero-reencode RTSP JPEG ingestion
  rtspUnsubscribe = subscribeRtspJpegFrames((jpegBytes, w, h, nowMs) => {
    if (!appState.bufferEnabled || appState.replayActive || !appState.isRtspStream) return;
    if (nowMs - lastRtspCaptureMs < minRtspIntervalMs) return;
    lastRtspCaptureMs = nowMs;

    const jpegBuffer =
      jpegBytes.byteOffset === 0 && jpegBytes.byteLength === jpegBytes.buffer.byteLength
        ? jpegBytes.buffer
        : jpegBytes.slice().buffer;

    appendFrameToRing(
      jpegBuffer,
      w || appState.streamWidth || 1920,
      h || appState.streamHeight || 1080,
      nowMs,
      getSoundPeak(),
      targetFps
    );
  });

  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas');
    captureCtx = captureCanvas.getContext('2d', { alpha: false }) || captureCanvas.getContext('2d');
  }

  // Fallback canvas capture loop for USB UVC & simulated streams
  captureInterval = setInterval(() => {
    if (!appState.bufferEnabled || appState.replayActive || appState.isRtspStream || encodingInProgress) return;
    const source = currentVideoEl;
    if (!source) return;
    if (source.tagName === 'VIDEO' && source.readyState < 2) return;

    const nativeW = source.videoWidth || source.width || appState.streamWidth || 1920;
    const nativeH = source.videoHeight || source.height || appState.streamHeight || 1080;

    if (captureCanvas.width !== nativeW || captureCanvas.height !== nativeH) {
      captureCanvas.width = nativeW;
      captureCanvas.height = nativeH;
    }

    encodingInProgress = true;
    const capturedAt = performance.now();
    const currentPeak = getSoundPeak();

    try {
      captureCtx.drawImage(source, 0, 0, nativeW, nativeH);
      captureCanvas.toBlob(
        async (blob) => {
          try {
            if (!blob || !appState.bufferEnabled) return;
            const jpegBuffer = await blob.arrayBuffer();
            appendFrameToRing(jpegBuffer, nativeW, nativeH, capturedAt, currentPeak, targetFps);
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
  if (rtspUnsubscribe) {
    rtspUnsubscribe();
    rtspUnsubscribe = null;
  }
  frameRing = [];
  ringEvents = [];
  totalBytes = 0;
  encodingInProgress = false;
  lastBufferStateUpdateTime = 0;
  lastRtspCaptureMs = 0;
  updateState({ bufferedSeconds: 0, bufferBytes: 0 });
}

export async function snapshotMemoryBuffer() {
  if (!frameRing.length) return null;

  const firstTs = frameRing[0].timestampMs;
  const lastTs = frameRing[frameRing.length - 1].timestampMs;
  const maxSec = appState.bufferMaxSeconds || 20;
  const durationSec = Math.max(0.5, Math.min(maxSec, (lastTs - firstTs) / 1000));
  const lastFrame = frameRing[frameRing.length - 1];

  // Zero-copy snapshot: frameRing never mutates individual ArrayBuffer contents
  const jpegFrames = frameRing.map((f) => f.jpegBuffer);
  const frameTimestamps = frameRing.map((f) => Number(((f.timestampMs - firstTs) / 1000).toFixed(3)));
  const effectiveFps =
    frameRing.length > 1
      ? Math.max(1, Math.min(60, Math.round((frameRing.length - 1) / durationSec)))
      : appState.bufferTargetFps || 15;

  // Downsample sound peaks to up to 80 bins across duration
  const rawPeaks = frameRing.map((f) => f.soundPeak || 0);
  const targetBins = Math.min(80, Math.max(1, rawPeaks.length));
  const step = rawPeaks.length / targetBins;
  const soundPeaks = [];
  for (let i = 0; i < targetBins; i++) {
    const start = Math.floor(i * step);
    const end = Math.min(rawPeaks.length, Math.floor((i + 1) * step));
    let maxP = 0;
    for (let j = start; j < end; j++) {
      if (rawPeaks[j] > maxP) maxP = rawPeaks[j];
    }
    soundPeaks.push(Number(maxP.toFixed(2)));
  }

  // Calculate events relative to the start of the recording in seconds
  // Group events occurring within the same second into a single event timestamp
  const spanSec = Math.max(0.5, (lastTs - firstTs) / 1000);
  const tailCutoffTs = Math.max(lastTs, performance.now()) + 150;
  const hitPerfTimestamps = Array.isArray(appState.detectionHits)
    ? appState.detectionHits
      .map((h) => h?.perfMs)
      .filter((t) => typeof t === 'number' && Number.isFinite(t))
    : [];
  const allEventTimestamps = [
    ...ringEvents.map((e) => e.timestampMs),
    ...hitPerfTimestamps
  ];
  const rawEvents = allEventTimestamps
    .filter((ts) => ts >= firstTs - 350 && ts <= tailCutoffTs)
    .map((ts) => {
      const sec = Math.max(0, Math.min(spanSec, (ts - firstTs) / 1000));
      return Number(sec.toFixed(2));
    })
    .sort((a, b) => a - b);

  const events = [];
  for (const t of rawEvents) {
    if (!events.length || t - events[events.length - 1] > 1.0) {
      events.push(t);
    }
  }

  return {
    jpegFrames,
    frameTimestamps,
    startTs: firstTs,
    endTs: lastTs,
    fps: effectiveFps,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: totalBytes,
    width: lastFrame.width || appState.streamWidth || 1920,
    height: lastFrame.height || appState.streamHeight || 1080,
    timeline: {
      soundPeaks,
      events
    }
  };
}
