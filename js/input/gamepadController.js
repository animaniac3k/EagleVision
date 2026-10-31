/**
 * PS4 / Bluetooth Gamepad Controller
 *
 * Integrates:
 * 1. Native Chrome WebHID API (Direct Bluetooth HID report stream for Sony DualShock 4)
 *    - Bypasses Windows Bluetooth DirectInput XInput limitations
 *    - Zero external software or driver installation needed
 *    - Persistent authorization across reloads via navigator.hid.getDevices()
 * 2. HTML5 Gamepad API fallback (for USB-connected controllers, Xbox, and XInput emulators)
 */
import { appState, updateState } from '../state.js';
import { isSplashScreenActive, dismissSplashScreen } from '../ui/splashScreen.js';

let activeHIDDevice = null;
let webHIDConnected = false;
let webHIDLastReportTime = 0;
let prevButtonStates = {};
let latestAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
let currentActionState = {};
let rafId = null;
let consecutiveNullFrames = 0;

const DEADZONE = 0.16;
const ROI_SPEED = 0.015;
const PAN_SPEED = 0.018;

const ROLES = [
  'cross', 'circle', 'square', 'triangle',
  'l1', 'r1', 'l2', 'r2',
  'dpad-up', 'dpad-down', 'dpad-left', 'dpad-right',
  'share', 'options', 'l3', 'r3',
  'ps', 'touchpad'
];

const SONY_DS4_FILTERS = [
  { vendorId: 0x054c, productId: 0x05c4 }, // DualShock 4 Gen 1
  { vendorId: 0x054c, productId: 0x09cc }, // DualShock 4 Gen 2 (CUH-ZCT2)
  { vendorId: 0x054c }                     // Generic Sony Interactive Entertainment HID
];

function updateGamepadUI(connected, text) {
  const dot = document.getElementById('gamepadStatusDot');
  const status = document.getElementById('gamepadStatusText');
  if (dot) dot.classList.toggle('connected', connected);
  if (status) status.textContent = text;
}

export function initGamepadController() {
  // 1. Immediately start polling & frame loop
  startFrameLoop();

  // 2. Check for previously authorized WebHID devices (persistent across reloads)
  autoReconnectWebHID();

  // 3. Listen to standard HTML5 Gamepad API connection events (for USB / Xbox)
  window.addEventListener('gamepadconnected', (e) => {
    const pad = e.gamepad;
    console.log(`[Gamepad API] Connected: "${pad.id}" (index: ${pad.index})`);
    if (!webHIDConnected) {
      const formatted = formatControllerName(pad.id);
      updateState({
        gamepadConnected: true,
        gamepadName: pad.id,
        lastGamepadAction: `CONNECTED: ${formatted}`
      });
      updateGamepadUI(true, formatted);
    }
  });

  window.addEventListener('gamepaddisconnected', (e) => {
    console.log(`[Gamepad API] Disconnected: "${e.gamepad.id}"`);
    if (!webHIDConnected) {
      const getPads = navigator.getGamepads || navigator.webkitGetGamepads;
      const remaining = getPads ? Array.from(getPads.call(navigator) || []).filter(Boolean) : [];
      if (!remaining.length) {
        updateState({
          gamepadConnected: false,
          gamepadName: '',
          lastGamepadAction: 'DISCONNECTED'
        });
        updateGamepadUI(false, 'DISCONNECTED (PRESS ANY BUTTON)');
      }
    }
  });

  // 4. Hook up "PAIR PS4 BT" WebHID button in Settings
  const btnConnectHID = document.getElementById('btnConnectWebHID');
  if (btnConnectHID) {
    btnConnectHID.addEventListener('click', async (e) => {
      e.stopPropagation();
      await requestWebHIDDualShock4();
    });
  }

  // 5. SCAN button in Settings
  const btnScan = document.getElementById('btnDetectGamepad');
  if (btnScan) {
    btnScan.addEventListener('click', (e) => {
      e.stopPropagation();
      window.focus();

      if (webHIDConnected && activeHIDDevice) {
        const name = activeHIDDevice.productName || 'Sony PS4 Wireless Controller';
        updateState({
          gamepadConnected: true,
          gamepadName: name,
          lastGamepadAction: `ACTIVE: ${name} (WebHID BT)`
        });
        updateGamepadUI(true, `${name} (BT)`);
        return;
      }

      const getPads = navigator.getGamepads || navigator.webkitGetGamepads;
      const raw = getPads ? Array.from(getPads.call(navigator) || []).filter((p) => p !== null && p !== undefined) : [];
      if (raw.length > 0) {
        const p = raw[0];
        const formatted = formatControllerName(p.id);
        updateState({
          gamepadConnected: true,
          gamepadName: p.id,
          lastGamepadAction: `DETECTED: ${formatted}`
        });
        updateGamepadUI(true, formatted);
      } else {
        const actionEl = document.getElementById('gamepadActionText');
        const hint = 'FOR BT PS4: CLICK "PAIR PS4 BT" TO CONNECT DIRECTLY';
        updateState({ lastGamepadAction: hint });
        if (actionEl) actionEl.textContent = hint;
      }
    });
  }
}

