/**
 * PS4 / Bluetooth Gamepad Controller
 *
 * Integrates HTML5 Gamepad API for Sony DualShock 4 (PS4) and standard Bluetooth controllers.
 * Operates silently in the background without modifying the live interface.
 *
 * Mappings:
 * - Left Stick: Smoothly moves ROI Target Crosshair (accelerated analog control)
 * - Right Stick: Smoothly pans main camera stream when zoomed in (>1.0x)
 * - D-Pad Up / Down: Zoom Window (PiP) magnification (+ / -)
 * - D-Pad Left / Right: Main camera zoom (- / +) or Frame Step (-1 / +1) during playback
 * - Cross (X / Button 0): Play / Pause (in Replay / Gallery) or Cycle Remote Mode
 * - Circle (O / Button 1): Back to Live Feed (from Settings / Reticle / Gallery / Replay)
 * - Square ([] / Button 2): Toggle Overlay Reticle / Slow-Mo (in Gallery)
 * - Triangle (^ / Button 3): Toggle Micro-Change Heatmap / Toggle Clips Drawer (in Gallery)
 * - L1 / R1: Zoom Out / Zoom In
 * - L2 / R2: Step -1 Frame / Step +1 Frame (in Replay / Gallery)
 * - Options (Button 9): Instant Replay 20s (Auto-Save)
 * - Share (Button 8): Open / Close Settings Screen
 * - PS Button (Button 16): Toggle Declutter Mode
 * - L3 (Left Stick Click): Recenter ROI Target Crosshair to (0.5, 0.5)
 * - R3 (Right Stick Click): Reset Main Zoom to 1.0x (1:1)
 */
import { appState, updateState } from '../state.js';

let prevButtonStates = {};
let lastActionTime = 0;
let rafId = null;

const DEADZONE = 0.16;
const ROI_SPEED = 0.015;
const PAN_SPEED = 0.018;

export function initGamepadController() {
  window.addEventListener('gamepadconnected', (e) => {
    const pad = e.gamepad;
    console.log(`Gamepad connected: ${pad.id} (index: ${pad.index})`);
    updateState({
      gamepadConnected: true,
      gamepadName: pad.id,
      lastGamepadAction: `CONNECTED: ${pad.id.split('(')[0].trim() || 'Controller'}`
    });
    startPolling();
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    console.log(`Gamepad disconnected: ${e.gamepad.id}`);
    const remaining = Array.from(navigator.getGamepads ? navigator.getGamepads() : []).filter(Boolean);
    if (!remaining.length) {
      updateState({
        gamepadConnected: false,
        gamepadName: '',
        lastGamepadAction: 'DISCONNECTED'
      });
      stopPolling();
    }
  });

  // Check if a controller is already connected at load
  const initialPads = navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean) : [];
  if (initialPads.length) {
    const p = initialPads[0];
    updateState({
      gamepadConnected: true,
      gamepadName: p.id,
      lastGamepadAction: `READY: ${p.id.split('(')[0].trim() || 'Controller'}`
    });
    startPolling();
  }
}

function startPolling() {
  if (rafId) return;
  function pollLoop() {
    pollGamepadState();
    rafId = requestAnimationFrame(pollLoop);
  }
  rafId = requestAnimationFrame(pollLoop);
}

function stopPolling() {
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = null;
  }
}

function applyDeadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  return v > 0 ? (v - DEADZONE) / (1 - DEADZONE) : (v + DEADZONE) / (1 - DEADZONE);
}

