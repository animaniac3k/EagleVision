/**
 * PS4 / Bluetooth Gamepad Controller
 *
 * Integrates:
 * 1. Native Chrome WebHID API (Direct Bluetooth HID report stream for Sony DualShock 4)
 *    - Sends Bluetooth initialization output report (0x11 with CRC32) to unlock full 78-byte telemetry & capacitive touchpad
 *    - Sets lightbar to SPOTR cyan (#22d3ee)
 *    - Decodes capacitive touchpad multi-touch coordinates for Virtual Mouse
 *    - Non-linear power curve for sticks (50-70% reduction at low end for micro-tick positioning)
 *    - L3 / R3 stick-click cycles GUI color schemes (◀ Prev / ▶ Next)
 *    - Options button opens/closes Settings; Share button triggers 20s Instant Replay
 * 2. HTML5 Gamepad API fallback (for USB-connected controllers, Xbox, and XInput emulators)
 */
import { appState, updateState } from '../state.js';
import { isSplashScreenActive, dismissSplashScreen } from '../ui/splashScreen.js';
import { applyThemeColor } from '../ui/sidebarControls.js';
import { saveSettings } from '../storage/settingsStore.js';

let activeHIDDevice = null;
let webHIDConnected = false;
let webHIDLastReportTime = 0;
let lastReportId = 0;
let lastReportLen = 0;
let hasSentInit = false;
let lastInitAttemptTime = 0;
let latestTouchInfo = { active: false, x: 0, y: 0 };

let prevButtonStates = {};
let latestAxes = { lx: 0, ly: 0, rx: 0, ry: 0 };
let currentActionState = {};
let rafId = null;
let consecutiveNullFrames = 0;

// Virtual Mouse State Variables
let vmCursorX = typeof window !== 'undefined' ? window.innerWidth / 2 : 500;
let vmCursorY = typeof window !== 'undefined' ? window.innerHeight / 2 : 400;
let vmLastTouchX = 0;
let vmLastTouchY = 0;
let vmLastTrackingId = -1;
let vmWasTouching = false;
let vmTouchStartTime = 0;
let vmTouchStartCursorX = 0;
let vmTouchStartCursorY = 0;
let vmHideTimeout = null;
let vmIsDragging = false;
let vmDragTargetEl = null;
let vmLastPhysicalClick = false;
let reticleStickLastXTime = 0;
let reticleStickLastYTime = 0;
let reticleStickRightXTime = 0;
let reticleStickRightYTime = 0;

// Stick Tuning: Power curve provides 50-70% reduction at low end for fine-tick adjustments
const DEADZONE = 0.16;
const BASE_ROI_SPEED = 0.012;
const BASE_PAN_SPEED = 0.014;

// Tactical GUI Color Schemes (Cycled via L3 / R3)
const GUI_THEMES = [
  { id: 'teal', name: 'Radar Teal', color: '#2dd4bf' },
  { id: 'green', name: 'Phosphor Green', color: '#22c55e' },
  { id: 'cyan', name: 'Sonar Cyan', color: '#38bdf8' },
  { id: 'amber', name: 'Avionics Amber', color: '#f59e0b' },
  { id: 'crimson', name: 'Night-Vision Crimson', color: '#f43f5e' },
  { id: 'silver', name: 'Monochrome Silver', color: '#e5e5e5' }
];

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

// Standard IEEE 802.3 CRC-32 Table for Bluetooth Output Reports
const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

function computeCRC32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xFF];
  }
  return (~crc) >>> 0;
}

function updateGamepadUI(connected, text) {
  const dot = document.getElementById('gamepadStatusDot');
  const status = document.getElementById('gamepadStatusText');
  if (dot) dot.classList.toggle('connected', connected);
  if (status) status.textContent = text;
}