/**
 * Request user approval via Chrome's native security device picker for Sony PS4 DualShock 4
 */
export async function requestWebHIDDualShock4() {
  if (!('hid' in navigator)) {
    const msg = 'WebHID is not supported in this browser. Please use Chrome or Edge for direct Bluetooth PS4 connection.';
    console.warn(msg);
    alert(msg);
    return;
  }

  try {
    const actionEl = document.getElementById('gamepadActionText');
    if (actionEl) actionEl.textContent = 'CHOOSE "WIRELESS CONTROLLER" IN CHROME PROMPT...';

    const devices = await navigator.hid.requestDevice({
      filters: SONY_DS4_FILTERS
    });

    if (!devices || devices.length === 0) {
      if (actionEl) actionEl.textContent = 'PAIRING CANCELLED';
      return;
    }

    await setupWebHIDDevice(devices[0]);
  } catch (err) {
    console.error('[WebHID Request Error]', err);
    const actionEl = document.getElementById('gamepadActionText');
    if (actionEl) actionEl.textContent = `WEBHID ERROR: ${err.message || 'FAILED'}`;
  }
}

/**
 * Checks if user has already granted permission to Sony controller in prior sessions
 */
async function autoReconnectWebHID() {
  if (!('hid' in navigator)) return;
  try {
    const devices = await navigator.hid.getDevices();
    const ds4 = devices.find((d) => d.vendorId === 0x054c);
    if (ds4) {
      console.log('[WebHID] Found pre-authorized controller:', ds4.productName);
      await setupWebHIDDevice(ds4);
    }
  } catch (err) {
    console.warn('[WebHID Auto-reconnect Error]', err);
  }
}

/**
 * Opens WebHID device stream and registers report listener
 */
async function setupWebHIDDevice(device) {
  try {
    if (!device.opened) {
      await device.open();
    }
    activeHIDDevice = device;
    webHIDConnected = true;
    webHIDLastReportTime = performance.now();

    const name = device.productName || 'Sony PS4 Wireless Controller';
    console.log(`[WebHID] Active: ${name} (VID: 0x${device.vendorId.toString(16)}, PID: 0x${device.productId.toString(16)})`);

    updateState({
      gamepadConnected: true,
      gamepadName: name,
      lastGamepadAction: `READY: ${name} (WebHID BT)`
    });
    updateGamepadUI(true, `${name} (BT)`);

    device.removeEventListener('inputreport', handleWebHIDInputReport);
    device.addEventListener('inputreport', handleWebHIDInputReport);

    navigator.hid.addEventListener('disconnect', (event) => {
      if (event.device === activeHIDDevice) {
        console.log('[WebHID] Device disconnected');
        activeHIDDevice = null;
        webHIDConnected = false;
        updateState({
          gamepadConnected: false,
          gamepadName: '',
          lastGamepadAction: 'DISCONNECTED'
        });
        updateGamepadUI(false, 'DISCONNECTED (PRESS ANY BUTTON)');
      }
    });
  } catch (err) {
    console.error('[WebHID Setup Error]', err);
    updateGamepadUI(false, 'DEVICE BUSY (CLOSE JOY.CPL & RETRY)');
    const actionEl = document.getElementById('gamepadActionText');
    if (actionEl) actionEl.textContent = 'DEVICE BUSY: CLOSE JOY.CPL & CLICK "PAIR PS4 BT" AGAIN';
  }
}

/**
 * Decodes Sony DualShock 4 HID input reports directly over Bluetooth (Report 0x11 / 0x31) and USB (0x01)
 */
