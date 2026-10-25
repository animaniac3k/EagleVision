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

const HEAT_W = 160;
const HEAT_H = 90;
const HEAT_CELLS = HEAT_W * HEAT_H;
const GLOBAL_MOTION_REJECTION_RATIO = 0.18; // If >18% of image changes at once, treat as camera movement

export function initCompositor(videoEl) {
  const mainCanvas = document.getElementById('mainCanvas');
  const pipCanvas = document.getElementById('pipCanvas');
  const mainCtx = mainCanvas.getContext('2d');
  const pipCtx = pipCanvas.getContext('2d');

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
  const heatAccum = new Float32Array(HEAT_CELLS);
  let refInitialized = false;

  function updateHeatmap(videoSource) {
    sampleCtx.drawImage(videoSource, 0, 0, HEAT_W, HEAT_H);
    const src = sampleCtx.getImageData(0, 0, HEAT_W, HEAT_H).data;
    const out = heatImgData.data;

    // Map sensitivity (10..95) to pixel delta threshold (75..8)
    const sens = Math.max(10, Math.min(95, appState.heatmapSensitivity));
    const threshold = 82 - sens * 0.76;

    if (!refInitialized) {
      for (let i = 0; i < HEAT_CELLS; i++) {
        const p = i * 4;
        refLuma[i] = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
        heatAccum[i] = 0;
      }
      refInitialized = true;
      return;
    }

    // Pass 1: Measure how many cells changed above threshold to detect global camera motion
    let changedCells = 0;
    const currentLuma = new Float32Array(HEAT_CELLS);
    for (let i = 0; i < HEAT_CELLS; i++) {
      const p = i * 4;
      const luma = 0.299 * src[p] + 0.587 * src[p + 1] + 0.114 * src[p + 2];
      currentLuma[i] = luma;
      if (Math.abs(luma - refLuma[i]) > threshold) {
        changedCells++;
      }
    }

    const changedFraction = changedCells / HEAT_CELLS;

    // Global Motion Gate: if the whole camera moved (>18% of scene changed simultaneously),
    // re-anchor the background reference and do NOT light up the heatmap!
    if (changedFraction > GLOBAL_MOTION_REJECTION_RATIO) {
      for (let i = 0; i < HEAT_CELLS; i++) {
        refLuma[i] = currentLuma[i];
        heatAccum[i] *= 0.4; // Rapidly clear stale markings when camera moves
      }
    } else {
      // Localized change: accumulate heat on small changes and slowly adapt reference
      for (let i = 0; i < HEAT_CELLS; i++) {
        const delta = Math.abs(currentLuma[i] - refLuma[i]);
        if (delta > threshold) {
          heatAccum[i] = Math.min(255, heatAccum[i] + (delta - threshold) * 3.6);
        } else {
          heatAccum[i] *= 0.88;
        }
        refLuma[i] += (currentLuma[i] - refLuma[i]) * 0.15;
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
    if (!state.heatmapEnabled) {
      refInitialized = false;
    }
  });

  // Panning the main image when zoomed in (>1.0x)
  let panning = false;
  let panStartX = 0;
  let panStartY = 0;
  let startOffsetX = 0;
  let startOffsetY = 0;

  mainCanvas.addEventListener('pointerdown', (e) => {
    if (appState.mainZoom <= 1.01) return;
    panning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    startOffsetX = appState.mainPanX;
    startOffsetY = appState.mainPanY;
    mainCanvas.setPointerCapture(e.pointerId);
  });

  mainCanvas.addEventListener('pointermove', (e) => {
    if (!panning) return;
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

  function renderLoop() {
    if (appState.currentScreen === 'live' && !appState.replayActive && videoEl.readyState >= 2) {
      const vw = videoEl.videoWidth || appState.streamWidth || 1920;
      const vh = videoEl.videoHeight || appState.streamHeight || 1080;
      const cw = mainCanvas.width;
      const ch = mainCanvas.height;

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

      if (appState.heatmapEnabled) {
        updateHeatmap(videoEl);
      }

      // 1. Render Main Canvas
      mainCtx.drawImage(videoEl, sx, sy, cropW, cropH, 0, 0, cw, ch);
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
        const pw = pipCanvas.width || 340;
        const ph = pipCanvas.height || 210;

        const targetSourceX = sx + appState.roiX * cropW;
        const targetSourceY = sy + appState.roiY * cropH;

        const pipCropW = (cropW * (pw / cw)) / appState.pipZoom;
        const pipCropH = (cropH * (ph / ch)) / appState.pipZoom;

        const psx = Math.max(0, Math.min(vw - pipCropW, targetSourceX - pipCropW / 2));
        const psy = Math.max(0, Math.min(vh - pipCropH, targetSourceY - pipCropH / 2));

        pipCtx.drawImage(videoEl, psx, psy, pipCropW, pipCropH, 0, 0, pw, ph);
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

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
  return mainCanvas;
}
