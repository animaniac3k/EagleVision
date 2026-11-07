/**
 * Floating Icon Strips, Movable/Collapsible Settings Window, Memory Buffer Config,
 * Micro-Change Heatmap, Overlays, Filters & HSL Color Theme
 */
import { appState, updateState, subscribeState } from '../state.js';
import {
  enumerateCameras,
  startCameraStream,
  wakeCameraPipeline,
  checkRtspGatewayStatus
} from '../camera/streamManager.js';
import {
  startMemoryBuffer,
  stopMemoryBuffer,
  updateMemoryBufferConfig,
  getAvailableMemoryBudgetMB,
  getEstimatedBufferMB
} from '../recorder/memoryRingBuffer.js';
import { saveSettings } from '../storage/settingsStore.js';
import { speakDetectionAnnouncement, stopVoiceAnnouncement } from '../renderer/compositor.js';
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
  root.setProperty('--radar-bg-deep', `hsl(${h}, ${surfSat}%, 3%)`);
  root.setProperty('--radar-bg', `hsl(${h}, ${surfSat}%, 5%)`);
  root.setProperty('--radar-panel', `hsla(${h}, ${surfSat}%, 8%, 0.94)`);
  root.setProperty('--radar-header', `hsl(${h}, ${surfSat}%, 11%)`);
  root.setProperty('--radar-surface', `hsl(${h}, ${surfSat}%, 9%)`);
  root.setProperty('--radar-surface-hover', `hsl(${h}, ${surfSat}%, 15%)`);

  // Text and accents
  root.setProperty('--radar-text', `hsl(${h}, ${Math.min(85, sat)}%, 92%)`);
  root.setProperty('--radar-text-secondary', `hsl(${h}, ${Math.min(80, sat)}%, 80%)`);
  root.setProperty('--radar-text-muted', `hsl(${h}, ${Math.min(75, sat)}%, 66%)`);
  root.setProperty('--radar-accent', hex);

  if (l < 0.15) {
    // Pure Tactical Black Scheme (Solid Black Reticle, high-contrast light borders & text)
    root.setProperty('--radar-border', 'rgba(255, 255, 255, 0.25)');
    root.setProperty('--radar-border-strong', '#94a3b8');
    root.setProperty('--radar-accent-contrast', '#ffffff');
    root.setProperty('--shadow-glow', '0 0 10px rgba(0, 0, 0, 0.8), 0 0 2px rgba(255, 255, 255, 0.4)');
    root.setProperty('--reticle-shadow', 'drop-shadow(0 0 1px rgba(255, 255, 255, 0.65))');
  } else if (l > 0.85) {
    // Pure White Scheme
    root.setProperty('--radar-border', 'hsl(0, 0%, 30%)');
    root.setProperty('--radar-border-strong', '#ffffff');
    root.setProperty('--radar-accent-contrast', '#051317');
    root.setProperty('--shadow-glow', '0 0 14px rgba(255, 255, 255, 0.5)');
    root.setProperty('--reticle-shadow', 'drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.85))');
  } else {
    // Chromatic Schemes (Orange, Green, Red, Blue)
    root.setProperty('--radar-border', `hsl(${h}, ${Math.min(60, sat)}%, 24%)`);
    root.setProperty('--radar-border-strong', hex);
    const contrastColor = (l > 0.55 && h > 35 && h < 185) ? `hsl(${h}, ${surfSat}%, 5%)` : '#ffffff';
    root.setProperty('--radar-accent-contrast', contrastColor);
    root.setProperty('--shadow-glow', `0 0 14px hsla(${h}, ${sat}%, 55%, 0.4)`);
    root.setProperty('--reticle-shadow', 'drop-shadow(0 0 1.5px rgba(0, 0, 0, 0.75))');
  }
}