function handleWebHIDInputReport(event) {
  const { data, reportId } = event;
  webHIDLastReportTime = performance.now();

  let offset = 0;
  if (reportId === 0x11 || reportId === 0x31) {
    // Bluetooth extended report: byte 0 is header/flags, byte 1..4 are thumbstick axes
    offset = 1;
  } else if (reportId === 0x01) {
    // Standard USB / BT report
    offset = 0;
  } else if (data.byteLength >= 10) {
    // Fallback heuristic based on length
    offset = 1;
  }

  if (data.byteLength < offset + 6) return;

  // 1. Thumbstick axes (0..255 mapped to -1.0 .. +1.0 with deadzone)
  const rawLx = data.getUint8(offset + 0);
  const rawLy = data.getUint8(offset + 1);
  const rawRx = data.getUint8(offset + 2);
  const rawRy = data.getUint8(offset + 3);

  const lx = applyDeadzone((rawLx - 128) / 128);
  const ly = applyDeadzone((rawLy - 128) / 128);
  const rx = applyDeadzone((rawRx - 128) / 128);
  const ry = applyDeadzone((rawRy - 128) / 128);
  latestAxes = { lx, ly, rx, ry };

  // 2. Buttons Byte 1: D-pad (bits 0-3) + Shape Buttons (bits 4-7)
  const b1 = data.getUint8(offset + 4);
  const dpad = b1 & 0x0f;

  const dpadUp = dpad === 0 || dpad === 1 || dpad === 7;
  const dpadRight = dpad === 1 || dpad === 2 || dpad === 3;
  const dpadDown = dpad === 3 || dpad === 4 || dpad === 5;
  const dpadLeft = dpad === 5 || dpad === 6 || dpad === 7;

  const square = Boolean(b1 & 0x10);
  const cross = Boolean(b1 & 0x20);
  const circle = Boolean(b1 & 0x40);
  const triangle = Boolean(b1 & 0x80);

  // 3. Buttons Byte 2: Bumpers, Triggers, Share, Options, L3, R3
  const b2 = data.getUint8(offset + 5);
  const l1 = Boolean(b2 & 0x01);
  const r1 = Boolean(b2 & 0x02);
  const l2 = Boolean(b2 & 0x04);
  const r2 = Boolean(b2 & 0x08);
  const share = Boolean(b2 & 0x10);
  const options = Boolean(b2 & 0x20);
  const l3 = Boolean(b2 & 0x40);
  const r3 = Boolean(b2 & 0x80);

  // 4. Buttons Byte 3: PS Button & Touchpad Click
  let ps = false;
  let touchpad = false;
  if (data.byteLength > offset + 6) {
    const b3 = data.getUint8(offset + 6);
    ps = Boolean(b3 & 0x01);
    touchpad = Boolean(b3 & 0x02);
  }

  const actionState = {
    cross, circle, square, triangle,
    l1, r1, l2, r2,
    'dpad-up': dpadUp,
    'dpad-down': dpadDown,
    'dpad-left': dpadLeft,
    'dpad-right': dpadRight,
    share, options, l3, r3,
    ps, touchpad
  };

  dispatchControllerInputs(actionState);
}

/**
 * Continuous Animation Frame Loop:
 * - Executes smooth analog stick updates
 * - Polls Gamepad API if WebHID is not streaming
 * - Updates Settings diagnostics and button monitors
 */
function startFrameLoop() {
  if (rafId) return;

  function loop() {
    try {
      const now = performance.now();
      const isWebHIDActive = webHIDConnected && (now - webHIDLastReportTime < 500);

      if (isWebHIDActive) {
        // Continuous stick motion driven by WebHID
        applyStickMotion(latestAxes.lx, latestAxes.ly, latestAxes.rx, latestAxes.ry);
        updateSettingsDiagnostics('webhid', 1);
      } else {
        // Fallback to HTML5 Gamepad API
        pollGamepadAPI();
      }
    } catch (err) {
      console.warn('[Gamepad Frame Error]', err);
    }
    rafId = requestAnimationFrame(loop);
  }

  rafId = requestAnimationFrame(loop);
}

/**
 * Polls standard HTML5 Gamepad API (for USB controllers or XInput)
 */
