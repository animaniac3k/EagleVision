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
import { speakDetectionAnnouncement, stopVoiceAnnouncement, preloadVoiceAudio } from '../audio/voiceAudioEngine.js';
import { recordEvent } from '../recorder/memoryRingBuffer.js';
import { triggerAutoSaveHeatmapClip } from '../recorder/instantReplay.js';
import { shouldHoldCanvasPan } from '../ui/ringController.js';

export { speakDetectionAnnouncement, stopVoiceAnnouncement, preloadVoiceAudio };

const HEAT_W = 160;
const HEAT_H = 90;
const HEAT_CELLS = HEAT_W * HEAT_H;
const GLOBAL_MOTION_REJECTION_RATIO = 0.18; // If >18% of image changes at once, treat as camera movement
const MAX_DETECTION_HITS = 30;

let nextHitSeq = 1;
let rezeroHandler = null;

/**
 * Re-anchors the heatmap background reference immediately and clears accumulated thermal persistence.
 */
export function rezeroHeatmap() {
  if (rezeroHandler) rezeroHandler();
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
  const mainCtx = mainCanvas.getContext('2d', { alpha: false, desynchronized: true }) || mainCanvas.getContext('2d');
  const pipCtx = pipCanvas.getContext('2d', { alpha: false }) || pipCanvas.getContext('2d');

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
  let lastMasksRef = null;
  let refInitialized = false;
  let lastHeatTimeMs = performance.now();
  let lastHeatComputeMs = 0;

  const hitThumbCanvas = document.createElement('canvas');
  const hitThumbCtx = hitThumbCanvas.getContext('2d');

  rezeroHandler = () => {
    heatAccum.fill(0);
    refInitialized = false;
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

    const refX = (appState.pipEnabled && appState.roiTargetVisible) ? (appState.roiX ?? 0.5) : 0.5;
    const refY = (appState.pipEnabled && appState.roiTargetVisible) ? (appState.roiY ?? 0.5) : 0.5;
    const dx = (detViewX - refX) * cw;
    const dy = (detViewY - refY) * ch;
    const distPx = Math.hypot(dx, dy);

    const clickPx = getClickDistanceInPixels(cw, ch, appState.overlayScale);
    let clicks = 0;
    if (distPx >= clickPx * 0.4) {
      clicks = Math.max(1, Math.round(distPx / Math.max(1, clickPx)));
    }

    const angleDeg = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    let clockHour = Math.round(angleDeg / 30);
    if (clockHour === 0) clockHour = 12;

    const dirLabel = clicks === 0 ? 'Center' : `${clockHour} o'c, ${clicks} clk`;
    return { detViewX, detViewY, clockHour, clicks, dirLabel };
  }

  function announceHitVoice(hitMetrics) {
    if (!appState.heatmapSpeechEnabled) return;
    const { clockHour, clicks } = hitMetrics;
    const alertWord = (appState.voiceAlertKeyword || 'Detection').trim();
    const rawUnit = (appState.voiceUnitKeyword || 'clicks').trim();
    const unitWord = clicks === 1 && rawUnit.toLowerCase() === 'clicks' ? 'click' : rawUnit;

    const phrase = clicks === 0
      ? `${alertWord}! Center`
      : `${alertWord}! ${clockHour} o'clock, ${clicks} ${unitWord}`;

    speakDetectionAnnouncement(phrase);
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
        clockHour: metrics.clockHour,
        clicks: metrics.clicks,
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
      clockHour: metrics.clockHour,
      clicks: metrics.clicks,
      dirLabel: metrics.dirLabel,
      thumbDataUrl,
      frameW: vw,
      frameH: vh
    };

    const nextHits = hits.length >= MAX_DETECTION_HITS ? [...hits.slice(1), newHit] : [...hits, newHit];
    updateState({
      detectionHits: nextHits,
      selectedHitId: appState.selectedHitId ?? newHit.id
    });

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

    // Pass 1: Measure how many unmasked cells changed above threshold to detect global camera motion
    let changedCells = 0;
    let activeCells = 0;
    for (let i = 0; i < HEAT_CELLS; i++) {
      const p = i * 4;
      const luma = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      currentLuma[i] = luma;
      if (ignoreMaskGrid[i]) continue;
      activeCells++;
      if (Math.abs(luma - refLuma[i]) > threshold) {
        changedCells++;
      }
    }

    const changedFraction = activeCells > 0 ? changedCells / activeCells : 0;

    // Global Motion Gate: if the whole camera moved (>18% of scene changed simultaneously),
    // re-anchor the background reference and do NOT light up the heatmap!
    if (changedFraction > GLOBAL_MOTION_REJECTION_RATIO) {
      for (let i = 0; i < HEAT_CELLS; i++) {
        refLuma[i] = currentLuma[i];
        heatAccum[i] *= 0.4; // Rapidly clear stale markings when camera moves
      }
    } else {
      // Localized change: accumulate heat on small changes and decay over heatmapDuration seconds
      let spikeWeightSum = 0;
      let spikeSumX = 0;
      let spikeSumY = 0;
      let spikeCount = 0;
      let maxSpikeHeat = 0;

      for (let i = 0; i < HEAT_CELLS; i++) {
        if (ignoreMaskGrid[i]) {
          heatAccum[i] = 0;
          refLuma[i] = currentLuma[i];
          continue;
        }
        const delta = Math.abs(currentLuma[i] - refLuma[i]);
        if (delta > threshold) {
          const added = (delta - threshold) * 3.8;
          heatAccum[i] = Math.min(255, heatAccum[i] + added);
          if (heatAccum[i] > 115) {
            const cellX = i % HEAT_W;
            const cellY = (i / HEAT_W) | 0;
            spikeWeightSum += added;
            spikeSumX += cellX * added;
            spikeSumY += cellY * added;
            spikeCount++;
            if (heatAccum[i] > maxSpikeHeat) maxSpikeHeat = heatAccum[i];
          }
        } else {
          heatAccum[i] *= decayFactor;
        }
        refLuma[i] += (currentLuma[i] - refLuma[i]) * 0.15;
      }

      // Suppress hit detection when simultaneous motion exceeds customizable max hit area (default 5% = 1/20th of screen)
      const maxHitAreaFrac = Math.max(0.01, Math.min(0.25, (Number(appState.heatmapMaxAreaPct) || 5) / 100));
      const minHitCells = Math.max(1, Math.min(20, Number(appState.heatmapMinCells) || 2));
      const spikeFraction = activeCells > 0 ? spikeCount / activeCells : 0;

      // If a distinct localized movement spike occurred within area bounds, run unified detection pipeline
      if (
        changedFraction <= maxHitAreaFrac &&
        spikeFraction <= maxHitAreaFrac &&
        spikeCount >= minHitCells &&
        maxSpikeHeat >= 135 &&
        spikeWeightSum > 0
      ) {
        const centroidNormX = (spikeSumX / spikeWeightSum + 0.5) / HEAT_W;
        const centroidNormY = (spikeSumY / spikeWeightSum + 0.5) / HEAT_H;
        const metrics = computeDirectionMetrics(centroidNormX, centroidNormY, sx, sy, cropW, cropH, vw, vh, cw, ch);
        handleConsolidatedDetection(centroidNormX, centroidNormY, videoSource, vw, vh, metrics);
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

  function syncCanvasSize() {
    const rect = mainCanvas.parentElement.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(240, Math.round(rect.height));
    if (mainCanvas.width !== w || mainCanvas.height !== h) {
      mainCanvas.width = w;
      mainCanvas.height = h;
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
  subscribeState((state) => {
    const filterCss = buildCanvasFilterString(state);
    if (filterCss !== lastFilterCss) {
      lastFilterCss = filterCss;
      mainCanvas.style.filter = filterCss;
      pipCanvas.style.filter = filterCss;
    }
    if (!state.heatmapEnabled && !state.heatmapSpeechEnabled) {
      refInitialized = false;
    }
  });

  // Panning the main image when zoomed in (>1.0x)
  let panning = false;
  let panCommitted = false;
  let panStartTime = 0;
  let panStartX = 0;
  let panStartY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  mainCanvas.addEventListener('pointerdown', (e) => {
    if (appState.mainZoom <= 1.01) return;
    panning = true;
    panStartTime = performance.now();
    panCommitted = !shouldHoldCanvasPan(panStartTime);
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffsetX = appState.mainPanX;
    startOffsetY = appState.mainPanY;
    mainCanvas.setPointerCapture(e.pointerId);
  });

  mainCanvas.addEventListener('pointermove', (e) => {
    if (!panning) return;
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

  const stopPan = () => { panning = false; };
  mainCanvas.addEventListener('pointerup', stopPan);
  mainCanvas.addEventListener('pointercancel', stopPan);

  let lastRenderKey = '';

  function renderLoop() {
    if (appState.currentScreen === 'live' && !appState.replayActive) {
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

        const detectorActive = Boolean(appState.heatmapEnabled || appState.heatmapSpeechEnabled);
        if (isRtsp) {
          const heatTick = detectorActive ? Math.floor(performance.now() / 48) : 0;
          const renderKey = `${getRtspFrameSeq()}|${vw}x${vh}|${cw}x${ch}|${pw}x${ph}|${appState.mainZoom}|${appState.mainPanX}|${appState.mainPanY}|${appState.pipEnabled}|${appState.pipZoom}|${appState.roiX}|${appState.roiY}|${appState.heatmapEnabled}|${appState.heatmapSpeechEnabled}|${heatTick}`;
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

        if (detectorActive) {
          const nowMs = performance.now();
          if (nowMs - lastHeatComputeMs >= 48) { // Decouple heavy pixel analysis to ~20Hz to eliminate GPU readback stalls
            updateHeatmap(source, sx, sy, cropW, cropH, vw, vh, cw, ch);
            lastHeatComputeMs = nowMs;
          }
        }

        // 1. Render Main Canvas
        mainCtx.drawImage(source, sx, sy, cropW, cropH, 0, 0, cw, ch);
        if (appState.heatmapEnabled) {
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

        // 2. Render Magnified PiP Zoom Window
        if (appState.pipEnabled) {
          const targetSourceX = sx + appState.roiX * cropW;
          const targetSourceY = sy + appState.roiY * cropH;

          const pipCropW = (cropW * (pw / cw)) / appState.pipZoom;
          const pipCropH = (cropH * (ph / ch)) / appState.pipZoom;

          const psx = Math.max(0, Math.min(vw - pipCropW, targetSourceX - pipCropW / 2));
          const psy = Math.max(0, Math.min(vh - pipCropH, targetSourceY - pipCropH / 2));

          pipCtx.drawImage(source, psx, psy, pipCropW, pipCropH, 0, 0, pw, ph);
          if (appState.heatmapEnabled) {
            pipCtx.drawImage(
              heatOverlayCanvas,
              (psx / vw) * HEAT_W,
              (psy / vh) * HEAT_H,
              (pipCropW / vw) * HEAT_W,
              (pipCropH / vh) * HEAT_H,
              0,
              0,
              pw,
              ph
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