export function initSidebarAndTopControls(videoEl) {
  const screenLive = document.getElementById('screenLive');
  const screenSettings = document.getElementById('screenSettings');
  const screenReticle = document.getElementById('screenReticle');
  const screenController = document.getElementById('screenController');

  const btnDeclutterUi = document.getElementById('btnDeclutterUi');
  const btnRestoreUi = document.getElementById('btnRestoreUi');
  const btnToggleOptions = document.getElementById('btnToggleOptions');
  const btnSettingsBackToLive = document.getElementById('btnSettingsBackToLive');
  const btnOpenReticleScreen = document.getElementById('btnOpenReticleScreen');
  const btnOpenControllerScreen = document.getElementById('btnOpenControllerScreen');

  const btnTogglePip = document.getElementById('btnTogglePip');
  const btnToggleOverlayTop = document.getElementById('btnToggleOverlayTop');
  const btnToggleHeatmap = document.getElementById('btnToggleHeatmap');
  const btnToggleHud = document.getElementById('btnToggleHud');
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

  // 1. Fullscreen Settings Screen Navigation
  btnToggleOptions?.addEventListener('click', () => {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
    updateState({ currentScreen: 'settings' });
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
    updateState({ currentScreen: 'reticle', replayActive: false });
  };
  btnOpenReticleScreen?.addEventListener('click', openReticleScreen);

  const openControllerScreen = () => {
    screenLive?.classList.add('hidden');
    screenSettings?.classList.add('hidden');
    screenReticle?.classList.add('hidden');
    screenController?.classList.remove('hidden');
    updateState({ currentScreen: 'controller', replayActive: false });
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

  // 2. Show/Hide Digital Zoom Window
  btnTogglePip.addEventListener('click', () => {
    updateState({ pipEnabled: !appState.pipEnabled });
    saveSettings(appState);
  });

  // 2b. Toggle Overlay Guide from Top-Left Bar
  if (btnToggleOverlayTop) {
    btnToggleOverlayTop.addEventListener('click', () => {
      updateState({ overlayEnabled: !appState.overlayEnabled });
      saveSettings(appState);
    });
  }

  // Note: btnToggleReticleFfp is managed exclusively in reticleScreen.js

  // 2d. Cyclic Quick Tool HUD Pill Tap-to-Toggle
  const quickToolPill = document.getElementById('quickToolPill');
  quickToolPill?.addEventListener('click', () => {
    toggleQuickTool();
  });

  // 3. Toggle Localized Micro-Change Heatmap from Main Interface
  btnToggleHeatmap.addEventListener('click', () => {
    updateState({ heatmapEnabled: !appState.heatmapEnabled });
  });

  // 4. Show/Hide Stream Telemetry HUD
  btnToggleHud.addEventListener('click', () => {
    updateState({ hudOpen: !appState.hudOpen });
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
  const updateReplayBtnLabel = (sec) => {
    if (replayBtnLabel) replayBtnLabel.textContent = `REPLAY (${sec}s)`;
  };
  updateReplayBtnLabel(appState.bufferMaxSeconds || 20);

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
        await fetch('/api/rtsp/stop', { method: 'POST' }).catch(() => {});
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

    await fetch('/api/rtsp/stop', { method: 'POST' }).catch(() => {});
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
  if (inputCustomRtspUrl && appState.rtspCustomUrl) {
    inputCustomRtspUrl.value = appState.rtspCustomUrl;
  }

  async function populateCameraDropdown() {
    const devices = await enumerateCameras();
    let optionsHtml = '';

    // If an RTSP stream is currently active, surface it at the top of the selector
    if (appState.isRtspStream && appState.activeDeviceId) {
      optionsHtml += `<option value="${appState.activeDeviceId}" selected>📡 ${appState.activeDeviceLabel}</option>`;
    }

    optionsHtml += devices
      .map((d) => `<option value="${d.deviceId}">${d.label}</option>`)
      .join('');

    cameraSelect.innerHTML = optionsHtml;
    if (appState.activeDeviceId && !appState.isRtspStream && devices.some((d) => d.deviceId === appState.activeDeviceId)) {
      cameraSelect.value = appState.activeDeviceId;
    }
  }

  populateCameraDropdown().catch((err) => console.warn('Camera enum deferred:', err));

  cameraSelect.addEventListener('change', async (e) => {
    await startCameraStream(videoEl, e.target.value);
    if (appState.bufferEnabled) {
      startMemoryBuffer(videoEl);
    }
    populateCameraDropdown().catch((err) => console.warn('Camera enum deferred:', err));
  });

  btnRefreshCameras.addEventListener('click', populateCameraDropdown);
  if (navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateCameraDropdown);
  }

  // 8. Main Whole-Image Zoom Controls (Bottom Bar)
  const mainZoomMinus = document.getElementById('mainZoomMinus');
  const mainZoomPlus = document.getElementById('mainZoomPlus');
  const mainZoomReset = document.getElementById('mainZoomReset');
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

  mainZoomReset.addEventListener('click', () => {
    updateState({ mainZoom: 1.0, mainPanX: 0, mainPanY: 0 });
  });

  // Note: Overlay reticle master controls (btnToggleOverlay, opacity, scale, load img) are managed exclusively in reticleScreen.js

  // 10. Heatmap Sensitivity, Display Duration (with Infinity support) & Voice Callouts
  const sliderHeatmapSens = document.getElementById('sliderHeatmapSens');
  const valHeatmapSens = document.getElementById('valHeatmapSens');
  const sliderHeatmapDuration = document.getElementById('sliderHeatmapDuration');
  const valHeatmapDuration = document.getElementById('valHeatmapDuration');
  const inputHeatmapDuration = document.getElementById('inputHeatmapDuration');
  const btnHeatmapInfinite = document.getElementById('btnHeatmapInfinite');
  const btnToggleHeatmapSpeech = document.getElementById('btnToggleHeatmapSpeech');

  const sliderVoicePitch = document.getElementById('sliderVoicePitch');
  const valVoicePitch = document.getElementById('valVoicePitch');
  const sliderVoiceRate = document.getElementById('sliderVoiceRate');
  const valVoiceRate = document.getElementById('valVoiceRate');
  const btnTestVoiceSettings = document.getElementById('btnTestVoiceSettings');

  sliderHeatmapSens.value = String(appState.heatmapSensitivity || 60);
  valHeatmapSens.textContent = `${appState.heatmapSensitivity || 60}%`;

  function setHeatmapDuration(dur) {
    if (dur >= 99999 || dur === Infinity) {
      if (sliderHeatmapDuration) sliderHeatmapDuration.value = '125';
      if (valHeatmapDuration) valHeatmapDuration.textContent = '∞';
      if (inputHeatmapDuration) inputHeatmapDuration.value = '99999';
      btnHeatmapInfinite?.classList.add('radar-btn-active');
      updateState({ heatmapDuration: 99999 });
    } else {
      const clamped = Math.max(1, dur);
      if (sliderHeatmapDuration) sliderHeatmapDuration.value = String(Math.min(120, clamped));
      if (valHeatmapDuration) valHeatmapDuration.textContent = 's';
      if (inputHeatmapDuration) inputHeatmapDuration.value = String(clamped);
      btnHeatmapInfinite?.classList.remove('radar-btn-active');
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

  btnHeatmapInfinite?.addEventListener('click', () => {
    if (appState.heatmapDuration >= 99999) {
      setHeatmapDuration(30);
    } else {
      setHeatmapDuration(Infinity);
    }
  });

  function syncVoiceToggleUI(isEnabled) {
    const isVoiceOn = Boolean(isEnabled);
    if (btnToggleVoiceAnnounce) {
      btnToggleVoiceAnnounce.classList.toggle('radar-btn-active', isVoiceOn);
      btnToggleVoiceAnnounce.classList.toggle('radar-btn-muted', !isVoiceOn);
      btnToggleVoiceAnnounce.title = isVoiceOn
        ? 'Voice Announcements: ON (Click to Mute)'
        : 'Voice Announcements: MUTED (Click to Enable)';
      const iconVoiceOn = document.getElementById('iconVoiceOn');
      const iconVoiceMuted = document.getElementById('iconVoiceMuted');
      if (iconVoiceOn) iconVoiceOn.classList.toggle('hidden', !isVoiceOn);
      if (iconVoiceMuted) iconVoiceMuted.classList.toggle('hidden', isVoiceOn);
    }
    if (btnToggleHeatmapSpeech) {
      btnToggleHeatmapSpeech.textContent = isVoiceOn ? 'VOICE: ON' : 'VOICE: OFF';
      btnToggleHeatmapSpeech.classList.toggle('radar-btn-active', isVoiceOn);
    }
  }

  function toggleVoiceSpeech(e) {
    if (e) {
      e.preventDefault();
      e.stopPropagation();
    }
    const next = !appState.heatmapSpeechEnabled;
    updateState({ heatmapSpeechEnabled: next });
    saveSettings(appState);
    syncVoiceToggleUI(next);
    if (next) {
      speakDetectionAnnouncement('Voice callouts active');
    } else {
      stopVoiceAnnouncement();
    }
  }

  if (btnToggleHeatmapSpeech) {
    btnToggleHeatmapSpeech.addEventListener('click', toggleVoiceSpeech);
  }

  // Top-Left Floating Strip Voice Toggle Button
  const btnToggleVoiceAnnounce = document.getElementById('btnToggleVoiceAnnounce');
  if (btnToggleVoiceAnnounce) {
    btnToggleVoiceAnnounce.addEventListener('click', toggleVoiceSpeech);
  }
  syncVoiceToggleUI(Boolean(appState.heatmapSpeechEnabled));

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

  // Voice Keyword Customization
  const inputVoiceAlertKeyword = document.getElementById('inputVoiceAlertKeyword');
  const inputVoiceUnitKeyword = document.getElementById('inputVoiceUnitKeyword');

  function updateAuditionButtonText() {
    if (!btnTestVoiceSettings) return;
    const prefix = (appState.voiceAlertKeyword || 'Detection').trim();
    const unit = (appState.voiceUnitKeyword || 'clicks').trim();
    btnTestVoiceSettings.textContent = `AUDITION: "${prefix}! 11 o'clock, 3 ${unit}"`;
  }

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
      speakDetectionAnnouncement(`${prefix}! 11 o'clock, 3 ${unit}`);
    });
  });

  updateAuditionButtonText();

  btnTestVoiceSettings?.addEventListener('click', () => {
    const prefix = (appState.voiceAlertKeyword || 'Detection').trim();
    const unit = (appState.voiceUnitKeyword || 'clicks').trim();
    speakDetectionAnnouncement(`${prefix}! 11 o'clock, 3 ${unit}`);
  });

  sliderHeatmapSens.addEventListener('input', (e) => {
    const sens = Number(e.target.value) || 60;
    valHeatmapSens.textContent = `${sens}%`;
    updateState({ heatmapSensitivity: sens });
    saveSettings(appState);
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
  subscribeState((state) => {
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

      screenLive.classList.toggle('hidden', !isLive);
      if (screenSettings) screenSettings.classList.toggle('hidden', !isSettings);
      if (screenReticle) screenReticle.classList.toggle('hidden', !isReticle);
      if (screenController) screenController.classList.toggle('hidden', !isController);
      btnToggleOptions?.classList.toggle('radar-btn-active', isSettings);
    }
    btnTogglePip.classList.toggle('radar-btn-active', state.pipEnabled);
    if (btnToggleOverlayTop) {
      btnToggleOverlayTop.classList.toggle('radar-btn-active', state.overlayEnabled);
    }
    btnToggleHeatmap.classList.toggle('radar-btn-active', state.heatmapEnabled);
    syncVoiceToggleUI(Boolean(state.heatmapSpeechEnabled));
    btnToggleHud.classList.toggle('radar-btn-active', state.hudOpen);

    btnToggleBuffer.classList.toggle('radar-btn-active', state.bufferEnabled);
    bufferDot.className = state.bufferEnabled ? 'status-dot' : 'status-dot status-dot-off';
    bufferText.textContent = state.bufferEnabled
      ? `${Math.round(state.bufferedSeconds)}s / ${state.bufferMaxSeconds}s`
      : 'RAM OFF';

    // Update Memory Availability Meter in Settings
    valBufferResolution.textContent = `${state.streamWidth}×${state.streamHeight}`;
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
    mainZoomReset.classList.toggle('hidden', state.mainZoom <= 1.01);

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
    if (liveActionBanner && state.lastGamepadAction) {
      liveActionBanner.textContent = state.lastGamepadAction;
    }


  });
}