function pollGamepadAPI() {
  const getPads = navigator.getGamepads || navigator.webkitGetGamepads;
  if (!getPads) return;

  const rawPads = getPads.call(navigator) || [];
  const validPads = Array.from(rawPads).filter((p) => p !== null && p !== undefined);

  updateSettingsDiagnostics('gamepad_api', validPads.length);

  const pad = validPads.length > 0 ? validPads[0] : null;

  if (!pad) {
    consecutiveNullFrames++;
    if (consecutiveNullFrames > 60 && appState.gamepadConnected && !webHIDConnected) {
      updateState({
        gamepadConnected: false,
        gamepadName: '',
        lastGamepadAction: 'DISCONNECTED (PRESS ANY BUTTON)'
      });
      updateGamepadUI(false, 'DISCONNECTED (PRESS ANY BUTTON)');
    }
    return;
  }

  consecutiveNullFrames = 0;

  if (!appState.gamepadConnected && !webHIDConnected) {
    const formatted = formatControllerName(pad.id);
    updateState({
      gamepadConnected: true,
      gamepadName: pad.id,
      lastGamepadAction: `READY: ${formatted}`
    });
    updateGamepadUI(true, formatted);
  }

  // 1. Gather all normalized action states from Gamepad API
  const actionState = {};
  ROLES.forEach((r) => {
    actionState[r] = getGamepadApiActionDown(pad, r);
  });

  // 2. Analog Sticks
  const axes = pad.axes || [];
  const lx = axes.length >= 1 ? applyDeadzone(axes[0]) : 0;
  const ly = axes.length >= 2 ? applyDeadzone(axes[1]) : 0;
  const { rx, ry } = getGamepadApiRightStick(pad);
  latestAxes = { lx, ly, rx, ry };

  applyStickMotion(lx, ly, rx, ry);
  dispatchControllerInputs(actionState);
}

/**
 * Applies smooth thumbstick movement frame by frame
 */
function applyStickMotion(lx, ly, rx, ry) {
  // Left Stick: Moves ROI Target Crosshair (roiX, roiY) in live mode
  if (appState.currentScreen === 'live' && (lx !== 0 || ly !== 0)) {
    let nx = Math.max(0.04, Math.min(0.96, appState.roiX + lx * ROI_SPEED));
    let ny = Math.max(0.04, Math.min(0.96, appState.roiY + ly * ROI_SPEED));
    updateState({
      roiX: nx,
      roiY: ny,
      pipEnabled: true,
      roiTargetVisible: true
    });
  }

  // Right Stick: Pans Main View when zoomed in (>1.0x) in live mode
  if (appState.currentScreen === 'live' && appState.mainZoom > 1.01 && (rx !== 0 || ry !== 0)) {
    const maxPan = Math.max(0, (1 - 1 / appState.mainZoom) / 2);
    const nx = Math.max(-maxPan, Math.min(maxPan, appState.mainPanX + rx * PAN_SPEED));
    const ny = Math.max(-maxPan, Math.min(maxPan, appState.mainPanY + ry * PAN_SPEED));
    updateState({ mainPanX: nx, mainPanY: ny });
  }
}

/**
 * Dispatches button actions and updates UI monitors
 */
