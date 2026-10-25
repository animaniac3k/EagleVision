/**
 * 60fps Dual-Canvas Compositor (Full-Screen Main Feed + Magnified PiP Zoom Window)
 *
 * Includes Temporal Compare modes:
 * - 'ghost': Superimposes the video frame from N seconds ago at 50% opacity.
 * - 'delta': Change-Radar mode using Canvas 'difference' blending against the frame
 *            from N seconds ago so stationary regions cancel to black and only
 *            changes/movement light up.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { buildCanvasFilterString } from './imageFilters.js';
import { recordRenderedFrame } from '../camera/streamStats.js';
import { getDelayedFrameBitmap } from '../recorder/memoryRingBuffer.js';

export function initCompositor(videoEl) {
  const mainCanvas = document.getElementById('mainCanvas');
  const pipCanvas = document.getElementById('pipCanvas');
  const mainCtx = mainCanvas.getContext('2d');
  const pipCtx = pipCanvas.getContext('2d');

  // Resize canvases only when layout changes
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

  // Apply GPU-composited CSS filters only when state changes
  let lastFilterCss = '';
  subscribeState((state) => {
    const filterCss = buildCanvasFilterString(state);
    if (filterCss !== lastFilterCss) {
      lastFilterCss = filterCss;
      mainCanvas.style.filter = filterCss;
      pipCanvas.style.filter = filterCss;
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

  // Helper to composite Temporal Ghost or Delta layer from the 20s RAM ring buffer
  function drawTemporalLayer(ctx, pastBmp, normSx, normSy, normW, normH, destW, destH) {
    if (!pastBmp || appState.temporalMode === 'off') return;
    const bw = pastBmp.width;
    const bh = pastBmp.height;

    ctx.save();
    if (appState.temporalMode === 'ghost') {
      ctx.globalAlpha = 0.48;
      ctx.globalCompositeOperation = 'source-over';
    } else if (appState.temporalMode === 'delta') {
      ctx.globalAlpha = 1.0;
      ctx.globalCompositeOperation = 'difference';
    }

    ctx.drawImage(
      pastBmp,
      normSx * bw,
      normSy * bh,
      normW * bw,
      normH * bh,
      0,
      0,
      destW,
      destH
    );
    ctx.restore();
  }

  function renderLoop() {
    if (appState.currentScreen === 'live' && !appState.replayActive && videoEl.readyState >= 2) {
      const vw = videoEl.videoWidth || appState.streamWidth || 1280;
      const vh = videoEl.videoHeight || appState.streamHeight || 720;
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

      const pastBmp =
        appState.temporalMode !== 'off'
          ? getDelayedFrameBitmap(appState.temporalDelaySec)
          : null;

      // 1. Hardware-accelerated blit to Main Canvas
      mainCtx.drawImage(videoEl, sx, sy, cropW, cropH, 0, 0, cw, ch);
      if (pastBmp) {
        drawTemporalLayer(mainCtx, pastBmp, sx / vw, sy / vh, cropW / vw, cropH / vh, cw, ch);
      }

      // 2. Hardware-accelerated blit to Magnified PiP Zoom Window
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
        if (pastBmp) {
          drawTemporalLayer(pipCtx, pastBmp, psx / vw, psy / vh, pipCropW / vw, pipCropH / vh, pw, ph);
        }
      }

      recordRenderedFrame(videoEl);
    }

    requestAnimationFrame(renderLoop);
  }

  requestAnimationFrame(renderLoop);
  return mainCanvas;
}
