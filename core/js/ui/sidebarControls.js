/**
 * Floating Icon Strips, Movable/Collapsible Settings Window, Memory Buffer Config,
 * Micro-Change Heatmap, Overlays, Filters & HSL Color Theme
 */
import { appState, updateState, subscribeState } from '../state.js';
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
  stopVoiceAnnouncement,
  rezeroHeatmap,
  addHeatmapIgnoreZone,
  clearHeatmapIgnoreZones,
  subscribeHeatmapTelemetry,
  getLiveViewportProjection
} from '../renderer/compositor.js';
import { snapLoupeToLatestHit } from '../renderer/zoomWindow.js';
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

  // Background and panels
  // Neutral dark glass surfaces & legible slate text regardless of accent hue
  root.setProperty('--radar-bg-deep', '#06090d');
  root.setProperty('--radar-bg', '#0b1016');
  root.setProperty('--radar-panel', 'rgba(13, 19, 26, 0.84)');
  root.setProperty('--radar-header', 'rgba(17, 24, 33, 0.90)');
  root.setProperty('--radar-surface', 'rgba(255, 255, 255, 0.04)');
  root.setProperty('--radar-surface-hover', 'rgba(255, 255, 255, 0.08)');

  // Text and accents
  root.setProperty('--radar-text', '#f8fafc');
  root.setProperty('--radar-text-secondary', '#cbd5e1');
  root.setProperty('--radar-text-muted', '#94a3b8');
  root.setProperty('--radar-accent', hex);

  if (l < 0.15) {
    // Pure Tactical Black Scheme (Solid Black Reticle, high-contrast light borders & text)
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.25)');
    root.setProperty('--radar-border-strong', '#94a3b8');
    root.setProperty('--radar-accent-contrast', '#ffffff');
    root.setProperty('--shadow-glow', '0 0 10px rgba(0, 0, 0, 0.8), 0 0 2px rgba(255, 255, 255, 0.4)');
  } else if (l > 0.85) {
    // Pure White Scheme
    root.setProperty('--radar-border', 'hsl(0, 0%, 30%)');
    root.setProperty('--radar-border-strong', '#ffffff');
    root.setProperty('--radar-accent-contrast', '#051317');
    root.setProperty('--shadow-glow', '0 0 14px rgba(255, 255, 255, 0.5)');
  } else {
    // Chromatic Schemes (Orange, Green, Red, Blue)
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.14)');
    root.setProperty('--radar-border-strong', hex);
    const contrastColor = (l > 0.55 && h > 35 && h < 185) ? `hsl(${h}, ${surfSat}%, 5%)` : '#ffffff';
    root.setProperty('--radar-accent-contrast', contrastColor);
    root.setProperty('--shadow-glow', `0 0 14px hsla(${h}, ${sat}%, 55%, 0.4)`);
  }
}