function pollGamepadState() {
  if (!navigator.getGamepads) return;
  const gamepads = navigator.getGamepads();
  const pad = gamepads ? Array.from(gamepads).find((p) => p && p.connected) : null;

  if (!pad) {
    if (appState.gamepadConnected) {
      updateState({ gamepadConnected: false });
    }
    return;
  }

  if (!appState.gamepadConnected) {
    updateState({ gamepadConnected: true, gamepadName: pad.id });
  }

  const buttons = pad.buttons;
  const axes = pad.axes;
  const padKey = pad.index;
  if (!prevButtonStates[padKey]) {
    prevButtonStates[padKey] = {};
  }
  const prevButtons = prevButtonStates[padKey];

  // Helper for single-press edge trigger
  function isJustPressed(btnIndex) {
    const isDown = buttons[btnIndex] && buttons[btnIndex].pressed;
    const wasDown = Boolean(prevButtons[btnIndex]);
    prevButtons[btnIndex] = isDown;
    return isDown && !wasDown;
  }

  // 1. ANALOG STICKS (Smooth frame-by-frame movement)
  // Left Stick: Moves ROI Target Crosshair (roiX, roiY)
  if (axes.length >= 2 && appState.currentScreen === 'live') {
    const lx = applyDeadzone(axes[0]);
    const ly = applyDeadzone(axes[1]);
    if (lx !== 0 || ly !== 0) {
      let nx = Math.max(0.04, Math.min(0.96, appState.roiX + lx * ROI_SPEED));
      let ny = Math.max(0.04, Math.min(0.96, appState.roiY + ly * ROI_SPEED));
      updateState({
        roiX: nx,
        roiY: ny,
        pipEnabled: true,
        roiTargetVisible: true
      });
    }
  }

  // Right Stick: Pans Main View when zoomed in (>1.0x)
  if (axes.length >= 4 && appState.currentScreen === 'live' && appState.mainZoom > 1.01) {
    const rx = applyDeadzone(axes[2]);
    const ry = applyDeadzone(axes[3]);
    if (rx !== 0 || ry !== 0) {
      const maxPan = Math.max(0, (1 - 1 / appState.mainZoom) / 2);
      const nx = Math.max(-maxPan, Math.min(maxPan, appState.mainPanX + rx * PAN_SPEED));
      const ny = Math.max(-maxPan, Math.min(maxPan, appState.mainPanY + ry * PAN_SPEED));
      updateState({ mainPanX: nx, mainPanY: ny });
    }
  }

  // 2. BUTTON INPUTS WITH EDGE TRIGGERING
  const screen = appState.currentScreen;

  // Button 0: Cross (X)
  if (isJustPressed(0)) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryPlayPause')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CROSS (PLAY/PAUSE)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayPlayPause')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CROSS (PLAY/PAUSE)' });
    } else {
      document.getElementById('ringHudPill')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CROSS (MODE CYCLE)' });
    }
  }

  // Button 1: Circle (O) - Universal Back / Return to Live Feed
  if (isJustPressed(1)) {
    if (screen === 'gallery') {
      document.getElementById('btnBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CIRCLE (LIVE FEED)' });
    } else if (screen === 'settings') {
      document.getElementById('btnSettingsBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CIRCLE (LIVE FEED)' });
    } else if (screen === 'reticle') {
      document.getElementById('btnReticleBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CIRCLE (LIVE FEED)' });
    } else if (appState.replayActive) {
      document.getElementById('btnCloseReplay')?.click();
      updateState({ lastGamepadAction: 'BUTTON: CIRCLE (CLOSE REPLAY)' });
    } else {
      // On live screen, Circle toggles Declutter Mode
      updateState({
        uiDecluttered: !appState.uiDecluttered,
        lastGamepadAction: 'BUTTON: CIRCLE (DECLUTTER TOGGLE)'
      });
    }
  }

  // Button 2: Square ([])
  if (isJustPressed(2)) {
    if (screen === 'gallery') {
      document.getElementById('btnGallerySlowMo')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (0.5x SLOW-MO)' });
    } else {
      document.getElementById('btnToggleOverlayTop')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (OVERLAY TOGGLE)' });
    }
  }

  // Button 3: Triangle (^)
  if (isJustPressed(3)) {
    if (screen === 'gallery') {
      document.getElementById('btnToggleGalleryDrawer')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (CLIPS DRAWER)' });
    } else {
      document.getElementById('btnToggleHeatmap')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (HEATMAP TOGGLE)' });
    }
  }

  // Button 4: L1 (Bumper)
  if (isJustPressed(4)) {
    if (screen === 'gallery') {
      document.getElementById('galleryZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (VIDEO ZOOM -)' });
    } else {
      document.getElementById('mainZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (MAIN ZOOM -)' });
    }
  }

  // Button 5: R1 (Bumper)
  if (isJustPressed(5)) {
    if (screen === 'gallery') {
      document.getElementById('galleryZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (VIDEO ZOOM +)' });
    } else {
      document.getElementById('mainZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (MAIN ZOOM +)' });
    }
  }

  // Button 6: L2 (Left Trigger) - Step Backward 1 Frame
  if (isJustPressed(6)) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    }
  }

  // Button 7: R2 (Right Trigger) - Step Forward 1 Frame
  if (isJustPressed(7)) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    }
  }

  // Button 8: Share / Create - Open / Close Settings Screen
  if (isJustPressed(8)) {
    if (screen === 'settings') {
      document.getElementById('btnSettingsBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SHARE (EXIT SETTINGS)' });
    } else {
      document.getElementById('btnToggleOptions')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SHARE (OPEN SETTINGS)' });
    }
  }

  // Button 9: Options - Trigger Instant Replay (20s Auto-Save)
  if (isJustPressed(9)) {
    document.getElementById('btnReplay20s')?.click();
    updateState({ lastGamepadAction: 'BUTTON: OPTIONS (INSTANT REPLAY)' });
  }

  // Button 10: L3 (Left Stick Click) - Recenter ROI Target
  if (isJustPressed(10)) {
    updateState({
      roiX: 0.5,
      roiY: 0.5,
      lastGamepadAction: 'BUTTON: L3 (RECENTER ROI)'
    });
  }

  // Button 11: R3 (Right Stick Click) - Reset Main Zoom 1:1
  if (isJustPressed(11)) {
    document.getElementById('mainZoomReset')?.click();
    updateState({ lastGamepadAction: 'BUTTON: R3 (RESET ZOOM 1:1)' });
  }

  // D-PAD:
  // Button 12: D-Pad Up
  if (isJustPressed(12)) {
    if (screen === 'live') {
      document.getElementById('pipZoomPlus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: UP (WIN ZOOM +)' });
    }
  }

  // Button 13: D-Pad Down
  if (isJustPressed(13)) {
    if (screen === 'live') {
      document.getElementById('pipZoomMinus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: DOWN (WIN ZOOM -)' });
    }
  }

  // Button 14: D-Pad Left
  if (isJustPressed(14)) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStepBack')?.click();
      updateState({ lastGamepadAction: 'D-PAD: LEFT (STEP -1)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStepBack')?.click();
      updateState({ lastGamepadAction: 'D-PAD: LEFT (STEP -1)' });
    } else {
      document.getElementById('mainZoomMinus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: LEFT (MAIN ZOOM -)' });
    }
  }

  // Button 15: D-Pad Right
  if (isJustPressed(15)) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStep')?.click();
      updateState({ lastGamepadAction: 'D-PAD: RIGHT (STEP +1)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStep')?.click();
      updateState({ lastGamepadAction: 'D-PAD: RIGHT (STEP +1)' });
    } else {
      document.getElementById('mainZoomPlus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: RIGHT (MAIN ZOOM +)' });
    }
  }

  // Button 16: PS Button - Toggle Declutter Mode
  if (isJustPressed(16)) {
    updateState({
      uiDecluttered: !appState.uiDecluttered,
      lastGamepadAction: 'BUTTON: PS BUTTON (DECLUTTER TOGGLE)'
    });
  }
}
