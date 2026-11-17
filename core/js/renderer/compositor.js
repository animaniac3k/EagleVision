/**
 * 60fps Dual-Canvas Compositor + Localized Micro-Change Heatmap Engine
 *
 * Heatmap Engine:
 * - Analyzes frame-to-frame luminance deltas on a fast 160×90 grid.
 * - Rejects global camera movement: if >18% of the frame changes at once
 *   (e.g., camera shake or panning), the heatmap suppresses the global spike
 *   and re-anchors its reference background immediately.
 * - Highlights small, localized changes in high-contrast thermal/radar colors.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { buildCanvasFilterString } from './imageFilters.js';
import { recordRenderedFrame } from '../camera/streamStats.js';
import { getRtspCanvas, getRtspFrameSeq } from '../camera/streamManager.js';
import { getClickDistanceInPixels, buildGraduatedCrosshairSvg, RETICLE_VIEWBOX_W, RETICLE_VIEWBOX_H } from './overlayManager.js';
import { aimLoupeAtHit } from './zoomWindow.js';
import { speakDetectionAnnouncement, stopVoiceAnnouncement, preloadVoiceAudio } from '../audio/voiceAudioEngine.js';
import { recordEvent } from '../recorder/memoryRingBuffer.js';
import { triggerAutoSaveHeatmapClip } from '../recorder/instantReplay.js';
import { shouldHoldCanvasPan } from '../ui/ringController.js';

export { speakDetectionAnnouncement, stopVoiceAnnouncement, preloadVoiceAudio };

const HEAT_W = 160;
const HEAT_H = 90;
const HEAT_CELLS = HEAT_W * HEAT_H;
const DEFAULT_SHAKE_GATE_PCT = 18;
const OVERSIZE_FREEZE_MS = 1500;
const RECENT_ISLAND_WINDOW_MS = 550;
const MAX_DETECTION_HITS = 30;

let nextHitSeq = 1;
let rezeroHandler = null;
const heatmapTelemetryListeners = new Set();
let latestProjection = {
  vw: 1920,
  vh: 1080,
  cw: 1920,
  ch: 1080,
  sx: 0,
  sy: 0,
  cropW: 1920,
  cropH: 1080
};

/**
 * Subscribe to live ~15Hz heatmap noise-floor & gate telemetry while setup UI is open.
 */
export function subscribeHeatmapTelemetry(fn) {
  heatmapTelemetryListeners.add(fn);
  return () => heatmapTelemetryListeners.delete(fn);
}

/**
 * Returns the latest source-to-live-canvas projection metrics (accounts for aspect crop, zoom, pan).
 */
export function getLiveViewportProjection() {
  return latestProjection;
}

/**
 * Re-anchors the heatmap background reference immediately and clears accumulated thermal persistence.
 */
export function rezeroHeatmap() {
  if (rezeroHandler) rezeroHandler();
}

const SINGULAR_UNIT_MAP = {
  clicks: 'click',
  mils: 'mil',
  marks: 'mark',
  units: 'unit',
  degrees: 'degree',
  meters: 'meter',
  yards: 'yard'
};

function formatVoiceUnit(count, rawUnit) {
  const clean = (rawUnit || 'clicks').trim();
  if (count === 1) {
    return SINGULAR_UNIT_MAP[clean.toLowerCase()] || clean;
  }
  return clean;
}

/**
 * Computes axis click offsets and direction label from pixel displacement relative to optical center.
 */
export function computeClickCalloutOffset(dxPx, dyPx, clickPx, mode = appState.detectionCalloutMode) {
  const safeClickPx = Math.max(1, Number(clickPx) || 1);
  let xClicks = Math.abs(dxPx) >= safeClickPx * 0.4 ? Math.max(1, Math.round(Math.abs(dxPx) / safeClickPx)) : 0;
  let yClicks = Math.abs(dyPx) >= safeClickPx * 0.4 ? Math.max(1, Math.round(Math.abs(dyPx) / safeClickPx)) : 0;

  // Prevent diagonal hits >0.5 clicks away from snapping to Center on both axes
  if (xClicks === 0 && yClicks === 0 && Math.hypot(dxPx, dyPx) >= safeClickPx * 0.5) {
    if (Math.abs(dxPx) >= Math.abs(dyPx)) {
      xClicks = 1;
    } else {
      yClicks = 1;
    }
  }

  const calloutMode = mode === 'poa' ? 'poa' : 'poi';
  const impactXDir = dxPx >= 0 ? 'right' : 'left';
  const impactYDir = dyPx <= 0 ? 'up' : 'down';
  const xDir = calloutMode === 'poa' ? (impactXDir === 'right' ? 'left' : 'right') : impactXDir;
  const yDir = calloutMode === 'poa' ? (impactYDir === 'up' ? 'down' : 'up') : impactYDir;

  const dirParts = [];
  if (xClicks > 0) dirParts.push(`${xClicks} ${xDir[0].toUpperCase() + xDir.slice(1)}`);
  if (yClicks > 0) dirParts.push(`${yClicks} ${yDir[0].toUpperCase() + yDir.slice(1)}`);
  const baseLabel = dirParts.length ? dirParts.join(', ') : 'Center';
  const dirLabel = calloutMode === 'poa' && dirParts.length ? `${baseLabel} (POA)` : baseLabel;

  return { xClicks, xDir, yClicks, yDir, calloutMode, dirLabel };
}

/**
 * Formats an axis-based voice callout phrase (e.g. "Detection! 3 clicks right, 2 clicks up").
 */
export function buildDetectionCalloutPhrase({ xClicks = 0, xDir = 'right', yClicks = 0, yDir = 'up' } = {}) {
  const alertWord = (appState.voiceAlertKeyword || 'Detection').trim();
  const rawUnit = (appState.voiceUnitKeyword || 'clicks').trim();

  const segments = [];
  if (xClicks > 0) {
    segments.push(`${xClicks} ${formatVoiceUnit(xClicks, rawUnit)} ${xDir}`);
  }
  if (yClicks > 0) {
    segments.push(`${yClicks} ${formatVoiceUnit(yClicks, rawUnit)} ${yDir}`);
  }

  return segments.length
    ? `${alertWord}! ${segments.join(', ')}`
    : `${alertWord}! Center`;
}

/**
 * Clears all logged session detection pins from state.
 */
export function clearDetectionHits() {
  nextHitSeq = 1;
  updateState({ detectionHits: [], selectedHitId: null });
}

/**
 * Adds a normalized exclude zone ({ x, y, w, h } in [0..1]) so heatmap ignores wind/foliage motion there.
 */
export function addHeatmapIgnoreZone(zone) {
  if (!zone) return;
  const x = Math.max(0, Math.min(0.98, Number(zone.x) || 0));
  const y = Math.max(0, Math.min(0.98, Number(zone.y) || 0));
  const w = Math.max(0.02, Math.min(1 - x, Number(zone.w) || 0.08));
  const h = Math.max(0.02, Math.min(1 - y, Number(zone.h) || 0.08));
  const prev = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
  updateState({ heatmapIgnoreMasks: [...prev, { x, y, w, h }] });
}

