/**
 * Floating Icon Strips, Movable/Collapsible Settings Window, Memory Buffer Config,
 * Micro-Change Heatmap, Overlays, Filters & HSL Color Theme
 */
import { APP_VERSION, appState, updateState, subscribeState } from '../state.js';
import {
  enumerateCameras,
  startCameraStream,
  wakeCameraPipeline,
  checkRtspGatewayStatus,
  getGatewayBaseUrl
} from '../camera/streamManager.js';
import {
  startMemoryBuffer,
  stopMemoryBuffer,
  updateMemoryBufferConfig,
  getAvailableMemoryBudgetMB,
  getEstimatedBufferMB,
  getBufferedTargetDimensions
} from '../recorder/memoryRingBuffer.js';
import { saveSettings } from '../storage/settingsStore.js';
import {
  speakDetectionAnnouncement,
  speakModeAnnouncement,
  stopVoiceAnnouncement,
  rezeroHeatmap,
  clearDetectionHits,
  captureAnnotatedSnapshot
} from '../renderer/compositor.js';
import { snapLoupeToLatestHit } from '../renderer/zoomWindow.js';
import { openCalibrationScreen } from './calibrationScreen.js';
import { toggleQuickTool } from './controllerScreen.js';

export function applyThemeColor(hex) {
  let clean = (hex || '#f97316').replace('#', '').trim();
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const r = (parseInt(clean.substring(0, 2), 16) || 0) / 255;
  const g = (parseInt(clean.substring(2, 4), 16) || 0) / 255;
  const b = (parseInt(clean.substring(4, 6), 16) || 0) / 255;

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

  // High-contrast matte surfaces (no 4% transparent glass washout outdoors, zero GPU blur needed)
  root.setProperty('--radar-bg-deep', '#06090d');
  root.setProperty('--radar-bg', '#0b1016');
  root.setProperty('--radar-panel', 'rgba(13, 19, 26, 0.94)');
  root.setProperty('--radar-header', 'rgba(17, 24, 33, 0.96)');
  root.setProperty('--radar-surface', 'rgba(20, 29, 39, 0.90)');
  root.setProperty('--radar-surface-hover', 'rgba(34, 47, 61, 0.96)');

  // Text and accents
  root.setProperty('--radar-text', '#f8fafc');
  root.setProperty('--radar-text-secondary', '#cbd5e1');
  root.setProperty('--radar-text-muted', '#94a3b8');
  root.setProperty('--radar-accent', hex);

  // Proper WCAG relative luminance for guaranteed >= 4.5:1 button text contrast
  const toLinear = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const relLuma = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

  if (l < 0.15) {
    // Pure Tactical Black Scheme (crisp light border & text so primary CTAs stay legible)
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.28)');
    root.setProperty('--radar-border-strong', '#e2e8f0');
    root.setProperty('--radar-accent-contrast', '#ffffff');
    root.setProperty('--shadow-glow', '0 0 10px rgba(0, 0, 0, 0.8), 0 0 2px rgba(255, 255, 255, 0.45)');
  } else if (l > 0.85) {
    // Pure White Scheme
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.30)');
    root.setProperty('--radar-border-strong', '#ffffff');
    root.setProperty('--radar-accent-contrast', '#090d12');
    root.setProperty('--shadow-glow', '0 0 14px rgba(255, 255, 255, 0.45)');
  } else {
    // Chromatic Schemes (Orange, Green, Red, Blue, custom)
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.16)');
    root.setProperty('--radar-border-strong', hex);
    const contrastColor = relLuma > 0.179 ? '#090d12' : '#ffffff';
    root.setProperty('--radar-accent-contrast', contrastColor);
    root.setProperty('--shadow-glow', `0 0 14px hsla(${h}, ${sat}%, 55%, 0.4)`);
  }
}

