/**
 * EagleVision Main Entry Point
 */
import { appState, updateState } from './state.js';
import { loadSavedSettings } from './storage/settingsStore.js';
import { startCameraStream } from './camera/streamManager.js';
import { initCompositor } from './renderer/compositor.js';
import { initOverlayManager } from './renderer/overlayManager.js';
import { initZoomWindow } from './renderer/zoomWindow.js';
import { startMemoryBuffer } from './recorder/memoryRingBuffer.js';
import { initInstantReplay } from './recorder/instantReplay.js';
import { initHudController } from './ui/hudController.js';
import { initSidebarAndTopControls } from './ui/sidebarControls.js';
import { initVideoBrowser } from './ui/videoBrowser.js';
import { initRingController } from './ui/ringController.js';

async function bootstrapApp() {
  // 1. Restore saved user settings
  const saved = loadSavedSettings();
  if (saved) {
    updateState(saved);
  }

  // 2. Initialize Camera Stream (USB Camera or Test Signal fallback)
  const videoEl = document.getElementById('cameraVideoEl');
  await startCameraStream(videoEl, 'auto');

  // 3. Start 60fps Dual-Canvas Compositor (Main Feed + PiP Zoom Window)
  const mainCanvas = initCompositor(videoEl);

  // 4. Initialize Overlays, Draggable ROI Target & Zoom Window, HUD, Controls, and 5-Button BT Ring
  initOverlayManager();
  initZoomWindow();
  initHudController();
  initInstantReplay();
  await initSidebarAndTopControls(videoEl, mainCanvas);
  await initVideoBrowser();
  initRingController();

  // 5. Start 20-Second Rolling In-Memory Video Buffer if enabled
  if (appState.bufferEnabled) {
    startMemoryBuffer(videoEl);
  }

  // 6. Request Screen WakeLock on Chromebook / Android so display doesn't dim
  if ('wakeLock' in navigator) {
    navigator.wakeLock.request('screen').catch(() => {});
  }

  // 7. Register PWA Service Worker
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

window.addEventListener('DOMContentLoaded', bootstrapApp);
