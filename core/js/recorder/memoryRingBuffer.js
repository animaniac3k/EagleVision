/**
 * Native-Resolution Configurable In-Memory Frame Ring Buffer
 *
 * Captures frames at the camera stream's native resolution (e.g. 1920×1080)
 * and stores only compressed JPEG ArrayBuffers in RAM.
 * For RTSP streams, ingests incoming JPEG frames directly with zero canvas
 * readback or double-JPEG re-encoding.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { subscribeRtspJpegFrames } from '../camera/streamManager.js';
import { getSoundPeak, initSoundSampler, stopSoundSampler } from '../audio/soundSampler.js';

let frameRing = []; // Array of { timestampMs, perfMs, jpegBuffer, width, height, soundPeak }
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
let pausedAtMs = appState.currentScreen !== 'live' ? performance.now() : null;

function rebasePausedTimeline(nowMs = performance.now()) {
  if (pausedAtMs === null) return;
  const deltaMs = Math.max(0, nowMs - pausedAtMs);
  pausedAtMs = null;
  if (deltaMs > 0) {
    for (const f of frameRing) {
      f.timestampMs += deltaMs;
    }
    for (const e of ringEvents) {
      e.timestampMs += deltaMs;
    }
  }
  lastBufferStateUpdateTime = 0;
  lastRtspCaptureMs = 0;
}

subscribeState((state) => {
  if (state.currentScreen !== 'live') {
    if (pausedAtMs === null) {
      pausedAtMs = performance.now();
    }
  } else if (pausedAtMs !== null) {
    rebasePausedTimeline(performance.now());
  }
});

/**
 * Records an external detection event (e.g. Micro-Change Heatmap target hit)
 * into the rolling in-memory timeline.
 */
