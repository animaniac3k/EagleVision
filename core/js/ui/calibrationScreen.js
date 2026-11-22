/**
 * Hit Detection Calibration Screen Controller (#screenCalibration)
 *
 * Houses the live thermal heatmap debug view, 3 environment presets, 1-tap Auto-Tune,
 * noise-floor telemetry meter, Min/Max hit size tuning, ignore-zone masking, and
 * collapsed Advanced settings (Shake Gate, Thermal Trail, Auto-Save).
 */
import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import {
  rezeroHeatmap,
  addHeatmapIgnoreZone,
  clearHeatmapIgnoreZones,
  subscribeHeatmapTelemetry
} from '../renderer/compositor.js';

const HEAT_GRID_CELLS = 160 * 90;
const MAX_HIT_AREA_MAX_PCT = 20;
const MAX_HIT_AREA_CURVE = 2.5;
const DELTA_BAR_MAX = 85;
const MIN_MASK_SIZE = 0.02;

let initialized = false;

export function openCalibrationScreen() {
  const screenLive = document.getElementById('screenLive');
  const screenSettings = document.getElementById('screenSettings');
  const screenReticle = document.getElementById('screenReticle');
  const screenController = document.getElementById('screenController');
  const screenGallery = document.getElementById('screenGallery');
  const screenCalibration = document.getElementById('screenCalibration');
  screenLive?.classList.add('hidden');
  screenSettings?.classList.add('hidden');
  screenReticle?.classList.add('hidden');
  screenController?.classList.add('hidden');
  screenGallery?.classList.add('hidden');
  screenCalibration?.classList.remove('hidden');
  updateState({
    currentScreen: 'calibration',
    uiDecluttered: false,
    heatmapSetupOpen: true,
    replaySetupOpen: false,
    liveMasksVisible: true
  });
  rezeroHeatmap();
}

