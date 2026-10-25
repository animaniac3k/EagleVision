/**
 * Decoupled Draggable ROI Target Crosshair & Movable/Resizable Digital Zoom Window (PiP)
 *
 * Includes:
 * - Viewport boundary clamping on window resize so neither the Zoom Window,
 *   the ROI Target Crosshair, nor the Settings Panel can ever go out of view.
 * - Bottom-left and bottom-right corner resize handles for the Zoom Window.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';

const trackedFloatingPanels = new Set();

export function clampFloatingPanelToParent(panelEl) {
  const parent = panelEl.parentElement;
  if (!parent || panelEl.classList.contains('hidden')) return;

  const pw = parent.clientWidth;
  const ph = parent.clientHeight;
  if (pw <= 0 || ph <= 0) return;

  // Ensure panel dimensions fit inside parent
  const maxW = Math.max(200, pw - 16);
  const maxH = Math.max(150, ph - 16);
  if (panelEl.offsetWidth > maxW) {
    panelEl.style.width = `${maxW}px`;
  }
  if (panelEl.offsetHeight > maxH) {
    panelEl.style.height = `${maxH}px`;
  }

  const w = panelEl.offsetWidth;
  const h = panelEl.offsetHeight;
  const curLeft = panelEl.offsetLeft;
  const curTop = panelEl.offsetTop;

  const clampedLeft = Math.max(8, Math.min(pw - w - 8, curLeft));
  const clampedTop = Math.max(8, Math.min(ph - h - 8, curTop));

  panelEl.style.left = `${clampedLeft}px`;
  panelEl.style.top = `${clampedTop}px`;
  panelEl.style.right = 'auto';
}

export function makeElementDraggable(containerEl, handleEl, onPositionChange) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let origLeft = 0;
  let origTop = 0;

  const trigger = handleEl || containerEl;
  if (containerEl.id !== 'zoomTargetCrosshair') {
    trackedFloatingPanels.add(containerEl);
  }

  trigger.addEventListener('pointerdown', (e) => {
    if (
      e.target.closest('button') ||
      e.target.closest('.pip-resize-handle') ||
      e.target.tagName === 'INPUT' ||
      e.target.tagName === 'SELECT'
    ) {
      return;
    }
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    origLeft = containerEl.offsetLeft;
    origTop = containerEl.offsetTop;
    trigger.setPointerCapture(e.pointerId);
    e.stopPropagation();
  });

  trigger.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const parent = containerEl.parentElement;
    const maxX = Math.max(0, parent.clientWidth - containerEl.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - containerEl.offsetHeight);

    const nx = Math.max(0, Math.min(maxX, origLeft + (e.clientX - startX)));
    const ny = Math.max(0, Math.min(maxY, origTop + (e.clientY - startY)));

    containerEl.style.left = `${nx}px`;
    containerEl.style.top = `${ny}px`;
    containerEl.style.right = 'auto';

    if (onPositionChange) {
      onPositionChange(nx, ny, parent.clientWidth, parent.clientHeight);
    }
  });

  const endDrag = () => {
    dragging = false;
  };
  trigger.addEventListener('pointerup', endDrag);
  trigger.addEventListener('pointercancel', endDrag);
}

function initPipCornerResize(pipWindowEl, pipCanvas) {
  const handleSE = document.getElementById('pipResizeSE');
  const handleSW = document.getElementById('pipResizeSW');

  function syncPipCanvasResolution() {
    const vp = pipCanvas.parentElement;
    if (!vp) return;
    const w = Math.max(160, Math.round(vp.clientWidth));
    const h = Math.max(100, Math.round(vp.clientHeight));
    if (pipCanvas.width !== w || pipCanvas.height !== h) {
      pipCanvas.width = w;
      pipCanvas.height = h;
    }
  }

  function attachCorner(handleEl, isLeftCorner) {
    if (!handleEl) return;
    let resizing = false;
    let startX = 0;
    let startY = 0;
    let startW = 0;
    let startH = 0;
    let startLeft = 0;

    handleEl.addEventListener('pointerdown', (e) => {
      resizing = true;
      startX = e.clientX;
      startY = e.clientY;
      startW = pipWindowEl.offsetWidth;
      startH = pipWindowEl.offsetHeight;
      startLeft = pipWindowEl.offsetLeft;
      pipWindowEl.style.left = `${startLeft}px`;
      pipWindowEl.style.right = 'auto';
      handleEl.setPointerCapture(e.pointerId);
      e.stopPropagation();
    });

    handleEl.addEventListener('pointermove', (e) => {
      if (!resizing) return;
      const parent = pipWindowEl.parentElement;
      const pw = parent.clientWidth;
      const ph = parent.clientHeight;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const minW = 220;
      const minH = 170;

      if (isLeftCorner) {
        // Resize from bottom-left corner: moves left edge and bottom edge
        const maxLeftDelta = startW - minW;
        const clampedDx = Math.max(-startLeft + 8, Math.min(maxLeftDelta, dx));
        const newW = startW - clampedDx;
        const newLeft = startLeft + clampedDx;
        const maxH = Math.max(minH, ph - pipWindowEl.offsetTop - 8);
        const newH = Math.max(minH, Math.min(maxH, startH + dy));

        pipWindowEl.style.left = `${newLeft}px`;
        pipWindowEl.style.width = `${newW}px`;
        pipWindowEl.style.height = `${newH}px`;
      } else {
        // Resize from bottom-right corner: moves right edge and bottom edge
        const maxW = Math.max(minW, pw - startLeft - 8);
        const maxH = Math.max(minH, ph - pipWindowEl.offsetTop - 8);
        const newW = Math.max(minW, Math.min(maxW, startW + dx));
        const newH = Math.max(minH, Math.min(maxH, startH + dy));

        pipWindowEl.style.width = `${newW}px`;
        pipWindowEl.style.height = `${newH}px`;
      }

      syncPipCanvasResolution();
    });

    const stopResize = () => {
      resizing = false;
    };
    handleEl.addEventListener('pointerup', stopResize);
    handleEl.addEventListener('pointercancel', stopResize);
  }

  attachCorner(handleSE, false);
  attachCorner(handleSW, true);
}

export function initZoomWindow() {
  const crosshairEl = document.getElementById('zoomTargetCrosshair');
  const pipWindowEl = document.getElementById('pipZoomWindow');
  const pipCanvas = document.getElementById('pipCanvas');
  const pipZoomBadge = document.getElementById('pipZoomBadge');
  const btnPipToggleRoi = document.getElementById('btnPipToggleRoi');
  const btnPipMinus = document.getElementById('pipZoomMinus');
  const btnPipPlus = document.getElementById('pipZoomPlus');

  // Position the ROI crosshair proportionally to (appState.roiX, appState.roiY) and keep inside bounds
  function syncRoiCrosshairPosition() {
    const parent = crosshairEl.parentElement;
    if (!parent) return;
    const pw = parent.clientWidth;
    const ph = parent.clientHeight;
    if (pw <= 0 || ph <= 0) return;

    const cw = crosshairEl.offsetWidth || 96;
    const ch = crosshairEl.offsetHeight || 96;
    const targetLeft = Math.round(appState.roiX * pw - cw / 2);
    const targetTop = Math.round(appState.roiY * ph - ch / 2);

    const clampedLeft = Math.max(0, Math.min(pw - cw, targetLeft));
    const clampedTop = Math.max(0, Math.min(ph - ch, targetTop));

    crosshairEl.style.left = `${clampedLeft}px`;
    crosshairEl.style.top = `${clampedTop}px`;
  }

  // 1. Draggable ROI Target Crosshair updates normalized (roiX, roiY)
  makeElementDraggable(crosshairEl, crosshairEl, (nx, ny, parentW, parentH) => {
    const centerX = nx + crosshairEl.offsetWidth / 2;
    const centerY = ny + crosshairEl.offsetHeight / 2;
    updateState({
      roiX: Math.max(0, Math.min(1, centerX / parentW)),
      roiY: Math.max(0, Math.min(1, centerY / parentH))
    });
  });

  // 2. Draggable & Corner-Resizable Digital Zoom Window
  makeElementDraggable(pipWindowEl, pipWindowEl);
  initPipCornerResize(pipWindowEl, pipCanvas);

  // 3. Keep ROI Crosshair and all floating windows inside viewport on window resize
  window.addEventListener('resize', () => {
    syncRoiCrosshairPosition();
    trackedFloatingPanels.forEach((panel) => clampFloatingPanelToParent(panel));
  });

  // Initial placement
  requestAnimationFrame(() => {
    syncRoiCrosshairPosition();
    trackedFloatingPanels.forEach((panel) => clampFloatingPanelToParent(panel));
  });

  // 4. Single ROI Crosshair Show/Hide Button inside Zoom Window Header
  btnPipToggleRoi.addEventListener('click', () => {
    updateState({ roiTargetVisible: !appState.roiTargetVisible });
  });

  // 5. Zoom Window +/- Buttons
  btnPipMinus.addEventListener('click', () => {
    const next = Math.max(1.5, Math.round((appState.pipZoom - 0.5) * 10) / 10);
    updateState({ pipZoom: next });
    saveSettings(appState);
  });

  btnPipPlus.addEventListener('click', () => {
    const next = Math.min(12.0, Math.round((appState.pipZoom + 0.5) * 10) / 10);
    updateState({ pipZoom: next });
    saveSettings(appState);
  });

  // Sync UI state
  subscribeState((state, patch) => {
    pipWindowEl.classList.toggle('hidden', !state.pipEnabled);
    const showCrosshair = state.pipEnabled && state.roiTargetVisible;
    crosshairEl.classList.toggle('hidden', !showCrosshair);
    btnPipToggleRoi.classList.toggle('radar-btn-active', state.roiTargetVisible);
    pipZoomBadge.textContent = `${state.pipZoom.toFixed(1)}x`;
    if (patch && (patch.roiX !== undefined || patch.roiY !== undefined)) {
      syncRoiCrosshairPosition();
    }
  });
}
