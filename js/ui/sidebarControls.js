/**
 * Floating Icon Strips, Movable/Collapsible Settings Window, Overlays, Filters & Color Theme
 */
import { appState, updateState, subscribeState } from '../state.js';
import { enumerateCameras, startCameraStream } from '../camera/streamManager.js';
import { makeElementDraggable } from '../renderer/zoomWindow.js';
import { startMemoryBuffer, stopMemoryBuffer } from '../recorder/memoryRingBuffer.js';
import { saveSettings } from '../storage/settingsStore.js';

/**
 * Converts a #RRGGBB hex color into HSL and updates all --radar-* CSS custom properties
 * so the entire UI (surfaces, borders, text, active glow, and SVG overlays) shifts cohesively.
 */
export function applyThemeColor(hex) {
  const clean = (hex || '#2dd4bf').replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h = Math.round(h * 60);
  }
  const sat = Math.round(s * 100);
  const surfSat = Math.min(45, sat);

  const root = document.documentElement.style;
  root.setProperty('--radar-bg-deep', `hsl(${h}, ${surfSat}%, 3%)`);
  root.setProperty('--radar-bg', `hsl(${h}, ${surfSat}%, 5%)`);
  root.setProperty('--radar-panel', `hsla(${h}, ${surfSat}%, 8%, 0.94)`);
  root.setProperty('--radar-header', `hsl(${h}, ${surfSat}%, 11%)`);
  root.setProperty('--radar-surface', `hsl(${h}, ${surfSat}%, 9%)`);
  root.setProperty('--radar-surface-hover', `hsl(${h}, ${surfSat}%, 15%)`);
  root.setProperty('--radar-border', `hsl(${h}, ${ Math.min(60, sat)}%, 24%)`);
  root.setProperty('--radar-border-strong', hex);
  root.setProperty('--radar-text', `hsl(${h}, ${Math.min(85, sat)}%, 92%)`);
  root.setProperty('--radar-text-secondary', `hsl(${h}, ${Math.min(80, sat)}%, 80%)`);
  root.setProperty('--radar-text-muted', `hsl(${h}, ${Math.min(75, sat)}%, 66%)`);
  root.setProperty('--radar-accent', hex);
  root.setProperty('--radar-accent-contrast', `hsl(${h}, ${surfSat}%, 5%)`);
  root.setProperty('--shadow-glow', `0 0 14px hsla(${h}, ${sat}%, 55%, 0.4)`);
}

