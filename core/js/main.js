/**
 * SPOTR Main Entry Point
 */
import { appState, updateState, subscribeState, APP_VERSION } from './state.js';
import { loadSavedSettings } from './storage/settingsStore.js';
import { startCameraStream } from './camera/streamManager.js';
import { initCompositor, preloadVoiceAudio } from './renderer/compositor.js';
import { initOverlayManager } from './renderer/overlayManager.js';
import { initZoomWindow } from './renderer/zoomWindow.js';
import { startMemoryBuffer } from './recorder/memoryRingBuffer.js';
import { initInstantReplay } from './recorder/instantReplay.js';
import { initHudController } from './ui/hudController.js';
import { initSidebarAndTopControls } from './ui/sidebarControls.js';
import { initVideoBrowser } from './ui/videoBrowser.js';
import { initDetectionsScreen } from './ui/detectionsScreen.js';
import { initReticleScreen } from './ui/reticleScreen.js';
import { initCalibrationScreen } from './ui/calibrationScreen.js';
import { initControllerScreen } from './ui/controllerScreen.js';
import { initRingController } from './ui/ringController.js';
import { initGamepadController } from './input/gamepadController.js';
import { initSplashScreen } from './ui/splashScreen.js';

async function bootstrapApp() {
  window.__spotrBootstrapped = true;
  // 0. Initialize SPOTR Tactical Splash Screen (dismisses after 1.1s or silently on Space/controller/tap)
  initSplashScreen();

  // 1. Restore saved user settings
  const saved = loadSavedSettings();
  if (saved) {
    updateState(saved);
  }

  const videoEl = document.getElementById('cameraVideoEl');

  // 2. Start Dual-Canvas Compositor (Main Feed + PiP Zoom Window)
  const mainCanvas = initCompositor(videoEl);

  // Lazy-decode studio female voice sprite only if voice callouts are already enabled (saves 19-38MB RAM at boot)
  if (appState.heatmapSpeechEnabled) {
    preloadVoiceAudio();
  }

  // 3. Initialize ALL UI screens, controllers & event listeners IMMEDIATELY (synchronously)
  // so all buttons, sliders, screens and shortcuts are interactive from the first millisecond
  initOverlayManager();
  initZoomWindow();
  initHudController();
  initInstantReplay();
  initReticleScreen();
  initCalibrationScreen();
  initControllerScreen();
  initRingController();
  initGamepadController();
  initSidebarAndTopControls(videoEl, mainCanvas);
  initVideoBrowser();
  initDetectionsScreen(subscribeState);

  // 4. Handle direct screen and testing query parameters if specified (after listeners are wired)
  const params = new URLSearchParams(window.location.search);
  const targetScreen = params.get('screen');
  if (['controller', 'reticle', 'calibration', 'settings', 'gallery'].includes(targetScreen)) {
    updateState({ currentScreen: targetScreen });
  }
  if (params.get('reticleClicks') || params.get('reticleCenter')) {
    const patch = {};
    if (params.get('reticleClicks')) {
      const parsedClicks = parseInt(params.get('reticleClicks'), 10);
      if (Number.isFinite(parsedClicks)) {
        patch.clickCount = Math.min(30, Math.max(2, parsedClicks));
      }
    }
    if (params.get('reticleCenter')) {
      const validStyles = ['empty', 'dot', 'cross', 'chevron'];
      const requestedStyle = params.get('reticleCenter');
      if (validStyles.includes(requestedStyle)) {
        patch.centerStyle = requestedStyle;
      }
    }
    if (Object.keys(patch).length > 0) {
      updateState({ reticleConfig: Object.assign({}, appState.reticleConfig, patch) });
    }
  }

  // 4. Initialize Camera Stream (USB Camera or Test Signal fallback) asynchronously in background
  startCameraStream(videoEl, 'auto').then(() => {
    window.__spotrRefreshCameras?.();
    if (appState.bufferEnabled) {
      startMemoryBuffer(videoEl);
    }
  }).catch((err) => {
    console.warn('Camera stream error, fallback active:', err);
  });

  // 5. Request Screen WakeLock on Chromebook / Android & re-acquire after visibility changes
  if ('wakeLock' in navigator) {
    let wakeLockSentinel = null;
    const requestWakeLock = () => {
      if (document.visibilityState !== 'visible') return;
      navigator.wakeLock.request('screen').then((sentinel) => {
        wakeLockSentinel = sentinel;
      }).catch(() => {});
    };
    requestWakeLock();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!wakeLockSentinel || wakeLockSentinel.released)) {
        requestWakeLock();
      }
    });
  }

  // 6. Populate Setup version badges & register PWA Service Worker
  document.querySelectorAll('.setup-version-badge').forEach((el) => {
    el.textContent = APP_VERSION;
    el.title = `SPOTR Build ${APP_VERSION}`;
  });

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    const hadController = Boolean(navigator.serviceWorker.controller);
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      // Only skip auto-reload if the shooter has active recorded hits on screen
      const hasLoggedHits = Array.isArray(appState.detectionHits) && appState.detectionHits.length > 0;
      if (hadController && !reloading && !hasLoggedHits) {
        reloading = true;
        window.location.reload();
      }
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

window.addEventListener('DOMContentLoaded', bootstrapApp);
