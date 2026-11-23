/**
 * High-Speed ImageBitmap Frame Sequence Player
 *
 * Replaces HTMLImageElement + ObjectURL decoding with off-thread
 * createImageBitmap decoding, a small LRU bitmap cache with 1-frame lookahead
 * pre-decoding, stale-frame skipping under decode pressure, and { alpha: false }
 * canvas rendering without redundant clears.
 */

import { drawDisplayTimestampOnCanvas, sampleSourceRegionLuma } from '../renderer/timestampOverlay.js';

const MAX_CACHED_BITMAPS = 8;
const PREFETCH_AHEAD = 3;
const MAX_INFLIGHT_PREFETCH = 4;

export function createJpegFramePlayer(canvasEl, getViewportTransform) {
  const ctx =
    canvasEl.getContext('2d', { alpha: false, desynchronized: true }) ||
    canvasEl.getContext('2d');

  let frames = [];
  let timestamps = null;
  let durationSec = 0;
  let generation = 0;
  let currentIdx = -1;
  let targetIdx = -1;
  let currentBitmap = null;
  let decodingTarget = false;
  let cachedLumaIdx = -1;
  let cachedLumaPos = '';
  let cachedLumaVal = 30;
  let lastLumaSampleMs = 0;

  const bitmapCache = new Map(); // idx -> ImageBitmap (LRU order)
  const inflight = new Map();    // idx -> Promise<ImageBitmap | null>

  function evictCacheIfNeeded(keepIdxA, keepIdxB) {
    while (bitmapCache.size > MAX_CACHED_BITMAPS) {
      let evicted = false;
      for (const [k, bmp] of bitmapCache.entries()) {
        if (k !== keepIdxA && k !== keepIdxB) {
          bitmapCache.delete(k);
          try {
            bmp.close?.();
          } catch {}
          evicted = true;
          break;
        }
      }
      if (!evicted) break;
    }
  }

  function decodeFrame(idx, gen) {
    if (gen !== generation || idx < 0 || idx >= frames.length) {
      return Promise.resolve(null);
    }
    if (bitmapCache.has(idx)) {
      const hit = bitmapCache.get(idx);
      if (hit && hit.width > 0) {
        // Refresh LRU recency
        bitmapCache.delete(idx);
        bitmapCache.set(idx, hit);
        return Promise.resolve(hit);
      }
      bitmapCache.delete(idx);
    }
    if (inflight.has(idx)) {
      return inflight.get(idx);
    }

    const blob = new Blob([frames[idx]], { type: 'image/jpeg' });
    const promise = createImageBitmap(blob)
      .then((bmp) => {
        inflight.delete(idx);
        if (gen !== generation) {
          try {
            bmp.close?.();
          } catch {}
          return null;
        }
        bitmapCache.delete(idx);
        bitmapCache.set(idx, bmp);
        evictCacheIfNeeded(currentIdx, targetIdx);
        return bmp;
      })
      .catch(() => {
        inflight.delete(idx);
        return null;
      });

    inflight.set(idx, promise);
    return promise;
  }

  function draw() {
    if (!currentBitmap || !canvasEl || currentBitmap.width <= 0 || currentBitmap.height <= 0) return;
    const iw = currentBitmap.width || canvasEl.width;
    const ih = currentBitmap.height || canvasEl.height;
    const cw = canvasEl.width;
    const ch = canvasEl.height;
    if (!iw || !ih || !cw || !ch) return;

    const tf = getViewportTransform ? getViewportTransform() : {};
    const zoom = Math.max(1.0, tf.zoom || 1.0);
    const panX = tf.panX || 0;
    const panY = tf.panY || 0;

    const cropW = iw / zoom;
    const cropH = ih / zoom;
    const centerX = iw * (0.5 + panX);
    const centerY = ih * (0.5 + panY);
    const sx = Math.max(0, Math.min(iw - cropW, centerX - cropW / 2));
    const sy = Math.max(0, Math.min(ih - cropH, centerY - cropH / 2));

    ctx.drawImage(currentBitmap, sx, sy, cropW, cropH, 0, 0, cw, ch);
    if (tf.showTimestamp && Number.isFinite(tf.baseWallMs)) {
      const offsetSec = currentIdx >= 0 ? getTimeForIndex(currentIdx) : 0;
      const pos = tf.tsPosition || 'bottom-right';
      const adaptive = tf.tsAdaptive !== false;
      let bgLuma = 30;
      if (adaptive) {
        const now = performance.now();
        if (currentIdx !== cachedLumaIdx || pos !== cachedLumaPos || now - lastLumaSampleMs > 350) {
          cachedLumaVal = sampleSourceRegionLuma(currentBitmap, pos, sx, sy, cropW, cropH);
          cachedLumaIdx = currentIdx;
          cachedLumaPos = pos;
          lastLumaSampleMs = now;
        }
        bgLuma = cachedLumaVal;
      }
      drawDisplayTimestampOnCanvas(ctx, cw, ch, tf.baseWallMs + offsetSec * 1000, {
        position: pos,
        opacity: tf.tsOpacity ?? 0.6,
        adaptive,
        bgLuma,
        isLive: false,
        safeInsetX: tf.tsSafeInsetX || 0,
        safeInsetY: tf.tsSafeInsetY || 0
      });
    }
  }

  function shouldApplyDecodedFrame(reqIdx) {
    if (currentBitmap === null || currentIdx < 0) return true;
    if (reqIdx === targetIdx) return true;
    // Forward playback or scrub
    if (targetIdx > currentIdx && reqIdx > currentIdx && reqIdx <= targetIdx) return true;
    // Backward scrub: only accept frames between targetIdx and currentIdx (never older stale frames)
    if (targetIdx < currentIdx && reqIdx >= targetIdx && reqIdx < currentIdx) return true;
    return false;
  }

  function applyBitmap(idx, bmp) {
    if (!bmp || bmp.width <= 0 || bmp.height <= 0) return;
    bitmapCache.delete(idx);
    bitmapCache.set(idx, bmp);
    currentBitmap = bmp;
    currentIdx = idx;
    draw();
  }

  function prefetchAhead(fromIdx, gen) {
    if (gen !== generation || frames.length <= 1 || fromIdx < 0) return;
    for (let offset = 1; offset <= PREFETCH_AHEAD; offset++) {
      if (inflight.size >= MAX_INFLIGHT_PREFETCH) break;
      const nextIdx = (fromIdx + offset) % frames.length;
      if (nextIdx === fromIdx) break;
      if (bitmapCache.has(nextIdx) || inflight.has(nextIdx)) continue;
      decodeFrame(nextIdx, gen).then((bmp) => {
        if (bmp && gen === generation && shouldApplyDecodedFrame(nextIdx) && currentIdx !== nextIdx) {
          applyBitmap(nextIdx, bmp);
        }
      });
    }
  }

  function pumpDecode() {
    if (targetIdx < 0 || targetIdx >= frames.length) return;
    if (targetIdx === currentIdx && currentBitmap && currentBitmap.width > 0) {
      prefetchAhead(targetIdx, generation);
      return;
    }

    const cached = bitmapCache.get(targetIdx);
    if (cached && cached.width > 0) {
      applyBitmap(targetIdx, cached);
      prefetchAhead(targetIdx, generation);
      return;
    }

    // Keep off-thread lookahead decoding pipelined ahead of targetIdx even while
    // a current target frame is still decoding.
    prefetchAhead(targetIdx, generation);

    if (decodingTarget) return;

    const reqIdx = targetIdx;
    const gen = generation;
    decodingTarget = true;

    decodeFrame(reqIdx, gen).then((bmp) => {
      decodingTarget = false;
      if (gen !== generation) return;

      if (bmp && shouldApplyDecodedFrame(reqIdx)) {
        applyBitmap(reqIdx, bmp);
      }

      // Guard against infinite decode spin on a corrupt JPEG frame: only recurse if targetIdx moved
      if (targetIdx !== reqIdx && targetIdx !== currentIdx && targetIdx >= 0 && targetIdx < frames.length) {
        pumpDecode();
      } else {
        prefetchAhead(targetIdx, gen);
      }
    });
  }

  function load(jpegFrames, clipDurationSec, frameTimestamps = null) {
    unload();
    frames = Array.isArray(jpegFrames) ? jpegFrames : [];
    durationSec = Math.max(0.1, clipDurationSec || 0.5);
    timestamps =
      Array.isArray(frameTimestamps) && frameTimestamps.length === frames.length
        ? frameTimestamps
        : null;
  }

  function unload() {
    generation += 1;
    frames = [];
    timestamps = null;
    durationSec = 0;
    currentIdx = -1;
    targetIdx = -1;
    currentBitmap = null;
    decodingTarget = false;
    inflight.clear();
    for (const bmp of bitmapCache.values()) {
      try {
        bmp.close?.();
      } catch {}
    }
    bitmapCache.clear();
  }

  function clearCanvas() {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, canvasEl.width, canvasEl.height);
  }

  function showFrame(idx) {
    if (!frames.length) return;
    const clamped = Math.max(0, Math.min(frames.length - 1, idx));
    targetIdx = clamped;
    if (clamped === currentIdx && currentBitmap) return;
    pumpDecode();
  }

  function getIndexForTime(playheadSec) {
    const count = frames.length;
    if (!count) return -1;
    if (timestamps) {
      if (playheadSec <= timestamps[0]) return 0;
      if (playheadSec >= timestamps[count - 1]) return count - 1;
      let lo = 0;
      let hi = count - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (timestamps[mid] <= playheadSec) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    }
    const progress = durationSec > 0 ? Math.max(0, Math.min(1, playheadSec / durationSec)) : 0;
    return Math.min(count - 1, Math.floor(progress * count));
  }

  function getTimeForIndex(idx) {
    const count = frames.length;
    if (!count) return 0;
    const clamped = Math.max(0, Math.min(count - 1, idx));
    if (timestamps) return timestamps[clamped];
    return (clamped / count) * durationSec;
  }

  return {
    load,
    unload,
    clearCanvas,
    showFrame,
    draw,
    getIndexForTime,
    getTimeForIndex,
    getFrameCount: () => frames.length,
    getCurrentIndex: () => currentIdx
  };
}