export function recordEvent(type = 'event') {
  if (!appState.bufferEnabled || appState.currentScreen !== 'live') return;
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

export function getBufferedTargetDimensions(nativeW, nativeH) {
  const nw = nativeW || appState.streamWidth || 1920;
  const nh = nativeH || appState.streamHeight || 1080;
  if (appState.bufferFastQuality !== false && !appState.isRtspStream && nh > 720) {
    const scale = 720 / nh;
    return {
      width: Math.max(2, Math.round((nw * scale) / 2) * 2),
      height: 720
    };
  }
  return { width: nw, height: nh };
}

/**
 * Estimates how many MB of RAM the configured (bufferMaxSeconds × bufferTargetFps)
 * will consume at the current capture resolution.
 */
export function getEstimatedBufferMB() {
  const totalTargetFrames = appState.bufferMaxSeconds * appState.bufferTargetFps;
  if (frameRing.length > 0) {
    const avgBytes = totalBytes / frameRing.length;
    return Number(((avgBytes * totalTargetFrames) / (1024 * 1024)).toFixed(1));
  }
  const { width, height } = getBufferedTargetDimensions();
  const bytesPerPixel = appState.bufferFastQuality !== false && !appState.isRtspStream ? 0.045 : 0.055;
  const estFrameBytes = width * height * bytesPerPixel;
  return Number(((estFrameBytes * totalTargetFrames) / (1024 * 1024)).toFixed(1));
}

function appendFrameToRing(jpegBuffer, width, height, capturedAt, soundPeak, targetFps) {
  if (pausedAtMs !== null) {
    rebasePausedTimeline(capturedAt);
  }
  frameRing.push({
    timestampMs: capturedAt,
    perfMs: capturedAt,
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
    (frameRing.length > 1 && frameRing[0].timestampMs < cutoff) ||
    (frameRing.length > 1 && totalBytes > maxBudgetBytes)
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

  // Opt-in microphone sound sampler (avoids launch-time mic prompts in the field)
  if (appState.bufferMicEnabled) {
    initSoundSampler().catch(() => {});
  } else {
    stopSoundSampler();
  }

  const targetFps = Math.max(5, Math.min(30, appState.bufferTargetFps || 15));
  const intervalMs = Math.round(1000 / targetFps);
  const minRtspIntervalMs = (1000 / targetFps) * 0.92;
  const jpegQuality = appState.bufferFastQuality !== false ? 0.75 : 0.84;

  // Direct zero-reencode RTSP JPEG ingestion
  rtspUnsubscribe = subscribeRtspJpegFrames((jpegBytes, w, h, nowMs) => {
    if (!appState.bufferEnabled || appState.currentScreen !== 'live' || !appState.isRtspStream) return;
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
      appState.bufferMicEnabled ? getSoundPeak() : 0,
      targetFps
    );
  });

  if (!captureCanvas) {
    captureCanvas = document.createElement('canvas');
    captureCtx = captureCanvas.getContext('2d', { alpha: false }) || captureCanvas.getContext('2d');
  }

  // Fallback canvas capture loop for USB UVC & simulated streams
  captureInterval = setInterval(() => {
    if (!appState.bufferEnabled || appState.currentScreen !== 'live' || appState.isRtspStream || encodingInProgress) return;
    const source = currentVideoEl;
    if (!source) return;
    if (source.tagName === 'VIDEO' && source.readyState < 2) return;

    const nativeW = source.videoWidth || source.width || appState.streamWidth || 1920;
    const nativeH = source.videoHeight || source.height || appState.streamHeight || 1080;
    const { width: capW, height: capH } = getBufferedTargetDimensions(nativeW, nativeH);

    if (captureCanvas.width !== capW || captureCanvas.height !== capH) {
      captureCanvas.width = capW;
      captureCanvas.height = capH;
    }

    encodingInProgress = true;
    const capturedAt = performance.now();
    const currentPeak = appState.bufferMicEnabled ? getSoundPeak() : 0;

    try {
      captureCtx.drawImage(source, 0, 0, capW, capH);
      captureCanvas.toBlob(
        async (blob) => {
          try {
            if (!blob || !appState.bufferEnabled || appState.currentScreen !== 'live') return;
            const jpegBuffer = await blob.arrayBuffer();
            if (!appState.bufferEnabled || appState.currentScreen !== 'live') return;
            appendFrameToRing(jpegBuffer, capW, capH, capturedAt, currentPeak, targetFps);
          } finally {
            encodingInProgress = false;
          }
        },
        'image/jpeg',
        jpegQuality
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
  if (frameRing.length > 0) {
    const maxSec = Math.max(5, Math.min(60, appState.bufferMaxSeconds || 20));
    const targetFps = Math.max(5, Math.min(30, appState.bufferTargetFps || 15));
    const maxFrames = maxSec * targetFps;
    const now = performance.now();
    const effectivePauseMs = pausedAtMs !== null ? Math.max(0, now - pausedAtMs) : 0;
    const cutoff = now - effectivePauseMs - maxSec * 1000;
    while (
      frameRing.length > maxFrames ||
      (frameRing.length > 1 && frameRing[0].timestampMs < cutoff)
    ) {
      const old = frameRing.shift();
      totalBytes = Math.max(0, totalBytes - old.jpegBuffer.byteLength);
    }
    ringEvents = ringEvents.filter((e) => e.timestampMs >= cutoff);
    const spanSec =
      frameRing.length > 1
        ? Math.min(maxSec, (frameRing[frameRing.length - 1].timestampMs - frameRing[0].timestampMs) / 1000)
        : Number((1 / targetFps).toFixed(1));
    updateState({
      bufferedSeconds: Number(spanSec.toFixed(1)),
      bufferBytes: totalBytes
    });
  }
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
  pausedAtMs = appState.currentScreen !== 'live' ? performance.now() : null;
  stopSoundSampler();
  updateState({ bufferedSeconds: 0, bufferBytes: 0 });
}

function mapHitPerfToTimelineMs(hitPerfMs, firstTs, lastTs) {
  if (!frameRing.length || typeof hitPerfMs !== 'number' || !Number.isFinite(hitPerfMs)) {
    return null;
  }
  const firstPerf = frameRing[0].perfMs ?? firstTs;
  const lastPerf = frameRing[frameRing.length - 1].perfMs ?? lastTs;
  if (hitPerfMs < firstPerf - 350 || hitPerfMs > lastPerf + 150) {
    return null;
  }
  if (hitPerfMs <= firstPerf) return firstTs;
  if (hitPerfMs >= lastPerf) return lastTs;

  let lo = 0;
  let hi = frameRing.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    const midPerf = frameRing[mid].perfMs ?? frameRing[mid].timestampMs;
    if (midPerf < hitPerfMs) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return frameRing[lo].timestampMs;
}

export async function snapshotMemoryBuffer() {
  if (!frameRing.length) return null;

  const maxSec = appState.bufferMaxSeconds || 20;
  const now = performance.now();
  const effectivePauseMs = pausedAtMs !== null ? Math.max(0, now - pausedAtMs) : 0;
  const cutoff = now - effectivePauseMs - maxSec * 1000;
  while (frameRing.length > 1 && frameRing[0].timestampMs < cutoff) {
    const old = frameRing.shift();
    totalBytes = Math.max(0, totalBytes - old.jpegBuffer.byteLength);
  }
  ringEvents = ringEvents.filter((e) => e.timestampMs >= cutoff);

  const firstTs = frameRing[0].timestampMs;
  const lastTs = frameRing[frameRing.length - 1].timestampMs;
  const rawSpanSec = Math.max(0.05, (lastTs - firstTs) / 1000);
  const durationSec = Math.max(0.5, Math.min(maxSec, rawSpanSec));
  const lastFrame = frameRing[frameRing.length - 1];

  // Zero-copy snapshot: frameRing never mutates individual ArrayBuffer contents
  const jpegFrames = frameRing.map((f) => f.jpegBuffer);
  const frameTimestamps = frameRing.map((f) => Number(((f.timestampMs - firstTs) / 1000).toFixed(3)));
  const effectiveFps =
    frameRing.length > 1
      ? Math.max(1, Math.min(60, Math.round((frameRing.length - 1) / rawSpanSec)))
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
  const spanSec = Math.max(0.5, rawSpanSec);
  const tailCutoffTs = Math.max(lastTs, now - effectivePauseMs) + 150;
  const hitTimelineTimestamps = Array.isArray(appState.detectionHits)
    ? appState.detectionHits
      .map((h) => mapHitPerfToTimelineMs(h?.perfMs, firstTs, lastTs))
      .filter((t) => typeof t === 'number' && Number.isFinite(t))
    : [];
  const allEventTimestamps = [
    ...ringEvents.map((e) => e.timestampMs),
    ...hitTimelineTimestamps
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