export function initSidebarAndTopControls(videoEl) {
  const screenLive = document.getElementById('screenLive');
  const screenSettings = document.getElementById('screenSettings');
  const screenReticle = document.getElementById('screenReticle');
  const screenCalibration = document.getElementById('screenCalibration');
  const screenController = document.getElementById('screenController');
  const screenGallery = document.getElementById('screenGallery');

  const btnDeclutterUi = document.getElementById('btnDeclutterUi');
  const iconEyeOpen = document.getElementById('iconEyeOpen');
  const iconEyeSlash = document.getElementById('iconEyeSlash');
  const btnToggleOptions = document.getElementById('btnToggleOptions');
  const btnSettingsBackToLive = document.getElementById('btnSettingsBackToLive');
  const btnOpenReticleScreen = document.getElementById('btnOpenReticleScreen');
  const btnOpenControllerScreen = document.getElementById('btnOpenControllerScreen');

  const btnTogglePip = document.getElementById('btnTogglePip');
  const btnToggleOverlayTop = document.getElementById('btnToggleOverlayTop');
  const btnToggleHeatmap = document.getElementById('btnToggleHeatmap');
  const btnToggleBuffer = document.getElementById('btnToggleBuffer');
  const bufferDot = document.getElementById('bufferDot');
  const bufferText = document.getElementById('bufferText');

  const cameraSelect = document.getElementById('cameraSelect');
  const btnRefreshCameras = document.getElementById('btnRefreshCameras');

  applyThemeColor(appState.themeColor || '#f97316');
  document.querySelectorAll('.setup-version-badge').forEach((el) => {
    el.textContent = APP_VERSION;
  });

  // 0. Clean View Mode (Hides interface & reticle while keeping top-left Gear & Eye-Slash toggle visible)
  btnDeclutterUi?.addEventListener('click', () => {
    updateState({ uiDecluttered: !appState.uiDecluttered });
  });

  // 1. Fullscreen Settings Screen & Setup Sub-tab Navigation
  const setupSubTabs = {
    camera: document.getElementById('setupTabCamera'),
    detection: document.getElementById('setupTabDetection'),
    display: document.getElementById('setupTabDisplay')
  };

  function switchSettingsSubTab(tabName = 'camera') {
    const activeTab = setupSubTabs[tabName] ? tabName : 'camera';
    Object.entries(setupSubTabs).forEach(([key, panel]) => {
      panel?.classList.toggle('hidden', key !== activeTab);
    });
    screenSettings?.querySelectorAll('.setup-nav-tab[data-setup-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.setupTab === activeTab);
    });
  }

  screenSettings?.querySelectorAll('.setup-nav-tab[data-setup-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchSettingsSubTab(btn.dataset.setupTab);
    });
  });

  document.querySelectorAll('.setup-jump-settings[data-setup-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      screenReticle?.classList.add('hidden');
      screenCalibration?.classList.add('hidden');
      screenController?.classList.add('hidden');
      screenLive?.classList.add('hidden');
      screenSettings?.classList.remove('hidden');
      switchSettingsSubTab(btn.dataset.setupTab);
      updateState({ currentScreen: 'settings' });
      populateCameraDropdown().catch(() => {});
    });
  });

  switchSettingsSubTab('camera');
  btnToggleOptions?.addEventListener('click', () => {
    screenLive?.classList.add('hidden');
    screenCalibration?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
    updateState({ currentScreen: 'settings' });
    populateCameraDropdown().catch(() => {});
  });

  btnSettingsBackToLive?.addEventListener('click', () => {
    screenSettings?.classList.add('hidden');
    screenLive?.classList.remove('hidden');
    updateState({ currentScreen: 'live' });
  });

  const openReticleScreen = () => {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.add('hidden');
    screenCalibration?.classList.add('hidden');
    screenController?.classList.add('hidden');
    screenReticle?.classList.remove('hidden');
    updateState({ currentScreen: 'reticle' });
  };
  btnOpenReticleScreen?.addEventListener('click', openReticleScreen);
  document.getElementById('btnCalibToReticle')?.addEventListener('click', openReticleScreen);

  const openControllerScreen = () => {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.add('hidden');
    screenReticle?.classList.add('hidden');
    screenCalibration?.classList.add('hidden');
    screenController?.classList.remove('hidden');
    updateState({ currentScreen: 'controller' });
  };
  btnOpenControllerScreen?.addEventListener('click', openControllerScreen);
  document.getElementById('btnCalibToController')?.addEventListener('click', openControllerScreen);

  if (appState.currentScreen === 'controller') {
    openControllerScreen();
  } else if (appState.currentScreen === 'reticle') {
    openReticleScreen();
  } else if (appState.currentScreen === 'calibration') {
    openCalibrationScreen();
  } else if (appState.currentScreen === 'settings') {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
  }

  // 2. Consolidated Digital Loupe Mode Cycle (ON -> Auto Aim -> OFF)
  const loupeModeLabel = document.getElementById('loupeModeLabel');
  const iconLoupeOn = document.getElementById('iconLoupeOn');
  const iconLoupeAuto = document.getElementById('iconLoupeAuto');
  const iconLoupeOff = document.getElementById('iconLoupeOff');

  function syncLoupeModeUI(pipEnabled, autoAimLoupe) {
    const isOn = Boolean(pipEnabled);
    const isAuto = isOn && Boolean(autoAimLoupe);
    if (btnTogglePip) {
      btnTogglePip.classList.toggle('radar-btn-active', isOn);
      btnTogglePip.classList.toggle('radar-btn-muted', !isOn);
      btnTogglePip.classList.toggle('loupe-mode-auto', isAuto);
      btnTogglePip.title = !isOn
        ? 'Digital Loupe: OFF — Tap to turn ON'
        : isAuto
          ? 'Digital Loupe: AUTO AIM — Snaps to new detections (Tap to turn OFF)'
          : 'Digital Loupe: ON — Tap to switch to Auto Aim';
    }
    if (iconLoupeOn) iconLoupeOn.classList.toggle('hidden', !(isOn && !isAuto));
    if (iconLoupeAuto) iconLoupeAuto.classList.toggle('hidden', !isAuto);
    if (iconLoupeOff) iconLoupeOff.classList.toggle('hidden', isOn);
    if (loupeModeLabel) {
      loupeModeLabel.textContent = !isOn ? 'Loupe OFF' : (isAuto ? 'Loupe AA' : 'Loupe ON');
    }
  }
  syncLoupeModeUI(appState.pipEnabled, appState.autoAimLoupe);

  btnTogglePip?.addEventListener('click', () => {
    const isOn = Boolean(appState.pipEnabled);
    const isAuto = isOn && Boolean(appState.autoAimLoupe);
    if (isOn && !isAuto) {
      // ON -> AUTO AIM
      updateState({ pipEnabled: true, autoAimLoupe: true, roiTargetVisible: true });
      snapLoupeToLatestHit();
    } else if (isAuto) {
      // AUTO AIM -> OFF
      updateState({ pipEnabled: false, autoAimLoupe: false });
    } else {
      // OFF -> ON
      updateState({ pipEnabled: true, autoAimLoupe: false });
    }
    saveSettings(appState);
  });

  // 2b. Toggle Overlay Guide & FFP/SFP Focal Plane Mode on Live Dock
  const reticleDockGroup = btnToggleOverlayTop?.closest('.reticle-dock-group');
  const btnToggleReticleFfp = document.getElementById('btnToggleReticleFfp');
  const reticleFfpLabel = document.getElementById('reticleFfpLabel');

  function syncReticleFfpUI(ffpMode) {
    const isFfp = ffpMode !== false;
    if (btnToggleReticleFfp) {
      btnToggleReticleFfp.classList.toggle('radar-btn-active', isFfp);
      btnToggleReticleFfp.setAttribute('aria-pressed', String(isFfp));
      btnToggleReticleFfp.title = isFfp
        ? 'Focal Plane: FFP (Scales with zoom) — Tap for SFP'
        : 'Focal Plane: SFP (Fixed screen size) — Tap for FFP';
    }
    if (reticleFfpLabel) {
      reticleFfpLabel.textContent = isFfp ? 'FFP' : 'SFP';
    }
  }
  syncReticleFfpUI(appState.reticleFfpMode);

  if (btnToggleOverlayTop) {
    btnToggleOverlayTop.addEventListener('click', () => {
      updateState({ overlayEnabled: !appState.overlayEnabled });
      saveSettings(appState);
    });
  }

  btnToggleReticleFfp?.addEventListener('click', () => {
    const nextFfp = appState.reticleFfpMode === false;
    updateState({ reticleFfpMode: nextFfp });
    saveSettings(appState);
  });

  // 2d. Cyclic Quick Tool HUD Pill Tap-to-Toggle
  const quickToolPill = document.getElementById('quickToolPill');
  quickToolPill?.addEventListener('click', () => {
    toggleQuickTool();
  });

  // 3. Toggle Hit Detection & Clear Hits + Replay Buffer Popover
  let clearFeedbackTimer = null;
  let heatmapLongPressTimer = null;
  let heatmapLongPressFired = false;
  const btnLiveClearHits = document.getElementById('btnLiveClearHits');
  const btnOpenCalibration = document.getElementById('btnOpenCalibration');
  const heatmapDockGroup = btnToggleHeatmap?.closest('.heatmap-dock-group');

  const btnReplayTune = document.getElementById('btnReplayTune');
  const replayDockGroup = btnReplayTune?.closest('.replay-dock-group');
  const replayDockDot = document.getElementById('replayDockDot');
  const replayTunePopover = document.getElementById('replayTunePopover');
  const replayPopoverHeader = document.getElementById('replayPopoverHeader');
  const btnCloseReplaySetup = document.getElementById('btnCloseReplaySetup');

  function makePopoverDraggable(popoverEl, headerEl) {
    let customPos = false;
    let dragState = null;

    function clampPosition() {
      if (!popoverEl || !customPos || popoverEl.classList.contains('hidden')) return;
      const parent = popoverEl.parentElement;
      if (!parent || !parent.clientWidth || !parent.clientHeight) return;
      const maxX = Math.max(8, parent.clientWidth - popoverEl.offsetWidth - 8);
      const maxY = Math.max(8, parent.clientHeight - popoverEl.offsetHeight - 8);
      const curLeft = parseFloat(popoverEl.style.left);
      const curTop = parseFloat(popoverEl.style.top);
      const clampedX = Math.max(8, Math.min(maxX, Number.isFinite(curLeft) ? curLeft : popoverEl.offsetLeft));
      const clampedY = Math.max(8, Math.min(maxY, Number.isFinite(curTop) ? curTop : popoverEl.offsetTop));
      popoverEl.style.left = `${clampedX}px`;
      popoverEl.style.top = `${clampedY}px`;
    }

    headerEl?.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (e.target.closest('button') || !popoverEl?.parentElement) return;
      const popRect = popoverEl.getBoundingClientRect();
      const parentRect = popoverEl.parentElement.getBoundingClientRect();
      const origLeft = popRect.left - parentRect.left;
      const origTop = popRect.top - parentRect.top;
      popoverEl.style.left = `${origLeft}px`;
      popoverEl.style.top = `${origTop}px`;
      popoverEl.style.bottom = 'auto';
      popoverEl.style.transform = 'none';
      customPos = true;
      dragState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        origLeft,
        origTop
      };
      headerEl.classList.add('is-dragging');
      try {
        headerEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic capture failures
      }
      e.preventDefault();
      e.stopPropagation();
    });

    headerEl?.addEventListener('pointermove', (e) => {
      if (!dragState || e.pointerId !== dragState.pointerId || !popoverEl?.parentElement) return;
      const parent = popoverEl.parentElement;
      const maxX = Math.max(8, parent.clientWidth - popoverEl.offsetWidth - 8);
      const maxY = Math.max(8, parent.clientHeight - popoverEl.offsetHeight - 8);
      const nx = Math.max(8, Math.min(maxX, dragState.origLeft + (e.clientX - dragState.startX)));
      const ny = Math.max(8, Math.min(maxY, dragState.origTop + (e.clientY - dragState.startY)));
      popoverEl.style.left = `${nx}px`;
      popoverEl.style.top = `${ny}px`;
      e.stopPropagation();
    });

    const endDrag = (e) => {
      if (!dragState) return;
      if (e?.pointerId !== undefined && e.pointerId !== dragState.pointerId) return;
      dragState = null;
      headerEl?.classList.remove('is-dragging');
      e?.stopPropagation?.();
    };
    headerEl?.addEventListener('pointerup', endDrag);
    headerEl?.addEventListener('pointercancel', endDrag);
    headerEl?.addEventListener('lostpointercapture', endDrag);

    return clampPosition;
  }

  const clampReplayPopoverPosition = makePopoverDraggable(replayTunePopover, replayPopoverHeader);

  function openCalibrationFromLive() {
    openCalibrationScreen();
  }

  function setReplaySetupOpen(open) {
    const next = Boolean(open);
    if (next) {
      updateState({
        currentScreen: 'live',
        uiDecluttered: false,
        replaySetupOpen: true,
        heatmapSetupOpen: false
      });
      requestAnimationFrame(() => clampReplayPopoverPosition());
    } else {
      updateState({ replaySetupOpen: false });
    }
  }

  // 0b. 1-Tap Live Snapshot & Rain/Carry Touch Lock
  const btnLiveSnapshot = document.getElementById('btnLiveSnapshot');
  btnLiveSnapshot?.addEventListener('click', async () => {
    btnLiveSnapshot.classList.add('radar-btn-active');
    try {
      await captureAnnotatedSnapshot();
    } finally {
      setTimeout(() => btnLiveSnapshot.classList.remove('radar-btn-active'), 450);
    }
  });

  const btnToggleTouchLock = document.getElementById('btnToggleTouchLock');
  const touchLockOverlay = document.getElementById('touchLockOverlay');
  const btnUnlockTouchScreen = document.getElementById('btnUnlockTouchScreen');
  btnToggleTouchLock?.addEventListener('click', () => {
    touchLockOverlay?.classList.remove('hidden');
  });
  btnUnlockTouchScreen?.addEventListener('click', () => {
    touchLockOverlay?.classList.add('hidden');
  });

  let clearHitsArmed = false;
  let clearHitsArmTimer = null;
  function resetClearHitsArm() {
    clearHitsArmed = false;
    clearTimeout(clearHitsArmTimer);
    if (btnLiveClearHits) {
      btnLiveClearHits.classList.remove('radar-btn-armed');
      btnLiveClearHits.title = 'Clear Hit Markers & Re-Zero Background';
    }
  }

  btnLiveClearHits?.addEventListener('click', () => {
    const hitsCount = Array.isArray(appState.detectionHits) ? appState.detectionHits.length : 0;
    // Require 2-tap confirmation when logged hits would be wiped; allow instant Re-Zero at 0 hits
    if (hitsCount > 0 && !clearHitsArmed) {
      clearHitsArmed = true;
      btnLiveClearHits.classList.add('radar-btn-armed');
      btnLiveClearHits.title = 'Tap again to confirm clearing hits';
      clearTimeout(clearHitsArmTimer);
      clearHitsArmTimer = setTimeout(resetClearHitsArm, 2600);
      return;
    }
    resetClearHitsArm();
    clearDetectionHits();
    rezeroHeatmap();
    btnLiveClearHits.classList.add('radar-btn-active');
    clearTimeout(clearFeedbackTimer);
    clearFeedbackTimer = setTimeout(() => {
      btnLiveClearHits.classList.remove('radar-btn-active');
    }, 550);
  });

  btnOpenCalibration?.addEventListener('click', openCalibrationFromLive);

  btnCloseReplaySetup?.addEventListener('click', () => setReplaySetupOpen(false));
  btnReplayTune?.addEventListener('click', () => setReplaySetupOpen(!appState.replaySetupOpen));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && appState.replaySetupOpen) {
      setReplaySetupOpen(false);
    }
  });

  window.addEventListener('resize', () => {
    if (appState.replaySetupOpen) {
      clampReplayPopoverPosition();
    }
  });

  btnToggleHeatmap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    heatmapLongPressFired = false;
    clearTimeout(heatmapLongPressTimer);
    heatmapLongPressTimer = setTimeout(() => {
      heatmapLongPressFired = true;
      openCalibrationFromLive();
    }, 420);
  });

  const cancelHeatmapLongPress = () => clearTimeout(heatmapLongPressTimer);
  btnToggleHeatmap.addEventListener('pointerup', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('pointercancel', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('pointerleave', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    openCalibrationFromLive();
  });

  btnToggleHeatmap.addEventListener('click', () => {
    if (heatmapLongPressFired) {
      heatmapLongPressFired = false;
      return;
    }
    const nextEnabled = !appState.heatmapEnabled;
    if (nextEnabled) {
      rezeroHeatmap();
    }
    updateState({ heatmapEnabled: nextEnabled });
    saveSettings(appState);
  });

  // 5. Enable/Disable Rolling In-Memory Buffer
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

  // 6. Adjustable Buffer Duration & Frame Rate + Live Memory Availability Meter
  const sliderBufferDuration = document.getElementById('sliderBufferDuration');
  const valBufferDuration = document.getElementById('valBufferDuration');
  const sliderBufferFps = document.getElementById('sliderBufferFps');
  const valBufferFps = document.getElementById('valBufferFps');
  const valBufferResolution = document.getElementById('valBufferResolution');
  const memUsedLabel = document.getElementById('memUsedLabel');
  const memBudgetLabel = document.getElementById('memBudgetLabel');
  const memBarEstFill = document.getElementById('memBarEstFill');
  const memBarUsedFill = document.getElementById('memBarUsedFill');

  sliderBufferDuration.value = String(appState.bufferMaxSeconds || 20);
  valBufferDuration.textContent = `${appState.bufferMaxSeconds || 20}s`;
  sliderBufferFps.value = String(appState.bufferTargetFps || 15);
  valBufferFps.textContent = `${appState.bufferTargetFps || 15} FPS`;

  const replayBtnLabel = document.getElementById('replayBtnLabel');
  const replayTuneDurChip = document.getElementById('replayTuneDurChip');
  const updateReplayBtnLabel = (sec, enabled = appState.bufferEnabled) => {
    if (replayBtnLabel) replayBtnLabel.textContent = 'Replay';
    if (replayTuneDurChip) replayTuneDurChip.textContent = enabled ? `${sec}s` : 'OFF';
  };
  updateReplayBtnLabel(appState.bufferMaxSeconds || 20, appState.bufferEnabled);

  sliderBufferDuration.addEventListener('input', (e) => {
    const sec = Number(e.target.value) || 20;
    valBufferDuration.textContent = `${sec}s`;
    updateReplayBtnLabel(sec);
    updateState({ bufferMaxSeconds: sec });
    saveSettings(appState);
    updateMemoryBufferConfig();
  });

  sliderBufferFps.addEventListener('input', (e) => {
    const fps = Number(e.target.value) || 15;
    valBufferFps.textContent = `${fps} FPS`;
    updateState({ bufferTargetFps: fps });
    saveSettings(appState);
    updateMemoryBufferConfig();
  });

  const btnBufferQuality = document.getElementById('btnBufferQuality');
  const btnBufferMic = document.getElementById('btnBufferMic');

  function syncBufferOptionButtons() {
    if (btnBufferQuality) {
      const fast = appState.bufferFastQuality !== false;
      btnBufferQuality.classList.toggle('radar-btn-active', fast);
      btnBufferQuality.textContent = fast ? 'Capture: 720p Fast' : 'Capture: Native';
    }
    if (btnBufferMic) {
      const micOn = Boolean(appState.bufferMicEnabled);
      btnBufferMic.classList.toggle('radar-btn-active', micOn);
      btnBufferMic.textContent = micOn ? 'Mic Peaks: ON' : 'Mic Peaks: OFF';
    }
  }
  syncBufferOptionButtons();

  btnBufferQuality?.addEventListener('click', () => {
    updateState({ bufferFastQuality: !(appState.bufferFastQuality !== false) });
    saveSettings(appState);
    syncBufferOptionButtons();
    updateMemoryBufferConfig();
  });

  btnBufferMic?.addEventListener('click', () => {
    updateState({ bufferMicEnabled: !appState.bufferMicEnabled });
    saveSettings(appState);
    syncBufferOptionButtons();
    updateMemoryBufferConfig();
  });

  // 7. Video Source Enumeration & Selection (USB & Network RTSP)
  const btnSourceModeUsb = document.getElementById('btnSourceModeUsb');
  const btnSourceModeRtsp = document.getElementById('btnSourceModeRtsp');
  const panelSourceUsb = document.getElementById('panelSourceUsb');
  const panelSourceRtsp = document.getElementById('panelSourceRtsp');

  const btnPresetBresser = document.getElementById('btnPresetBresser');
  const btnPresetOnvif = document.getElementById('btnPresetOnvif');
  const btnPresetCustom = document.getElementById('btnPresetCustom');

  const secBresserConfig = document.getElementById('secBresserConfig');
  const secOnvifConfig = document.getElementById('secOnvifConfig');
  const secCustomRtspConfig = document.getElementById('secCustomRtspConfig');

  const inputBresserIp = document.getElementById('inputBresserIp');
  const btnBresserWake = document.getElementById('btnBresserWake');
  const badgeRtspWake = document.getElementById('badgeRtspWake');

  const inputOnvifIp = document.getElementById('inputOnvifIp');
  const inputOnvifPort = document.getElementById('inputOnvifPort');
  const inputOnvifUser = document.getElementById('inputOnvifUser');
  const inputOnvifPass = document.getElementById('inputOnvifPass');
  const btnOnvifConnect = document.getElementById('btnOnvifConnect');

  const inputCustomRtspUrl = document.getElementById('inputCustomRtspUrl');
  const btnCustomRtspConnect = document.getElementById('btnCustomRtspConnect');
  const inputRtspGatewayHost = document.getElementById('inputRtspGatewayHost');

  const textRtspStatus = document.getElementById('textRtspStatus');
  const textRtspFps = document.getElementById('textRtspFps');

  let selectedBresserChannel = appState.rtspChannel || 'ch0'; // Default highest res (1080p Full HD)
  let selectedOnvifPath = appState.rtspOnvifPath || '/onvif1';
  const inputBresserRtspUrl = document.getElementById('inputBresserRtspUrl');
  const btnConnectBresserEndpoint = document.getElementById('btnConnectBresserEndpoint');

  function updateBresserRtspUrlField() {
    const ip = (inputBresserIp?.value || '192.168.0.1').trim();
    if (inputBresserRtspUrl) {
      inputBresserRtspUrl.value = `rtsp://${ip}/live/tcp/${selectedBresserChannel}`;
    }
  }

  inputBresserIp?.addEventListener('input', () => {
    updateBresserRtspUrlField();
  });

  function setSourceMode(mode) {
    updateState({ rtspSourceMode: mode });
    saveSettings(appState);

    if (mode === 'rtsp') {
      btnSourceModeRtsp?.classList.add('radar-btn-active');
      btnSourceModeUsb?.classList.remove('radar-btn-active');
      if (panelSourceUsb) {
        panelSourceUsb.classList.add('hidden');
        panelSourceUsb.style.display = 'none';
      }
      if (panelSourceRtsp) {
        panelSourceRtsp.classList.remove('hidden');
        panelSourceRtsp.style.display = 'flex';
      }

      checkRtspGatewayStatus().then((st) => {
        if (!st.available) {
          if (textRtspStatus) textRtspStatus.textContent = 'GATEWAY: OFFLINE (Run server.py)';
        } else if (textRtspStatus) {
          textRtspStatus.textContent = `GATEWAY: ONLINE (OpenCV ${st.opencvVersion || 'Ready'})`;
        }
      });
    } else {
      btnSourceModeUsb?.classList.add('radar-btn-active');
      btnSourceModeRtsp?.classList.remove('radar-btn-active');
      if (panelSourceUsb) {
        panelSourceUsb.classList.remove('hidden');
        panelSourceUsb.style.display = 'block';
      }
      if (panelSourceRtsp) {
        panelSourceRtsp.classList.add('hidden');
        panelSourceRtsp.style.display = 'none';
      }
    }
  }

  btnSourceModeUsb?.addEventListener('click', () => setSourceMode('usb'));
  btnSourceModeRtsp?.addEventListener('click', () => setSourceMode('rtsp'));

  function setRtspPreset(preset) {
    updateState({ rtspPreset: preset });
    saveSettings(appState);

    [btnPresetBresser, btnPresetOnvif, btnPresetCustom].forEach((b) => b?.classList.remove('radar-btn-active'));
    [secBresserConfig, secOnvifConfig, secCustomRtspConfig].forEach((s) => {
      if (s) {
        s.classList.add('hidden');
        s.style.display = 'none';
      }
    });

    if (preset === 'bresser') {
      btnPresetBresser?.classList.add('radar-btn-active');
      if (secBresserConfig) {
        secBresserConfig.classList.remove('hidden');
        secBresserConfig.style.display = 'flex';
      }
    } else if (preset === 'onvif') {
      btnPresetOnvif?.classList.add('radar-btn-active');
      if (secOnvifConfig) {
        secOnvifConfig.classList.remove('hidden');
        secOnvifConfig.style.display = 'flex';
      }
    } else {
      btnPresetCustom?.classList.add('radar-btn-active');
      if (secCustomRtspConfig) {
        secCustomRtspConfig.classList.remove('hidden');
        secCustomRtspConfig.style.display = 'flex';
      }
    }
  }

  btnPresetBresser?.addEventListener('click', () => setRtspPreset('bresser'));
  btnPresetOnvif?.addEventListener('click', () => setRtspPreset('onvif'));
  btnPresetCustom?.addEventListener('click', () => setRtspPreset('custom'));

  // Bresser Channel Selection buttons
  document.querySelectorAll('.btn-bresser-channel').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      document.querySelectorAll('.btn-bresser-channel').forEach((b) => b.classList.remove('radar-btn-active'));
      btn.classList.add('radar-btn-active');
      selectedBresserChannel = btn.dataset.channel || 'ch0';
      updateState({ rtspChannel: selectedBresserChannel });
      saveSettings(appState);
      updateBresserRtspUrlField();

      // If Bresser stream is currently live, switch channels immediately
      if (appState.isRtspStream && appState.activeDeviceId?.includes('live/tcp/')) {
        await fetch(`${getGatewayBaseUrl()}/api/rtsp/stop`, { method: 'POST' }).catch(() => {});
        const targetUrl = (inputBresserRtspUrl?.value || `rtsp://${(inputBresserIp?.value || '192.168.0.1').trim()}/live/tcp/${selectedBresserChannel}`).trim();
        const lbl = btn.dataset.label || `Bresser (${selectedBresserChannel})`;
        await startCameraStream(videoEl, 'rtsp:' + targetUrl, lbl);
        if (appState.bufferEnabled) startMemoryBuffer(videoEl);
        if (textRtspStatus) textRtspStatus.textContent = `LIVE: ${lbl}`;
        populateCameraDropdown();
      }
    });
  });

  // Direct RTSP Endpoint Connect Button (Supports manual/arbitrary endpoints)
  btnConnectBresserEndpoint?.addEventListener('click', async () => {
    const rawUrl = (inputBresserRtspUrl?.value || '').trim();
    if (!rawUrl) return;

    if (badgeRtspWake) {
      badgeRtspWake.textContent = 'CONNECTING';
      badgeRtspWake.style.color = '#38bdf8';
    }
    const streamLabel = `RTSP: ${rawUrl.split('/').pop() || 'Stream'}`;
    if (textRtspStatus) textRtspStatus.textContent = `CONNECTING: ${rawUrl}...`;

    await startCameraStream(videoEl, 'rtsp:' + rawUrl, streamLabel);
    if (appState.bufferEnabled) startMemoryBuffer(videoEl);
    populateCameraDropdown();
  });

  // Bresser Wake-Up Trigger & Stream Connection
  btnBresserWake?.addEventListener('click', async () => {
    const ip = (inputBresserIp?.value || '192.168.0.1').trim();
    updateState({ rtspCameraIp: ip });
    saveSettings(appState);

    if (badgeRtspWake) {
      badgeRtspWake.textContent = '⚡ WAKING...';
      badgeRtspWake.style.color = '#f59e0b';
    }
    if (textRtspStatus) textRtspStatus.textContent = `WAKING MEDIA PIPELINE AT ${ip}...`;

    await fetch(`${getGatewayBaseUrl()}/api/rtsp/stop`, { method: 'POST' }).catch(() => {});
    const wakeResult = await wakeCameraPipeline(ip, '/app/getmediainfo');

    if (wakeResult && wakeResult.success) {
      if (badgeRtspWake) {
        badgeRtspWake.textContent = selectedBresserChannel === 'ch0' ? 'READY (1080p)' : 'READY';
        badgeRtspWake.style.color = '#22c55e';
      }
      const streamUrl = (inputBresserRtspUrl?.value || `rtsp://${ip}/live/tcp/${selectedBresserChannel}`).trim();
      const streamLabel = `Bresser (${selectedBresserChannel === 'ch0' ? '1080p Main' : selectedBresserChannel})`;
      if (textRtspStatus) textRtspStatus.textContent = `CONNECTING: ${streamUrl}...`;

      await startCameraStream(videoEl, 'rtsp:' + streamUrl, streamLabel);
      if (appState.bufferEnabled) startMemoryBuffer(videoEl);
      populateCameraDropdown();
    } else {
      if (badgeRtspWake) {
        badgeRtspWake.textContent = 'WAKE FAILED';
        badgeRtspWake.style.color = '#fda4af';
      }
      if (textRtspStatus) {
        textRtspStatus.textContent = `ERROR: ${wakeResult?.error || 'Check Bresser Wi-Fi connection'}`;
      }
    }
  });

  // ONVIF Channel Selection
  document.querySelectorAll('.btn-onvif-channel').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.btn-onvif-channel').forEach((b) => b.classList.remove('radar-btn-active'));
      btn.classList.add('radar-btn-active');
      selectedOnvifPath = btn.dataset.path || '/onvif1';
      updateState({ rtspOnvifPath: selectedOnvifPath });
      saveSettings(appState);
    });
  });

  // ONVIF Connect
  btnOnvifConnect?.addEventListener('click', async () => {
    const ip = (inputOnvifIp?.value || '192.168.1.100').trim();
    const port = (inputOnvifPort?.value || '554').trim();
    const user = (inputOnvifUser?.value || '').trim();
    const pass = (inputOnvifPass?.value || '').trim();

    updateState({
      rtspOnvifIp: ip,
      rtspCameraIp: ip,
      rtspOnvifPort: parseInt(port, 10) || 554,
      rtspOnvifUser: user
    });
    saveSettings(appState);

    const authPrefix = user ? `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@` : '';
    const streamUrl = `rtsp://${authPrefix}${ip}:${port}${selectedOnvifPath}`;
    const label = `ONVIF ${ip} (${selectedOnvifPath})`;

    if (textRtspStatus) textRtspStatus.textContent = `CONNECTING TO ${ip}...`;
    await startCameraStream(videoEl, 'rtsp:' + streamUrl, label);
    if (appState.bufferEnabled) startMemoryBuffer(videoEl);
    populateCameraDropdown();
  });

  // Custom RTSP Connect
  btnCustomRtspConnect?.addEventListener('click', async () => {
    const customUrl = (inputCustomRtspUrl?.value || '').trim();
    if (!customUrl) return;

    updateState({ rtspCustomUrl: customUrl });
    saveSettings(appState);

    if (textRtspStatus) textRtspStatus.textContent = `CONNECTING TO RTSP...`;
    await startCameraStream(videoEl, 'rtsp:' + customUrl, 'CUSTOM RTSP');
    if (appState.bufferEnabled) startMemoryBuffer(videoEl);
    populateCameraDropdown();
  });

  // Restore saved RTSP view state (UI only — do not trigger redundant localStorage write on boot)
  if (appState.rtspSourceMode) {
    const isRtsp = appState.rtspSourceMode === 'rtsp';
    btnSourceModeUsb?.classList.toggle('radar-btn-active', !isRtsp);
    btnSourceModeRtsp?.classList.toggle('radar-btn-active', isRtsp);
    panelSourceUsb?.classList.toggle('hidden', isRtsp);
    panelSourceRtsp?.classList.toggle('hidden', !isRtsp);
  }
  if (appState.rtspPreset) {
    const p = appState.rtspPreset;
    btnPresetBresser?.classList.toggle('radar-btn-active', p === 'bresser');
    btnPresetOnvif?.classList.toggle('radar-btn-active', p === 'onvif');
    btnPresetCustom?.classList.toggle('radar-btn-active', p === 'custom');
    if (secBresserConfig) {
      secBresserConfig.classList.toggle('hidden', p !== 'bresser');
      secBresserConfig.style.display = p === 'bresser' ? 'flex' : 'none';
    }
    if (secOnvifConfig) {
      secOnvifConfig.classList.toggle('hidden', p !== 'onvif');
      secOnvifConfig.style.display = p === 'onvif' ? 'flex' : 'none';
    }
    if (secCustomRtspConfig) {
      secCustomRtspConfig.classList.toggle('hidden', p !== 'custom');
      secCustomRtspConfig.style.display = p === 'custom' ? 'flex' : 'none';
    }
  }
  if (inputBresserIp && appState.rtspCameraIp) {
    inputBresserIp.value = appState.rtspCameraIp;
  }
  document.querySelectorAll('.btn-bresser-channel').forEach((btn) => {
    btn.classList.toggle('radar-btn-active', (btn.dataset.channel || 'ch0') === selectedBresserChannel);
  });
  updateBresserRtspUrlField();
  document.querySelectorAll('.btn-onvif-channel').forEach((btn) => {
    btn.classList.toggle('radar-btn-active', (btn.dataset.path || '/onvif1') === selectedOnvifPath);
  });
  if (inputCustomRtspUrl && appState.rtspCustomUrl) {
    inputCustomRtspUrl.value = appState.rtspCustomUrl;
  }
  if (inputRtspGatewayHost && appState.rtspGatewayHost) {
    inputRtspGatewayHost.value = appState.rtspGatewayHost;
  }
  inputRtspGatewayHost?.addEventListener('input', () => {
    updateState({ rtspGatewayHost: inputRtspGatewayHost.value.trim() });
    saveSettings(appState);
  });
  if (inputOnvifIp && appState.rtspOnvifIp) {
    inputOnvifIp.value = appState.rtspOnvifIp;
  }
  if (inputOnvifPort && appState.rtspOnvifPort) {
    inputOnvifPort.value = appState.rtspOnvifPort;
  }
  if (inputOnvifUser && appState.rtspOnvifUser) {
    inputOnvifUser.value = appState.rtspOnvifUser;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function populateCameraDropdown() {
    const devices = await enumerateCameras();
    let optionsHtml = '';

    // If an RTSP stream is currently active, surface it at the top of the selector
    if (appState.isRtspStream && appState.activeDeviceId && !appState.activeDeviceId.startsWith('uvc:')) {
      optionsHtml += `<option value="${escapeHtml(appState.activeDeviceId)}" selected>📡 ${escapeHtml(appState.activeDeviceLabel)}</option>`;
    }

    optionsHtml += devices
      .map((d) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label)}</option>`)
      .join('');

    cameraSelect.innerHTML = optionsHtml;
    if (appState.activeDeviceId && devices.some((d) => d.deviceId === appState.activeDeviceId)) {
      cameraSelect.value = appState.activeDeviceId;
    }
  }

  populateCameraDropdown().catch((err) => console.warn('Camera enum deferred:', err));

  cameraSelect.addEventListener('change', async (e) => {
    const selectedOpt = e.target.selectedOptions?.[0];
    await startCameraStream(videoEl, e.target.value, selectedOpt?.textContent || null);
    if (appState.bufferEnabled) {
      startMemoryBuffer(videoEl);
    }
    populateCameraDropdown().catch((err) => console.warn('Camera enum deferred:', err));
  });

  btnRefreshCameras.addEventListener('click', populateCameraDropdown);
  window.addEventListener('spotr:camera-list-changed', populateCameraDropdown);
  window.__spotrRefreshCameras = () => populateCameraDropdown().catch(() => {});
  window.__spotrOnAndroidCameraPermission = async (granted) => {
    if (granted && (appState.isSimulatedStream || appState.activeDeviceId === 'auto' || appState.activeDeviceId === 'sim')) {
      await startCameraStream(videoEl, 'auto');
      if (appState.bufferEnabled) {
        startMemoryBuffer(videoEl);
      }
    }
    await populateCameraDropdown().catch(() => {});
  };
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateCameraDropdown);
  }

  // 8. Main Whole-Image Zoom Controls (Bottom Bar)
  const mainZoomMinus = document.getElementById('mainZoomMinus');
  const mainZoomPlus = document.getElementById('mainZoomPlus');
  const mainZoomBadge = document.getElementById('mainZoomBadge');

  mainZoomMinus.addEventListener('click', () => {
    const next = Math.max(1.0, Math.round((appState.mainZoom - 0.5) * 2) / 2);
    updateState({
      mainZoom: next,
      mainPanX: next <= 1.01 ? 0 : appState.mainPanX,
      mainPanY: next <= 1.01 ? 0 : appState.mainPanY
    });
  });

  mainZoomPlus.addEventListener('click', () => {
    const next = Math.min(8.0, Math.round((appState.mainZoom + 0.5) * 2) / 2);
    updateState({ mainZoom: next });
  });

  mainZoomBadge?.addEventListener('click', () => {
    updateState({ mainZoom: 1.0, mainPanX: 0, mainPanY: 0 });
  });

  // Note: Overlay reticle master controls (btnToggleOverlay, opacity, scale, load img) are managed exclusively in reticleScreen.js

  // 10. Voice Callouts & Customization (Calibration controls live in calibrationScreen.js)
  const btnToggleHeatmapSpeech = document.getElementById('btnToggleHeatmapSpeech');
  const sliderVoicePitch = document.getElementById('sliderVoicePitch');
  const valVoicePitch = document.getElementById('valVoicePitch');
  const sliderVoiceRate = document.getElementById('sliderVoiceRate');
  const valVoiceRate = document.getElementById('valVoiceRate');
  const btnTestVoiceSettings = document.getElementById('btnTestVoiceSettings');

  const btnToggleVoiceAnnounce = document.getElementById('btnToggleVoiceAnnounce');
  const voiceModeLabel = document.getElementById('voiceModeLabel');

  function syncVoiceToggleUI(isEnabled, mode = appState.detectionCalloutMode) {
    const isVoiceOn = Boolean(isEnabled);
    const isPoa = mode === 'poa';
    if (btnToggleVoiceAnnounce) {
      btnToggleVoiceAnnounce.classList.toggle('radar-btn-active', isVoiceOn);
      btnToggleVoiceAnnounce.classList.toggle('radar-btn-muted', !isVoiceOn);
      btnToggleVoiceAnnounce.classList.toggle('voice-mode-poi', isVoiceOn && !isPoa);
      btnToggleVoiceAnnounce.classList.toggle('voice-mode-poa', isVoiceOn && isPoa);
      btnToggleVoiceAnnounce.title = !isVoiceOn
        ? 'Voice Callouts: OFF — Tap to cycle OFF → POI → POA'
        : isPoa
          ? 'Voice Callouts: POA (Turret adjust clicks) — Tap to Mute'
          : 'Voice Callouts: POI (Impact location) — Tap for POA';
      if (voiceModeLabel) {
        voiceModeLabel.textContent = !isVoiceOn ? 'OFF' : (isPoa ? 'POA' : 'POI');
      }
      const iconVoiceOn = document.getElementById('iconVoiceOn');
      const iconVoiceMuted = document.getElementById('iconVoiceMuted');
      if (iconVoiceOn) iconVoiceOn.classList.toggle('hidden', !isVoiceOn);
      if (iconVoiceMuted) iconVoiceMuted.classList.toggle('hidden', isVoiceOn);
    }
    if (btnToggleHeatmapSpeech) {
      btnToggleHeatmapSpeech.textContent = !isVoiceOn ? 'VOICE: OFF' : (isPoa ? 'VOICE: POA' : 'VOICE: POI');
      btnToggleHeatmapSpeech.classList.toggle('radar-btn-active', isVoiceOn);
    }
  }

  function cycleVoiceMode(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const wasOn = Boolean(appState.heatmapSpeechEnabled);
    const wasPoa = appState.detectionCalloutMode === 'poa';
    let nextSpeech = true;
    let nextMode = 'poi';

    if (!wasOn) {
      nextSpeech = true;
      nextMode = 'poi';
    } else if (!wasPoa) {
      nextSpeech = true;
      nextMode = 'poa';
    } else {
      nextSpeech = false;
      nextMode = 'poi';
    }

    updateState({ heatmapSpeechEnabled: nextSpeech, detectionCalloutMode: nextMode });
    saveSettings(appState);
    syncVoiceToggleUI(nextSpeech, nextMode);
    if (nextSpeech) {
      speakModeAnnouncement(nextMode === 'poa' ? 'Point of Aim' : 'Point of Impact');
    } else {
      stopVoiceAnnouncement();
    }
  }

  if (btnToggleHeatmapSpeech) {
    btnToggleHeatmapSpeech.addEventListener('click', cycleVoiceMode);
  }

  if (btnToggleVoiceAnnounce) {
    btnToggleVoiceAnnounce.addEventListener('click', cycleVoiceMode);
  }
  syncVoiceToggleUI(Boolean(appState.heatmapSpeechEnabled), appState.detectionCalloutMode);

  // Voice Customization (Pitch & Speed)
  if (sliderVoicePitch && valVoicePitch) {
    const p = Number(appState.voicePitch || 1.25);
    sliderVoicePitch.value = String(p);
    valVoicePitch.textContent = `${p.toFixed(2)}x`;
    sliderVoicePitch.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 1.25;
      valVoicePitch.textContent = `${val.toFixed(2)}x`;
      updateState({ voicePitch: val });
      saveSettings(appState);
    });
  }

  if (sliderVoiceRate && valVoiceRate) {
    const r = Number(appState.voiceRate || 0.80);
    sliderVoiceRate.value = String(r);
    valVoiceRate.textContent = `${r.toFixed(2)}x`;
    sliderVoiceRate.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value) || 0.80;
      valVoiceRate.textContent = `${val.toFixed(2)}x`;
      updateState({ voiceRate: val });
      saveSettings(appState);
    });
  }

  // Voice Keyword & POI/POA Mode Customization
  const inputVoiceAlertKeyword = document.getElementById('inputVoiceAlertKeyword');
  const inputVoiceUnitKeyword = document.getElementById('inputVoiceUnitKeyword');
  const btnCalloutModePoi = document.getElementById('btnCalloutModePoi');
  const btnCalloutModePoa = document.getElementById('btnCalloutModePoa');
  const calloutModeDesc = document.getElementById('calloutModeDesc');

  function getAuditionPhrase(prefixOverride, unitOverride) {
    const prefix = (prefixOverride ?? appState.voiceAlertKeyword ?? 'Detection').trim();
    const unit = (unitOverride ?? appState.voiceUnitKeyword ?? 'clicks').trim();
    const isPoa = appState.detectionCalloutMode === 'poa';
    return isPoa
      ? `${prefix}! 3 ${unit} left, 2 ${unit} down`
      : `${prefix}! 3 ${unit} right, 2 ${unit} up`;
  }

  function updateAuditionButtonText() {
    if (!btnTestVoiceSettings) return;
    btnTestVoiceSettings.textContent = `AUDITION: "${getAuditionPhrase()}"`;
  }

  function syncCalloutModeUI(mode) {
    const isPoa = mode === 'poa';
    btnCalloutModePoi?.classList.toggle('radar-btn-active', !isPoa);
    btnCalloutModePoa?.classList.toggle('radar-btn-active', isPoa);
    if (calloutModeDesc) {
      calloutModeDesc.textContent = isPoa
        ? 'POA: turret clicks to dial hit back to center'
        : 'POI: where hit landed relative to reticle';
    }
    syncVoiceToggleUI(Boolean(appState.heatmapSpeechEnabled), mode);
    updateAuditionButtonText();
  }

  function setCalloutMode(nextMode) {
    const normalized = nextMode === 'poa' ? 'poa' : 'poi';
    updateState({ detectionCalloutMode: normalized });
    saveSettings(appState);
    syncCalloutModeUI(normalized);
  }

  btnCalloutModePoi?.addEventListener('click', () => setCalloutMode('poi'));
  btnCalloutModePoa?.addEventListener('click', () => setCalloutMode('poa'));
  syncCalloutModeUI(appState.detectionCalloutMode);

  if (inputVoiceAlertKeyword) {
    inputVoiceAlertKeyword.value = appState.voiceAlertKeyword || 'Detection';
    inputVoiceAlertKeyword.addEventListener('input', (e) => {
      const val = e.target.value.trim() || 'Detection';
      updateState({ voiceAlertKeyword: val });
      saveSettings(appState);
      updateAuditionButtonText();
    });
  }

  if (inputVoiceUnitKeyword) {
    inputVoiceUnitKeyword.value = appState.voiceUnitKeyword || 'clicks';
    inputVoiceUnitKeyword.addEventListener('input', (e) => {
      const val = e.target.value.trim() || 'clicks';
      updateState({ voiceUnitKeyword: val });
      saveSettings(appState);
      updateAuditionButtonText();
    });
  }

  // Voice Preset Quick Chips
  document.querySelectorAll('.btn-voice-preset').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const prefix = btn.dataset.prefix || 'Detection';
      const unit = btn.dataset.unit || 'clicks';
      if (inputVoiceAlertKeyword) inputVoiceAlertKeyword.value = prefix;
      if (inputVoiceUnitKeyword) inputVoiceUnitKeyword.value = unit;
      updateState({ voiceAlertKeyword: prefix, voiceUnitKeyword: unit });
      saveSettings(appState);
      updateAuditionButtonText();
      speakDetectionAnnouncement(getAuditionPhrase(prefix, unit));
    });
  });

  updateAuditionButtonText();

  btnTestVoiceSettings?.addEventListener('click', () => {
    speakDetectionAnnouncement(getAuditionPhrase());
  });

  // 11. Image Manipulation Sliders & Toggles
  const sliderBrightness = document.getElementById('sliderBrightness');
  const valBrightness = document.getElementById('valBrightness');
  const sliderContrast = document.getElementById('sliderContrast');
  const valContrast = document.getElementById('valContrast');
  const sliderSaturation = document.getElementById('sliderSaturation');
  const valSaturation = document.getElementById('valSaturation');
  const btnFilterInvert = document.getElementById('btnFilterInvert');
  const btnFilterGrayscale = document.getElementById('btnFilterGrayscale');
  const btnResetFilters = document.getElementById('btnResetFilters');

  if (sliderBrightness && valBrightness) {
    sliderBrightness.value = String(appState.brightness ?? 100);
    valBrightness.textContent = `${appState.brightness ?? 100}%`;
  }
  if (sliderContrast && valContrast) {
    sliderContrast.value = String(appState.contrast ?? 100);
    valContrast.textContent = `${appState.contrast ?? 100}%`;
  }
  if (sliderSaturation && valSaturation) {
    sliderSaturation.value = String(appState.saturation ?? 100);
    valSaturation.textContent = `${appState.saturation ?? 100}%`;
  }

  sliderBrightness.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valBrightness.textContent = `${v}%`;
    updateState({ brightness: v });
    saveSettings(appState);
  });

  sliderContrast.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valContrast.textContent = `${v}%`;
    updateState({ contrast: v });
    saveSettings(appState);
  });

  sliderSaturation.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    valSaturation.textContent = `${v}%`;
    updateState({ saturation: v });
    saveSettings(appState);
  });

  btnFilterInvert.addEventListener('click', () => {
    updateState({ invert: !appState.invert });
    saveSettings(appState);
  });

  btnFilterGrayscale.addEventListener('click', () => {
    updateState({ grayscale: !appState.grayscale });
    saveSettings(appState);
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
    saveSettings(appState);
  });

  // 12. Interface Color Swatches & 2D Color Picker (exclude Reticle-only swatches to avoid double-binding)
  const swatches = document.querySelectorAll('.theme-swatch:not(.theme-swatch-reticle)');
  const colorPickerCustom = document.getElementById('colorPickerCustom');

  function syncThemeSwatchesUI(color) {
    const clean = (color || '#f97316').toLowerCase();
    applyThemeColor(color || '#f97316');
    if (colorPickerCustom && colorPickerCustom.value.toLowerCase() !== clean) {
      colorPickerCustom.value = color || '#f97316';
    }
    swatches.forEach((s) => {
      s.classList.toggle('active', (s.dataset.color || '').toLowerCase() === clean);
    });
  }

  function selectThemeColor(color) {
    syncThemeSwatchesUI(color);
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

  if (appState.themeColor) {
    colorPickerCustom.value = appState.themeColor;
    swatches.forEach((s) => {
      s.classList.toggle('active', s.dataset.color.toLowerCase() === appState.themeColor.toLowerCase());
    });
  }

  // 13. Global Interface Opacity Slider (Fades all UI chrome together)
  const sliderUiOpacity = document.getElementById('sliderUiOpacity');
  const valUiOpacity = document.getElementById('valUiOpacity');
  const initUiOpacity = Math.max(15, Math.min(100, Number(appState.uiOpacity ?? 100)));
  document.documentElement.style.setProperty('--ui-opacity', String(initUiOpacity / 100));

  if (sliderUiOpacity && valUiOpacity) {
    sliderUiOpacity.value = String(initUiOpacity);
    valUiOpacity.textContent = `${initUiOpacity}%`;
    sliderUiOpacity.addEventListener('input', (e) => {
      const op = Math.max(15, Math.min(100, Number(e.target.value) || 100));
      valUiOpacity.textContent = `${op}%`;
      document.documentElement.style.setProperty('--ui-opacity', String(op / 100));
      updateState({ uiOpacity: op });
      saveSettings(appState);
    });
  }

  // 14. Display/Video & Hit Timestamps
  const btnToggleDisplayTimestamp = document.getElementById('btnToggleDisplayTimestamp');
  const btnToggleHitTimestamps = document.getElementById('btnToggleHitTimestamps');
  const valTimestampPos = document.getElementById('valTimestampPos');
  const tsPosBtns = document.querySelectorAll('.ts-pos-btn[data-pos]');
  const sliderTimestampOpacity = document.getElementById('sliderTimestampOpacity');
  const valTimestampOpacity = document.getElementById('valTimestampOpacity');
  const btnToggleTimestampAdaptive = document.getElementById('btnToggleTimestampAdaptive');

  const TS_POS_LABELS = {
    'top-left': 'Top Left',
    'top-center': 'Top Middle',
    'top-right': 'Top Right',
    'bottom-left': 'Bottom Left',
    'bottom-center': 'Bottom Middle',
    'bottom-right': 'Bottom Right'
  };

  function syncTimestampButtonsUI(state) {
    const dispOn = state.showDisplayTimestamp !== false;
    const hitsOn = Boolean(state.showHitTimestamps);
    const pos = state.timestampPosition || 'bottom-right';
    const op = Math.max(15, Math.min(100, Number(state.timestampOpacity ?? 60)));
    const adaptive = state.timestampAdaptive !== false;

    if (btnToggleDisplayTimestamp) {
      btnToggleDisplayTimestamp.textContent = dispOn ? 'ON' : 'OFF';
      btnToggleDisplayTimestamp.classList.toggle('radar-btn-active', dispOn);
    }
    if (btnToggleHitTimestamps) {
      btnToggleHitTimestamps.textContent = hitsOn ? 'ON' : 'OFF';
      btnToggleHitTimestamps.classList.toggle('radar-btn-active', hitsOn);
    }
    if (valTimestampPos) {
      valTimestampPos.textContent = TS_POS_LABELS[pos] || 'Bottom Right';
    }
    tsPosBtns.forEach((btn) => {
      btn.classList.toggle('radar-btn-active', btn.dataset.pos === pos);
    });
    if (sliderTimestampOpacity) sliderTimestampOpacity.value = String(op);
    if (valTimestampOpacity) valTimestampOpacity.textContent = `${op}%`;
    if (btnToggleTimestampAdaptive) {
      btnToggleTimestampAdaptive.textContent = adaptive ? 'AUTO' : 'FIXED';
      btnToggleTimestampAdaptive.classList.toggle('radar-btn-active', adaptive);
    }
  }

  btnToggleDisplayTimestamp?.addEventListener('click', () => {
    updateState({ showDisplayTimestamp: !(appState.showDisplayTimestamp !== false) });
    saveSettings(appState);
  });

  tsPosBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const pos = btn.dataset.pos;
      if (!pos) return;
      updateState({ timestampPosition: pos });
      saveSettings(appState);
    });
  });

  sliderTimestampOpacity?.addEventListener('input', (e) => {
    const op = Math.max(15, Math.min(100, Number(e.target.value) || 60));
    updateState({ timestampOpacity: op });
    saveSettings(appState);
  });

  btnToggleTimestampAdaptive?.addEventListener('click', () => {
    updateState({ timestampAdaptive: !(appState.timestampAdaptive !== false) });
    saveSettings(appState);
  });

  btnToggleHitTimestamps?.addEventListener('click', () => {
    updateState({ showHitTimestamps: !appState.showHitTimestamps });
    saveSettings(appState);
  });

  // Reactive UI Sync (patch-gated to avoid unnecessary DOM work during 1Hz buffer ticks & pan/aim drags)
  function syncSubscribedControls(state, patch = {}, isInit = false) {
    if (isInit || patch.themeColor !== undefined) {
      syncThemeSwatchesUI(state.themeColor || '#f97316');
    }

    if (isInit || patch.uiDecluttered !== undefined) {
      const isDecluttered = Boolean(state.uiDecluttered);
      if (screenLive) {
        screenLive.classList.toggle('ui-decluttered', isDecluttered);
      }
      if (iconEyeOpen) iconEyeOpen.classList.toggle('hidden', isDecluttered);
      if (iconEyeSlash) iconEyeSlash.classList.toggle('hidden', !isDecluttered);
      if (btnDeclutterUi) {
        btnDeclutterUi.classList.toggle('radar-btn-active', isDecluttered);
        btnDeclutterUi.setAttribute('aria-pressed', String(isDecluttered));
        btnDeclutterUi.title = isDecluttered
          ? 'Show Interface Controls & Reticle'
          : 'Clean View (Hide Controls & Reticle)';
      }
    }

    if (
      isInit ||
      patch.showDisplayTimestamp !== undefined ||
      patch.showHitTimestamps !== undefined ||
      patch.timestampPosition !== undefined ||
      patch.timestampOpacity !== undefined ||
      patch.timestampAdaptive !== undefined
    ) {
      syncTimestampButtonsUI(state);
    }

    if (isInit || patch.currentScreen !== undefined) {
      heatmapLongPressFired = false;
      if (screenLive) {
        const isSettings = state.currentScreen === 'settings';
        const isReticle = state.currentScreen === 'reticle';
        const isCalibration = state.currentScreen === 'calibration';
        const isController = state.currentScreen === 'controller';
        const isLive = state.currentScreen === 'live';
        const isGallery = state.currentScreen === 'gallery';

        if (screenGallery) screenGallery.classList.toggle('hidden', !isGallery);
        screenLive.classList.toggle('hidden', !isLive);
        if (screenSettings) screenSettings.classList.toggle('hidden', !isSettings);
        if (screenReticle) screenReticle.classList.toggle('hidden', !isReticle);
        if (screenCalibration) screenCalibration.classList.toggle('hidden', !isCalibration);
        if (screenController) screenController.classList.toggle('hidden', !isController);
        btnToggleOptions?.classList.toggle('radar-btn-active', isSettings);
      }
    }

    // Live Source Status Pill & RTSP Status / FPS Banner (truthful async connection telemetry)
    if (
      isInit ||
      patch.streamStatus !== undefined ||
      patch.activeDeviceLabel !== undefined ||
      patch.fps !== undefined ||
      patch.isRtspStream !== undefined ||
      patch.isSimulatedStream !== undefined
    ) {
      const status = state.streamStatus || (state.isSimulatedStream ? 'simulated' : 'live');
      const liveSourceDot = document.getElementById('liveSourceDot');
      const liveSourceLabel = document.getElementById('liveSourceLabel');
      if (liveSourceDot && liveSourceLabel) {
        liveSourceDot.className = `live-source-dot status-${status}`;
        if (status === 'reconnecting') {
          liveSourceLabel.textContent = 'RECONNECTING...';
        } else if (status === 'offline') {
          liveSourceLabel.textContent = 'STREAM OFFLINE';
        } else if (status === 'connecting') {
          liveSourceLabel.textContent = 'CONNECTING...';
        } else if (status === 'simulated' || state.isSimulatedStream) {
          liveSourceLabel.textContent = 'TEST SIGNAL';
        } else {
          liveSourceLabel.textContent = `LIVE · ${(state.activeDeviceLabel || 'CAMERA').slice(0, 18)}`;
        }
      }
      if (state.isRtspStream) {
        if (textRtspStatus) {
          if (status === 'live') textRtspStatus.textContent = `LIVE: ${state.activeDeviceLabel}`;
          else if (status === 'reconnecting') textRtspStatus.textContent = `RECONNECTING: ${state.activeDeviceLabel}...`;
          else if (status === 'offline') textRtspStatus.textContent = `OFFLINE: ${state.activeDeviceLabel}`;
          else if (status === 'connecting') textRtspStatus.textContent = `CONNECTING: ${state.activeDeviceLabel}...`;
        }
        if (badgeRtspWake) {
          if (status === 'live') { badgeRtspWake.textContent = 'LIVE'; badgeRtspWake.style.color = '#22c55e'; }
          else if (status === 'reconnecting') { badgeRtspWake.textContent = 'RETRYING'; badgeRtspWake.style.color = '#f59e0b'; }
          else if (status === 'offline') { badgeRtspWake.textContent = 'OFFLINE'; badgeRtspWake.style.color = '#fda4af'; }
        }
        if (textRtspFps) {
          textRtspFps.textContent = status === 'live' && state.fps ? `${state.fps} FPS` : '';
        }
      } else if (textRtspFps) {
        textRtspFps.textContent = '';
      }
    }

    if (isInit || patch.pipEnabled !== undefined || patch.autoAimLoupe !== undefined) {
      syncLoupeModeUI(state.pipEnabled, state.autoAimLoupe);
    }

    if (isInit || patch.overlayEnabled !== undefined) {
      if (btnToggleOverlayTop) {
        btnToggleOverlayTop.classList.toggle('radar-btn-active', state.overlayEnabled);
      }
      reticleDockGroup?.classList.toggle('is-reticle-on', Boolean(state.overlayEnabled));
    }

    if (isInit || patch.reticleFfpMode !== undefined) {
      syncReticleFfpUI(state.reticleFfpMode);
    }

    if (isInit || patch.heatmapEnabled !== undefined) {
      btnToggleHeatmap.classList.toggle('radar-btn-active', state.heatmapEnabled);
      heatmapDockGroup?.classList.toggle('is-heatmap-on', Boolean(state.heatmapEnabled));
    }

    if (isInit || patch.replaySetupOpen !== undefined || patch.currentScreen !== undefined || patch.uiDecluttered !== undefined) {
      const replayOpen = Boolean(state.replaySetupOpen && state.currentScreen === 'live' && !state.uiDecluttered);
      if (state.replaySetupOpen && !replayOpen) {
        queueMicrotask(() => setReplaySetupOpen(false));
      }
      replayTunePopover?.classList.toggle('hidden', !replayOpen);
      if (btnReplayTune) {
        btnReplayTune.classList.toggle('radar-btn-active', replayOpen);
        btnReplayTune.setAttribute('aria-expanded', replayOpen ? 'true' : 'false');
      }
    }

    if (isInit || patch.detectionHits !== undefined || patch.heatmapEnabled !== undefined || patch.heatmapSpeechEnabled !== undefined) {
      const hitsCount = Array.isArray(state.detectionHits) ? state.detectionHits.length : 0;
      const canClear = hitsCount > 0 || Boolean(state.heatmapEnabled || state.heatmapSpeechEnabled);
      if (btnLiveClearHits) {
        btnLiveClearHits.disabled = !canClear;
        // Never disable pointer-events via .dock-btn-dimmed when Re-Zero is valid at 0 hits!
        btnLiveClearHits.classList.toggle('dock-btn-dimmed', !canClear);
      }
    }

    if (isInit || patch.heatmapSpeechEnabled !== undefined || patch.detectionCalloutMode !== undefined) {
      syncVoiceToggleUI(Boolean(state.heatmapSpeechEnabled), state.detectionCalloutMode);
      if (patch.detectionCalloutMode !== undefined) {
        syncCalloutModeUI(state.detectionCalloutMode);
      }
    }

    if (
      isInit ||
      patch.replaySetupOpen !== undefined ||
      patch.bufferEnabled !== undefined ||
      patch.bufferedSeconds !== undefined ||
      patch.bufferMaxSeconds !== undefined ||
      patch.bufferBytes !== undefined ||
      patch.bufferTargetFps !== undefined ||
      patch.bufferFastQuality !== undefined ||
      patch.streamWidth !== undefined ||
      patch.streamHeight !== undefined
    ) {
      replayDockGroup?.classList.toggle('is-buffer-off', !state.bufferEnabled);
      if (replayDockDot) {
        replayDockDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
      }
      updateReplayBtnLabel(state.bufferMaxSeconds || 20, state.bufferEnabled);

      // Gate heavy memory-meter DOM updates to when Replay Setup popover is actually open
      if (isInit || state.replaySetupOpen) {
        btnToggleBuffer.classList.toggle('radar-btn-active', state.bufferEnabled);
        bufferDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
        bufferText.textContent = state.bufferEnabled
          ? `${Math.round(state.bufferedSeconds)}/${state.bufferMaxSeconds}s`
          : 'RAM OFF';

        const bufDims = getBufferedTargetDimensions(state.streamWidth, state.streamHeight);
        valBufferResolution.textContent = `${bufDims.width}×${bufDims.height}`;
        const usedMB = (state.bufferBytes / (1024 * 1024)).toFixed(1);
        const estMB = getEstimatedBufferMB();
        const maxBudgetMB = getAvailableMemoryBudgetMB();
        memUsedLabel.textContent = `USED: ${usedMB} MB`;
        memBudgetLabel.textContent = `EST: ~${estMB} MB / ${maxBudgetMB} MB FREE`;

        const estPct = Math.min(100, Math.round((estMB / maxBudgetMB) * 100));
        const usedPct = Math.min(100, Math.round((parseFloat(usedMB) / maxBudgetMB) * 100));
        memBarEstFill.style.transform = `scaleX(${(estPct / 100).toFixed(3)})`;
        memBarUsedFill.style.transform = `scaleX(${(usedPct / 100).toFixed(3)})`;
      }
    }

    if (isInit || patch.mainZoom !== undefined) {
      mainZoomBadge.textContent = `${state.mainZoom.toFixed(1)}x`;
      mainZoomBadge.classList.toggle('zoom-can-reset', state.mainZoom > 1.01);
    }

    if (isInit || patch.invert !== undefined || patch.grayscale !== undefined) {
      btnFilterInvert.classList.toggle('radar-btn-active', state.invert);
      btnFilterGrayscale.classList.toggle('radar-btn-active', state.grayscale);
    }

    // Live Gamepad Connection & Action Telemetry
    if (isInit || patch.gamepadConnected !== undefined || patch.gamepadName !== undefined || patch.lastGamepadAction !== undefined) {
      const gamepadStatusDot = document.getElementById('gamepadStatusDot');
      const gamepadStatusText = document.getElementById('gamepadStatusText');
      const liveActionBanner = document.getElementById('cmLiveActionBanner');
      if (gamepadStatusDot && gamepadStatusText) {
        gamepadStatusDot.classList.toggle('connected', Boolean(state.gamepadConnected));
        gamepadStatusText.textContent = state.gamepadConnected
          ? (state.gamepadName.split('(')[0].trim() || 'Controller Connected')
          : 'DISCONNECTED (PRESS ANY BUTTON)';
      }
      if (liveActionBanner && patch.lastGamepadAction !== undefined && state.lastGamepadAction) {
        liveActionBanner.textContent = state.lastGamepadAction;
      }
    }
  }

  syncSubscribedControls(appState, {}, true);
  subscribeState((state, patch = {}) => syncSubscribedControls(state, patch, false));
}