export function initCalibrationScreen() {
  if (initialized) return;
  initialized = true;

  const screenCalibration = document.getElementById('screenCalibration');
  const screenLive = document.getElementById('screenLive');

  const btnCalibBackToLive = document.getElementById('btnCalibBackToLive');
  const btnCalibRezero = document.getElementById('btnCalibRezero');
  const btnCalibAutoTune = document.getElementById('btnCalibAutoTune');

  const sliderSens = document.getElementById('liveSliderHeatmapSens');
  const valSens = document.getElementById('liveValHeatmapSens');
  const sliderMaxArea = document.getElementById('liveSliderHeatmapMaxArea');
  const valMaxArea = document.getElementById('liveValHeatmapMaxArea');
  const sliderMinCells = document.getElementById('liveSliderHeatmapMinCells');
  const valMinCells = document.getElementById('liveValHeatmapMinCells');
  const sliderShakeGate = document.getElementById('liveSliderHeatmapShakeGate');
  const valShakeGate = document.getElementById('liveValHeatmapShakeGate');

  const gatePill = document.getElementById('heatmapLiveGatePill');
  const noiseMeterFill = document.getElementById('heatmapNoiseMeterFill');
  const noisePeakTick = document.getElementById('heatmapNoisePeakTick');
  const noiseGateMarker = document.getElementById('heatmapNoiseGateMarker');
  const noiseTelemetryText = document.getElementById('heatmapNoiseTelemetryText');
  const noiseMarginText = document.getElementById('heatmapNoiseMarginText');

  const sliderDuration = document.getElementById('sliderHeatmapDuration');
  const valDuration = document.getElementById('valHeatmapDuration');
  const btnToggleAutoSave = document.getElementById('btnToggleHeatmapAutoSave');

  const calibIgnoreLayer = document.getElementById('calibIgnoreLayer');
  const calibDrawPreview = document.getElementById('calibDrawPreview');
  const btnMaskDraw = document.getElementById('btnLiveMaskDraw');
  const btnMasksVisible = document.getElementById('btnLiveMasksVisible');
  const btnClearMasks = document.getElementById('btnLiveClearMasks');
  const maskDrawHint = document.getElementById('liveMaskDrawHint');

  let lastNoiseDelta = 0;
  let lastActiveCells = HEAT_GRID_CELLS;
  let lastGatePillText = '';
  let lastGatePillClass = '';
  let lastTelemetryStr = '';
  let rezeroTimer = null;
  let autoTuneTimer = null;
  let autoTuneResetTimer = null;
  let autoTuneActive = false;
  let autoTuneNoiseSamples = [];
  let autoTunePeakSamples = [];

  const CALIB_ENV_PRESETS = {
    indoor: { heatmapSensitivity: 78, heatmapMinCells: 2, heatmapMaxAreaPct: 4, heatmapShakeGatePct: 22 },
    calm: { heatmapSensitivity: 62, heatmapMinCells: 2, heatmapMaxAreaPct: 5, heatmapShakeGatePct: 18 },
    windy: { heatmapSensitivity: 44, heatmapMinCells: 3, heatmapMaxAreaPct: 3.5, heatmapShakeGatePct: 12 }
  };

  function syncEnvPresetHighlight() {
    const sens = Number(appState.heatmapSensitivity) || 60;
    document.querySelectorAll('.calib-env-preset[data-preset]').forEach((btn) => {
      const p = CALIB_ENV_PRESETS[btn.dataset.preset];
      if (!p) return;
      const matches = Math.abs(sens - p.heatmapSensitivity) <= 2 &&
        Number(appState.heatmapMinCells || 2) === p.heatmapMinCells &&
        Number(appState.heatmapShakeGatePct || 18) === p.heatmapShakeGatePct;
      btn.classList.toggle('radar-btn-active', matches);
    });
  }

  document.querySelectorAll('.calib-env-preset[data-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const preset = CALIB_ENV_PRESETS[btn.dataset.preset];
      if (!preset) return;
      updateState(preset);
      rezeroHeatmap();
      saveSettings(appState);
      syncEnvPresetHighlight();
    });
  });

  let clearMasksArmTimer = null;
  let clearMasksArmed = false;
  let drawStart = null;
  let activeMaskDrag = null;

  function handleOpenCalibration() {
    openCalibrationScreen();
    requestAnimationFrame(renderCalibIgnoreMasks);
  }

  function closeCalibrationToLive() {
    cancelAutoTune(false);
    screenCalibration?.classList.add('hidden');
    screenLive?.classList.remove('hidden');
    updateState({
      currentScreen: 'live',
      heatmapSetupOpen: false,
      liveMaskDrawActive: false
    });
    rezeroHeatmap();
  }

  btnCalibBackToLive?.addEventListener('click', closeCalibrationToLive);

  document.querySelectorAll('.setup-jump-calibration').forEach((btn) => {
    btn.addEventListener('click', handleOpenCalibration);
  });

  btnCalibRezero?.addEventListener('click', () => {
    rezeroHeatmap();
    btnCalibRezero.classList.add('radar-btn-active');
    clearTimeout(rezeroTimer);
    rezeroTimer = setTimeout(() => {
      btnCalibRezero.classList.remove('radar-btn-active');
    }, 800);
  });

  // 1. Noise Floor & Sensitivity Helpers
  function getMinMaxAreaPct(minCells = appState.heatmapMinCells ?? 2) {
    const safeMin = Math.max(1, Math.min(20, Number(minCells) || 2));
    return ((safeMin + 1) / HEAT_GRID_CELLS) * 100;
  }

  function clampMaxAreaPct(pct, minCells = appState.heatmapMinCells ?? 2) {
    const minPct = getMinMaxAreaPct(minCells);
    const num = Number(pct);
    const fallback = Number.isFinite(num) && num > 0 ? num : 5;
    return Math.max(minPct, Math.min(MAX_HIT_AREA_MAX_PCT, fallback));
  }

  function sliderPosToMaxAreaPct(pos, minCells = appState.heatmapMinCells ?? 2) {
    const t = Math.max(0, Math.min(1, (Number(pos) || 0) / 100));
    const minPct = getMinMaxAreaPct(minCells);
    const raw = minPct + (MAX_HIT_AREA_MAX_PCT - minPct) * Math.pow(t, MAX_HIT_AREA_CURVE);
    return Number(raw.toFixed(4));
  }

  function maxAreaPctToSliderPos(pct, minCells = appState.heatmapMinCells ?? 2) {
    const minPct = getMinMaxAreaPct(minCells);
    const clamped = clampMaxAreaPct(pct, minCells);
    const norm = Math.max(0, Math.min(1, (clamped - minPct) / Math.max(0.0001, MAX_HIT_AREA_MAX_PCT - minPct)));
    return Math.round(Math.pow(norm, 1 / MAX_HIT_AREA_CURVE) * 100);
  }

  function clampShakeGatePct(pct, maxAreaPct = appState.heatmapMaxAreaPct ?? 5) {
    const minShake = Math.max(5, Math.ceil(Number(maxAreaPct) || 5));
    const raw = Number(pct);
    const val = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 18;
    return Math.max(minShake, Math.min(50, val));
  }

  function renderNoiseGateMarker(sens) {
    const threshold = 82 - Math.max(10, Math.min(95, sens)) * 0.76;
    if (noiseGateMarker) {
      const gatePct = Math.max(2, Math.min(98, (threshold / DELTA_BAR_MAX) * 100));
      noiseGateMarker.style.left = `${gatePct.toFixed(1)}%`;
    }
    if (noiseMarginText) {
      const margin = threshold - lastNoiseDelta;
      noiseMarginText.textContent = margin >= 0
        ? `Headroom +${Math.round(margin)} Δ`
        : `Noise +${Math.abs(Math.round(margin))} Δ over gate`;
      noiseMarginText.style.color = margin >= 4 ? '' : '#fda4af';
    }
  }

  function syncSensitivityUI(sens) {
    const clamped = Math.max(10, Math.min(95, Number(sens) || 60));
    const threshold = Math.round(82 - clamped * 0.76);
    if (sliderSens) sliderSens.value = String(clamped);
    if (valSens) valSens.textContent = `${clamped}% · Δ>${threshold}`;
    renderNoiseGateMarker(clamped);
  }

  function syncMinCellsUI(cells) {
    const clamped = Math.max(1, Math.min(20, Number(cells) || 2));
    if (sliderMinCells) sliderMinCells.value = String(clamped);
    if (valMinCells) valMinCells.textContent = `${clamped} cell${clamped === 1 ? '' : 's'}`;
  }

  function syncMaxAreaUI(pct, minCells = appState.heatmapMinCells ?? 2) {
    const safeMin = Math.max(1, Math.min(20, Number(minCells) || 2));
    const clamped = clampMaxAreaPct(pct, safeMin);
    const pos = maxAreaPctToSliderPos(clamped, safeMin);
    const cells = Math.max(safeMin + 1, Math.round((clamped / 100) * Math.max(1, lastActiveCells)));
    if (sliderMaxArea) sliderMaxArea.value = String(pos);
    if (valMaxArea) valMaxArea.textContent = `${cells} cells`;
  }

  function syncShakeGateUI(pct, maxAreaPct = appState.heatmapMaxAreaPct ?? 5) {
    const clamped = clampShakeGatePct(pct, maxAreaPct);
    const cells = Math.round((clamped / 100) * Math.max(1, lastActiveCells));
    if (sliderShakeGate) sliderShakeGate.value = String(clamped);
    if (valShakeGate) valShakeGate.textContent = `${clamped}% (${cells}c)`;
  }

  function syncDurationUI(dur) {
    const clamped = Math.max(2, Math.min(60, Math.round(Number(dur) || 30)));
    if (sliderDuration) sliderDuration.value = String(clamped);
    if (valDuration) valDuration.textContent = `${clamped}s`;
    document.querySelectorAll('.calib-dur-preset[data-dur]').forEach((b) => {
      b.classList.toggle('radar-btn-active', Number(b.dataset.dur) === clamped);
    });
  }

  function syncAutoSaveUI(on) {
    if (!btnToggleAutoSave) return;
    btnToggleAutoSave.classList.toggle('radar-btn-active', Boolean(on));
    btnToggleAutoSave.textContent = on ? 'AUTO-SAVE: ON' : 'AUTO-SAVE: OFF';
  }

  // 2. Auto-Tune
  function cancelAutoTune(resetBtnText = true) {
    clearTimeout(autoTuneTimer);
    clearTimeout(autoTuneResetTimer);
    autoTuneActive = false;
    autoTuneNoiseSamples = [];
    autoTunePeakSamples = [];
    if (resetBtnText && btnCalibAutoTune) {
      btnCalibAutoTune.disabled = false;
      btnCalibAutoTune.classList.remove('radar-btn-active');
      btnCalibAutoTune.textContent = '✦ Auto-Tune';
    }
  }

  function finishAutoTune() {
    if (!autoTuneActive) return;
    autoTuneActive = false;
    if (autoTuneNoiseSamples.length === 0) {
      if (btnCalibAutoTune) {
        btnCalibAutoTune.disabled = false;
        btnCalibAutoTune.classList.remove('radar-btn-active');
        btnCalibAutoTune.textContent = 'No Live Frames';
        clearTimeout(autoTuneResetTimer);
        autoTuneResetTimer = setTimeout(() => {
          btnCalibAutoTune.textContent = '✦ Auto-Tune';
        }, 2000);
      }
      return;
    }
    const noises = autoTuneNoiseSamples.slice().sort((a, b) => a - b);
    const peaks = autoTunePeakSamples.slice().sort((a, b) => a - b);
    const p90Noise = noises[Math.min(noises.length - 1, Math.floor(noises.length * 0.9))];
    const p85Peak = peaks.length ? peaks[Math.min(peaks.length - 1, Math.floor(peaks.length * 0.85))] : p90Noise;

    const targetThreshold = Math.max(12, Math.min(70, Math.max(p90Noise + 12, Math.min(p90Noise + 22, p85Peak * 0.5 + 8))));
    const rawSens = Math.round((82 - targetThreshold) / 0.76);
    const snappedSens = Math.max(20, Math.min(90, Math.round(rawSens / 5) * 5));

    updateState({ heatmapSensitivity: snappedSens });
    rezeroHeatmap();
    saveSettings(appState);

    if (btnCalibAutoTune) {
      btnCalibAutoTune.disabled = false;
      btnCalibAutoTune.classList.add('radar-btn-active');
      btnCalibAutoTune.textContent = `✓ Tuned ${snappedSens}%`;
      clearTimeout(autoTuneResetTimer);
      autoTuneResetTimer = setTimeout(() => {
        btnCalibAutoTune.classList.remove('radar-btn-active');
        btnCalibAutoTune.textContent = '✦ Auto-Tune';
      }, 2200);
    }
  }

  btnCalibAutoTune?.addEventListener('click', () => {
    if (autoTuneActive) return;
    clearTimeout(autoTuneResetTimer);
    autoTuneActive = true;
    autoTuneNoiseSamples = [];
    autoTunePeakSamples = [];
    rezeroHeatmap();
    if (btnCalibAutoTune) {
      btnCalibAutoTune.disabled = true;
      btnCalibAutoTune.classList.add('radar-btn-active');
      btnCalibAutoTune.textContent = 'Sampling...';
    }
    autoTuneTimer = setTimeout(finishAutoTune, 1300);
  });

  // 3. Slider Bindings
  sliderSens?.addEventListener('input', (e) => {
    const sens = Math.max(10, Math.min(95, Number(e.target.value) || 60));
    syncSensitivityUI(sens);
    updateState({ heatmapSensitivity: sens });
    saveSettings(appState);
  });

  sliderMinCells?.addEventListener('input', (e) => {
    const cells = Math.max(1, Math.min(20, Number(e.target.value) || 2));
    syncMinCellsUI(cells);
    const nextMaxPct = clampMaxAreaPct(appState.heatmapMaxAreaPct ?? 5, cells);
    syncMaxAreaUI(nextMaxPct, cells);
    const nextShake = clampShakeGatePct(appState.heatmapShakeGatePct ?? 18, nextMaxPct);
    syncShakeGateUI(nextShake, nextMaxPct);
    updateState({
      heatmapMinCells: cells,
      heatmapMaxAreaPct: nextMaxPct,
      heatmapShakeGatePct: nextShake
    });
    saveSettings(appState);
  });

  sliderMaxArea?.addEventListener('input', (e) => {
    const pct = sliderPosToMaxAreaPct(e.target.value, appState.heatmapMinCells ?? 2);
    syncMaxAreaUI(pct, appState.heatmapMinCells ?? 2);
    const nextShake = clampShakeGatePct(appState.heatmapShakeGatePct ?? 18, pct);
    syncShakeGateUI(nextShake, pct);
    updateState({
      heatmapMaxAreaPct: pct,
      heatmapShakeGatePct: nextShake
    });
    saveSettings(appState);
  });

  sliderShakeGate?.addEventListener('input', (e) => {
    const pct = clampShakeGatePct(e.target.value, appState.heatmapMaxAreaPct ?? 5);
    syncShakeGateUI(pct, appState.heatmapMaxAreaPct ?? 5);
    updateState({ heatmapShakeGatePct: pct });
    saveSettings(appState);
  });

  function setCalibDuration(dur) {
    const clamped = Math.max(2, Math.min(60, Math.round(Number(dur) || 30)));
    syncDurationUI(clamped);
    updateState({ heatmapDuration: clamped });
    saveSettings(appState);
  }

  sliderDuration?.addEventListener('input', (e) => setCalibDuration(e.target.value));
  document.querySelectorAll('.calib-dur-preset[data-dur]').forEach((btn) => {
    btn.addEventListener('click', () => setCalibDuration(btn.dataset.dur));
  });

  btnToggleAutoSave?.addEventListener('click', () => {
    updateState({ heatmapAutoSave: !appState.heatmapAutoSave });
    saveSettings(appState);
  });

  // 4. Live Noise-Floor & Gate Telemetry Subscription
  subscribeHeatmapTelemetry((snap) => {
    if (appState.currentScreen !== 'calibration') return;
    lastNoiseDelta = snap.noiseDelta;
    if (Number.isFinite(snap.activeCells) && snap.activeCells > 0 && snap.activeCells !== lastActiveCells) {
      lastActiveCells = snap.activeCells;
      syncMaxAreaUI(appState.heatmapMaxAreaPct ?? 5, appState.heatmapMinCells ?? 2);
      syncShakeGateUI(appState.heatmapShakeGatePct ?? 18, appState.heatmapMaxAreaPct ?? 5);
    }
    if (autoTuneActive) {
      autoTuneNoiseSamples.push(snap.noiseDelta);
      autoTunePeakSamples.push(snap.peakDelta);
    }

    const noisePct = Math.max(0, Math.min(100, (snap.noiseDelta / DELTA_BAR_MAX) * 100));
    const peakPct = Math.max(0, Math.min(100, (snap.peakDelta / DELTA_BAR_MAX) * 100));
    if (noiseMeterFill) {
      noiseMeterFill.style.transform = `scaleX(${(noisePct / 100).toFixed(3)})`;
      noiseMeterFill.classList.toggle('level-warn', snap.noiseDelta >= snap.threshold * 0.72 && snap.noiseDelta < snap.threshold);
      noiseMeterFill.classList.toggle('level-hot', snap.noiseDelta >= snap.threshold);
    }
    if (noisePeakTick) {
      noisePeakTick.style.left = `${peakPct.toFixed(1)}%`;
    }
    const teleStr = `Noise Δ${Math.round(snap.noiseDelta)} · Peak Δ${Math.round(snap.peakDelta)}`;
    if (noiseTelemetryText && teleStr !== lastTelemetryStr) {
      lastTelemetryStr = teleStr;
      noiseTelemetryText.textContent = teleStr;
    }
    renderNoiseGateMarker(appState.heatmapSensitivity ?? 60);

    if (gatePill) {
      const gateMap = {
        idle: ['READY', 'gate-idle'],
        building: ['DETECTING', 'gate-warn'],
        below_min: [`< MIN (${snap.changedCells}/${appState.heatmapMinCells || 2})`, 'gate-warn'],
        valid: [`HIT VALID (${snap.spikeCount}c)`, 'gate-valid'],
        too_large: [`> MAX (${(snap.changedFraction * 100).toFixed(1)}%)`, 'gate-suppressed'],
        global_shake: ['SHAKE GATE', 'gate-suppressed']
      };
      const [label, cls] = gateMap[snap.gateStatus] || gateMap.idle;
      const nextCls = `heatmap-gate-pill ${cls}`;
      if (label !== lastGatePillText) {
        lastGatePillText = label;
        gatePill.textContent = label;
      }
      if (nextCls !== lastGatePillClass) {
        lastGatePillClass = nextCls;
        gatePill.className = nextCls;
      }
    }
  });

  // 5. Ignore Masks on Calibration Stage (1:1 normalized sensor frame)
  function resetClearMasksArm() {
    clearMasksArmed = false;
    clearTimeout(clearMasksArmTimer);
    if (btnClearMasks) {
      btnClearMasks.textContent = 'Clear All';
      btnClearMasks.classList.remove('radar-btn-armed');
    }
  }

  function applyMaskBoxGeometry(box, mask) {
    box.style.left = `${(Number(mask.x) * 100).toFixed(2)}%`;
    box.style.top = `${(Number(mask.y) * 100).toFixed(2)}%`;
    box.style.width = `${(Number(mask.w) * 100).toFixed(2)}%`;
    box.style.height = `${(Number(mask.h) * 100).toFixed(2)}%`;
  }

  function attachMaskDragHandlers(targetEl, box, idx, mask, handleMode) {
    targetEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (handleMode === 'move' && (e.target.closest('.live-ignore-handle') || e.target.closest('.live-ignore-box-remove'))) {
        return;
      }
      const layerRect = calibIgnoreLayer?.getBoundingClientRect();
      if (!layerRect || !layerRect.width || !layerRect.height) return;
      activeMaskDrag = {
        idx,
        handleMode,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        layerRect,
        orig: {
          x: Number(mask.x) || 0,
          y: Number(mask.y) || 0,
          w: Number(mask.w) || MIN_MASK_SIZE,
          h: Number(mask.h) || MIN_MASK_SIZE
        },
        box
      };
      box.classList.add('is-editing');
      try {
        targetEl.setPointerCapture(e.pointerId);
      } catch {}
      e.preventDefault();
      e.stopPropagation();
    });

    targetEl.addEventListener('pointermove', (e) => {
      if (!activeMaskDrag || activeMaskDrag.pointerId !== e.pointerId || activeMaskDrag.idx !== idx) return;
      const { startX, startY, layerRect, orig, handleMode: mode } = activeMaskDrag;
      const dsx = (e.clientX - startX) / layerRect.width;
      const dsy = (e.clientY - startY) / layerRect.height;

      let nx = orig.x;
      let ny = orig.y;
      let nw = orig.w;
      let nh = orig.h;

      if (mode === 'move') {
        nx = Math.max(0, Math.min(1 - orig.w, orig.x + dsx));
        ny = Math.max(0, Math.min(1 - orig.h, orig.y + dsy));
      } else {
        let left = orig.x;
        let top = orig.y;
        let right = orig.x + orig.w;
        let bottom = orig.y + orig.h;
        if (mode.includes('w')) left = Math.max(0, Math.min(right - MIN_MASK_SIZE, orig.x + dsx));
        if (mode.includes('e')) right = Math.min(1, Math.max(left + MIN_MASK_SIZE, orig.x + orig.w + dsx));
        if (mode.includes('n')) top = Math.max(0, Math.min(bottom - MIN_MASK_SIZE, orig.y + dsy));
        if (mode.includes('s')) bottom = Math.min(1, Math.max(top + MIN_MASK_SIZE, orig.y + orig.h + dsy));
        nx = left;
        ny = top;
        nw = right - left;
        nh = bottom - top;
      }

      const updated = { x: nx, y: ny, w: nw, h: nh };
      applyMaskBoxGeometry(box, updated);
      const curMasks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
      if (idx >= 0 && idx < curMasks.length) {
        updateState({ heatmapIgnoreMasks: curMasks.map((item, i) => (i === idx ? updated : item)) });
      }
      e.stopPropagation();
    });

    const finishMaskEdit = (e) => {
      if (!activeMaskDrag || activeMaskDrag.idx !== idx) return;
      if (e?.pointerId !== undefined && e.pointerId !== activeMaskDrag.pointerId) return;
      e?.stopPropagation?.();
      box.classList.remove('is-editing');
      activeMaskDrag = null;
      saveSettings(appState);
      renderCalibIgnoreMasks();
    };
    targetEl.addEventListener('pointerup', finishMaskEdit);
    targetEl.addEventListener('pointercancel', finishMaskEdit);
    targetEl.addEventListener('lostpointercapture', finishMaskEdit);
  }

  function renderCalibIgnoreMasks() {
    if (!calibIgnoreLayer) return;
    const isCalib = appState.currentScreen === 'calibration';
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    const showMasks = Boolean(isCalib && appState.liveMasksVisible !== false);
    const drawActive = Boolean(isCalib && appState.liveMaskDrawActive);

    if (btnMasksVisible) {
      btnMasksVisible.disabled = masks.length === 0;
      btnMasksVisible.classList.toggle('radar-btn-active', showMasks && masks.length > 0);
      btnMasksVisible.textContent = showMasks ? `👁 Masks (${masks.length})` : `🙈 Hidden (${masks.length})`;
    }
    if (btnMaskDraw) {
      btnMaskDraw.classList.toggle('radar-btn-active', drawActive);
      btnMaskDraw.textContent = drawActive ? '✓ Done Drawing' : '✎ Draw Mask';
    }
    if (btnClearMasks) {
      btnClearMasks.classList.toggle('hidden', masks.length === 0);
      if (masks.length === 0) resetClearMasksArm();
    }
    if (maskDrawHint) {
      maskDrawHint.classList.toggle('hidden', !drawActive);
    }

    calibIgnoreLayer.classList.toggle('hidden', !showMasks && !drawActive);
    calibIgnoreLayer.classList.toggle('mask-draw-active', drawActive);
    calibIgnoreLayer.classList.toggle('mask-edit-active', showMasks);

    if (!showMasks && !drawActive) {
      activeMaskDrag = null;
      drawStart = null;
      calibDrawPreview?.classList.add('hidden');
    }

    if (activeMaskDrag) return;

    calibIgnoreLayer.innerHTML = '';
    if (!showMasks) return;

    masks.forEach((m, idx) => {
      const box = document.createElement('div');
      box.className = 'live-ignore-box';
      box.title = 'Drag to move mask, or drag corners to resize';
      applyMaskBoxGeometry(box, m);
      attachMaskDragHandlers(box, box, idx, m, 'move');

      ['nw', 'ne', 'sw', 'se'].forEach((corner) => {
        const handle = document.createElement('div');
        handle.className = `live-ignore-handle handle-${corner}`;
        handle.title = 'Drag corner to resize mask';
        attachMaskDragHandlers(handle, box, idx, m, corner);
        box.appendChild(handle);
      });

      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'live-ignore-box-remove';
      rm.title = 'Remove ignore zone';
      rm.textContent = '×';
      rm.addEventListener('pointerdown', (e) => e.stopPropagation());
      rm.addEventListener('click', (e) => {
        e.stopPropagation();
        updateState({ heatmapIgnoreMasks: masks.filter((_, i) => i !== idx) });
        saveSettings(appState);
      });
      box.appendChild(rm);
      calibIgnoreLayer.appendChild(box);
    });
  }

  btnMaskDraw?.addEventListener('click', () => {
    const next = !appState.liveMaskDrawActive;
    updateState({
      liveMaskDrawActive: next,
      ...(next ? { liveMasksVisible: true } : {})
    });
  });

  btnMasksVisible?.addEventListener('click', () => {
    updateState({ liveMasksVisible: appState.liveMasksVisible === false });
  });

  btnClearMasks?.addEventListener('click', () => {
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    if (!masks.length) return;
    if (!clearMasksArmed) {
      clearMasksArmed = true;
      btnClearMasks.textContent = 'Confirm Clear?';
      btnClearMasks.classList.add('radar-btn-armed');
      clearTimeout(clearMasksArmTimer);
      clearMasksArmTimer = setTimeout(resetClearMasksArm, 2500);
      return;
    }
    resetClearMasksArm();
    updateState({ liveMaskDrawActive: false });
    clearHeatmapIgnoreZones();
    saveSettings(appState);
  });

  calibIgnoreLayer?.addEventListener('pointerdown', (e) => {
    if (!appState.liveMaskDrawActive || e.target.closest('.live-ignore-box') || e.target.closest('.live-ignore-box-remove')) return;
    const rect = calibIgnoreLayer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const vx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const vy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    drawStart = { vx, vy, pointerId: e.pointerId };
    try {
      calibIgnoreLayer.setPointerCapture(e.pointerId);
    } catch {}
    if (calibDrawPreview) {
      calibDrawPreview.classList.remove('hidden');
      calibDrawPreview.style.left = `${(vx * 100).toFixed(2)}%`;
      calibDrawPreview.style.top = `${(vy * 100).toFixed(2)}%`;
      calibDrawPreview.style.width = '0%';
      calibDrawPreview.style.height = '0%';
    }
  });

  calibIgnoreLayer?.addEventListener('pointermove', (e) => {
    if (!drawStart || e.pointerId !== drawStart.pointerId || !calibDrawPreview) return;
    const rect = calibIgnoreLayer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    calibDrawPreview.style.left = `${(Math.min(drawStart.vx, curX) * 100).toFixed(2)}%`;
    calibDrawPreview.style.top = `${(Math.min(drawStart.vy, curY) * 100).toFixed(2)}%`;
    calibDrawPreview.style.width = `${(Math.abs(curX - drawStart.vx) * 100).toFixed(2)}%`;
    calibDrawPreview.style.height = `${(Math.abs(curY - drawStart.vy) * 100).toFixed(2)}%`;
  });

  const cancelDraw = () => {
    drawStart = null;
    calibDrawPreview?.classList.add('hidden');
  };

  const finishDraw = (e) => {
    if (!drawStart || (e?.pointerId !== undefined && e.pointerId !== drawStart.pointerId)) return;
    const rect = calibIgnoreLayer.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      cancelDraw();
      return;
    }
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const vx0 = Math.min(drawStart.vx, curX);
    const vy0 = Math.min(drawStart.vy, curY);
    const vwFrac = Math.abs(curX - drawStart.vx);
    const vhFrac = Math.abs(curY - drawStart.vy);
    drawStart = null;
    calibDrawPreview?.classList.add('hidden');
    if (vwFrac >= 0.025 && vhFrac >= 0.025) {
      addHeatmapIgnoreZone({ x: vx0, y: vy0, w: vwFrac, h: vhFrac });
      saveSettings(appState);
    }
  };
  calibIgnoreLayer?.addEventListener('pointerup', finishDraw);
  calibIgnoreLayer?.addEventListener('pointercancel', cancelDraw);
  calibIgnoreLayer?.addEventListener('lostpointercapture', cancelDraw);

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appState.currentScreen === 'calibration') {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (appState.liveMaskDrawActive) {
        updateState({ liveMaskDrawActive: false });
      } else {
        closeCalibrationToLive();
      }
    }
  });

  // Initial sync & reactive updates
  syncSensitivityUI(appState.heatmapSensitivity ?? 60);
  syncMinCellsUI(appState.heatmapMinCells ?? 2);
  syncMaxAreaUI(appState.heatmapMaxAreaPct ?? 5, appState.heatmapMinCells ?? 2);
  syncShakeGateUI(appState.heatmapShakeGatePct ?? 18, appState.heatmapMaxAreaPct ?? 5);
  syncDurationUI(appState.heatmapDuration ?? 30);
  syncAutoSaveUI(Boolean(appState.heatmapAutoSave));
  syncEnvPresetHighlight();

  subscribeState((state, patch = {}) => {
    if (patch.currentScreen !== undefined) {
      const isCalib = state.currentScreen === 'calibration';
      screenCalibration?.classList.toggle('hidden', !isCalib);
      if (isCalib) {
        requestAnimationFrame(renderCalibIgnoreMasks);
      } else {
        cancelAutoTune(true);
        // Always clean up transient draw/setup flags even when leaving via Setup tabs
        if (state.liveMaskDrawActive || state.heatmapSetupOpen) {
          updateState({ liveMaskDrawActive: false, heatmapSetupOpen: false });
        }
      }
    }
    if (patch.heatmapSensitivity !== undefined) syncSensitivityUI(state.heatmapSensitivity);
    if (patch.heatmapMinCells !== undefined) syncMinCellsUI(state.heatmapMinCells);
    if (patch.heatmapMaxAreaPct !== undefined || patch.heatmapMinCells !== undefined) {
      syncMaxAreaUI(state.heatmapMaxAreaPct, state.heatmapMinCells);
    }
    if (patch.heatmapShakeGatePct !== undefined || patch.heatmapMaxAreaPct !== undefined) {
      syncShakeGateUI(state.heatmapShakeGatePct, state.heatmapMaxAreaPct);
    }
    if (patch.heatmapDuration !== undefined) syncDurationUI(state.heatmapDuration);
    if (patch.heatmapAutoSave !== undefined) syncAutoSaveUI(Boolean(state.heatmapAutoSave));
    if (
      patch.heatmapSensitivity !== undefined ||
      patch.heatmapMinCells !== undefined ||
      patch.heatmapShakeGatePct !== undefined
    ) {
      syncEnvPresetHighlight();
    }
    if (
      patch.currentScreen !== undefined ||
      patch.heatmapIgnoreMasks !== undefined ||
      patch.liveMasksVisible !== undefined ||
      patch.liveMaskDrawActive !== undefined
    ) {
      renderCalibIgnoreMasks();
    }
  });
}