/**
 * Removes all heatmap ignore mask zones.
 */
export function clearHeatmapIgnoreZones() {
  updateState({ heatmapIgnoreMasks: [] });
}

/**
 * Captures the given base canvas (and optional #svgOverlay reticle) into a timestamped PNG download.
 */
export async function exportAnnotatedCanvasPng(baseCanvas, options = {}) {
  if (!baseCanvas || !baseCanvas.width || !baseCanvas.height) return false;
  const { includeReticle = true, reticleZoom = null, prefix = 'SPOTR', drawExtra = null } = options;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = baseCanvas.width;
  outCanvas.height = baseCanvas.height;
  const ctx = outCanvas.getContext('2d');
  if (!ctx) return false;

  ctx.drawImage(baseCanvas, 0, 0, outCanvas.width, outCanvas.height);

  if (typeof drawExtra === 'function') {
    await drawExtra(ctx, outCanvas.width, outCanvas.height);
  }

  if (includeReticle) {
    try {
      const zoomVal = reticleZoom !== null ? Math.max(1.0, Number(reticleZoom) || 1.0) : Math.max(1.0, Number(appState.mainZoom) || 1.0);
      const ffpFactor = appState.reticleFfpMode ? zoomVal : 1.0;
      const scaleVal = ((appState.overlayScale ?? 100) / 100) * ffpFactor;
      const alpha = Math.max(0.1, Math.min(1, (appState.overlayOpacity ?? 85) / 100));

      if (appState.overlayType === 'custom' && appState.customOverlayUrl) {
        await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.save();
            ctx.globalAlpha = alpha;
            const fitScale = Math.min((outCanvas.width * 0.9) / Math.max(1, img.width), (outCanvas.height * 0.9) / Math.max(1, img.height)) * scaleVal;
            const drawW = img.width * fitScale;
            const drawH = img.height * fitScale;
            ctx.drawImage(img, (outCanvas.width - drawW) / 2, (outCanvas.height - drawH) / 2, drawW, drawH);
            ctx.restore();
            resolve();
          };
          img.onerror = () => resolve();
          img.src = appState.customOverlayUrl;
        });
      } else {
        const accentColor = appState.themeColor || '#f97316';
        const svgInner = buildGraduatedCrosshairSvg(appState.reticleConfig)
          .replaceAll('var(--radar-accent)', accentColor);
        const svgText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${RETICLE_VIEWBOX_W} ${RETICLE_VIEWBOX_H}" preserveAspectRatio="xMidYMid meet" width="${outCanvas.width}" height="${outCanvas.height}">${svgInner}</svg>`;
        const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
        const svgUrl = URL.createObjectURL(svgBlob);
        await new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            ctx.save();
            ctx.globalAlpha = alpha;
            ctx.translate(outCanvas.width / 2, outCanvas.height / 2);
            ctx.scale(scaleVal, scaleVal);
            ctx.drawImage(img, -outCanvas.width / 2, -outCanvas.height / 2, outCanvas.width, outCanvas.height);
            ctx.restore();
            URL.revokeObjectURL(svgUrl);
            resolve();
          };
          img.onerror = () => {
            URL.revokeObjectURL(svgUrl);
            resolve();
          };
          img.src = svgUrl;
        });
      }
    } catch {
      // Ignore SVG rasterization fallback errors
    }
  }

  return new Promise((resolve) => {
    outCanvas.toBlob((blob) => {
      if (!blob) {
        resolve(false);
        return;
      }
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${prefix}_${stamp}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      resolve(true);
    }, 'image/png');
  });
}

/**
 * Captures the currently visible live or replay canvas + reticle overlay as a PNG file.
 */
export async function captureAnnotatedSnapshot() {
  const mainCanvas = document.getElementById('mainCanvas');
  return exportAnnotatedCanvasPng(mainCanvas, {
    includeReticle: Boolean(appState.overlayEnabled),
    prefix: 'SPOTR_Live'
  });
}