export function initGamepadController() {
  startFrameLoop();
  autoReconnectWebHID();

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

  // Hook up "PAIR PS4 BT" WebHID button in Settings
  const btnConnectHID = document.getElementById('btnConnectWebHID');
  if (btnConnectHID) {
    btnConnectHID.addEventListener('click', async (e) => {
      e.stopPropagation();
      await requestWebHIDDualShock4();
    });
  }

  // SCAN button in Settings
  const btnScan = document.getElementById('btnDetectGamepad');
  if (btnScan) {
    btnScan.addEventListener('click', async (e) => {
      e.stopPropagation();
      window.focus();

      if (webHIDConnected && activeHIDDevice) {
        // Re-send Bluetooth initialization report to ensure full telemetry stream is active
        await sendDualShock4BluetoothInit(activeHIDDevice);
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
 * Sends Bluetooth Output Report 0x11 with valid CRC32 to unlock full 78-byte sensor & touchpad streaming
 */
async function sendDualShock4BluetoothInit(device) {
  try {
    // 79-byte Bluetooth output report frame
    // report[0]: 0xA2 (Bluetooth HID Data Output header / CRC32 seed)
    // report[1]: 0x11 (Output Report ID)
    // report[2]: 0xC4 = 0x80 (HID) | 0x40 (CRC32 enable) | 0x04 (4ms polling rate)
    // report[3]: 0x00 (Audio control)
    // report[4]: 0x07 (common.valid_flag0: 0x01 motor | 0x02 lightbar | 0x04 blink)
    // report[5]: 0x04 (common.valid_flag1: lightbar configure)
    const report = new Uint8Array(79);
    report[0] = 0xA2; // Bluetooth HID Data Output header
    report[1] = 0x11; // Report ID 0x11
    report[2] = 0xC4; // Hardware control: 0x80 (HID) | 0x40 (CRC32 enable) | 0x04 (4ms polling)
    report[3] = 0x00; // Audio control
    report[4] = 0x07; // Enable motor and lightbar
    report[5] = 0x04; // Enable lightbar setup

    // Lightbar color: SPOTR Cyan (#22d3ee)
    report[9] = 34;   // Red
    report[10] = 211; // Green
    report[11] = 238; // Blue

    // Calculate CRC32 over the first 75 bytes (report[0..74], including 0xA2 seed and 0x11 report ID)
    const crcVal = computeCRC32(report.subarray(0, 75));
    report[75] = crcVal & 0xFF;
    report[76] = (crcVal >>> 8) & 0xFF;
    report[77] = (crcVal >>> 16) & 0xFF;
    report[78] = (crcVal >>> 24) & 0xFF;

    // Send 77-byte payload excluding 0xA2 header and 0x11 report ID
    await device.sendReport(0x11, report.subarray(2));
    console.log('[WebHID] DualShock 4 Bluetooth 0x11 output report sent (telemetry & lightbar unlocked)!');
    hasSentInit = true;
  } catch (err) {
    console.warn('[WebHID] Bluetooth init report notice:', err);
    hasSentInit = false;
  }
}

/**
 * Opens WebHID device stream, unlocks full telemetry, and registers report listener
 */
async function setupWebHIDDevice(device) {
  try {
    if (!device.opened) {
      await device.open();
    }
    activeHIDDevice = device;
    webHIDConnected = true;
    webHIDLastReportTime = performance.now();
    hasSentInit = false;

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

    // Send output report to unlock extended report 0x11 mode
    await sendDualShock4BluetoothInit(device);
    device.receiveFeatureReport(0x02).catch(() => {});

    navigator.hid.addEventListener('disconnect', (event) => {
      if (event.device === activeHIDDevice) {
        console.log('[WebHID] Device disconnected');
        activeHIDDevice = null;
        webHIDConnected = false;
        hasSentInit = false;
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
 * Decodes Sony DualShock 4 HID input reports directly over Bluetooth and USB
 */
function handleWebHIDInputReport(event) {
  const { data, reportId } = event;
  webHIDLastReportTime = performance.now();
  lastReportId = reportId;
  lastReportLen = data.byteLength;

  // If controller is still streaming basic truncated report, prompt mode switch
  if (data.byteLength < 64 && activeHIDDevice && (performance.now() - lastInitAttemptTime > 1800)) {
    lastInitAttemptTime = performance.now();
    sendDualShock4BluetoothInit(activeHIDDevice);
  }

  // DualShock 4 Report Offset:
  // - Bluetooth Extended Mode (Report 0x11 / 0x31, 77-78 bytes): 2-byte transport header (padding1[2])
  //   Sticks start at byte 2, buttons at bytes 6, 7, 8.
  // - USB Mode (Report 0x01, 64 bytes) & Basic BT (10 bytes): Zero transport header bytes.
  //   Sticks start at byte 0, buttons at bytes 4, 5, 6.
  const offset = (reportId === 0x11 || reportId === 0x31 || data.byteLength >= 70) ? 2 : 0;

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

  // Dispatch continuous analog stick movement immediately on each report
  applyStickMotion(lx, ly, rx, ry);

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

  // 5. DualShock 4 Capacitive Touchpad Virtual Mouse Tracking
  const touch = parseDualShock4Touch(data, reportId);
  processTouchpadVirtualMouse(touch, touchpad);

  const actionState = {
    cross, circle, square, triangle,
    l1, r1, l2, r2,
    'dpad-up': dpadUp,
    'dpad-down': dpadDown,
    'dpad-left': dpadLeft,
    'dpad-right': dpadRight,
    share, options, l3, r3,
    ps,
    touchpad: Boolean(touchpad || (touch && touch.active))
  };

  dispatchControllerInputs(actionState);
}

/**
 * Decodes DualShock 4 Capacitive Touchpad multi-touch coordinates
 *
 * Ground truth from Chromium device/gamepad/dualshock4_controller.cc:
 * In Bluetooth Report 0x11 (data.byteLength === 77):
 * - byte 34: touches_count
 * - byte 35: touch_data_timestamp (rolling packet counter)
 * - byte 36: touch[0].id : 7, is_invalid : 1 (contact byte)
 * - byte 37: touch[0].data[0] (X lower 8 bits)
 * - byte 38: touch[0].data[1] (X upper 4 bits in low nibble, Y lower 4 bits in high nibble)
 * - byte 39: touch[0].data[2] (Y upper 8 bits)
 * - byte 40: touch[1].id : 7, is_invalid : 1
 *
 * In USB Report 0x01 (data.byteLength === 64):
 * - byte 32: touches_count
 * - byte 33: touch_data_timestamp
 * - byte 34: touch[0].contact
 * - byte 35: touch[0].data[0]
 * - byte 36: touch[0].data[1]
 * - byte 37: touch[0].data[2]
 */
function parseDualShock4Touch(data, reportId) {
  if (data.byteLength < 38) {
    return { active: false, x: 0, y: 0, trackingId: -1 };
  }

  // Candidate contact offsets:
  // For Bluetooth 77B packets, index 36 is the primary contact byte.
  // For USB 64B packets, index 34 is the primary contact byte.
  // Note: We NEVER test index 35 first because byte 35 in BT reports is the rolling timestamp counter!
  const candidateOffsets = (data.byteLength >= 70 || reportId === 0x11 || reportId === 0x31)
    ? [36, 40, 34, 37]
    : [34, 38, 36, 37];

  for (let i = 0; i < candidateOffsets.length; i++) {
    const c = candidateOffsets[i];
    if (c + 3 >= data.byteLength) continue;

    const contact = data.getUint8(c);
    // Bit 7 is 0 when touching down (active), 1 when released / inactive
    const isContactActive = (contact & 0x80) === 0;

    if (isContactActive) {
      const b0 = data.getUint8(c + 1); // X lower 8 bits
      const b1 = data.getUint8(c + 2); // X upper 4 bits & Y lower 4 bits
      const b2 = data.getUint8(c + 3); // Y upper 8 bits

      const x = b0 | ((b1 & 0x0f) << 8);
      const y = ((b1 & 0xf0) >> 4) | (b2 << 4);

      // Verify realistic touch coordinates on DualShock 4 1920x942 surface
      if (x >= 0 && x <= 1920 && y >= 0 && y <= 942) {
        return { active: true, x, y, trackingId: contact & 0x7f };
      }
    }
  }

  return { active: false, x: 0, y: 0, trackingId: -1 };
}

/**
 * Handles capacitive trackpad movement, tap-to-click, and physical click & drag
 */
function processTouchpadVirtualMouse(touch, physicalClick) {
  latestTouchInfo = touch && touch.active
    ? { active: true, x: touch.x, y: touch.y }
    : { active: false, x: 0, y: 0 };

  // 1. Physical Mechanical Touchpad Click (down/drag and up)
  if (physicalClick && !vmLastPhysicalClick) {
    vmLastPhysicalClick = true;
    vmIsDragging = true;
    wakeVirtualMouse();
    startVirtualDrag(vmCursorX, vmCursorY);
  } else if (!physicalClick && vmLastPhysicalClick) {
    vmLastPhysicalClick = false;
    vmIsDragging = false;
    endVirtualDrag(vmCursorX, vmCursorY);
  }

  // 2. Capacitive Surface Glide & Tap-to-Click
  if (touch && touch.active) {
    if (isSplashScreenActive()) {
      dismissSplashScreen('gamepad');
      return;
    }

    wakeVirtualMouse();

    if (!vmWasTouching) {
      // Finger first touchdown on trackpad
      vmWasTouching = true;
      vmLastTouchX = touch.x;
      vmLastTouchY = touch.y;
      vmLastTrackingId = touch.trackingId;
      vmTouchStartTime = performance.now();
      vmTouchStartCursorX = vmCursorX;
      vmTouchStartCursorY = vmCursorY;
    } else {
      // Finger dragging across trackpad
      const rawDx = touch.x - vmLastTouchX;
      const rawDy = touch.y - vmLastTouchY;
      vmLastTouchX = touch.x;
      vmLastTouchY = touch.y;

      // Handle subtle tracking ID re-keys without aborting smooth motion
      if (touch.trackingId !== vmLastTrackingId) {
        vmLastTrackingId = touch.trackingId;
        if (Math.hypot(rawDx, rawDy) > 280) {
          // Large leap indicates finger repositioned elsewhere, skip jump
          return;
        }
      }

      // Smooth relative tracking with brisk acceleration on fast swipes
      if (Math.abs(rawDx) >= 1 || Math.abs(rawDy) >= 1) {
        const dist = Math.hypot(rawDx, rawDy);
        if (dist < 400) {
          const sensRatio = (appState.touchpadSensitivity ?? 50) / 100;
          const speedFactor = dist > 40 ? 1.45 : dist > 18 ? 1.25 : 1.0;
          const dx = rawDx * 1.35 * sensRatio * speedFactor;
          const dy = rawDy * 1.35 * sensRatio * speedFactor;

          vmCursorX = Math.max(6, Math.min(window.innerWidth - 6, vmCursorX + dx));
          vmCursorY = Math.max(6, Math.min(window.innerHeight - 6, vmCursorY + dy));
          updateVirtualMouseElementPosition();

          if (vmIsDragging && vmDragTargetEl) {
            dispatchVirtualDragMove(vmDragTargetEl, vmCursorX, vmCursorY);
          } else {
            dispatchVirtualHover(vmCursorX, vmCursorY);
          }
        }
      }
    }
  } else if (vmWasTouching) {
    // Finger lifted from trackpad!
    vmWasTouching = false;
    const duration = performance.now() - vmTouchStartTime;
    const travel = Math.hypot(vmCursorX - vmTouchStartCursorX, vmCursorY - vmTouchStartCursorY);

    // Tap to Click: short contact (< 320ms) with minimal travel (< 18px)
    if (duration < 320 && travel < 18 && !physicalClick) {
      triggerVirtualClick(vmCursorX, vmCursorY);
    }
  }
}

function wakeVirtualMouse() {
  const el = document.getElementById('spotrVirtualMouse');
  if (el) {
    el.classList.remove('hidden');
    updateVirtualMouseElementPosition();
  }
  if (vmHideTimeout) clearTimeout(vmHideTimeout);
  vmHideTimeout = setTimeout(() => {
    if (!vmWasTouching && !vmIsDragging) {
      const cur = document.getElementById('spotrVirtualMouse');
      if (cur) cur.classList.add('hidden');
    }
  }, 3500);
}

function updateVirtualMouseElementPosition() {
  const el = document.getElementById('spotrVirtualMouse');
  if (el) {
    el.style.transform = `translate3d(${vmCursorX}px, ${vmCursorY}px, 0)`;
  }
}

function setVirtualMouseState(state) {
  const el = document.getElementById('spotrVirtualMouse');
  if (!el) return;
  el.classList.remove('vm-clicked', 'vm-dragging');
  if (state === 'clicked') el.classList.add('vm-clicked');
  if (state === 'dragging') el.classList.add('vm-dragging');
}

function dispatchVirtualHover(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  el.dispatchEvent(new PointerEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: -1,
    buttons: 0,
    pointerId: 101,
    isPrimary: true
  }));
}

function startVirtualDrag(x, y) {
  setVirtualMouseState('clicked');
  const el = document.elementFromPoint(x, y);
  vmDragTargetEl = el;

  if (el) {
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 101,
      isPrimary: true
    }));
    el.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1
    }));
  }
}

function dispatchVirtualDragMove(targetEl, x, y) {
  setVirtualMouseState('dragging');
  const target = targetEl || document.elementFromPoint(x, y);
  if (target) {
    target.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 1,
      pointerId: 101,
      isPrimary: true
    }));

    // If dragging an <input type="range"> (slider):
    const slider = target.type === 'range' ? target : target.closest('input[type="range"]');
    if (slider) {
      updateRangeSliderFromX(slider, x);
    }
  }
}