function dispatchControllerInputs(actionState) {
  currentActionState = actionState;

  // 1. Silently dismiss Splash Screen if user presses any button
  if (isSplashScreenActive()) {
    const anyPressed = ROLES.some((r) => actionState[r]);
    if (anyPressed) {
      dismissSplashScreen('gamepad');
    }
    return;
  }

  // 2. Live monitor in Settings screen
  if (appState.currentScreen === 'settings') {
    ROLES.forEach((r) => {
      const badge = document.querySelector(`.gp-badge[data-gp="${r}"]`);
      if (badge) {
        badge.classList.toggle('gp-pressed', Boolean(actionState[r]));
      }
    });

    const activeRoles = ROLES.filter((r) => actionState[r]).map((r) => r.toUpperCase()).join(' + ');
    if (activeRoles) {
      const actionEl = document.getElementById('gamepadActionText');
      if (actionEl) actionEl.textContent = `ACTIVE: ${activeRoles}`;
    }
  }

  // Edge-trigger helper
  function isJustPressed(role) {
    const isDown = Boolean(actionState[role]);
    const wasDown = Boolean(prevButtonStates[role]);
    return isDown && !wasDown;
  }

  const screen = appState.currentScreen;

  // Cross (✕)
  if (isJustPressed('cross')) {
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

  // Circle (◯) - Universal Back / Return to Live Feed
  if (isJustPressed('circle')) {
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
      updateState({
        uiDecluttered: !appState.uiDecluttered,
        lastGamepadAction: 'BUTTON: CIRCLE (DECLUTTER TOGGLE)'
      });
    }
  }

  // Square (▢)
  if (isJustPressed('square')) {
    if (screen === 'gallery') {
      document.getElementById('btnGallerySlowMo')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (0.5x SLOW-MO)' });
    } else {
      document.getElementById('btnToggleOverlayTop')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (OVERLAY TOGGLE)' });
    }
  }

  // Triangle (△)
  if (isJustPressed('triangle')) {
    if (screen === 'gallery') {
      document.getElementById('btnToggleGalleryDrawer')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (CLIPS DRAWER)' });
    } else {
      document.getElementById('btnToggleHeatmap')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (HEATMAP TOGGLE)' });
    }
  }

  // L1 (Bumper)
  if (isJustPressed('l1')) {
    if (screen === 'gallery') {
      document.getElementById('galleryZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (VIDEO ZOOM -)' });
    } else {
      document.getElementById('mainZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (MAIN ZOOM -)' });
    }
  }

  // R1 (Bumper)
  if (isJustPressed('r1')) {
    if (screen === 'gallery') {
      document.getElementById('galleryZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (VIDEO ZOOM +)' });
    } else {
      document.getElementById('mainZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (MAIN ZOOM +)' });
    }
  }

  // L2 (Trigger) - Step Backward 1 Frame
  if (isJustPressed('l2')) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    }
  }

  // R2 (Trigger) - Step Forward 1 Frame
  if (isJustPressed('r2')) {
    if (screen === 'gallery') {
      document.getElementById('btnGalleryStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    }
  }

  // Share - Open / Close Settings Screen
  if (isJustPressed('share')) {
    if (screen === 'settings') {
      document.getElementById('btnSettingsBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SHARE (EXIT SETTINGS)' });
    } else {
      document.getElementById('btnToggleOptions')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SHARE (OPEN SETTINGS)' });
    }
  }

  // Options - Trigger Instant Replay
  if (isJustPressed('options')) {
    document.getElementById('btnReplay20s')?.click();
    updateState({ lastGamepadAction: 'BUTTON: OPTIONS (INSTANT REPLAY)' });
  }

  // L3 (Left Stick Click) - Recenter ROI Target
  if (isJustPressed('l3')) {
    updateState({
      roiX: 0.5,
      roiY: 0.5,
      lastGamepadAction: 'BUTTON: L3 (RECENTER ROI)'
    });
  }

  // R3 (Right Stick Click) - Reset Main Zoom 1:1
  if (isJustPressed('r3')) {
    document.getElementById('mainZoomReset')?.click();
    updateState({ lastGamepadAction: 'BUTTON: R3 (RESET ZOOM 1:1)' });
  }

  // D-Pad Up
  if (isJustPressed('dpad-up')) {
    if (screen === 'live') {
      document.getElementById('pipZoomPlus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: UP (WIN ZOOM +)' });
    }
  }

  // D-Pad Down
  if (isJustPressed('dpad-down')) {
    if (screen === 'live') {
      document.getElementById('pipZoomMinus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: DOWN (WIN ZOOM -)' });
    }
  }

  // D-Pad Left
  if (isJustPressed('dpad-left')) {
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

  // D-Pad Right
  if (isJustPressed('dpad-right')) {
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

  // PS Button - Toggle Declutter Mode
  if (isJustPressed('ps')) {
    updateState({
      uiDecluttered: !appState.uiDecluttered,
      lastGamepadAction: 'BUTTON: PS BUTTON (DECLUTTER TOGGLE)'
    });
  }

  // Save current states for edge detection in subsequent reports/frames
  ROLES.forEach((r) => {
    prevButtonStates[r] = actionState[r];
  });
}

function updateSettingsDiagnostics(backend, count) {
  if (appState.currentScreen !== 'settings') return;

  const focusEl = document.getElementById('gamepadFocusStatus');
  const slotEl = document.getElementById('gamepadSlotStatus');

  if (focusEl) {
    const isFocused = document.hasFocus();
    focusEl.textContent = isFocused ? 'PAGE FOCUS: ACTIVE ✓' : 'PAGE FOCUS: LOST ⚠ (CLICK PAGE)';
    focusEl.style.color = isFocused ? '#22c55e' : '#f59e0b';
  }

  if (slotEl) {
    if (backend === 'webhid') {
      slotEl.textContent = 'BACKEND: WEBHID BT CONNECTED ✓';
      slotEl.style.color = '#22c55e';
    } else if (count > 0) {
      slotEl.textContent = `BACKEND: GAMEPAD API (${count} CONNECTED ✓)`;
      slotEl.style.color = '#22c55e';
    } else {
      slotEl.textContent = 'SLOTS: 0 DETECTED (CLICK "PAIR PS4 BT")';
      slotEl.style.color = '#94a3b8';
    }
  }
}

// Helpers for HTML5 Gamepad API fallback
function formatControllerName(id) {
  if (!id) return 'Controller';
  const lower = id.toLowerCase();
  if (lower.includes('054c') || lower.includes('wireless controller') || lower.includes('dualshock') || lower.includes('ps4')) {
    return 'Sony PS4 Wireless Controller';
  }
  return id.split('(')[0].trim() || 'Controller';
}

function applyDeadzone(v) {
  if (Math.abs(v) < DEADZONE) return 0;
  return v > 0 ? (v - DEADZONE) / (1 - DEADZONE) : (v + DEADZONE) / (1 - DEADZONE);
}

function isDirectInputDS4(pad) {
  if (pad.mapping === 'standard') return false;
  const id = (pad.id || '').toLowerCase();
  return id.includes('054c') || id.includes('wireless controller') || id.includes('dualshock') || id.includes('sony') || id.includes('ps4');
}

function isButtonPressed(pad, btnIndex) {
  if (!pad.buttons || !pad.buttons[btnIndex]) return false;
  const btn = pad.buttons[btnIndex];
  return Boolean(btn.pressed || btn.value > 0.45);
}

function checkDpadAxis(pad, dir) {
  if (!pad.axes) return false;
  for (let a = 4; a < pad.axes.length; a++) {
    const val = pad.axes[a];
    if (val === undefined || Math.abs(val) > 1.05) continue;
    if (dir === 'up' && ((val >= -1.05 && val <= -0.65) || (val >= 0.95 && val <= 1.05))) return true;
    if (dir === 'right' && val >= -0.75 && val <= -0.15) return true;
    if (dir === 'down' && val >= -0.20 && val <= 0.45) return true;
    if (dir === 'left' && val >= 0.40 && val <= 0.95) return true;
  }
  return false;
}

function getGamepadApiActionDown(pad, role) {
  const isDInput = isDirectInputDS4(pad);

  switch (role) {
    case 'cross':
      return isDInput ? isButtonPressed(pad, 1) : isButtonPressed(pad, 0);
    case 'circle':
      return isDInput ? isButtonPressed(pad, 2) : isButtonPressed(pad, 1);
    case 'square':
      return isDInput ? isButtonPressed(pad, 0) : isButtonPressed(pad, 2);
    case 'triangle':
      return isButtonPressed(pad, 3);
    case 'l1':
      return isButtonPressed(pad, 4);
    case 'r1':
      return isButtonPressed(pad, 5);
    case 'l2':
      return isButtonPressed(pad, 6);
    case 'r2':
      return isButtonPressed(pad, 7);
    case 'share':
      return isButtonPressed(pad, 8);
    case 'options':
      return isButtonPressed(pad, 9);
    case 'l3':
      return isButtonPressed(pad, 10);
    case 'r3':
      return isButtonPressed(pad, 11);
    case 'dpad-up':
      if (isButtonPressed(pad, 12)) return true;
      return checkDpadAxis(pad, 'up');
    case 'dpad-down':
      if (isButtonPressed(pad, 13)) return true;
      return checkDpadAxis(pad, 'down');
    case 'dpad-left':
      if (isButtonPressed(pad, 14)) return true;
      return checkDpadAxis(pad, 'left');
    case 'dpad-right':
      if (isButtonPressed(pad, 15)) return true;
      return checkDpadAxis(pad, 'right');
    case 'ps':
      return isDInput ? isButtonPressed(pad, 12) : isButtonPressed(pad, 16);
    case 'touchpad':
      return isDInput ? isButtonPressed(pad, 13) : isButtonPressed(pad, 17);
    default:
      return false;
  }
}

function getGamepadApiRightStick(pad) {
  const isDInput = isDirectInputDS4(pad);
  const rx = applyDeadzone(pad.axes[2] || 0);
  let ryVal = 0;
  if (isDInput && pad.axes.length >= 6) {
    ryVal = pad.axes[5];
  } else if (pad.axes.length >= 4) {
    ryVal = pad.axes[3];
  }
  const ry = applyDeadzone(ryVal || 0);
  return { rx, ry };
}