export function initSidebarAndTopControls(videoEl) {
  const screenLive = document.getElementById('screenLive');
  const screenSettings = document.getElementById('screenSettings');
  const screenReticle = document.getElementById('screenReticle');
  const screenController = document.getElementById('screenController');
  const screenGallery = document.getElementById('screenGallery');

  const btnDeclutterUi = document.getElementById('btnDeclutterUi');
  const btnRestoreUi = document.getElementById('btnRestoreUi');
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

  // 0. Declutter Mode (Hides whole interface except single top-left restore button)
  btnDeclutterUi?.addEventListener('click', () => {
    updateState({ uiDecluttered: true });
  });
  btnRestoreUi?.addEventListener('click', () => {
    updateState({ uiDecluttered: false });
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
    screenController?.classList.add('hidden');
    screenReticle?.classList.remove('hidden');
    updateState({ currentScreen: 'reticle' });
  };
  btnOpenReticleScreen?.addEventListener('click', openReticleScreen);

  const openControllerScreen = () => {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.add('hidden');
    screenReticle?.classList.add('hidden');
    screenController?.classList.remove('hidden');
    updateState({ currentScreen: 'controller' });
  };
  btnOpenControllerScreen?.addEventListener('click', openControllerScreen);

  if (appState.currentScreen === 'controller') {
    openControllerScreen();
  } else if (appState.currentScreen === 'reticle') {
    openReticleScreen();
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

  // 3. Toggle Localized Micro-Change Heatmap (double-tap re-zeros; long-press / caret opens live setup)
  let lastHeatmapTapMs = 0;
  let rezeroFeedbackTimer = null;
  let heatmapLongPressTimer = null;
  let heatmapLongPressFired = false;
  const btnLiveRezero = document.getElementById('btnLiveRezero');
  const btnHeatmapTune = document.getElementById('btnHeatmapTune');
  const heatmapDockGroup = btnToggleHeatmap?.closest('.heatmap-dock-group');
  const heatmapTunePopover = document.getElementById('heatmapTunePopover');
  const heatmapPopoverHeader = document.getElementById('heatmapPopoverHeader');
  const btnPopoverRezero = document.getElementById('btnPopoverRezero');
  const btnCloseHeatmapSetup = document.getElementById('btnCloseHeatmapSetup');

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

  const clampHeatmapPopoverPosition = makePopoverDraggable(heatmapTunePopover, heatmapPopoverHeader);
  const clampReplayPopoverPosition = makePopoverDraggable(replayTunePopover, replayPopoverHeader);

  const triggerLiveRezero = () => {
    rezeroHeatmap();
    [btnLiveRezero, btnPopoverRezero].forEach((b) => b?.classList.add('radar-btn-active'));
    clearTimeout(rezeroFeedbackTimer);
    rezeroFeedbackTimer = setTimeout(() => {
      [btnLiveRezero, btnPopoverRezero].forEach((b) => b?.classList.remove('radar-btn-active'));
    }, 900);
  };

  function setHeatmapSetupOpen(open) {
    const next = Boolean(open);
    if (next) {
      updateState({
        currentScreen: 'live',
        uiDecluttered: false,
        heatmapEnabled: true,
        heatmapSetupOpen: true,
        replaySetupOpen: false,
        liveMasksVisible: true
      });
      saveSettings(appState);
      requestAnimationFrame(() => {
        clampHeatmapPopoverPosition();
        renderLiveIgnoreMasks();
      });
    } else {
      updateState({
        heatmapSetupOpen: false,
        liveMaskDrawActive: false,
        liveMasksVisible: false
      });
    }
  }

  function setReplaySetupOpen(open) {
    const next = Boolean(open);
    if (next) {
      updateState({
        currentScreen: 'live',
        uiDecluttered: false,
        replaySetupOpen: true,
        heatmapSetupOpen: false,
        liveMaskDrawActive: false,
        liveMasksVisible: false
      });
      requestAnimationFrame(() => clampReplayPopoverPosition());
    } else {
      updateState({ replaySetupOpen: false });
    }
  }

  btnLiveRezero?.addEventListener('click', triggerLiveRezero);
  btnPopoverRezero?.addEventListener('click', triggerLiveRezero);
  btnCloseHeatmapSetup?.addEventListener('click', () => setHeatmapSetupOpen(false));
  btnHeatmapTune?.addEventListener('click', () => setHeatmapSetupOpen(!appState.heatmapSetupOpen));

  btnCloseReplaySetup?.addEventListener('click', () => setReplaySetupOpen(false));
  btnReplayTune?.addEventListener('click', () => setReplaySetupOpen(!appState.replaySetupOpen));

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (appState.heatmapSetupOpen) setHeatmapSetupOpen(false);
      if (appState.replaySetupOpen) setReplaySetupOpen(false);
    }
  });

  btnToggleHeatmap.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    heatmapLongPressFired = false;
    clearTimeout(heatmapLongPressTimer);
    heatmapLongPressTimer = setTimeout(() => {
      heatmapLongPressFired = true;
      setHeatmapSetupOpen(!appState.heatmapSetupOpen);
    }, 420);
  });

  const cancelHeatmapLongPress = () => clearTimeout(heatmapLongPressTimer);
  btnToggleHeatmap.addEventListener('pointerup', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('pointercancel', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('pointerleave', cancelHeatmapLongPress);
  btnToggleHeatmap.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    setHeatmapSetupOpen(!appState.heatmapSetupOpen);
  });

  btnToggleHeatmap.addEventListener('click', () => {
    if (heatmapLongPressFired) {
      heatmapLongPressFired = false;
      return;
    }
    const now = performance.now();
    if (now - lastHeatmapTapMs < 350 && appState.heatmapEnabled) {
      lastHeatmapTapMs = 0;
      triggerLiveRezero();
      return;
    }
    lastHeatmapTapMs = now;
    const nextEnabled = !appState.heatmapEnabled;
    updateState({
      heatmapEnabled: nextEnabled,
      ...(nextEnabled ? {} : { heatmapSetupOpen: false, liveMaskDrawActive: false, liveMasksVisible: false })
    });
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

    if (textRtspStatus) textRtspStatus.textContent = `LIVE: ${streamLabel.toUpperCase()}`;
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

      if (textRtspStatus) textRtspStatus.textContent = `LIVE: ${streamLabel.toUpperCase()}`;
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
    if (textRtspStatus) textRtspStatus.textContent = `LIVE: ${label}`;
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
    if (textRtspStatus) textRtspStatus.textContent = `LIVE: CUSTOM RTSP`;
    populateCameraDropdown();
  });

  // Restore saved RTSP view state
  if (appState.rtspSourceMode) {
    setSourceMode(appState.rtspSourceMode);
  }
  if (appState.rtspPreset) {
    setRtspPreset(appState.rtspPreset);
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

  // 10. Heatmap Display Duration (with Infinity support), Live Calibration & Voice Callouts
  const sliderHeatmapDuration = document.getElementById('sliderHeatmapDuration');
  const valHeatmapDuration = document.getElementById('valHeatmapDuration');
  const inputHeatmapDuration = document.getElementById('inputHeatmapDuration');
  const btnHeatmapInfinite = document.getElementById('btnHeatmapInfinite');
  const btnToggleHeatmapSpeech = document.getElementById('btnToggleHeatmapSpeech');
  const btnToggleHeatmapAutoSave = document.getElementById('btnToggleHeatmapAutoSave');
  const syncAutoSaveUI = (on) => {
    if (!btnToggleHeatmapAutoSave) return;
    btnToggleHeatmapAutoSave.classList.toggle('radar-btn-active', on);
    btnToggleHeatmapAutoSave.textContent = on ? 'AUTO-SAVE: ON' : 'AUTO-SAVE: OFF';
  };
  syncAutoSaveUI(Boolean(appState.heatmapAutoSave));
  btnToggleHeatmapAutoSave?.addEventListener('click', () => {
    const next = !appState.heatmapAutoSave;
    updateState({ heatmapAutoSave: next });
    saveSettings(appState);
  });

  const sliderVoicePitch = document.getElementById('sliderVoicePitch');
  const valVoicePitch = document.getElementById('valVoicePitch');
  const sliderVoiceRate = document.getElementById('sliderVoiceRate');
  const valVoiceRate = document.getElementById('valVoiceRate');
  const btnTestVoiceSettings = document.getElementById('btnTestVoiceSettings');

  const liveSliderHeatmapSens = document.getElementById('liveSliderHeatmapSens');
  const liveValHeatmapSens = document.getElementById('liveValHeatmapSens');
  const heatmapTuneSensChip = document.getElementById('heatmapTuneSensChip');
  const liveSliderHeatmapMaxArea = document.getElementById('liveSliderHeatmapMaxArea');
  const liveValHeatmapMaxArea = document.getElementById('liveValHeatmapMaxArea');
  const liveSliderHeatmapMinCells = document.getElementById('liveSliderHeatmapMinCells');
  const liveValHeatmapMinCells = document.getElementById('liveValHeatmapMinCells');
  const liveSliderHeatmapShakeGate = document.getElementById('liveSliderHeatmapShakeGate');
  const liveValHeatmapShakeGate = document.getElementById('liveValHeatmapShakeGate');

  const heatmapLiveGatePill = document.getElementById('heatmapLiveGatePill');
  const heatmapNoiseMeterFill = document.getElementById('heatmapNoiseMeterFill');
  const heatmapNoisePeakTick = document.getElementById('heatmapNoisePeakTick');
  const heatmapNoiseGateMarker = document.getElementById('heatmapNoiseGateMarker');
  const heatmapNoiseTelemetryText = document.getElementById('heatmapNoiseTelemetryText');
  const heatmapNoiseMarginText = document.getElementById('heatmapNoiseMarginText');

  const DELTA_BAR_MAX = 85;
  let lastNoiseDelta = 0;

  function renderNoiseGateMarker(sens) {
    const threshold = 82 - Math.max(10, Math.min(95, sens)) * 0.76;
    if (heatmapNoiseGateMarker) {
      const gatePct = Math.max(2, Math.min(98, (threshold / DELTA_BAR_MAX) * 100));
      heatmapNoiseGateMarker.style.left = `${gatePct.toFixed(1)}%`;
    }
    if (heatmapNoiseMarginText) {
      const margin = threshold - lastNoiseDelta;
      heatmapNoiseMarginText.textContent = margin >= 0
        ? `Headroom +${Math.round(margin)} Δ`
        : `Noise +${Math.abs(Math.round(margin))} Δ over gate`;
      heatmapNoiseMarginText.style.color = margin >= 4 ? '' : '#fda4af';
    }
  }

  function syncSensitivityUI(sens) {
    const clamped = Math.max(10, Math.min(95, Number(sens) || 60));
    const threshold = Math.round(82 - clamped * 0.76);
    if (liveSliderHeatmapSens) liveSliderHeatmapSens.value = String(clamped);
    if (liveValHeatmapSens) liveValHeatmapSens.textContent = `${clamped}% · Δ>${threshold}`;
    if (heatmapTuneSensChip) heatmapTuneSensChip.textContent = `${clamped}%`;
    renderNoiseGateMarker(clamped);
  }

  const HEAT_GRID_CELLS = 160 * 90;
  const MAX_HIT_AREA_MAX_PCT = 20;
  const MAX_HIT_AREA_CURVE = 2.5;

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

  function syncMaxAreaUI(pct, minCells = appState.heatmapMinCells ?? 2) {
    const safeMin = Math.max(1, Math.min(20, Number(minCells) || 2));
    const clamped = clampMaxAreaPct(pct, safeMin);
    const pos = maxAreaPctToSliderPos(clamped, safeMin);
    const cells = Math.max(safeMin + 1, Math.round((clamped / 100) * HEAT_GRID_CELLS));
    if (liveSliderHeatmapMaxArea) liveSliderHeatmapMaxArea.value = String(pos);
    if (liveValHeatmapMaxArea) liveValHeatmapMaxArea.textContent = `${cells} cells`;
  }

  function syncMinCellsUI(cells) {
    const clamped = Math.max(1, Math.min(20, Number(cells) || 2));
    const label = `${clamped} cell${clamped === 1 ? '' : 's'}`;
    if (liveSliderHeatmapMinCells) liveSliderHeatmapMinCells.value = String(clamped);
    if (liveValHeatmapMinCells) liveValHeatmapMinCells.textContent = label;
  }

  function clampShakeGatePct(pct, maxAreaPct = appState.heatmapMaxAreaPct ?? 5) {
    const minShake = Math.max(5, Math.ceil(Number(maxAreaPct) || 5));
    const raw = Number(pct);
    const val = Number.isFinite(raw) && raw > 0 ? Math.round(raw) : 18;
    return Math.max(minShake, Math.min(50, val));
  }

  function syncShakeGateUI(pct, maxAreaPct = appState.heatmapMaxAreaPct ?? 5) {
    const clamped = clampShakeGatePct(pct, maxAreaPct);
    const cells = Math.round((clamped / 100) * HEAT_GRID_CELLS);
    if (liveSliderHeatmapShakeGate) liveSliderHeatmapShakeGate.value = String(clamped);
    if (liveValHeatmapShakeGate) liveValHeatmapShakeGate.textContent = `${clamped}% (${cells}c)`;
  }

  function applyHeatmapSensitivity(val) {
    const sens = Math.max(10, Math.min(95, Number(val) || 60));
    syncSensitivityUI(sens);
    updateState({ heatmapSensitivity: sens });
    saveSettings(appState);
  }

  function applyHeatmapMaxAreaFromSlider(pos) {
    const pct = sliderPosToMaxAreaPct(pos, appState.heatmapMinCells ?? 2);
    syncMaxAreaUI(pct, appState.heatmapMinCells ?? 2);
    const nextShake = clampShakeGatePct(appState.heatmapShakeGatePct ?? 18, pct);
    syncShakeGateUI(nextShake, pct);
    updateState({ heatmapMaxAreaPct: pct, heatmapShakeGatePct: nextShake });
    saveSettings(appState);
  }

  function applyHeatmapMinCells(val) {
    const cells = Math.max(1, Math.min(20, Number(val) || 2));
    syncMinCellsUI(cells);
    const nextMaxPct = clampMaxAreaPct(appState.heatmapMaxAreaPct ?? 5, cells);
    syncMaxAreaUI(nextMaxPct, cells);
    const nextShake = clampShakeGatePct(appState.heatmapShakeGatePct ?? 18, nextMaxPct);
    syncShakeGateUI(nextShake, nextMaxPct);
    updateState({ heatmapMinCells: cells, heatmapMaxAreaPct: nextMaxPct, heatmapShakeGatePct: nextShake });
    saveSettings(appState);
  }

  function applyHeatmapShakeGate(val) {
    const pct = clampShakeGatePct(val, appState.heatmapMaxAreaPct ?? 5);
    syncShakeGateUI(pct, appState.heatmapMaxAreaPct ?? 5);
    updateState({ heatmapShakeGatePct: pct });
    saveSettings(appState);
  }

  syncSensitivityUI(appState.heatmapSensitivity ?? 60);
  syncMinCellsUI(appState.heatmapMinCells ?? 2);
  syncMaxAreaUI(appState.heatmapMaxAreaPct ?? 5, appState.heatmapMinCells ?? 2);
  syncShakeGateUI(appState.heatmapShakeGatePct ?? 18, appState.heatmapMaxAreaPct ?? 5);

  liveSliderHeatmapMaxArea?.addEventListener('input', (e) => applyHeatmapMaxAreaFromSlider(e.target.value));
  liveSliderHeatmapMinCells?.addEventListener('input', (e) => applyHeatmapMinCells(e.target.value));
  liveSliderHeatmapShakeGate?.addEventListener('input', (e) => applyHeatmapShakeGate(e.target.value));
  liveSliderHeatmapSens?.addEventListener('input', (e) => applyHeatmapSensitivity(e.target.value));

  // Live Noise-Floor & Gate Telemetry Subscription (active only when setup popover is open)
  subscribeHeatmapTelemetry((snap) => {
    if (!appState.heatmapSetupOpen) return;
    lastNoiseDelta = snap.noiseDelta;
    const noisePct = Math.max(0, Math.min(100, (snap.noiseDelta / DELTA_BAR_MAX) * 100));
    const peakPct = Math.max(0, Math.min(100, (snap.peakDelta / DELTA_BAR_MAX) * 100));
    if (heatmapNoiseMeterFill) {
      heatmapNoiseMeterFill.style.width = `${noisePct.toFixed(1)}%`;
      heatmapNoiseMeterFill.classList.toggle('level-warn', snap.noiseDelta >= snap.threshold * 0.72 && snap.noiseDelta < snap.threshold);
      heatmapNoiseMeterFill.classList.toggle('level-hot', snap.noiseDelta >= snap.threshold);
    }
    if (heatmapNoisePeakTick) {
      heatmapNoisePeakTick.style.left = `${peakPct.toFixed(1)}%`;
    }
    if (heatmapNoiseTelemetryText) {
      heatmapNoiseTelemetryText.textContent = `Noise Δ${Math.round(snap.noiseDelta)} · Peak Δ${Math.round(snap.peakDelta)}`;
    }
    renderNoiseGateMarker(appState.heatmapSensitivity ?? 60);

    if (heatmapLiveGatePill) {
      const gateMap = {
        idle: ['READY', 'gate-idle'],
        building: ['DETECTING', 'gate-warn'],
        below_min: [`< MIN (${snap.changedCells}/${appState.heatmapMinCells || 2})`, 'gate-warn'],
        valid: [`HIT VALID (${snap.spikeCount}c)`, 'gate-valid'],
        too_large: [`> MAX (${(snap.changedFraction * 100).toFixed(1)}%)`, 'gate-suppressed'],
        global_shake: ['SHAKE GATE', 'gate-suppressed']
      };
      const [label, cls] = gateMap[snap.gateStatus] || gateMap.idle;
      heatmapLiveGatePill.textContent = label;
      heatmapLiveGatePill.className = `heatmap-gate-pill ${cls}`;
    }
  });

  // Live Ignore Masks (Draw / Move / Resize / Show / Delete / Clear right on Live Viewport)
  const liveIgnoreLayer = document.getElementById('liveIgnoreLayer');
  const liveDrawPreview = document.getElementById('liveDrawPreview');
  const btnLiveMaskDraw = document.getElementById('btnLiveMaskDraw');
  const btnLiveMasksVisible = document.getElementById('btnLiveMasksVisible');
  const btnLiveClearMasks = document.getElementById('btnLiveClearMasks');
  const liveMaskDrawHint = document.getElementById('liveMaskDrawHint');
  const MIN_MASK_SIZE = 0.02;
  let clearMasksArmTimer = null;
  let clearMasksArmed = false;
  let liveDrawStart = null;
  let activeMaskDrag = null;

  function resetClearMasksArm() {
    clearMasksArmed = false;
    clearTimeout(clearMasksArmTimer);
    if (btnLiveClearMasks) {
      btnLiveClearMasks.textContent = 'Clear All';
      btnLiveClearMasks.classList.remove('radar-btn-armed');
    }
  }

  function applyMaskBoxGeometry(box, mask, proj) {
    const leftPct = ((mask.x * proj.vw - proj.sx) / proj.cropW) * 100;
    const topPct = ((mask.y * proj.vh - proj.sy) / proj.cropH) * 100;
    const widthPct = ((mask.w * proj.vw) / proj.cropW) * 100;
    const heightPct = ((mask.h * proj.vh) / proj.cropH) * 100;
    box.style.left = `${leftPct.toFixed(2)}%`;
    box.style.top = `${topPct.toFixed(2)}%`;
    box.style.width = `${widthPct.toFixed(2)}%`;
    box.style.height = `${heightPct.toFixed(2)}%`;
  }

  function attachMaskDragHandlers(targetEl, box, idx, mask, handleMode) {
    targetEl.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      if (handleMode === 'move' && (e.target.closest('.live-ignore-handle') || e.target.closest('.live-ignore-box-remove'))) {
        return;
      }
      const layerRect = liveIgnoreLayer?.getBoundingClientRect();
      if (!layerRect || !layerRect.width || !layerRect.height) return;
      const proj = getLiveViewportProjection();
      const orig = {
        x: Number(mask.x) || 0,
        y: Number(mask.y) || 0,
        w: Number(mask.w) || MIN_MASK_SIZE,
        h: Number(mask.h) || MIN_MASK_SIZE
      };
      activeMaskDrag = {
        idx,
        handleMode,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        layerRect,
        proj,
        orig,
        box
      };
      box.classList.add('is-editing');
      try {
        targetEl.setPointerCapture(e.pointerId);
      } catch {
        // Ignore synthetic capture errors
      }
      e.preventDefault();
      e.stopPropagation();
    });

    targetEl.addEventListener('pointermove', (e) => {
      if (!activeMaskDrag || activeMaskDrag.pointerId !== e.pointerId || activeMaskDrag.idx !== idx) return;
      const { startX, startY, layerRect, proj, orig, handleMode: mode } = activeMaskDrag;
      const dvx = (e.clientX - startX) / layerRect.width;
      const dvy = (e.clientY - startY) / layerRect.height;
      const dsx = (dvx * proj.cropW) / proj.vw;
      const dsy = (dvy * proj.cropH) / proj.vh;

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
      applyMaskBoxGeometry(box, updated, proj);

      const curMasks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
      if (idx >= 0 && idx < curMasks.length) {
        const nextMasks = curMasks.map((item, i) => (i === idx ? updated : item));
        updateState({ heatmapIgnoreMasks: nextMasks });
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
      renderLiveIgnoreMasks();
    };
    targetEl.addEventListener('pointerup', finishMaskEdit);
    targetEl.addEventListener('pointercancel', finishMaskEdit);
    targetEl.addEventListener('lostpointercapture', finishMaskEdit);
  }

  function renderLiveIgnoreMasks() {
    if (!liveIgnoreLayer) return;
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    const showMasks = Boolean(appState.heatmapSetupOpen && appState.liveMasksVisible);
    const drawActive = Boolean(appState.heatmapSetupOpen && appState.liveMaskDrawActive);

    if (btnLiveMasksVisible) {
      btnLiveMasksVisible.disabled = masks.length === 0;
      btnLiveMasksVisible.classList.toggle('radar-btn-active', showMasks && masks.length > 0);
      btnLiveMasksVisible.textContent = showMasks ? `👁 Masks (${masks.length})` : `🙈 Hidden (${masks.length})`;
    }
    if (btnLiveMaskDraw) {
      btnLiveMaskDraw.classList.toggle('radar-btn-active', drawActive);
      btnLiveMaskDraw.textContent = drawActive ? '✓ Done Drawing' : '✎ Draw Mask';
    }
    if (btnLiveClearMasks) {
      btnLiveClearMasks.classList.toggle('hidden', masks.length === 0);
      if (masks.length === 0) resetClearMasksArm();
    }
    if (liveMaskDrawHint) {
      liveMaskDrawHint.classList.toggle('hidden', !drawActive);
    }

    liveIgnoreLayer.classList.toggle('hidden', !showMasks && !drawActive);
    liveIgnoreLayer.classList.toggle('mask-draw-active', drawActive);
    liveIgnoreLayer.classList.toggle('mask-edit-active', showMasks);

    if (!showMasks && !drawActive) {
      activeMaskDrag = null;
      liveDrawStart = null;
      liveDrawPreview?.classList.add('hidden');
    }

    if (activeMaskDrag) return;

    liveIgnoreLayer.innerHTML = '';
    if (!showMasks) return;

    const proj = getLiveViewportProjection();
    masks.forEach((m, idx) => {
      const box = document.createElement('div');
      box.className = 'live-ignore-box';
      box.title = 'Drag to move mask, or drag corners to resize';
      applyMaskBoxGeometry(box, m, proj);
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
        const next = masks.filter((_, i) => i !== idx);
        updateState({ heatmapIgnoreMasks: next });
        saveSettings(appState);
      });
      box.appendChild(rm);
      liveIgnoreLayer.appendChild(box);
    });
  }

  btnLiveMaskDraw?.addEventListener('click', () => {
    const next = !appState.liveMaskDrawActive;
    updateState({
      liveMaskDrawActive: next,
      ...(next ? { liveMasksVisible: true } : {})
    });
  });

  btnLiveMasksVisible?.addEventListener('click', () => {
    updateState({ liveMasksVisible: !appState.liveMasksVisible });
  });

  btnLiveClearMasks?.addEventListener('click', () => {
    const masks = Array.isArray(appState.heatmapIgnoreMasks) ? appState.heatmapIgnoreMasks : [];
    if (!masks.length) return;
    if (!clearMasksArmed) {
      clearMasksArmed = true;
      btnLiveClearMasks.textContent = 'Confirm Clear?';
      btnLiveClearMasks.classList.add('radar-btn-armed');
      clearTimeout(clearMasksArmTimer);
      clearMasksArmTimer = setTimeout(resetClearMasksArm, 2500);
      return;
    }
    resetClearMasksArm();
    updateState({ liveMaskDrawActive: false });
    clearHeatmapIgnoreZones();
    saveSettings(appState);
  });

  liveIgnoreLayer?.addEventListener('pointerdown', (e) => {
    if (!appState.liveMaskDrawActive || e.target.closest('.live-ignore-box') || e.target.closest('.live-ignore-box-remove')) return;
    const rect = liveIgnoreLayer.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const vx = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const vy = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    liveDrawStart = { vx, vy, pointerId: e.pointerId };
    try {
      liveIgnoreLayer.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic pointer capture errors
    }
    if (liveDrawPreview) {
      liveDrawPreview.classList.remove('hidden');
      liveDrawPreview.style.left = `${(vx * 100).toFixed(2)}%`;
      liveDrawPreview.style.top = `${(vy * 100).toFixed(2)}%`;
      liveDrawPreview.style.width = '0%';
      liveDrawPreview.style.height = '0%';
    }
  });

  liveIgnoreLayer?.addEventListener('pointermove', (e) => {
    if (!liveDrawStart || e.pointerId !== liveDrawStart.pointerId || !liveDrawPreview) return;
    const rect = liveIgnoreLayer.getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    liveDrawPreview.style.left = `${(Math.min(liveDrawStart.vx, curX) * 100).toFixed(2)}%`;
    liveDrawPreview.style.top = `${(Math.min(liveDrawStart.vy, curY) * 100).toFixed(2)}%`;
    liveDrawPreview.style.width = `${(Math.abs(curX - liveDrawStart.vx) * 100).toFixed(2)}%`;
    liveDrawPreview.style.height = `${(Math.abs(curY - liveDrawStart.vy) * 100).toFixed(2)}%`;
  });

  const finishLiveMaskDraw = (e) => {
    if (!liveDrawStart || (e?.pointerId !== undefined && e.pointerId !== liveDrawStart.pointerId)) return;
    const rect = liveIgnoreLayer.getBoundingClientRect();
    const curX = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const curY = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height));
    const vx0 = Math.min(liveDrawStart.vx, curX);
    const vy0 = Math.min(liveDrawStart.vy, curY);
    const vwFrac = Math.abs(curX - liveDrawStart.vx);
    const vhFrac = Math.abs(curY - liveDrawStart.vy);
    liveDrawStart = null;
    liveDrawPreview?.classList.add('hidden');

    if (vwFrac >= 0.025 && vhFrac >= 0.025) {
      const proj = getLiveViewportProjection();
      const srcX = (proj.sx + vx0 * proj.cropW) / proj.vw;
      const srcY = (proj.sy + vy0 * proj.cropH) / proj.vh;
      const srcW = (vwFrac * proj.cropW) / proj.vw;
      const srcH = (vhFrac * proj.cropH) / proj.vh;
      addHeatmapIgnoreZone({ x: srcX, y: srcY, w: srcW, h: srcH });
      saveSettings(appState);
    }
  };
  liveIgnoreLayer?.addEventListener('pointerup', finishLiveMaskDraw);
  liveIgnoreLayer?.addEventListener('pointercancel', () => {
    liveDrawStart = null;
    liveDrawPreview?.classList.add('hidden');
  });
  window.addEventListener('resize', () => {
    if (appState.heatmapSetupOpen) {
      clampHeatmapPopoverPosition();
      renderLiveIgnoreMasks();
    }
    if (appState.replaySetupOpen) {
      clampReplayPopoverPosition();
    }
  });

  function setHeatmapDuration(dur) {
    if (dur >= 99999 || dur === Infinity) {
      if (sliderHeatmapDuration) sliderHeatmapDuration.value = '125';
      if (valHeatmapDuration) valHeatmapDuration.textContent = '∞';
      if (inputHeatmapDuration) inputHeatmapDuration.value = '99999';
      document.querySelectorAll('.duration-preset-btn[data-dur]').forEach((b) => b.classList.remove('radar-btn-active'));
      btnHeatmapInfinite?.classList.add('radar-btn-active');
      updateState({ heatmapDuration: 99999 });
    } else {
      const clamped = Math.max(1, dur);
      if (sliderHeatmapDuration) sliderHeatmapDuration.value = String(Math.min(120, clamped));
      if (valHeatmapDuration) valHeatmapDuration.textContent = `${clamped}s`;
      if (inputHeatmapDuration) inputHeatmapDuration.value = String(clamped);
      btnHeatmapInfinite?.classList.remove('radar-btn-active');
      document.querySelectorAll('.duration-preset-btn[data-dur]').forEach((b) => {
        b.classList.toggle('radar-btn-active', Number(b.dataset.dur) === clamped);
      });
      updateState({ heatmapDuration: clamped });
    }
    saveSettings(appState);
  }

  const initHeatDur = Number(appState.heatmapDuration) || 30;
  setHeatmapDuration(initHeatDur);

  sliderHeatmapDuration?.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (v >= 125) {
      setHeatmapDuration(Infinity);
    } else {
      setHeatmapDuration(v);
    }
  });

  inputHeatmapDuration?.addEventListener('change', (e) => {
    const v = Number(e.target.value) || 30;
    setHeatmapDuration(v);
  });

  document.querySelectorAll('.duration-preset-btn[data-dur]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dur = Number(btn.dataset.dur);
      if (dur > 0) setHeatmapDuration(dur);
    });
  });

  btnHeatmapInfinite?.addEventListener('click', () => {
    if (appState.heatmapDuration >= 99999) {
      setHeatmapDuration(30);
    } else {
      setHeatmapDuration(Infinity);
    }
  });

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
    if (nextSpeech && !wasOn) {
      speakDetectionAnnouncement('Voice callouts active');
    } else if (!nextSpeech) {
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

  // 12. Interface Color Swatches & 2D Color Picker
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

  // Reactive UI Sync
  subscribeState((state, patch = {}) => {
    if (screenLive) {
      screenLive.classList.toggle('ui-decluttered', Boolean(state.uiDecluttered));
    }
    if (btnRestoreUi) {
      btnRestoreUi.classList.toggle('hidden', !state.uiDecluttered);
    }

    // Fullscreen view visibility sync
    if (screenLive) {
      const isSettings = state.currentScreen === 'settings';
      const isReticle = state.currentScreen === 'reticle';
      const isController = state.currentScreen === 'controller';
      const isLive = state.currentScreen === 'live';
      const isGallery = state.currentScreen === 'gallery';

      if (screenGallery) screenGallery.classList.toggle('hidden', !isGallery);

      screenLive.classList.toggle('hidden', !isLive);
      if (screenSettings) screenSettings.classList.toggle('hidden', !isSettings);
      if (screenReticle) screenReticle.classList.toggle('hidden', !isReticle);
      if (screenController) screenController.classList.toggle('hidden', !isController);
      btnToggleOptions?.classList.toggle('radar-btn-active', isSettings);
    }
    syncLoupeModeUI(state.pipEnabled, state.autoAimLoupe);
    if (btnToggleOverlayTop) {
      btnToggleOverlayTop.classList.toggle('radar-btn-active', state.overlayEnabled);
    }
    reticleDockGroup?.classList.toggle('is-reticle-on', Boolean(state.overlayEnabled));
    syncReticleFfpUI(state.reticleFfpMode);
    btnToggleHeatmap.classList.toggle('radar-btn-active', state.heatmapEnabled);
    heatmapDockGroup?.classList.toggle('is-heatmap-on', Boolean(state.heatmapEnabled));
    const setupOpen = Boolean(state.heatmapSetupOpen && state.currentScreen === 'live' && !state.uiDecluttered);
    if (state.heatmapSetupOpen && !setupOpen) {
      queueMicrotask(() => setHeatmapSetupOpen(false));
    }
    heatmapTunePopover?.classList.toggle('hidden', !setupOpen);
    if (btnHeatmapTune) {
      btnHeatmapTune.classList.toggle('radar-btn-active', setupOpen);
      btnHeatmapTune.setAttribute('aria-expanded', setupOpen ? 'true' : 'false');
    }
    const replayOpen = Boolean(state.replaySetupOpen && state.currentScreen === 'live' && !state.uiDecluttered);
    if (state.replaySetupOpen && !replayOpen) {
      queueMicrotask(() => setReplaySetupOpen(false));
    }
    replayTunePopover?.classList.toggle('hidden', !replayOpen);
    if (btnReplayTune) {
      btnReplayTune.classList.toggle('radar-btn-active', replayOpen);
      btnReplayTune.setAttribute('aria-expanded', replayOpen ? 'true' : 'false');
    }
    if (
      patch.heatmapSetupOpen !== undefined ||
      patch.heatmapIgnoreMasks !== undefined ||
      patch.liveMasksVisible !== undefined ||
      patch.liveMaskDrawActive !== undefined ||
      patch.mainZoom !== undefined ||
      patch.mainPanX !== undefined ||
      patch.mainPanY !== undefined ||
      patch.currentScreen !== undefined
    ) {
      renderLiveIgnoreMasks();
    }
    if (patch.heatmapSensitivity !== undefined) syncSensitivityUI(state.heatmapSensitivity);
    if (patch.heatmapMinCells !== undefined) syncMinCellsUI(state.heatmapMinCells);
    if (patch.heatmapMaxAreaPct !== undefined || patch.heatmapMinCells !== undefined) {
      syncMaxAreaUI(state.heatmapMaxAreaPct, state.heatmapMinCells);
    }
    if (patch.heatmapShakeGatePct !== undefined || patch.heatmapMaxAreaPct !== undefined) {
      syncShakeGateUI(state.heatmapShakeGatePct, state.heatmapMaxAreaPct);
    }
    const detectorActive = Boolean(state.heatmapEnabled || state.heatmapSpeechEnabled);
    if (btnLiveRezero) {
      btnLiveRezero.disabled = !detectorActive;
      btnLiveRezero.classList.toggle('dock-btn-dimmed', !detectorActive);
    }
    syncVoiceToggleUI(Boolean(state.heatmapSpeechEnabled), state.detectionCalloutMode);
    if (patch.detectionCalloutMode !== undefined) {
      syncCalloutModeUI(state.detectionCalloutMode);
    }
    syncAutoSaveUI(Boolean(state.heatmapAutoSave));

    btnToggleBuffer.classList.toggle('radar-btn-active', state.bufferEnabled);
    bufferDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
    bufferText.textContent = state.bufferEnabled
      ? `${Math.round(state.bufferedSeconds)}/${state.bufferMaxSeconds}s`
      : 'RAM OFF';
    replayDockGroup?.classList.toggle('is-buffer-off', !state.bufferEnabled);
    if (replayDockDot) {
      replayDockDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
    }
    updateReplayBtnLabel(state.bufferMaxSeconds || 20, state.bufferEnabled);

    // Update Memory Availability Meter in Settings
    const bufDims = getBufferedTargetDimensions(state.streamWidth, state.streamHeight);
    valBufferResolution.textContent = `${bufDims.width}×${bufDims.height}`;
    const usedMB = (state.bufferBytes / (1024 * 1024)).toFixed(1);
    const estMB = getEstimatedBufferMB();
    const maxBudgetMB = getAvailableMemoryBudgetMB();
    memUsedLabel.textContent = `USED: ${usedMB} MB`;
    memBudgetLabel.textContent = `EST: ~${estMB} MB / ${maxBudgetMB} MB FREE`;

    const estPct = Math.min(100, Math.round((estMB / maxBudgetMB) * 100));
    const usedPct = Math.min(100, Math.round((parseFloat(usedMB) / maxBudgetMB) * 100));
    memBarEstFill.style.width = `${estPct}%`;
    memBarUsedFill.style.width = `${usedPct}%`;

    mainZoomBadge.textContent = `${state.mainZoom.toFixed(1)}x`;
    mainZoomBadge.classList.toggle('zoom-can-reset', state.mainZoom > 1.01);

    btnFilterInvert.classList.toggle('radar-btn-active', state.invert);
    btnFilterGrayscale.classList.toggle('radar-btn-active', state.grayscale);

    // Live Gamepad Connection & Action Telemetry
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


  });
}