function endVirtualDrag(x, y) {
  setVirtualMouseState('normal');
  const el = vmDragTargetEl || document.elementFromPoint(x, y);

  if (el) {
    el.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0,
      pointerId: 101,
      isPrimary: true
    }));
    el.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      buttons: 0
    }));
    el.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0
    }));

    const interactive = el.closest('button, a, .radar-btn, .gp-badge, .ov-btn');
    if (interactive && typeof interactive.click === 'function') {
      interactive.click();
    }
  }
  vmDragTargetEl = null;
}

function triggerVirtualClick(x, y) {
  wakeVirtualMouse();
  setVirtualMouseState('clicked');
  setTimeout(() => setVirtualMouseState('normal'), 180);

  const el = document.elementFromPoint(x, y);
  if (!el) return;

  const interactive = el.closest('button, input, select, a, [data-gp], [data-tab], .radar-btn, .ov-btn') || el;

  interactive.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1, pointerId: 101, isPrimary: true
  }));
  interactive.dispatchEvent(new PointerEvent('pointerup', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 0, pointerId: 101, isPrimary: true
  }));
  interactive.dispatchEvent(new MouseEvent('click', {
    bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0
  }));

  if (typeof interactive.focus === 'function') interactive.focus();
  if (typeof interactive.click === 'function' && interactive !== el) {
    interactive.click();
  }

  // If clicked on main video canvas in live screen, move the ROI target crosshair right there!
  const canvasWrapper = el.closest('.canvas-wrapper') || (el.id === 'mainCanvas' ? el : null);
  if (canvasWrapper && appState.currentScreen === 'live') {
    const rect = canvasWrapper.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      const roiX = Math.max(0.04, Math.min(0.96, (x - rect.left) / rect.width));
      const roiY = Math.max(0.04, Math.min(0.96, (y - rect.top) / rect.height));
      updateState({
        roiX,
        roiY,
        pipEnabled: true,
        roiTargetVisible: true,
        lastGamepadAction: `TOUCHPAD CLICK: AIM ROI (${Math.round(roiX * 100)}%, ${Math.round(roiY * 100)}%)`
      });
    }
  }
}