export function initCompositor(videoEl) {
  const mainCanvas = document.getElementById('mainCanvas');
  const pipCanvas = document.getElementById('pipCanvas');
  const setupCanvas = document.getElementById('heatmapSetupCanvas');
  const mainCtx = mainCanvas.getContext('2d', { alpha: false, desynchronized: true }) || mainCanvas.getContext('2d');
  const pipCtx = pipCanvas.getContext('2d', { alpha: false }) || pipCanvas.getContext('2d');
  const setupCtx = setupCanvas ? setupCanvas.getContext('2d') : null;

  // Offscreen buffers for Localized Micro-Change Heatmap
  const sampleCanvas = document.createElement('canvas');
  sampleCanvas.width = HEAT_W;
  sampleCanvas.height = HEAT_H;
  const sampleCtx = sampleCanvas.getContext('2d', { willReadFrequently: true });

  const heatOverlayCanvas = document.createElement('canvas');
  heatOverlayCanvas.width = HEAT_W;
  heatOverlayCanvas.height = HEAT_H;
  const heatOverlayCtx = heatOverlayCanvas.getContext('2d');
  const heatImgData = heatOverlayCtx.createImageData(HEAT_W, HEAT_H);

  const refLuma = new Float32Array(HEAT_CELLS);
  const currentLuma = new Float32Array(HEAT_CELLS);
  const heatAccum = new Float32Array(HEAT_CELLS);
  const ignoreMaskGrid = new Uint8Array(HEAT_CELLS);
  const recentActiveAt = new Float32Array(HEAT_CELLS);
  const islandVisited = new Uint8Array(HEAT_CELLS);
  const islandQueue = new Int32Array(HEAT_CELLS);
  const islandCells = new Int32Array(HEAT_CELLS);
  const deltaHist = new Uint32Array(256);
  let lastMasksRef = null;
  let refInitialized = false;
  let lastHeatTimeMs = performance.now();
  let lastHeatComputeMs = 0;
  let oversizeSinceMs = 0;
  let smoothNoiseDelta = 0;
  let smoothPeakDelta = 0;
  let setupCanvasCleared = true;

  const liveHeatSnapshot = {
    noiseDelta: 0,
    peakDelta: 0,
    threshold: 36.4,
    changedCells: 0,
    activeCells: HEAT_CELLS,
    changedFraction: 0,
    spikeCount: 0,
    spikeFraction: 0,
    gateStatus: 'idle',
    clusterMinX: HEAT_W,
    clusterMinY: HEAT_H,
    clusterMaxX: -1,
    clusterMaxY: -1,
    lastOutcomeStatus: 'idle',
    lastOutcomeCells: 0,
    lastOutcomeFrac: 0,
    lastOutcomeMs: 0
  };

  const hitThumbCanvas = document.createElement('canvas');
  const hitThumbCtx = hitThumbCanvas.getContext('2d');

  rezeroHandler = () => {
    heatAccum.fill(0);
    recentActiveAt.fill(0);
    oversizeSinceMs = 0;
    refInitialized = false;
    smoothNoiseDelta = 0;
    smoothPeakDelta = 0;
    liveHeatSnapshot.changedCells = 0;
    liveHeatSnapshot.spikeCount = 0;
    liveHeatSnapshot.gateStatus = 'idle';
    liveHeatSnapshot.clusterMaxX = -1;
    liveHeatSnapshot.lastOutcomeStatus = 'idle';
    liveHeatSnapshot.lastOutcomeMs = 0;
    heatImgData.data.fill(0);
    heatOverlayCtx.putImageData(heatImgData, 0, 0);
  };

  function syncIgnoreMaskGrid() {
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    if (masks === lastMasksRef) return;
    lastMasksRef = masks;
    ignoreMaskGrid.fill(0);
    for (const m of masks) {
      const x0 = Math.max(0, Math.floor((m.x || 0) * HEAT_W));
      const y0 = Math.max(0, Math.floor((m.y || 0) * HEAT_H));
      const x1 = Math.min(HEAT_W, Math.ceil(((m.x || 0) + (m.w || 0)) * HEAT_W));
      const y1 = Math.min(HEAT_H, Math.ceil(((m.y || 0) + (m.h || 0)) * HEAT_H));
      for (let gy = y0; gy < y1; gy++) {
        const rowOff = gy * HEAT_W;
        for (let gx = x0; gx < x1; gx++) {
          ignoreMaskGrid[rowOff + gx] = 1;
          heatAccum[rowOff + gx] = 0;
        }
      }
    }
  }

  function computeDirectionMetrics(detSourceNormX, detSourceNormY, sx, sy, cropW, cropH, vw, vh, cw, ch) {
    const detViewX = (detSourceNormX * vw - sx) / cropW;
    const detViewY = (detSourceNormY * vh - sy) / cropH;

    // Anchor at the Scope Reticle Center (0.5, 0.5), decoupled from PiP Loupe ROI position
    const dxPx = (detViewX - 0.5) * cw;
    const dyPx = (detViewY - 0.5) * ch;

    const clickPx = Math.max(1, getClickDistanceInPixels(cw, ch, appState.overlayScale));
    const offset = computeClickCalloutOffset(dxPx, dyPx, clickPx, appState.detectionCalloutMode);
    return { detViewX, detViewY, ...offset };
  }

  function announceHitVoice(hitMetrics) {
    if (!appState.heatmapSpeechEnabled) return;
    speakDetectionAnnouncement(buildDetectionCalloutPhrase(hitMetrics));
  }

  /**
   * Single consolidated detection handler:
   * Every confirmed detection from the heatmap algorithm executes spatial hit logging,
   * voice callout (if enabled), timeline event marker, and optional auto-save together.
   */
  function handleConsolidatedDetection(detSourceNormX, detSourceNormY, videoSource, vw, vh, metrics) {
    const nowWall = Date.now();
    const nowPerf = performance.now();
    const hits = Array.isArray(appState.detectionHits) ? appState.detectionHits : [];
    const last = hits.length ? hits[hits.length - 1] : null;

    if (last && (nowWall - last.timestampMs) < 1500 && Math.hypot(detSourceNormX - last.normX, detSourceNormY - last.normY) < 0.055) {
      const updated = hits.slice();
      updated[updated.length - 1] = {
        ...last,
        timestampMs: nowWall,
        perfMs: nowPerf,
        normX: (last.normX + detSourceNormX) * 0.5,
        normY: (last.normY + detSourceNormY) * 0.5,
        xClicks: metrics.xClicks,
        xDir: metrics.xDir,
        yClicks: metrics.yClicks,
        yDir: metrics.yDir,
        calloutMode: metrics.calloutMode,
        dirLabel: metrics.dirLabel
      };
      updateState({ detectionHits: updated });
      return;
    }

    let thumbDataUrl = '';
    try {
      const scale = vw > 960 ? 960 / vw : 1;
      const tw = Math.max(160, Math.round(vw * scale));
      const th = Math.max(90, Math.round(vh * scale));
      if (hitThumbCanvas.width !== tw || hitThumbCanvas.height !== th) {
        hitThumbCanvas.width = tw;
        hitThumbCanvas.height = th;
      }
      if (hitThumbCtx) {
        hitThumbCtx.drawImage(videoSource, 0, 0, tw, th);
        thumbDataUrl = hitThumbCanvas.toDataURL('image/jpeg', 0.72);
      }
    } catch {
      thumbDataUrl = '';
    }

    const newHit = {
      id: nextHitSeq++,
      timestampMs: nowWall,
      perfMs: nowPerf,
      normX: detSourceNormX,
      normY: detSourceNormY,
      xClicks: metrics.xClicks,
      xDir: metrics.xDir,
      yClicks: metrics.yClicks,
      yDir: metrics.yDir,
      calloutMode: metrics.calloutMode,
      dirLabel: metrics.dirLabel,
      thumbDataUrl,
      frameW: vw,
      frameH: vh
    };

    const autoAimActive = Boolean(appState.pipEnabled && appState.autoAimLoupe);
    const nextHits = hits.length >= MAX_DETECTION_HITS ? [...hits.slice(1), newHit] : [...hits, newHit];
    updateState({
      detectionHits: nextHits,
      selectedHitId: autoAimActive ? newHit.id : (appState.selectedHitId ?? newHit.id)
    });

    if (autoAimActive) {
      aimLoupeAtHit(newHit, { switchToLive: false, ensurePipVisible: false });
    }

    announceHitVoice(metrics);
    recordEvent('heatmap');
    triggerAutoSaveHeatmapClip(newHit.id);
  }

  function updateHeatmap(videoSource, sx, sy, cropW, cropH, vw, vh, cw, ch) {
    const nowMs = performance.now();
    const dtSec = Math.max(0.005, Math.min(0.25, (nowMs - lastHeatTimeMs) / 1000));
    lastHeatTimeMs = nowMs;

    sampleCtx.drawImage(videoSource, 0, 0, HEAT_W, HEAT_H);
    const src = sampleCtx.getImageData(0, 0, HEAT_W, HEAT_H).data;
    const out = heatImgData.data;

    // Map sensitivity (10..95) to pixel delta threshold (75..8)
    const sens = Math.max(10, Math.min(95, appState.heatmapSensitivity));
    const threshold = 82 - sens * 0.76;

    // Compute per-frame decay factor so peak heat (255) decays to visibility threshold (20)
    // over the exact user-selected heatmapDuration (0.5s .. 60.0s)
    const durationSec = Math.max(0.2, Number(appState.heatmapDuration) || 2.0);
    const decayFactor = Math.exp((-2.545 * dtSec) / durationSec);

    if (!refInitialized) {
      for (let i = 0; i < HEAT_CELLS; i++) {
        const p = i * 4;
        refLuma[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
        heatAccum[i] = 0;
      }
      refInitialized = true;
      return;
    }

    syncIgnoreMaskGrid();

    // Pass 1: Measure unmasked luma deltas, exact 98th-percentile noise floor & global motion
    deltaHist.fill(0);
    let changedCells = 0;
    let activeCells = 0;
    let maxDelta = 0;
    for (let i = 0; i < HEAT_CELLS; i++) {
      const p = i * 4;
      const luma = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      currentLuma[i] = luma;
      if (ignoreMaskGrid[i]) continue;
      activeCells++;
      const d = Math.abs(luma - refLuma[i]);
      const bin = d >= 255 ? 255 : d | 0;
      deltaHist[bin]++;
      if (d > maxDelta) maxDelta = d;
      if (d > threshold) {
        changedCells++;
      }
    }

    let p98Delta = 0;
    if (activeCells > 0) {
      const targetRank = Math.floor(activeCells * 0.98);
      let cumulative = 0;
      for (let b = 0; b < 256; b++) {
        cumulative += deltaHist[b];
        if (cumulative >= targetRank) {
          p98Delta = b;
          break;
        }
      }
    }
    smoothNoiseDelta += (p98Delta - smoothNoiseDelta) * (p98Delta > smoothNoiseDelta ? 0.42 : 0.14);
    smoothPeakDelta += (maxDelta - smoothPeakDelta) * (maxDelta > smoothPeakDelta ? 0.55 : 0.14);

    const changedFraction = activeCells > 0 ? changedCells / activeCells : 0;
    const minHitCells = Math.max(1, Math.min(20, Number(appState.heatmapMinCells) || 2));
    const minAllowedFrac = (minHitCells + 1) / Math.max(1, activeCells);
    const rawMaxAreaFrac = Math.max(0.0001, Math.min(0.25, (Number(appState.heatmapMaxAreaPct) || 5) / 100));
    const maxHitAreaFrac = Math.max(minAllowedFrac, rawMaxAreaFrac);
    const maxAllowedCells = Math.max(minHitCells + 1, Math.round(maxHitAreaFrac * activeCells));
    const shakeGatePct = Math.max(5, Math.min(50, Math.round(Number(appState.heatmapShakeGatePct) || DEFAULT_SHAKE_GATE_PCT)));
    const shakeGateFrac = Math.max(maxHitAreaFrac, shakeGatePct / 100);

    let spikeCount = 0;
    let spikeFraction = 0;
    let gateStatus = 'idle';
    let clusterMinX = HEAT_W;
    let clusterMinY = HEAT_H;
    let clusterMaxX = -1;
    let clusterMaxY = -1;

    // 1. Global Motion / Shake Gate: immediate background re-anchor when > shakeGatePct shifts at once
    if (changedFraction > shakeGateFrac) {
      gateStatus = 'global_shake';
      oversizeSinceMs = 0;
      recentActiveAt.fill(0);
      for (let i = 0; i < HEAT_CELLS; i++) {
        refLuma[i] = currentLuma[i];
        heatAccum[i] *= 0.4;
      }
    } else if (changedFraction > maxHitAreaFrac) {
      // 2. Oversized Flash / Area Gate: suppress without pumping heat & freeze pre-flash refLuma
      //    briefly so simultaneous hits appear cleanly once a brief flash ends.
      gateStatus = 'too_large';
      if (oversizeSinceMs === 0) {
        oversizeSinceMs = nowMs;
      }
      const permanentShift = nowMs - oversizeSinceMs >= OVERSIZE_FREEZE_MS;
      if (permanentShift) {
        oversizeSinceMs = 0;
        recentActiveAt.fill(0);
      }
      for (let i = 0; i < HEAT_CELLS; i++) {
        if (ignoreMaskGrid[i]) {
          heatAccum[i] = 0;
          refLuma[i] = currentLuma[i];
          continue;
        }
        heatAccum[i] *= decayFactor;
        if (permanentShift) {
          refLuma[i] = currentLuma[i];
        }
        if (heatAccum[i] > 28) {
          const cx = i % HEAT_W;
          const cy = (i / HEAT_W) | 0;
          if (cx < clusterMinX) clusterMinX = cx;
          if (cy < clusterMinY) clusterMinY = cy;
          if (cx > clusterMaxX) clusterMaxX = cx;
          if (cy > clusterMaxY) clusterMaxY = cy;
        }
      }
    } else {
      // 3. Localized Change: update heat & refLuma, then evaluate 8-connected islands
      oversizeSinceMs = 0;

      for (let i = 0; i < HEAT_CELLS; i++) {
        if (ignoreMaskGrid[i]) {
          heatAccum[i] = 0;
          recentActiveAt[i] = 0;
          refLuma[i] = currentLuma[i];
          continue;
        }
        const delta = Math.abs(currentLuma[i] - refLuma[i]);
        if (delta > threshold) {
          const added = (delta - threshold) * 3.8;
          heatAccum[i] = Math.min(255, heatAccum[i] + added);
          recentActiveAt[i] = nowMs;
        } else {
          heatAccum[i] *= decayFactor;
        }
        refLuma[i] += (currentLuma[i] - refLuma[i]) * 0.15;
      }

      islandVisited.fill(0);
      let bestHit = null;
      let sawOversizeIsland = false;
      let oversizeBounds = null;
      let oversizeFrac = 0;
      let bestSmallSpikes = 0;
      let bestSmallBounds = null;

      for (let seed = 0; seed < HEAT_CELLS; seed++) {
        if (ignoreMaskGrid[seed] || islandVisited[seed]) continue;
        const rAt = recentActiveAt[seed];
        if (rAt <= 0 || nowMs - rAt > RECENT_ISLAND_WINDOW_MS) continue;

        let qHead = 0;
        let qTail = 0;
        let islandCount = 0;
        let islandSpikes = 0;
        let islandMaxHeat = 0;
        let islandWeightSum = 0;
        let islandSumX = 0;
        let islandSumY = 0;
        let minX = HEAT_W;
        let minY = HEAT_H;
        let maxX = -1;
        let maxY = -1;

        islandVisited[seed] = 1;
        islandQueue[qTail++] = seed;

        while (qHead < qTail) {
          const idx = islandQueue[qHead++];
          islandCells[islandCount++] = idx;

          const cx = idx % HEAT_W;
          const cy = (idx / HEAT_W) | 0;
          if (cx < minX) minX = cx;
          if (cy < minY) minY = cy;
          if (cx > maxX) maxX = cx;
          if (cy > maxY) maxY = cy;

          const h = heatAccum[idx];
          if (h > 115) {
            const delta = Math.abs(currentLuma[idx] - refLuma[idx]);
            const weight = Math.max(1, delta > threshold ? (delta - threshold) * 3.8 : h * 0.2);
            islandSpikes++;
            islandWeightSum += weight;
            islandSumX += cx * weight;
            islandSumY += cy * weight;
            if (h > islandMaxHeat) islandMaxHeat = h;
          }

          for (let dy = -1; dy <= 1; dy++) {
            const ny = cy + dy;
            if (ny < 0 || ny >= HEAT_H) continue;
            const rowOff = ny * HEAT_W;
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const nx = cx + dx;
              if (nx < 0 || nx >= HEAT_W) continue;
              const nIdx = rowOff + nx;
              if (islandVisited[nIdx] || ignoreMaskGrid[nIdx]) continue;
              const nAt = recentActiveAt[nIdx];
              if (nAt > 0 && nowMs - nAt <= RECENT_ISLAND_WINDOW_MS) {
                islandVisited[nIdx] = 1;
                islandQueue[qTail++] = nIdx;
              }
            }
          }
        }

        if (islandCount > maxAllowedCells) {
          // Suppress slow sweep / wide wind island while keeping recentActiveAt intact so sweeps stay linked
          sawOversizeIsland = true;
          const frac = activeCells > 0 ? islandCount / activeCells : 0;
          if (frac > oversizeFrac) {
            oversizeFrac = frac;
            oversizeBounds = { minX, minY, maxX, maxY };
          }
          for (let k = 0; k < islandCount; k++) {
            heatAccum[islandCells[k]] *= 0.35;
          }
        } else if (islandSpikes >= minHitCells && islandMaxHeat >= 135 && islandWeightSum > 0) {
          if (!bestHit || islandWeightSum > bestHit.weightSum) {
            bestHit = {
              spikes: islandSpikes,
              weightSum: islandWeightSum,
              sumX: islandSumX,
              sumY: islandSumY,
              minX,
              minY,
              maxX,
              maxY
            };
          }
        } else if (islandSpikes > bestSmallSpikes || (changedCells > 0 && !bestSmallBounds)) {
          bestSmallSpikes = Math.max(bestSmallSpikes, islandSpikes);
          bestSmallBounds = { minX, minY, maxX, maxY };
        }
      }

      if (bestHit) {
        gateStatus = 'valid';
        spikeCount = bestHit.spikes;
        spikeFraction = activeCells > 0 ? spikeCount / activeCells : 0;
        clusterMinX = bestHit.minX;
        clusterMinY = bestHit.minY;
        clusterMaxX = bestHit.maxX;
        clusterMaxY = bestHit.maxY;
        const centroidNormX = (bestHit.sumX / bestHit.weightSum + 0.5) / HEAT_W;
        const centroidNormY = (bestHit.sumY / bestHit.weightSum + 0.5) / HEAT_H;
        const metrics = computeDirectionMetrics(centroidNormX, centroidNormY, sx, sy, cropW, cropH, vw, vh, cw, ch);
        handleConsolidatedDetection(centroidNormX, centroidNormY, videoSource, vw, vh, metrics);
      } else if (sawOversizeIsland) {
        gateStatus = 'too_large';
        if (oversizeBounds) {
          clusterMinX = oversizeBounds.minX;
          clusterMinY = oversizeBounds.minY;
          clusterMaxX = oversizeBounds.maxX;
          clusterMaxY = oversizeBounds.maxY;
        }
      } else if (bestSmallSpikes > 0 && bestSmallSpikes < minHitCells) {
        gateStatus = 'below_min';
        spikeCount = bestSmallSpikes;
        if (bestSmallBounds) {
          clusterMinX = bestSmallBounds.minX;
          clusterMinY = bestSmallBounds.minY;
          clusterMaxX = bestSmallBounds.maxX;
          clusterMaxY = bestSmallBounds.maxY;
        }
      } else if (changedCells > 0) {
        gateStatus = changedCells < minHitCells ? 'below_min' : 'building';
        if (bestSmallBounds) {
          clusterMinX = bestSmallBounds.minX;
          clusterMinY = bestSmallBounds.minY;
          clusterMaxX = bestSmallBounds.maxX;
          clusterMaxY = bestSmallBounds.maxY;
        }
      }

      if (clusterMaxX < clusterMinX) {
        for (let i = 0; i < HEAT_CELLS; i++) {
          if (heatAccum[i] > 28) {
            const cx = i % HEAT_W;
            const cy = (i / HEAT_W) | 0;
            if (cx < clusterMinX) clusterMinX = cx;
            if (cy < clusterMinY) clusterMinY = cy;
            if (cx > clusterMaxX) clusterMaxX = cx;
            if (cy > clusterMaxY) clusterMaxY = cy;
          }
        }
      }
    }

    liveHeatSnapshot.noiseDelta = smoothNoiseDelta;
    liveHeatSnapshot.peakDelta = smoothPeakDelta;
    liveHeatSnapshot.threshold = threshold;
    liveHeatSnapshot.changedCells = changedCells;
    liveHeatSnapshot.activeCells = activeCells;
    liveHeatSnapshot.changedFraction = changedFraction;
    liveHeatSnapshot.spikeCount = spikeCount;
    liveHeatSnapshot.spikeFraction = spikeFraction;
    liveHeatSnapshot.gateStatus = gateStatus;
    liveHeatSnapshot.clusterMinX = clusterMinX;
    liveHeatSnapshot.clusterMinY = clusterMinY;
    liveHeatSnapshot.clusterMaxX = clusterMaxX;
    liveHeatSnapshot.clusterMaxY = clusterMaxY;
    if (gateStatus === 'valid' || gateStatus === 'too_large' || gateStatus === 'below_min' || gateStatus === 'global_shake') {
      liveHeatSnapshot.lastOutcomeStatus = gateStatus;
      liveHeatSnapshot.lastOutcomeCells = gateStatus === 'valid' ? spikeCount : Math.max(spikeCount, changedCells);
      liveHeatSnapshot.lastOutcomeFrac = Math.max(changedFraction, spikeFraction);
      liveHeatSnapshot.lastOutcomeMs = nowMs;
    }

    if (heatmapTelemetryListeners.size > 0) {
      for (const fn of heatmapTelemetryListeners) {
        fn(liveHeatSnapshot);
      }
    }

    // Render high-contrast thermal/radar markings into heatOverlayCanvas
    for (let i = 0; i < HEAT_CELLS; i++) {
      const h = heatAccum[i];
      const p = i * 4;
      if (h < 20) {
        out[p + 3] = 0; // Transparent where no change occurred
      } else if (h < 100) {
        // High-contrast electric yellow-green for subtle micro-changes
        out[p] = 255;
        out[p + 1] = 230;
        out[p + 2] = 0;
        out[p + 3] = Math.min(220, Math.round(h * 2.1));
      } else {
        // High-contrast hot crimson/orange-white core for strong localized changes
        out[p] = 255;
        out[p + 1] = Math.max(0, 255 - Math.round((h - 100) * 1.6));
        out[p + 2] = h > 210 ? 255 : 40;
        out[p + 3] = 235;
      }
    }

    heatOverlayCtx.putImageData(heatImgData, 0, 0);
  }

  function drawSetupBadge(ctx, x, y, text, borderCol, textCol) {
    ctx.save();
    ctx.font = '700 11px ui-monospace, SFMono-Regular, Menlo, monospace';
    const padX = 8;
    const h = 20;
    const w = Math.ceil(ctx.measureText(text).width) + padX * 2;
    ctx.fillStyle = 'rgba(6, 9, 13, 0.86)';
    ctx.strokeStyle = borderCol;
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) {
      ctx.roundRect(x, y, w, h, 5);
    } else {
      ctx.rect(x, y, w, h);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = textCol;
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + padX, y + h / 2 + 0.5);
    ctx.restore();
    return { w, h };
  }

  function renderSetupFeedback(sx, sy, cropW, cropH, vw, vh, cw, ch) {
    if (!setupCtx || !setupCanvas) return;
    if (!appState.heatmapSetupOpen) {
      if (!setupCanvasCleared) {
        setupCtx.clearRect(0, 0, setupCanvas.width, setupCanvas.height);
        setupCanvasCleared = true;
      }
      return;
    }

    setupCanvasCleared = false;
    setupCtx.clearRect(0, 0, cw, ch);

    const activeCells = Math.max(1, liveHeatSnapshot.activeCells || HEAT_CELLS);
    const activeFrac = activeCells / HEAT_CELLS;
    const minHitCells = Math.max(1, Math.min(20, Number(appState.heatmapMinCells) || 2));
    const minAllowedFrac = (minHitCells + 1) / activeCells;
    const rawMaxPct = Math.max(0.01, Math.min(20, Number(appState.heatmapMaxAreaPct) || 5));
    const maxHitAreaFrac = Math.max(minAllowedFrac, rawMaxPct / 100);
    const effectiveMaxPct = maxHitAreaFrac * 100;
    const maxPctLabel = effectiveMaxPct < 1
      ? `${effectiveMaxPct.toFixed(2)}%`
      : effectiveMaxPct < 10
        ? `${effectiveMaxPct.toFixed(1)}%`
        : `${Math.round(effectiveMaxPct)}%`;

    const shakeGatePct = Math.max(5, Math.min(50, Math.round(Number(appState.heatmapShakeGatePct) || DEFAULT_SHAKE_GATE_PCT)));
    const shakeGateFrac = Math.max(maxHitAreaFrac, shakeGatePct / 100);
    const shakeCellsAllowed = Math.round(shakeGateFrac * activeCells);

    // 0. Outer Shake Gate Boundary (Re-anchors background above this area)
    const shakeFrameFrac = shakeGateFrac * activeFrac;
    const shakeLinScale = Math.sqrt(shakeFrameFrac);
    const shakeBoxW = Math.max(12, ((shakeLinScale * vw) / cropW) * cw);
    const shakeBoxH = Math.max(12, ((shakeLinScale * vh) / cropH) * ch);
    const shakeLeft = (cw - shakeBoxW) / 2;
    const shakeTop = (ch - shakeBoxH) / 2;

    setupCtx.save();
    setupCtx.strokeStyle = 'rgba(244, 63, 94, 0.45)';
    setupCtx.lineWidth = 1.25;
    setupCtx.setLineDash([4, 6]);
    setupCtx.strokeRect(shakeLeft, shakeTop, shakeBoxW, shakeBoxH);
    setupCtx.restore();

    const shakeLabelX = Math.max(16, Math.min(cw - 220, shakeLeft + shakeBoxW - 210));
    const shakeLabelY = Math.max(58, Math.min(ch - 260, shakeTop - 24));
    drawSetupBadge(
      setupCtx,
      shakeLabelX,
      shakeLabelY,
      `SHAKE GATE · ${shakeGatePct}% (${shakeCellsAllowed}c)`,
      'rgba(244, 63, 94, 0.72)',
      '#fda4af'
    );

    // 1. Exact Max Hit Area Footprint (proportional to unmasked source area, scaled to live zoom)
    const allowedFrameFrac = maxHitAreaFrac * activeFrac;
    const linScale = Math.sqrt(allowedFrameFrac);
    const maxBoxW = Math.max(6, ((linScale * vw) / cropW) * cw);
    const maxBoxH = Math.max(6, ((linScale * vh) / cropH) * ch);
    const maxLeft = (cw - maxBoxW) / 2;
    const maxTop = (ch - maxBoxH) / 2;

    setupCtx.save();
    setupCtx.fillStyle = 'rgba(245, 158, 11, 0.04)';
    setupCtx.fillRect(maxLeft, maxTop, maxBoxW, maxBoxH);
    setupCtx.strokeStyle = 'rgba(245, 158, 11, 0.78)';
    setupCtx.lineWidth = 1.5;
    setupCtx.setLineDash([6, 4]);
    setupCtx.strokeRect(maxLeft, maxTop, maxBoxW, maxBoxH);
    setupCtx.setLineDash([]);

    // Solid corner brackets on Max Hit Area box
    const leg = Math.min(14, maxBoxW * 0.25, maxBoxH * 0.25);
    setupCtx.strokeStyle = '#fbbf24';
    setupCtx.lineWidth = 2.2;
    const bx1 = maxLeft;
    const by1 = maxTop;
    const bx2 = maxLeft + maxBoxW;
    const by2 = maxTop + maxBoxH;
    setupCtx.beginPath();
    setupCtx.moveTo(bx1, by1 + leg); setupCtx.lineTo(bx1, by1); setupCtx.lineTo(bx1 + leg, by1);
    setupCtx.moveTo(bx2 - leg, by1); setupCtx.lineTo(bx2, by1); setupCtx.lineTo(bx2, by1 + leg);
    setupCtx.moveTo(bx1, by2 - leg); setupCtx.lineTo(bx1, by2); setupCtx.lineTo(bx1 + leg, by2);
    setupCtx.moveTo(bx2 - leg, by2); setupCtx.lineTo(bx2, by2); setupCtx.lineTo(bx2, by2 - leg);
    setupCtx.stroke();
    setupCtx.restore();

    const maxCellsAllowed = Math.max(minHitCells + 1, Math.round(maxHitAreaFrac * activeCells));
    const maxLabelX = Math.max(16, Math.min(cw - 240, maxLeft));
    const maxLabelY = Math.max(66, Math.min(ch - 260, maxTop - 26));
    drawSetupBadge(
      setupCtx,
      maxLabelX,
      maxLabelY,
      `MAX HIT AREA · ${maxCellsAllowed} cells (${maxPctLabel})`,
      'rgba(245, 158, 11, 0.8)',
      '#fbbf24'
    );

    // 2. Exact 1:1 Min Hit Size Grid Block (Always inside Max Hit Area box)
    const cellW = ((vw / HEAT_W) / cropW) * cw;
    const cellH = ((vh / HEAT_H) / cropH) * ch;
    const cols = Math.ceil(Math.sqrt(minHitCells));
    const rows = Math.ceil(minHitCells / cols);
    const blockW = Math.max(4, cols * cellW);
    const blockH = Math.max(4, rows * cellH);

    const insetX = maxBoxW >= blockW + 20 ? 10 : Math.max(2, (maxBoxW - blockW) / 2);
    const insetY = maxBoxH >= blockH + 20 ? 10 : Math.max(2, (maxBoxH - blockH) / 2);
    const minAnchorX = Math.max(16, Math.min(cw - blockW - 16, maxLeft + insetX));
    const minAnchorY = Math.max(92, Math.min(ch - blockH - 220, maxTop + insetY));

    setupCtx.save();
    for (let idx = 0; idx < minHitCells; idx++) {
      const gx = idx % cols;
      const gy = (idx / cols) | 0;
      const cx = minAnchorX + gx * cellW;
      const cy = minAnchorY + gy * cellH;
      setupCtx.fillStyle = 'rgba(34, 211, 238, 0.36)';
      setupCtx.strokeStyle = '#22d3ee';
      setupCtx.lineWidth = 1;
      setupCtx.fillRect(cx, cy, Math.max(2, cellW), Math.max(2, cellH));
      setupCtx.strokeRect(cx, cy, Math.max(2, cellW), Math.max(2, cellH));
    }
    setupCtx.restore();

    const badgeFitsInside = maxBoxW >= blockW + 150 && maxBoxH >= 36;
    const minBadgeX = badgeFitsInside
      ? Math.min(cw - 160, minAnchorX + blockW + 8)
      : Math.max(16, Math.min(cw - 160, maxLeft));
    const minBadgeY = badgeFitsInside
      ? minAnchorY + Math.max(0, (blockH - 20) / 2)
      : Math.max(92, Math.min(ch - 225, maxTop + maxBoxH + 8));

    drawSetupBadge(
      setupCtx,
      minBadgeX,
      minBadgeY,
      `MIN HIT · ${minHitCells} cell${minHitCells === 1 ? '' : 's'}`,
      'rgba(34, 211, 238, 0.85)',
      '#67e8f9'
    );

    // 3. Live Active Motion Cluster Bounding Box & Gate Status
    const { clusterMinX, clusterMinY, clusterMaxX, clusterMaxY, gateStatus, spikeCount, changedCells, changedFraction } = liveHeatSnapshot;
    if (gateStatus === 'global_shake') {
      drawSetupBadge(
        setupCtx,
        Math.max(16, (cw - 240) / 2),
        66,
        `SHAKE GATE ACTIVE (${(changedFraction * 100).toFixed(0)}% > ${shakeGatePct}%)`,
        'rgba(244, 63, 94, 0.9)',
        '#fda4af'
      );
    } else if (gateStatus === 'too_large' && clusterMaxX < clusterMinX) {
      drawSetupBadge(
        setupCtx,
        Math.max(16, (cw - 260) / 2),
        66,
        `OVERSIZED SUPPRESSED (${(changedFraction * 100).toFixed(1)}% > ${maxPctLabel})`,
        'rgba(244, 63, 94, 0.9)',
        '#fda4af'
      );
    } else if (clusterMaxX >= clusterMinX && clusterMaxY >= clusterMinY) {
      const x0 = (((clusterMinX / HEAT_W) * vw - sx) / cropW) * cw;
      const y0 = (((clusterMinY / HEAT_H) * vh - sy) / cropH) * ch;
      const x1 = ((((clusterMaxX + 1) / HEAT_W) * vw - sx) / cropW) * cw;
      const y1 = ((((clusterMaxY + 1) / HEAT_H) * vh - sy) / cropH) * ch;
      const bw = Math.max(8, x1 - x0);
      const bh = Math.max(8, y1 - y0);

      const nowMs = performance.now();
      const hasRecentOutcome =
        gateStatus === 'idle' &&
        liveHeatSnapshot.lastOutcomeMs > 0 &&
        nowMs - liveHeatSnapshot.lastOutcomeMs < 1800;
      const effectiveStatus = hasRecentOutcome ? liveHeatSnapshot.lastOutcomeStatus : gateStatus;
      const effectiveCells = hasRecentOutcome ? liveHeatSnapshot.lastOutcomeCells : Math.max(spikeCount, changedCells);
      const effectiveFrac = hasRecentOutcome ? liveHeatSnapshot.lastOutcomeFrac : changedFraction;

      let strokeCol = 'rgba(251, 191, 36, 0.72)';
      let badgeText = 'DECAYING';
      if (effectiveStatus === 'valid') {
        strokeCol = '#10b981';
        badgeText = `VALID HIT · ${effectiveCells} cells (${(effectiveFrac * 100).toFixed(1)}%)`;
      } else if (effectiveStatus === 'too_large') {
        strokeCol = '#f43f5e';
        badgeText = `SUPPRESSED · ${(effectiveFrac * 100).toFixed(1)}% > ${maxPctLabel}`;
      } else if (effectiveStatus === 'below_min') {
        strokeCol = '#22d3ee';
        badgeText = `BELOW MIN · ${effectiveCells}/${minHitCells} cells`;
      } else if (effectiveStatus === 'building') {
        strokeCol = '#fbbf24';
        badgeText = `DETECTING · ${changedCells} cells`;
      } else if (effectiveStatus === 'global_shake') {
        strokeCol = '#f43f5e';
        badgeText = `SHAKE GATE (>${shakeGatePct}%)`;
      }

      setupCtx.save();
      setupCtx.strokeStyle = strokeCol;
      setupCtx.lineWidth = effectiveStatus === 'idle' ? 1.25 : 2;
      setupCtx.setLineDash(effectiveStatus === 'valid' ? [] : [4, 3]);
      setupCtx.strokeRect(x0, y0, bw, bh);
      setupCtx.restore();

      const lblX = Math.max(12, Math.min(cw - 220, x0));
      const lblY = y0 > 88 ? y0 - 24 : Math.min(ch - 220, y0 + bh + 4);
      drawSetupBadge(setupCtx, lblX, lblY, badgeText, strokeCol, strokeCol);
    }
  }

  function syncCanvasSize() {
    const rect = mainCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (mainCanvas.width !== w || mainCanvas.height !== h) {
      mainCanvas.width = w;
      mainCanvas.height = h;
    }
    if (setupCanvas && (setupCanvas.width !== w || setupCanvas.height !== h)) {
      setupCanvas.width = w;
      setupCanvas.height = h;
    }

    const pipRect = pipCanvas.parentElement.getBoundingClientRect();
    if (pipRect.width > 0 && pipRect.height > 0) {
      const pw = Math.round(pipRect.width);
      const ph = Math.round(pipRect.height);
      if (pipCanvas.width !== pw || pipCanvas.height !== ph) {
        pipCanvas.width = pw;
        pipCanvas.height = ph;
      }
    }
  }
  window.addEventListener('resize', syncCanvasSize);
  syncCanvasSize();

  let lastFilterCss = '';
  subscribeState((state, patch = {}) => {
    const filterCss = buildCanvasFilterString(state);
    if (filterCss !== lastFilterCss) {
      lastFilterCss = filterCss;
      mainCanvas.style.filter = filterCss;
      pipCanvas.style.filter = filterCss;
    }
    if (patch.currentScreen === 'live' && state.currentScreen === 'live') {
      requestAnimationFrame(syncCanvasSize);
    }
    if (!state.heatmapEnabled && !state.heatmapSpeechEnabled && !state.heatmapSetupOpen) {
      refInitialized = false;
      recentActiveAt.fill(0);
      oversizeSinceMs = 0;
    }
  });

  // Panning the main image when zoomed in (>1.0x)
  let panning = false;
  let panCommitted = false;
  let panPointerId = null;
  let panStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  mainCanvas.addEventListener('pointerdown', (e) => {
    if (appState.mainZoom <= 1.01 || appState.liveMaskDrawActive) return;
    panning = true;
    panPointerId = e.pointerId;
    panStartTime = performance.now();
    panCommitted = !shouldHoldCanvasPan(panStartTime);
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffsetX = appState.mainPanX;
    startOffsetY = appState.mainPanY;
    try {
      mainCanvas.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture errors
    }
  });

  mainCanvas.addEventListener('pointermove', (e) => {
    if (!panning || e.pointerId !== panPointerId) return;
    if (!panCommitted) {
      if (shouldHoldCanvasPan(panStartTime)) return;
      panCommitted = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
    }
    const dx = (e.clientX - panStartX) / mainCanvas.width;
    const dy = (e.clientY - panStartY) / mainCanvas.height;
    const maxPan = Math.max(0, (1 - 1 / appState.mainZoom) / 2);
    updateState({
      mainPanX: Math.max(-maxPan, Math.min(maxPan, startOffsetX - dx / appState.mainZoom)),
      mainPanY: Math.max(-maxPan, Math.min(maxPan, startOffsetY - dy / appState.mainZoom))
    });
  });

  const stopPan = (e) => {
    if (panPointerId !== null && e?.pointerId !== undefined && e.pointerId !== panPointerId) return;
    panning = false;
    panCommitted = false;
    panPointerId = null;
  };
  mainCanvas.addEventListener('pointerup', stopPan);
  mainCanvas.addEventListener('pointercancel', stopPan);
  mainCanvas.addEventListener('lostpointercapture', stopPan);

  let lastRenderKey = '';

  function renderLoop() {
    if (appState.currentScreen !== 'live') {
      lastRenderKey = '';
    } else {
      const isRtsp = Boolean(appState.isRtspStream);
      const rtspCanv = isRtsp ? getRtspCanvas() : null;
      const source = isRtsp ? rtspCanv : videoEl;
      const sourceReady = isRtsp
        ? Boolean(rtspCanv && rtspCanv.width > 0 && rtspCanv.height > 0)
        : Boolean(videoEl && videoEl.readyState >= 2);

      if (sourceReady) {
        const vw = (isRtsp ? source.width : videoEl.videoWidth) || appState.streamWidth || 1920;
        const vh = (isRtsp ? source.height : videoEl.videoHeight) || appState.streamHeight || 1080;
        const cw = mainCanvas.width;
        const ch = mainCanvas.height;
        const pw = pipCanvas.width || 340;
        const ph = pipCanvas.height || 210;

        const detectorActive = Boolean(appState.heatmapEnabled || appState.heatmapSpeechEnabled || appState.heatmapSetupOpen);
        const showHeatmapOverlay = Boolean(appState.heatmapEnabled || appState.heatmapSetupOpen);
        if (isRtsp) {
          const heatTick = detectorActive ? Math.floor(performance.now() / 48) : 0;
          const renderKey = `${getRtspFrameSeq()}|${vw}x${vh}|${cw}x${ch}|${pw}x${ph}|${appState.mainZoom}|${appState.mainPanX}|${appState.mainPanY}|${appState.pipEnabled}|${appState.pipZoom}|${appState.roiX}|${appState.roiY}|${appState.heatmapEnabled}|${appState.heatmapSpeechEnabled}|${appState.heatmapSetupOpen}|${appState.heatmapSensitivity}|${appState.heatmapMinCells}|${appState.heatmapMaxAreaPct}|${appState.heatmapShakeGatePct}|${(appState.heatmapIgnoreMasks || []).length}|${heatTick}`;
          if (renderKey === lastRenderKey) {
            requestAnimationFrame(renderLoop);
            return;
          }
          lastRenderKey = renderKey;
        } else {
          lastRenderKey = '';
        }

        const videoAspect = vw / vh;
        const canvasAspect = cw / ch;
        let baseW = vw;
        let baseH = vh;
        if (canvasAspect > videoAspect) {
          baseH = vw / canvasAspect;
        } else {
          baseW = vh * canvasAspect;
        }

        const zoom = appState.mainZoom;
        const cropW = baseW / zoom;
        const cropH = baseH / zoom;
        const centerX = vw * (0.5 + appState.mainPanX);
        const centerY = vh * (0.5 + appState.mainPanY);
        const sx = Math.max(0, Math.min(vw - cropW, centerX - cropW / 2));
        const sy = Math.max(0, Math.min(vh - cropH, centerY - cropH / 2));

        latestProjection = { vw, vh, cw, ch, sx, sy, cropW, cropH };

        if (detectorActive) {
          const nowMs = performance.now();
          if (nowMs - lastHeatComputeMs >= 48) { // Decouple heavy pixel analysis to ~20Hz to eliminate GPU readback stalls
            updateHeatmap(source, sx, sy, cropW, cropH, vw, vh, cw, ch);
            lastHeatComputeMs = nowMs;
          }
        }

        // 1. Render Main Canvas
        mainCtx.drawImage(source, sx, sy, cropW, cropH, 0, 0, cw, ch);
        if (showHeatmapOverlay) {
          mainCtx.drawImage(
            heatOverlayCanvas,
            (sx / vw) * HEAT_W,
            (sy / vh) * HEAT_H,
            (cropW / vw) * HEAT_W,
            (cropH / vh) * HEAT_H,
            0,
            0,
            cw,
            ch
          );
        }

        // 1b. Render Transient Heatmap Setup Feedback (Min/Max Boxes & Active Cluster Status)
        renderSetupFeedback(sx, sy, cropW, cropH, vw, vh, cw, ch);

        // 2. Render Magnified PiP Zoom Window
        if (appState.pipEnabled) {
          const pipParent = pipCanvas.parentElement;
          if (pipParent && pipParent.clientWidth > 0 && pipParent.clientHeight > 0) {
            const targetPw = Math.max(160, Math.round(pipParent.clientWidth));
            const targetPh = Math.max(100, Math.round(pipParent.clientHeight));
            if (pipCanvas.width !== targetPw || pipCanvas.height !== targetPh) {
              pipCanvas.width = targetPw;
              pipCanvas.height = targetPh;
            }
          }
          const drawPw = pipCanvas.width || 340;
          const drawPh = pipCanvas.height || 210;
          const targetSourceX = sx + appState.roiX * cropW;
          const targetSourceY = sy + appState.roiY * cropH;

          const pipCropW = (cropW * (drawPw / cw)) / appState.pipZoom;
          const pipCropH = (cropH * (drawPh / ch)) / appState.pipZoom;

          const psx = Math.max(0, Math.min(vw - pipCropW, targetSourceX - pipCropW / 2));
          const psy = Math.max(0, Math.min(vh - pipCropH, targetSourceY - pipCropH / 2));

          pipCtx.drawImage(source, psx, psy, pipCropW, pipCropH, 0, 0, drawPw, drawPh);
          if (showHeatmapOverlay) {
            pipCtx.drawImage(
              heatOverlayCanvas,
              (psx / vw) * HEAT_W,
              (psy / vh) * HEAT_H,
              (pipCropW / vw) * HEAT_W,
              (pipCropH / vh) * HEAT_H,
              0,
              0,
              drawPw,
              drawPh
            );
          }
        }

        recordRenderedFrame(videoEl);
      }
    }

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
  return mainCanvas;
}