export async function initSidebarAndTopControls(videoEl) {
  const optionsPanel = document.getElementById('optionsPanel');
  const optionsDragHandle = document.getElementById('optionsDragHandle');
  const btnToggleOptions = document.getElementById('btnToggleOptions');
  const btnCloseOptionsInner = document.getElementById('btnCloseOptionsInner');
  const btnTogglePip = document.getElementById('btnTogglePip');
  const btnToggleHud = document.getElementById('btnToggleHud');
  const btnToggleBuffer = document.getElementById('btnToggleBuffer');
  const bufferDot = document.getElementById('bufferDot');
  const bufferText = document.getElementById('bufferText');

  const cameraSelect = document.getElementById('cameraSelect');
  const btnRefreshCameras = document.getElementById('btnRefreshCameras');

  // Apply initial or saved theme color
  applyThemeColor(appState.themeColor || '#2dd4bf');

  // Make Settings Panel Draggable by its header bar
  makeElementDraggable(optionsPanel, optionsDragHandle);

  // 1. Show/Hide Settings Window
  const toggleOptions = (force) => {
    const next = typeof force === 'boolean' ? force : !appState.optionsOpen;
    updateState({ optionsOpen: next });
  };
  btnToggleOptions.addEventListener('click', () => toggleOptions());
  btnCloseOptionsInner.addEventListener('click', () => toggleOptions(false));

  // 2. Show/Hide Digital Zoom Window
  btnTogglePip.addEventListener('click', () => {
    updateState({ pipEnabled: !appState.pipEnabled });
    saveSettings(appState);
  });

  // 3. Show/Hide Stream Telemetry HUD
  btnToggleHud.addEventListener('click', () => {
    updateState({ hudOpen: !appState.hudOpen });
  });

  // 4. Enable/Disable 20-Second Rolling In-Memory Buffer
  btnToggleBuffer.addEventListener('click', () => {
    const next = !appState.bufferEnabled;
    updateState({ bufferEnabled: next });
    saveSettings(appState);
    if (next) {
      startMemoryBuffer(videoEl);
    } else {
      stopMemoryBuffer();
    }
  });

  // 5. Camera Enumeration & Selection
  async function populateCameraDropdown() {
    const devices = await enumerateCameras();
    cameraSelect.innerHTML = devices
      .map((d) => `<option value="${d.deviceId}">${d.label}</option>`)
      .join('');
    if (appState.activeDeviceId && devices.some((d) => d.deviceId === appState.activeDeviceId)) {
      cameraSelect.value = appState.activeDeviceId;
    }
  }

  await populateCameraDropdown();

  cameraSelect.addEventListener('change', async (e) => {
    await startCameraStream(videoEl, e.target.value);
    if (appState.bufferEnabled) {
      startMemoryBuffer(videoEl);
    }
    await populateCameraDropdown();
  });

  btnRefreshCameras.addEventListener('click', populateCameraDropdown);
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateCameraDropdown);
  }

  // 6. Main Whole-Image Zoom Controls (Bottom Bar)
  const mainZoomMinus = document.getElementById('mainZoomMinus');
  const mainZoomPlus = document.getElementById('mainZoomPlus');
  const mainZoomReset = document.getElementById('mainZoomReset');
  const mainZoomBadge = document.getElementById('mainZoomBadge');

  mainZoomMinus.addEventListener('click', () => {
    const next = Math.max(1.0, Math.round((appState.mainZoom - 0.5) * 10) / 10);
    updateState({
      mainZoom: next,
      mainPanX: next <= 1.01 ? 0 : appState.mainPanX,
      mainPanY: next <= 1.01 ? 0 : appState.mainPanY
    });
  });

  mainZoomPlus.addEventListener('click', () => {
    const next = Math.min(8.0, Math.round((appState.mainZoom + 0.5) * 10) / 10);
    updateState({ mainZoom: next });
  });

  mainZoomReset.addEventListener('click', () => {
    updateState({ mainZoom: 1.0, mainPanX: 0, mainPanY: 0 });
  });

  // 7. Overlay Guide Controls
  const btnToggleOverlay = document.getElementById('btnToggleOverlay');
  const ovButtons = document.querySelectorAll('.ov-btn');
  const fileCustomOverlay = document.getElementById('fileCustomOverlay');
  const sliderOvOpacity = document.getElementById('sliderOvOpacity');
  const valOvOpacity = document.getElementById('valOvOpacity');
  const sliderOvScale = document.getElementById('sliderOvScale');
  const valOvScale = document.getElementById('valOvScale');

  btnToggleOverlay.addEventListener('click', () => {
    updateState({ overlayEnabled: !appState.overlayEnabled });
    saveSettings(appState);
  });

  ovButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.ov;
      if (type === 'custom') {
        fileCustomOverlay.click();
        return;
      }
      updateState({ overlayType: type, overlayEnabled: true });
      saveSettings(appState);
    });
  });

  fileCustomOverlay.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (appState.customOverlayUrl) {
      URL.revokeObjectURL(appState.customOverlayUrl);
    }
    const url = URL.createObjectURL(file);
    updateState({
      customOverlayUrl: url,
      overlayType: 'custom',
      overlayEnabled: true
    });
  });

  sliderOvOpacity.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    valOvOpacity.textContent = `${val}%`;
    updateState({ overlayOpacity: val });
    saveSettings(appState);
  });

  sliderOvScale.addEventListener('input', (e) => {
    const val = Number(e.target.value);
    valOvScale.textContent = `${val}%`;
    updateState({ overlayScale: val });
    saveSettings(appState);
  });

  // 8. Image Manipulation Sliders & Toggles
  const sliderBrightness = document.getElementById('sliderBrightness');
  const valBrightness = document.getElementById('valBrightness');
  const sliderContrast = document.getElementById('sliderContrast');
  const valContrast = document.getElementById('valContrast');
  const sliderSaturation = document.getElementById('sliderSaturation');
  const valSaturation = document.getElementById('valSaturation');
  const btnFilterInvert = document.getElementById('btnFilterInvert');
  const btnFilterGrayscale = document.getElementById('btnFilterGrayscale');
  const btnResetFilters = document.getElementById('btnResetFilters');

  sliderBrightness.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valBrightness.textContent = `${v}%`;
    updateState({ brightness: v });
  });

  sliderContrast.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valContrast.textContent = `${v}%`;
    updateState({ contrast: v });
  });

  sliderSaturation.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valSaturation.textContent = `${v}%`;
    updateState({ saturation: v });
  });

  btnFilterInvert.addEventListener('click', () => {
    updateState({ invert: !appState.invert });
  });

  btnFilterGrayscale.addEventListener('click', () => {
    updateState({ grayscale: !appState.grayscale });
  });

  btnResetFilters.addEventListener('click', () => {
    sliderBrightness.value = '100';
    sliderContrast.value = '100';
    sliderSaturation.value = '100';
    valBrightness.textContent = '100%';
    valContrast.textContent = '100%';
    valSaturation.textContent = '100%';
    updateState({
      brightness: 100,
      contrast: 100,
      saturation: 100,
      invert: false,
      grayscale: false
    });
  });

  // 9. Temporal Compare (Chrono-Ghost & Change-Radar Delta)
  const tempButtons = document.querySelectorAll('.temp-btn');
  const sliderTemporalDelay = document.getElementById('sliderTemporalDelay');
  const valTemporalDelay = document.getElementById('valTemporalDelay');

  tempButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.temp;
      updateState({ temporalMode: mode });
      tempButtons.forEach((b) => b.classList.toggle('radar-btn-active', b.dataset.temp === mode));
    });
  });

  if (sliderTemporalDelay) {
    sliderTemporalDelay.addEventListener('input', (e) => {
      const sec = parseFloat(e.target.value) || 2.0;
      valTemporalDelay.textContent = `${sec.toFixed(1)}s AGO`;
      updateState({ temporalDelaySec: sec });
    });
  }

  // 10. Interface Color Swatches & Photoshop-Style Custom Picker
  const swatches = document.querySelectorAll('.theme-swatch');
  const colorPickerCustom = document.getElementById('colorPickerCustom');

  function selectThemeColor(color) {
    applyThemeColor(color);
    colorPickerCustom.value = color;
    swatches.forEach((s) => {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === color.toLowerCase());
    });
    updateState({ themeColor: color });
    saveSettings(appState);
  }

  swatches.forEach((swatch) => {
    swatch.addEventListener('click', () => {
      selectThemeColor(swatch.dataset.color);
    });
  });

  colorPickerCustom.addEventListener('input', (e) => {
    selectThemeColor(e.target.value);
  });

  // Sync initial swatch selection
  if (appState.themeColor) {
    colorPickerCustom.value = appState.themeColor;
    swatches.forEach((s) => {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === appState.themeColor.toLowerCase());
    });
  }

  // Reactive UI Sync
  subscribeState((state) => {
    optionsPanel.classList.toggle('hidden', !state.optionsOpen);
    btnToggleOptions.classList.toggle('radar-btn-active', state.optionsOpen);
    btnTogglePip.classList.toggle('radar-btn-active', state.pipEnabled);
    btnToggleHud.classList.toggle('radar-btn-active', state.hudOpen);

    btnToggleBuffer.classList.toggle('radar-btn-active', state.bufferEnabled);
    bufferDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
    bufferText.textContent = state.bufferEnabled
      ? `${Math.max(1, Math.round(state.bufferedSeconds))}s RAM`
      : 'RAM OFF';

    mainZoomBadge.textContent = `${state.mainZoom.toFixed(1)}x`;
    mainZoomReset.classList.toggle('hidden', state.mainZoom <= 1.01);

    btnToggleOverlay.textContent = state.overlayEnabled ? 'ON' : 'OFF';
    btnToggleOverlay.classList.toggle('radar-btn-active', state.overlayEnabled);

    ovButtons.forEach((b) => {
      b.classList.toggle('radar-btn-active', b.dataset.ov === state.overlayType);
    });

    btnFilterInvert.classList.toggle('radar-btn-active', state.invert);
    btnFilterGrayscale.classList.toggle('radar-btn-active', state.grayscale);
  });
}