function updateRangeSliderFromX(slider, clientX) {
  const rect = slider.getBoundingClientRect();
  if (rect.width <= 0) return;
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const min = parseFloat(slider.min) || 0;
  const max = parseFloat(slider.max) || 100;
  const step = parseFloat(slider.step) || 1;
  const rawVal = min + ratio * (max - min);
  const steppedVal = Math.round((rawVal - min) / step) * step + min;
  const finalVal = Math.max(min, Math.min(max, steppedVal));
  if (slider.value != finalVal) {
    slider.value = finalVal;
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

/**
 * Cycles GUI color theme backward (-1) or forward (+1)
 */
function cycleTheme(direction) {
  const current = (appState.themeColor || '#2dd4bf').toLowerCase();
  let idx = GUI_THEMES.findIndex((t) => t.color.toLowerCase() === current);
  if (idx < 0) idx = 0;

  const nextIdx = (idx + direction + GUI_THEMES.length) % GUI_THEMES.length;
  const newTheme = GUI_THEMES[nextIdx];

  applyThemeColor(newTheme.color);
  updateState({
    themeColor: newTheme.color,
    lastGamepadAction: `THEME: ${newTheme.name.toUpperCase()}`
  });
  saveSettings(appState);

  // Update UI swatches and custom picker in Settings
  const swatches = document.querySelectorAll('.theme-swatch');
  swatches.forEach((s) => {
    s.classList.toggle('active', s.dataset.color.toLowerCase() === newTheme.color.toLowerCase());
  });
  const colorPicker = document.getElementById('colorPickerCustom');
  if (colorPicker) colorPicker.value = newTheme.color;

  const actionEl = document.getElementById('gamepadActionText');
  if (actionEl) actionEl.textContent = `GUI COLOR: ${newTheme.name.toUpperCase()}`;
}

/**
 * Continuous Animation Frame Loop:
 * - Executes smooth analog stick updates with non-linear precision curve
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
 * Non-linear power response curve:
 * Deflection^1.8 provides 50-70% reduction at low stick angles for micro fine-tick aiming,
 * while retaining full velocity at 100% deflection.
 */
function applyStickCurve(v) {
  if (v === 0) return 0;
  return Math.sign(v) * Math.pow(Math.abs(v), 1.8);
}

/**
 * Applies smooth thumbstick movement frame by frame
 */
function applyStickMotion(lx, ly, rx, ry) {
  // Left Stick: Moves ROI Target Crosshair (roiX, roiY) in live mode
  // Maximum speed reduced by ~50% (scaled by reticleAimSpeed, default 50%) to allow pinpoint positioning
  if (appState.currentScreen === 'live' && (lx !== 0 || ly !== 0)) {
    const aimRatio = (appState.reticleAimSpeed ?? 50) / 100;
    const currentRoiSpeed = BASE_ROI_SPEED * aimRatio;
    const clx = applyStickCurve(lx);
    const cly = applyStickCurve(ly);
    let nx = Math.max(0.04, Math.min(0.96, appState.roiX + clx * currentRoiSpeed));
    let ny = Math.max(0.04, Math.min(0.96, appState.roiY + cly * currentRoiSpeed));
    updateState({
      roiX: nx,
      roiY: ny,
      pipEnabled: true,
      roiTargetVisible: true
    });
  }

  // Right Stick: Pans Main View when zoomed in (>1.0x) in live mode
  if (appState.currentScreen === 'live' && appState.mainZoom > 1.01 && (rx !== 0 || ry !== 0)) {
    const aimRatio = (appState.reticleAimSpeed ?? 50) / 100;
    const currentPanSpeed = BASE_PAN_SPEED * aimRatio;
    const crx = applyStickCurve(rx);
    const cry = applyStickCurve(ry);
    const maxPan = Math.max(0, (1 - 1 / appState.mainZoom) / 2);
    const nx = Math.max(-maxPan, Math.min(maxPan, appState.mainPanX + crx * currentPanSpeed));
    const ny = Math.max(-maxPan, Math.min(maxPan, appState.mainPanY + cry * currentPanSpeed));
    updateState({ mainPanX: nx, mainPanY: ny });
  }

  // Reticle Customizer Screen: Both Left & Right Sticks sculpt crosshair parameters in real time
  if (appState.currentScreen === 'reticle') {
    const now = performance.now();

    // 1. Left Stick Y: Select / Navigate Controls (Up / Down) through Drawer Menu
    // Note: Up on stick produces negative ly, Down produces positive ly
    if (Math.abs(ly) > 0.08) {
      const interval = Math.abs(ly) > 0.50 ? 120 : 220;
      if (now - reticleStickLastYTime > interval) {
        reticleStickLastYTime = now;
        const dir = ly > 0 ? 1 : -1;
        const ctrl = window.reticleGamepadAPI?.cycleFocus(dir);
        const label = ctrl ? ctrl.label.toUpperCase() : 'CONTROL';
        window.reticleGamepadAPI?.showToast(`SELECTED: ${label}`, 'lstick');
        updateState({ lastGamepadAction: `SELECT: ${label}` });
      }
    }

    // 2. Left Stick X: Adjust Currently Selected Control (- / +)
    // Note: Right on stick produces positive lx, Left produces negative lx
    if (Math.abs(lx) > 0.08) {
      const interval = Math.abs(lx) > 0.50 ? 90 : 200;
      if (now - reticleStickLastXTime > interval) {
        reticleStickLastXTime = now;
        const dir = lx > 0 ? 1 : -1;
        const res = window.reticleGamepadAPI?.adjust(dir);
        window.reticleGamepadAPI?.showToast(res || (dir > 0 ? 'INCREASE' : 'DECREASE'), 'lstick');
        updateState({ lastGamepadAction: `RETICLE: ${res || 'ADJUST'}` });
      }
    }

    // 3. Right Stick X: Direct Center Gap Adjustment (Left = tighter, Right = larger POI gap)
    if (Math.abs(rx) > 0.08) {
      const interval = Math.abs(rx) > 0.50 ? 75 : 150;
      if (now - reticleStickRightXTime > interval) {
        reticleStickRightXTime = now;
        const dir = rx > 0 ? 4 : -4;
        const res = window.reticleGamepadAPI?.quickAdjustGap(dir);
        window.reticleGamepadAPI?.showToast(res, 'rstick');
        updateState({ lastGamepadAction: `RETICLE: ${res}` });
      }
    }

    // 4. Right Stick Y: Direct Stroke Weight Adjustment (Up = thicker lines, Down = thinner lines)
    if (Math.abs(ry) > 0.08) {
      const interval = Math.abs(ry) > 0.50 ? 75 : 150;
      if (now - reticleStickRightYTime > interval) {
        reticleStickRightYTime = now;
        const dir = -ry > 0 ? 0.2 : -0.2;
        const res = window.reticleGamepadAPI?.quickAdjustStroke(dir);
        window.reticleGamepadAPI?.showToast(res, 'rstick');
        updateState({ lastGamepadAction: `RETICLE: ${res}` });
      }
    }
  }
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
    if (screen === 'reticle') {
      if (window.reticleGamepadAPI?.isFocusedOnMenu?.()) {
        const res = window.reticleGamepadAPI?.activate();
        window.reticleGamepadAPI?.showToast(res || 'ACTIVATED', 'cross');
        updateState({ lastGamepadAction: `RETICLE: ${res || 'ACTIVATE'}` });
      } else {
        document.getElementById('btnToggleReticleLabels')?.click();
        const stateStr = appState.reticleConfig?.showLabels ? 'ON' : 'OFF';
        window.reticleGamepadAPI?.showToast(`NUMBER LABELS: ${stateStr}`, 'cross');
        updateState({ lastGamepadAction: `RETICLE: NUMBER LABELS ${stateStr}` });
      }
    } else if (screen === 'gallery') {
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
    if (screen === 'reticle') {
      document.getElementById('btnToggleReticleRings')?.click();
      const stateStr = appState.reticleConfig?.concentricRings ? 'ON' : 'OFF';
      window.reticleGamepadAPI?.showToast(`CONCENTRIC RINGS: ${stateStr}`, 'square');
      updateState({ lastGamepadAction: `RETICLE: CONCENTRIC RINGS ${stateStr}` });
    } else if (screen === 'gallery') {
      document.getElementById('btnGallerySlowMo')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (0.5x SLOW-MO)' });
    } else {
      document.getElementById('btnToggleOverlayTop')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SQUARE (OVERLAY TOGGLE)' });
    }
  }

  // Triangle (△)
  if (isJustPressed('triangle')) {
    if (screen === 'reticle') {
      document.getElementById('btnToggleReticleBrackets')?.click();
      const stateStr = appState.reticleConfig?.innerBrackets ? 'ON' : 'OFF';
      window.reticleGamepadAPI?.showToast(`CENTER BRACKETS: ${stateStr}`, 'tri');
      updateState({ lastGamepadAction: `RETICLE: CENTER BRACKETS ${stateStr}` });
    } else if (screen === 'gallery') {
      document.getElementById('btnToggleGalleryDrawer')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (CLIPS DRAWER)' });
    } else {
      document.getElementById('btnToggleHeatmap')?.click();
      updateState({ lastGamepadAction: 'BUTTON: TRIANGLE (HEATMAP TOGGLE)' });
    }
  }

  // L1 (Bumper)
  if (isJustPressed('l1')) {
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.quickAdjustClicks(-1);
      window.reticleGamepadAPI?.showToast(res || 'CLICKS -1', 'bumpers');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'CLICKS -1'}` });
    } else if (screen === 'gallery') {
      document.getElementById('galleryZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (VIDEO ZOOM -)' });
    } else {
      document.getElementById('mainZoomMinus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: L1 (MAIN ZOOM -)' });
    }
  }

  // R1 (Bumper)
  if (isJustPressed('r1')) {
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.quickAdjustClicks(1);
      window.reticleGamepadAPI?.showToast(res || 'CLICKS +1', 'bumpers');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'CLICKS +1'}` });
    } else if (screen === 'gallery') {
      document.getElementById('galleryZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (VIDEO ZOOM +)' });
    } else {
      document.getElementById('mainZoomPlus')?.click();
      updateState({ lastGamepadAction: 'BUTTON: R1 (MAIN ZOOM +)' });
    }
  }

  // L2 (Trigger) - Step Backward 1 Frame / Reticle spacing -2px
  if (isJustPressed('l2')) {
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.quickAdjustSpacing(-2);
      window.reticleGamepadAPI?.showToast(res || 'SPACING -2px', 'triggers');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'SPACING -2px'}` });
    } else if (screen === 'gallery') {
      document.getElementById('btnGalleryStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStepBack')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: L2 (STEP -1 FRAME)' });
    }
  }

  // R2 (Trigger) - Step Forward 1 Frame / Reticle spacing +2px
  if (isJustPressed('r2')) {
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.quickAdjustSpacing(2);
      window.reticleGamepadAPI?.showToast(res || 'SPACING +2px', 'triggers');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'SPACING +2px'}` });
    } else if (screen === 'gallery') {
      document.getElementById('btnGalleryStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    } else if (appState.replayActive) {
      document.getElementById('btnReplayStep')?.click();
      updateState({ lastGamepadAction: 'TRIGGER: R2 (STEP +1 FRAME)' });
    }
  }

  // Options - Open / Close Settings (Options) Screen
  if (isJustPressed('options')) {
    if (screen === 'settings') {
      document.getElementById('btnSettingsBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: OPTIONS (EXIT SETTINGS)' });
    } else if (screen === 'reticle') {
      document.getElementById('btnReticleBackToLive')?.click();
      updateState({ lastGamepadAction: 'BUTTON: OPTIONS (EXIT TO LIVE)' });
    } else {
      document.getElementById('btnToggleOptions')?.click();
      updateState({ lastGamepadAction: 'BUTTON: OPTIONS (OPEN SETTINGS)' });
    }
  }

  // Share - Trigger 20s Instant Replay / Reset Reticle Defaults
  if (isJustPressed('share')) {
    if (screen === 'reticle') {
      document.getElementById('btnResetReticle')?.click();
      window.reticleGamepadAPI?.showToast('RETICLE: RESET PRESET DEFAULTS', 'tri');
      updateState({ lastGamepadAction: 'RETICLE: RESET DEFAULTS' });
    } else {
      document.getElementById('btnReplay20s')?.click();
      updateState({ lastGamepadAction: 'BUTTON: SHARE (INSTANT REPLAY)' });
    }
  }

  // L3 (Left Stick Click) - Circle Backward through GUI Color Themes on Live Feed, or Audition on Reticle
  if (isJustPressed('l3')) {
    if (screen === 'live') {
      cycleTheme(-1);
    } else if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.activate();
      window.reticleGamepadAPI?.showToast(res || 'AUDITION', 'lstick');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'AUDITION'}` });
    }
  }

  // R3 (Right Stick Click) - Circle Forward through GUI Color Themes on Live Feed, or Reset on Reticle
  if (isJustPressed('r3')) {
    if (screen === 'live') {
      cycleTheme(1);
    } else if (screen === 'reticle') {
      document.getElementById('btnResetReticle')?.click();
      window.reticleGamepadAPI?.showToast('RETICLE: RESET PRESET DEFAULTS', 'rstick');
      updateState({ lastGamepadAction: 'RETICLE: RESET DEFAULTS' });
    }
  }

  // D-Pad Up
  if (isJustPressed('dpad-up')) {
    if (screen === 'reticle') {
      const ctrl = window.reticleGamepadAPI?.cycleFocus(-1);
      const label = ctrl ? ctrl.label.toUpperCase() : 'PREV CONTROL';
      window.reticleGamepadAPI?.showToast(`SELECTED: ${label}`, 'dpad');
      updateState({ lastGamepadAction: `SELECT: ${label}` });
    } else if (screen === 'live') {
      document.getElementById('pipZoomPlus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: UP (WIN ZOOM +)' });
    }
  }

  // D-Pad Down
  if (isJustPressed('dpad-down')) {
    if (screen === 'reticle') {
      const ctrl = window.reticleGamepadAPI?.cycleFocus(1);
      const label = ctrl ? ctrl.label.toUpperCase() : 'NEXT CONTROL';
      window.reticleGamepadAPI?.showToast(`SELECTED: ${label}`, 'dpad');
      updateState({ lastGamepadAction: `SELECT: ${label}` });
    } else if (screen === 'live') {
      document.getElementById('pipZoomMinus')?.click();
      updateState({ lastGamepadAction: 'D-PAD: DOWN (WIN ZOOM -)' });
    }
  }

  // D-Pad Left
  if (isJustPressed('dpad-left')) {
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.adjust(-1);
      window.reticleGamepadAPI?.showToast(res || 'DECREASE', 'dpad');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'DECREASE'}` });
    } else if (screen === 'gallery') {
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
    if (screen === 'reticle') {
      const res = window.reticleGamepadAPI?.adjust(1);
      window.reticleGamepadAPI?.showToast(res || 'INCREASE', 'dpad');
      updateState({ lastGamepadAction: `RETICLE: ${res || 'INCREASE'}` });
    } else if (screen === 'gallery') {
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
      const info = `0x${lastReportId.toString(16).toUpperCase()} (${lastReportLen}B)`;
      const touchStr = latestTouchInfo.active ? `TOUCH [${latestTouchInfo.x}, ${latestTouchInfo.y}]` : `TOUCH IDLE`;
      slotEl.textContent = `BACKEND: WEBHID BT [${info}] ✓ | ${touchStr}`;
      slotEl.style.color = lastReportLen >= 64 ? '#22c55e' : '#f59e0b';
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
