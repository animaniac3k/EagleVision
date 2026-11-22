/**
 * Controller & Key Mapping Screen Controller (SPOTR Beta 1)
 *
 * Dedicated fullscreen interface for:
 * 1. Viewing live controller hardware diagnostics (WebHID BT / Gamepad API).
 * 2. Visual interactive gamepad representation with real-time input glowing.
 * 3. Re-mapping buttons, triggers, sticks, and keyboard shortcuts to app actions.
 * 4. Fine-tuning stick deadzones, invert Y-axis, aim speed, and touchpad glide.
 * 5. Profile presets (Default DualShock 4, Simplified Field, Flight / Arcade).
 */

import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { cycleTheme } from '../input/gamepadController.js';
import { getActiveRemoteMode, getLearningAction, setLearningAction } from './ringController.js';
import { snapLoupeToLatestHit } from '../renderer/zoomWindow.js';
import { rezeroHeatmap, captureAnnotatedSnapshot } from '../renderer/compositor.js';

// Mappable Action Registry
export const ACTION_DEFINITIONS = [
  // OPTICS & SIGHT
  {
    id: 'aim_reticle',
    category: 'optics',
    name: 'Primary Reticle Aim',
    desc: 'Steer scope reticle / target POI coordinates',
    defaultGamepad: 'left-stick',
    defaultKey: 'ArrowKeys',
    isAnalog: true
  },
  {
    id: 'pan_view',
    category: 'optics',
    name: 'Pan Viewport',
    desc: 'Pan video when main stream zoom is > 1.0x',
    defaultGamepad: 'right-stick',
    defaultKey: 'KeyW/A/S/D',
    isAnalog: true
  },
  {
    id: 'zoom_in',
    category: 'optics',
    name: 'Main Zoom In (+)',
    desc: 'Step whole-image digital zoom higher',
    defaultGamepad: 'r1',
    defaultKey: 'Equal'
  },
  {
    id: 'zoom_out',
    category: 'optics',
    name: 'Main Zoom Out (−)',
    desc: 'Step whole-image digital zoom lower',
    defaultGamepad: 'l1',
    defaultKey: 'Minus'
  },
  {
    id: 'zoom_reset',
    category: 'optics',
    name: 'Reset Zoom (1:1)',
    desc: 'Restore whole-image zoom to 1.0x native view',
    defaultGamepad: 'r3',
    defaultKey: 'Digit0'
  },
  {
    id: 'reticle_scale_up',
    category: 'optics',
    name: 'Reticle Mils/MOA Spacing Wider (+1px)',
    desc: 'Fine single-pixel expansion between mils/MOA reticle hashmarks',
    defaultGamepad: 'dpad-up',
    defaultKey: 'BracketRight'
  },
  {
    id: 'reticle_scale_down',
    category: 'optics',
    name: 'Reticle Mils/MOA Spacing Tighter (-1px)',
    desc: 'Fine single-pixel contraction between mils/MOA reticle hashmarks',
    defaultGamepad: 'dpad-down',
    defaultKey: 'BracketLeft'
  },
  {
    id: 'reticle_ffp_toggle',
    category: 'optics',
    name: 'Toggle Auto-FFP Zoom Sync',
    desc: 'Lock / unlock reticle scaling with whole-image digital zoom',
    defaultGamepad: 'none',
    defaultKey: 'KeyF'
  },
  {
    id: 'reticle_center_cycle',
    category: 'optics',
    name: 'Cycle Center Point Style',
    desc: 'Cycle reticle center symbol (Empty -> Dot -> Cross -> Chevron)',
    defaultGamepad: 'none',
    defaultKey: 'KeyC'
  },
  {
    id: 'toggle_overlay',
    category: 'optics',
    name: 'Toggle Scope Reticle',
    desc: 'Show or hide superimposed crosshair overlay',
    defaultGamepad: 'square',
    defaultKey: 'KeyO'
  },
  {
    id: 'toggle_pip',
    category: 'optics',
    name: 'Toggle Digital Loupe (PiP)',
    desc: 'Show or hide floating resizable digital zoom window',
    defaultGamepad: 'none',
    defaultKey: 'KeyP'
  },

  // DETECTION & HITS
  {
    id: 'toggle_heatmap',
    category: 'vision',
    name: 'Toggle Hits Detection',
    desc: 'Toggle 20Hz localized hit detection & target markers',
    defaultGamepad: 'triangle',
    defaultKey: 'KeyH'
  },
  {
    id: 'toggle_voice',
    category: 'vision',
    name: 'Cycle Voice Callouts',
    desc: 'Cycle directional voice callouts (OFF → POI → POA)',
    defaultGamepad: 'l3',
    defaultKey: 'KeyM'
  },
  {
    id: 'toggle_declutter',
    category: 'vision',
    name: 'Declutter Screen',
    desc: 'Toggle 100% full-screen sight picture (hide UI chrome)',
    defaultGamepad: 'ps',
    defaultKey: 'Space'
  },
  {
    id: 'toggle_hud',
    category: 'vision',
    name: 'Toggle Telemetry HUD',
    desc: 'Show or hide stream FPS, resolution, and RAM buffer readout',
    defaultGamepad: 'none',
    defaultKey: 'KeyI'
  },

  // RECORDING & REPLAY
  {
    id: 'instant_replay',
    category: 'recording',
    name: 'Instant Replay & Auto-Save',
    desc: 'Freeze circular RAM buffer & auto-save clip to archive',
    defaultGamepad: 'share',
    defaultKey: 'KeyR'
  },
  {
    id: 'play_pause',
    category: 'recording',
    name: 'Play / Pause Video',
    desc: 'Toggle video playback in instant replay or gallery',
    defaultGamepad: 'cross',
    defaultKey: 'KeyK'
  },
  {
    id: 'step_forward',
    category: 'recording',
    name: 'Step Forward (+1 Frame)',
    desc: 'Step forward 1 frame in replay or gallery for forensic review',
    defaultGamepad: 'dpad-right',
    defaultKey: 'Period'
  },
  {
    id: 'step_backward',
    category: 'recording',
    name: 'Step Backward (−1 Frame)',
    desc: 'Step backward 1 frame in replay or gallery',
    defaultGamepad: 'dpad-left',
    defaultKey: 'Comma'
  },
  {
    id: 'toggle_slowmo',
    category: 'recording',
    name: 'Toggle 0.5x Slow-Motion',
    desc: 'Toggle half-speed slow motion playback in gallery',
    defaultGamepad: 'square',
    defaultKey: 'KeyJ'
  },

  // VIRTUAL MOUSE & SYSTEM
  {
    id: 'vm_left_click',
    category: 'system',
    name: 'Virtual Mouse Left Click / Drag',
    desc: 'Perform left mouse click or drag UI elements with trackpad',
    defaultGamepad: 'l2',
    defaultKey: 'MouseLeft'
  },
  {
    id: 'vm_right_click',
    category: 'system',
    name: 'Virtual Mouse Right Click',
    desc: 'Perform right mouse context click',
    defaultGamepad: 'r2',
    defaultKey: 'MouseRight'
  },
  {
    id: 'toggle_vm',
    category: 'system',
    name: 'Toggle Virtual Mouse',
    desc: 'Show or hide virtual blue reticle mouse pointer',
    defaultGamepad: 'touchpad',
    defaultKey: 'Backquote'
  },
  {
    id: 'theme_cycle',
    category: 'system',
    name: 'Cycle Tactical Theme',
    desc: 'Cycle interface night-vision color schemes',
    defaultGamepad: 'r3',
    defaultKey: 'KeyT'
  },
  {
    id: 'open_settings',
    category: 'system',
    name: 'Open / Close Settings',
    desc: 'Toggle central system & sensor configuration screen',
    defaultGamepad: 'options',
    defaultKey: 'Escape'
  },
  {
    id: 'return_live',
    category: 'system',
    name: 'Universal Back to Live Feed',
    desc: 'Exit sub-screens or replay and return to live camera stream',
    defaultGamepad: 'circle',
    defaultKey: 'KeyB'
  },
  {
    id: 'quick_tool_cycle_next',
    category: 'system',
    name: 'Cycle Next Quick Tool (▶)',
    desc: 'Step cyclic selector forward across secondary tools (Heatmap, Voice, Reticle, FFP, etc.)',
    defaultGamepad: 'dpad-right',
    defaultKey: 'Period'
  },
  {
    id: 'quick_tool_cycle_prev',
    category: 'system',
    name: 'Cycle Prev Quick Tool (◀)',
    desc: 'Step cyclic selector backward across secondary tools',
    defaultGamepad: 'dpad-left',
    defaultKey: 'Comma'
  },
  {
    id: 'quick_tool_toggle',
    category: 'system',
    name: 'Toggle Selected Quick Tool',
    desc: 'Toggle ON/OFF whichever secondary tool is currently selected on the cyclic dock',
    defaultGamepad: 'cross',
    defaultKey: 'Enter'
  },
  {
    id: 'toggle_dpad_mode',
    category: 'optics',
    name: 'Switch D-Pad Mode (Pan ↔ Aim Loupe)',
    desc: 'Toggle D-Pad / single-stick directional keys between Pan View and Aim Loupe',
    defaultGamepad: 'none',
    defaultKey: 'KeyU'
  },
  {
    id: 'snap_loupe_last_hit',
    category: 'vision',
    name: 'Snap Loupe to Latest Hit',
    desc: 'Jump digital Loupe crosshair to the newest logged motion detection',
    defaultGamepad: 'none',
    defaultKey: 'KeyG'
  },
  {
    id: 'rezero_heatmap',
    category: 'vision',
    name: 'Re-Zero Detector Background',
    desc: 'Re-anchor hit detection reference immediately',
    defaultGamepad: 'none',
    defaultKey: 'KeyZ'
  },
  {
    id: 'capture_snapshot',
    category: 'recording',
    name: 'Save Annotated PNG Snapshot',
    desc: 'Download current frame + reticle overlay as a PNG image',
    defaultGamepad: 'none',
    defaultKey: 'KeyN'
  },
  {
    id: 'dpad_up',
    category: 'optics',
    name: 'D-Pad Up (Pan / Aim Loupe)',
    desc: 'Steer Pan or Aim Loupe Up (respects D-Pad Mode toggle)',
    defaultGamepad: 'none',
    defaultKey: 'none'
  },
  {
    id: 'dpad_down',
    category: 'optics',
    name: 'D-Pad Down (Pan / Aim Loupe)',
    desc: 'Steer Pan or Aim Loupe Down (respects D-Pad Mode toggle)',
    defaultGamepad: 'none',
    defaultKey: 'none'
  },
  {
    id: 'dpad_left',
    category: 'optics',
    name: 'D-Pad Left (Pan / Aim / Frame -1)',
    desc: 'Steer Pan or Aim Loupe Left in Live, or Step −1 frame in Replay',
    defaultGamepad: 'none',
    defaultKey: 'none'
  },
  {
    id: 'dpad_right',
    category: 'optics',
    name: 'D-Pad Right (Pan / Aim / Frame +1)',
    desc: 'Steer Pan or Aim Loupe Right in Live, or Step +1 frame in Replay',
    defaultGamepad: 'none',
    defaultKey: 'none'
  }
];

// 16-Button 8BitDo Micro K-Mode (HID Keyboard) Default Layout
export const MICRO_BUTTON_DEFS = [
  { id: 'up', label: 'D-Pad ▲', defaultAction: 'dpad_up', defaultKey: 'ArrowUp' },
  { id: 'down', label: 'D-Pad ▼', defaultAction: 'dpad_down', defaultKey: 'ArrowDown' },
  { id: 'left', label: 'D-Pad ◀', defaultAction: 'dpad_left', defaultKey: 'ArrowLeft' },
  { id: 'right', label: 'D-Pad ▶', defaultAction: 'dpad_right', defaultKey: 'ArrowRight' },
  { id: 'a', label: 'A (East)', defaultAction: 'snap_loupe_last_hit', defaultKey: 'KeyG' },
  { id: 'b', label: 'B (South)', defaultAction: 'rezero_heatmap', defaultKey: 'KeyZ' },
  { id: 'x', label: 'X (North)', defaultAction: 'toggle_heatmap', defaultKey: 'KeyH' },
  { id: 'y', label: 'Y (West)', defaultAction: 'toggle_pip', defaultKey: 'KeyL' },
  { id: 'l1', label: 'L1', defaultAction: 'zoom_out', defaultKey: 'Minus' },
  { id: 'r1', label: 'R1', defaultAction: 'zoom_in', defaultKey: 'Equal' },
  { id: 'l2', label: 'L2', defaultAction: 'reticle_scale_down', defaultKey: 'BracketLeft' },
  { id: 'r2', label: 'R2', defaultAction: 'reticle_scale_up', defaultKey: 'BracketRight' },
  { id: 'minus', label: '− (Select)', defaultAction: 'toggle_dpad_mode', defaultKey: 'KeyU' },
  { id: 'plus', label: '+ (Start)', defaultAction: 'instant_replay', defaultKey: 'KeyR' },
  { id: 'star', label: '★ (Star)', defaultAction: 'capture_snapshot', defaultKey: 'KeyN' },
  { id: 'home', label: '⌂ (Home)', defaultAction: 'return_live', defaultKey: 'KeyB' }
];

// Unified Bluetooth Ring & Remote Button Definitions (Single 1-to-1 Mode)
export const REMOTE_BUTTON_DEFS = [
  {
    id: 'UP',
    name: 'UP (▲)',
    badge: 'PAN',
    desc: 'Pan Live View Up • Replay: Toggle 0.5x Slow-Mo',
    defaultCodes: 'ArrowUp, PageUp, KeyW'
  },
  {
    id: 'DOWN',
    name: 'DOWN (▼)',
    badge: 'PAN',
    desc: 'Pan Live View Down • Replay: Exit to Live',
    defaultCodes: 'ArrowDown, PageDown, KeyS'
  },
  {
    id: 'LEFT',
    name: 'LEFT (◀)',
    badge: 'PAN',
    desc: 'Pan Live View Left • Replay: Step -1 Frame',
    defaultCodes: 'ArrowLeft, MediaTrackPrevious, KeyA'
  },
  {
    id: 'RIGHT',
    name: 'RIGHT (▶)',
    badge: 'PAN',
    desc: 'Pan Live View Right • Replay: Step +1 Frame',
    defaultCodes: 'ArrowRight, MediaTrackNext, KeyD'
  },
  {
    id: 'CENTER',
    name: 'CENTER (●)',
    badge: 'ZOOM / PLAY',
    desc: 'Zoom Cycle (1.0x → 1.5x → 2.0x → 2.5x → 3.0x → 1.0x) • Replay: Play / Pause',
    defaultCodes: 'Enter, Space, MediaPlayPause, KeyF'
  },
  {
    id: 'BTN1',
    name: 'BUTTON 1 (⏻ 1)',
    badge: 'REPLAY (ALT)',
    desc: 'Instant Replay In / Out (Note: ChromeOS often intercepts BTN 1 as Volume Up)',
    defaultCodes: 'AudioVolumeUp, KeyX, KeyR'
  },
  {
    id: 'BTN2',
    name: 'BUTTON 2 (2)',
    badge: 'REPLAY',
    desc: 'Instant Replay In / Out (Recommended on ChromeOS)',
    defaultCodes: 'AudioVolumeDown, KeyM, KeyT, KeyB'
  }
];

// Default Bluetooth Ring & Remote Key Map (excludes F12 & Tab)
export const DEFAULT_RING_KEY_MAP = {
  UP: 'ArrowUp, PageUp, KeyW',
  DOWN: 'ArrowDown, PageDown, KeyS',
  LEFT: 'ArrowLeft, MediaTrackPrevious, KeyA',
  RIGHT: 'ArrowRight, MediaTrackNext, KeyD',
  CENTER: 'Enter, Space, MediaPlayPause, KeyF',
  BTN1: 'AudioVolumeUp, KeyX, KeyR',
  BTN2: 'AudioVolumeDown, KeyM, KeyT, KeyB'
};

// Built-in Factory Profile Presets
export const BUILT_IN_PROFILES = {
  default: {
    id: 'default',
    name: 'Default DualShock 4',
    description: 'Balanced tactical layout optimized for precision optical scoping.',
    isBuiltIn: true,
    bindings: ACTION_DEFINITIONS.reduce((acc, act) => {
      acc[act.id] = { gamepad: act.defaultGamepad, key: act.defaultKey };
      return acc;
    }, {}),
    ringKeyMap: { ...DEFAULT_RING_KEY_MAP },
    calibration: {
      leftStickDeadzone: 16,
      rightStickDeadzone: 16,
      leftStickInvertY: false,
      rightStickInvertY: false,
      touchpadSensitivity: 50,
      reticleAimSpeed: 50,
      ringPanSpeed: 70
    }
  },
  simplified: {
    id: 'simplified',
    name: 'Simplified Field Mode',
    description: 'Essential controls only; minimizes accidental button presses during observation.',
    isBuiltIn: true,
    bindings: {
      aim_reticle: { gamepad: 'left-stick', key: 'ArrowKeys' },
      pan_view: { gamepad: 'right-stick', key: 'KeyW/A/S/D' },
      zoom_in: { gamepad: 'r1', key: 'Equal' },
      zoom_out: { gamepad: 'l1', key: 'Minus' },
      zoom_reset: { gamepad: 'none', key: 'Digit0' },
      reticle_scale_up: { gamepad: 'dpad-up', key: 'BracketRight' },
      reticle_scale_down: { gamepad: 'dpad-down', key: 'BracketLeft' },
      reticle_ffp_toggle: { gamepad: 'none', key: 'KeyF' },
      reticle_center_cycle: { gamepad: 'none', key: 'KeyC' },
      toggle_overlay: { gamepad: 'square', key: 'KeyO' },
      toggle_pip: { gamepad: 'none', key: 'KeyP' },
      toggle_heatmap: { gamepad: 'triangle', key: 'KeyH' },
      toggle_voice: { gamepad: 'none', key: 'KeyM' },
      toggle_declutter: { gamepad: 'none', key: 'Space' },
      toggle_hud: { gamepad: 'none', key: 'KeyI' },
      instant_replay: { gamepad: 'share', key: 'KeyR' },
      play_pause: { gamepad: 'cross', key: 'KeyK' },
      step_forward: { gamepad: 'dpad-right', key: 'Period' },
      step_backward: { gamepad: 'dpad-left', key: 'Comma' },
      toggle_slowmo: { gamepad: 'none', key: 'KeyJ' },
      vm_left_click: { gamepad: 'l2', key: 'MouseLeft' },
      vm_right_click: { gamepad: 'r2', key: 'MouseRight' },
      toggle_vm: { gamepad: 'touchpad', key: 'Backquote' },
      theme_cycle: { gamepad: 'none', key: 'KeyT' },
      open_settings: { gamepad: 'options', key: 'Escape' },
      return_live: { gamepad: 'circle', key: 'KeyB' },
      quick_tool_cycle_next: { gamepad: 'dpad-right', key: 'Period' },
      quick_tool_cycle_prev: { gamepad: 'dpad-left', key: 'Comma' },
      quick_tool_toggle: { gamepad: 'cross', key: 'Enter' }
    },
    ringKeyMap: {
      UP: 'ArrowUp',
      DOWN: 'ArrowDown',
      LEFT: 'ArrowLeft',
      RIGHT: 'ArrowRight',
      CENTER: 'Enter',
      BTN1: 'KeyX',
      BTN2: 'KeyM'
    },
    calibration: {
      leftStickDeadzone: 20,
      rightStickDeadzone: 20,
      leftStickInvertY: false,
      rightStickInvertY: false,
      touchpadSensitivity: 40,
      reticleAimSpeed: 40,
      ringPanSpeed: 70
    }
  },
  flight: {
    id: 'flight',
    name: 'Flight / Arcade Stick',
    description: 'Designed for single-stick throttles and digital D-pad steering.',
    isBuiltIn: true,
    bindings: {
      aim_reticle: { gamepad: 'dpad-up', key: 'ArrowKeys' },
      pan_view: { gamepad: 'right-stick', key: 'KeyW/A/S/D' },
      zoom_in: { gamepad: 'r1', key: 'Equal' },
      zoom_out: { gamepad: 'l1', key: 'Minus' },
      zoom_reset: { gamepad: 'none', key: 'Digit0' },
      reticle_scale_up: { gamepad: 'none', key: 'BracketRight' },
      reticle_scale_down: { gamepad: 'none', key: 'BracketLeft' },
      reticle_ffp_toggle: { gamepad: 'none', key: 'KeyF' },
      reticle_center_cycle: { gamepad: 'none', key: 'KeyC' },
      toggle_overlay: { gamepad: 'cross', key: 'KeyO' },
      toggle_pip: { gamepad: 'none', key: 'KeyP' },
      toggle_heatmap: { gamepad: 'triangle', key: 'KeyH' },
      toggle_voice: { gamepad: 'none', key: 'KeyM' },
      toggle_declutter: { gamepad: 'none', key: 'Space' },
      toggle_hud: { gamepad: 'none', key: 'KeyI' },
      instant_replay: { gamepad: 'circle', key: 'KeyR' },
      play_pause: { gamepad: 'cross', key: 'KeyK' },
      step_forward: { gamepad: 'none', key: 'Period' },
      step_backward: { gamepad: 'none', key: 'Comma' },
      toggle_slowmo: { gamepad: 'none', key: 'KeyJ' },
      vm_left_click: { gamepad: 'l2', key: 'MouseLeft' },
      vm_right_click: { gamepad: 'r2', key: 'MouseRight' },
      toggle_vm: { gamepad: 'touchpad', key: 'Backquote' },
      theme_cycle: { gamepad: 'r3', key: 'KeyT' },
      open_settings: { gamepad: 'options', key: 'Escape' },
      return_live: { gamepad: 'share', key: 'KeyB' },
      quick_tool_cycle_next: { gamepad: 'none', key: 'Period' },
      quick_tool_cycle_prev: { gamepad: 'none', key: 'Comma' },
      quick_tool_toggle: { gamepad: 'square', key: 'Enter' }
    },
    ringKeyMap: {
      UP: 'ArrowUp',
      DOWN: 'ArrowDown',
      LEFT: 'ArrowLeft',
      RIGHT: 'ArrowRight',
      CENTER: 'Space',
      BTN1: 'KeyR',
      BTN2: 'Tab'
    },
    calibration: {
      leftStickDeadzone: 10,
      rightStickDeadzone: 10,
      leftStickInvertY: true,
      rightStickInvertY: false,
      touchpadSensitivity: 60,
      reticleAimSpeed: 60,
      ringPanSpeed: 70
    }
  },
  '8bitdo_micro': {
    id: '8bitdo_micro',
    name: '8BitDo Micro (K-Mode)',
    description: '16-button BLE keyboard preset (Switch K): D-Pad switches Pan/Aim Loupe, ABXY + shoulders control Heatmap, Replay, Loupe Snap & Snapshots.',
    isBuiltIn: true,
    bindings: {
      ...ACTION_DEFINITIONS.reduce((acc, act) => {
        acc[act.id] = { gamepad: act.defaultGamepad, key: act.defaultKey };
        return acc;
      }, {}),
      aim_reticle: { gamepad: 'left-stick', key: 'none' },
      pan_view: { gamepad: 'right-stick', key: 'none' },
      dpad_up: { gamepad: 'none', key: 'ArrowUp' },
      dpad_down: { gamepad: 'none', key: 'ArrowDown' },
      dpad_left: { gamepad: 'none', key: 'ArrowLeft' },
      dpad_right: { gamepad: 'none', key: 'ArrowRight' },
      snap_loupe_last_hit: { gamepad: 'none', key: 'KeyG' },
      rezero_heatmap: { gamepad: 'none', key: 'KeyZ' },
      toggle_heatmap: { gamepad: 'triangle', key: 'KeyH' },
      toggle_pip: { gamepad: 'none', key: 'KeyL' },
      zoom_out: { gamepad: 'l1', key: 'Minus' },
      zoom_in: { gamepad: 'r1', key: 'Equal' },
      reticle_scale_down: { gamepad: 'dpad-down', key: 'BracketLeft' },
      reticle_scale_up: { gamepad: 'dpad-up', key: 'BracketRight' },
      toggle_dpad_mode: { gamepad: 'none', key: 'KeyU' },
      instant_replay: { gamepad: 'share', key: 'KeyR' },
      capture_snapshot: { gamepad: 'none', key: 'KeyN' },
      return_live: { gamepad: 'circle', key: 'KeyB' }
    },
    calibration: {
      leftStickDeadzone: 16,
      rightStickDeadzone: 16,
      leftStickInvertY: false,
      rightStickInvertY: false,
      touchpadSensitivity: 50,
      reticleAimSpeed: 50,
      ringPanSpeed: 70
    }
  }
};

// Backwards-compatibility export
export const PROFILES = BUILT_IN_PROFILES;

export function getProfile(id) {
  const profileKey = id || appState.activeControllerProfile || 'default';
  if (appState.customControllerProfiles && appState.customControllerProfiles[profileKey]) {
    return appState.customControllerProfiles[profileKey];
  }
  return BUILT_IN_PROFILES[profileKey] || BUILT_IN_PROFILES.default;
}

export function getActiveBindings() {
  const base = {};
  for (const act of ACTION_DEFINITIONS) {
    base[act.id] = { gamepad: act.defaultGamepad, key: act.defaultKey };
  }
  const source =
    appState.controllerBindings && typeof appState.controllerBindings === 'object'
      ? appState.controllerBindings
      : getProfile(appState.activeControllerProfile).bindings || {};
  for (const [actId, binding] of Object.entries(source)) {
    if (binding && typeof binding === 'object') {
      base[actId] = {
        gamepad: binding.gamepad ?? base[actId]?.gamepad ?? 'none',
        key: binding.key ?? base[actId]?.key ?? 'none'
      };
    }
  }
  return base;
}

let activeRebindActionId = null;
let activeRebindType = null; // 'gamepad' | 'key'
let microLearnSlotId = null;
let rebindTimeout = null;
let isControllerScreenInitialized = false;

if (typeof window !== 'undefined') {
  window.isSpotrRebindingKey = () => Boolean(activeRebindActionId || microLearnSlotId);
}

export function initControllerScreen() {
  if (isControllerScreenInitialized) return;
  isControllerScreenInitialized = true;

  const screenController = document.getElementById('screenController');
  const screenSettings = document.getElementById('screenSettings');
  const screenLive = document.getElementById('screenLive');
  const screenReticle = document.getElementById('screenReticle');
  const btnControllerToReticle = document.getElementById('btnControllerToReticle');
  const btnProfileOverflow = document.getElementById('btnProfileOverflow');
  const profileOverflowMenu = document.getElementById('profileOverflowMenu');
  const inputMappingSearch = document.getElementById('inputMappingSearch');
  let activeSearchQuery = '';
  let activeSchematicFilter = '';

  const btnBackToSettings = document.getElementById('btnControllerBackToSettings');
  const btnBackToLive = document.getElementById('btnControllerBackToLive');
  const btnResetDefaults = document.getElementById('btnResetControllerBindings');
  const selectProfile = document.getElementById('selectControllerProfile');
  const btnNewProfile = document.getElementById('btnNewProfile');
  const btnSaveProfile = document.getElementById('btnSaveProfile');
  const btnDeleteProfile = document.getElementById('btnDeleteProfile');
  const btnExportProfile = document.getElementById('btnExportProfile');
  const btnImportProfile = document.getElementById('btnImportProfile');
  const inputImportProfile = document.getElementById('inputImportProfile');

  // Modal dialog elements
  const modalProfileName = document.getElementById('modalProfileName');
  const btnCloseProfileModal = document.getElementById('btnCloseProfileModal');
  const btnCancelProfileModal = document.getElementById('btnCancelProfileModal');
  const btnConfirmProfileModal = document.getElementById('btnConfirmProfileModal');
  const inputNewProfileName = document.getElementById('inputNewProfileName');

  let isProfileDirty = false;

  // Stick calibration sliders
  const sliderLeftDeadzone = document.getElementById('sliderLeftStickDeadzone');
  const valLeftDeadzone = document.getElementById('valLeftStickDeadzone');
  const sliderRightDeadzone = document.getElementById('sliderRightStickDeadzone');
  const valRightDeadzone = document.getElementById('valRightStickDeadzone');
  const btnInvertLeftY = document.getElementById('btnToggleInvertLeftY');
  const btnInvertRightY = document.getElementById('btnToggleInvertRightY');

  const sliderTouchpadSens = document.getElementById('sliderControllerTouchpadSens');
  const valTouchpadSens = document.getElementById('valControllerTouchpadSens');
  const sliderAimSpeed = document.getElementById('sliderControllerAimSpeed');
  const valAimSpeed = document.getElementById('valControllerAimSpeed');
  const sliderRemotePanSpeed = document.getElementById('sliderRemotePanSpeed');
  const valRemotePanSpeed = document.getElementById('valRemotePanSpeed');

  const mappingTableBody = document.getElementById('controllerMappingTableBody');
  const categoryFilters = document.querySelectorAll('.mapping-cat-btn');

  let activeCategoryFilter = 'all';

  // Navigation handlers
  btnBackToSettings?.addEventListener('click', () => {
    cancelRebinding();
    screenController?.classList.add('hidden');
    screenSettings?.classList.remove('hidden');
    updateState({ currentScreen: 'settings' });
  });

  document.querySelectorAll('.setup-jump-calibration').forEach((btn) => {
    btn.addEventListener('click', () => {
      cancelRebinding();
      profileOverflowMenu?.classList.add('hidden');
    });
  });

  btnControllerToReticle?.addEventListener('click', () => {
    cancelRebinding();
    profileOverflowMenu?.classList.add('hidden');
    screenController?.classList.add('hidden');
    screenReticle?.classList.remove('hidden');
    updateState({ currentScreen: 'reticle' });
  });

  // Profile Overflow Dropdown Menu
  btnProfileOverflow?.addEventListener('click', (e) => {
    e.stopPropagation();
    profileOverflowMenu?.classList.toggle('hidden');
  });
  profileOverflowMenu?.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      profileOverflowMenu.classList.add('hidden');
    });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.cm-overflow-wrap')) {
      profileOverflowMenu?.classList.add('hidden');
    }
  });

  // Search filter + Interactive Schematic Button Click-to-Filter
  inputMappingSearch?.addEventListener('input', (e) => {
    activeSearchQuery = (e.target.value || '').trim().toLowerCase();
    renderMappingTable();
  });

  document.querySelectorAll('.cm-visual-btn[data-gp]').forEach((badge) => {
    badge.style.cursor = 'pointer';
    badge.title = 'Click to filter bindings by this button';
    badge.addEventListener('click', () => {
      const role = badge.dataset.gp || '';
      activeSchematicFilter = activeSchematicFilter === role ? '' : role;
      document.querySelectorAll('.cm-visual-btn[data-gp]').forEach((b) => {
        b.classList.toggle('cm-filter-selected', Boolean(activeSchematicFilter && b.dataset.gp === activeSchematicFilter));
      });
      renderMappingTable();
    });
  });

  btnBackToLive?.addEventListener('click', () => {
    cancelRebinding();
    screenController?.classList.add('hidden');
    screenLive?.classList.remove('hidden');
    updateState({ currentScreen: 'live' });
  });

  // -------------------------------------------------------------------------
  // UNIFIED PROFILE MANAGEMENT (Gamepad + BT Remote + Calibration)
  // -------------------------------------------------------------------------

  function markProfileDirty() {
    if (!isProfileDirty) {
      isProfileDirty = true;
      refreshProfileDropdown();
    }
  }

  function refreshProfileDropdown() {
    if (!selectProfile) return;
    const optBuiltIn = document.getElementById('optgroupBuiltInProfiles') || selectProfile;
    const optCustom = document.getElementById('optgroupCustomProfiles');

    const activeId = appState.activeControllerProfile || 'default';
    const customMap = appState.customControllerProfiles || {};

    // Update Built-in options
    if (optBuiltIn) {
      Object.keys(BUILT_IN_PROFILES).forEach((k) => {
        const opt = optBuiltIn.querySelector(`option[value="${k}"]`);
        if (opt) {
          const baseName = BUILT_IN_PROFILES[k].name;
          opt.textContent = (k === activeId && isProfileDirty) ? `${baseName} *` : baseName;
        }
      });
    }

    // Populate Custom options
    if (optCustom) {
      const customKeys = Object.keys(customMap);
      if (customKeys.length === 0) {
        optCustom.innerHTML = '<option value="" disabled>(No custom profiles yet)</option>';
      } else {
        optCustom.innerHTML = customKeys.map((k) => {
          const p = customMap[k];
          const isMod = (k === activeId && isProfileDirty);
          const safeName = escapeHtmlStr(p.name || 'Untitled Profile');
          return `<option value="${escapeHtmlStr(k)}">${safeName}${isMod ? ' *' : ''}</option>`;
        }).join('');
      }
    }

    selectProfile.value = activeId;

    // Delete button: enabled ONLY for custom profiles (protect built-in factory presets)
    if (btnDeleteProfile) {
      const isCustom = Boolean(customMap[activeId]);
      btnDeleteProfile.disabled = !isCustom;
      btnDeleteProfile.style.opacity = isCustom ? '1' : '0.45';
      btnDeleteProfile.style.cursor = isCustom ? 'pointer' : 'not-allowed';
    }

    // Save button: pulse highlight when unsaved changes exist
    if (btnSaveProfile) {
      btnSaveProfile.classList.toggle('radar-btn-active', isProfileDirty);
    }
  }

  function loadProfile(profileId, showToast = true) {
    const prof = getProfile(profileId);
    if (!prof) return;

    const newBindings = JSON.parse(JSON.stringify(prof.bindings || {}));
    const isMicro = profileId === '8bitdo_micro';
    const newRingMap = isMicro
      ? {}
      : JSON.parse(JSON.stringify(prof.ringKeyMap || DEFAULT_RING_KEY_MAP));
    const cal = prof.calibration || {};

    updateState({
      activeControllerProfile: profileId,
      controllerBindings: newBindings,
      ringKeyMap: newRingMap,
      ...(isMicro ? { ringEnabled: false } : {}),
      leftStickDeadzone: cal.leftStickDeadzone ?? 16,
      rightStickDeadzone: cal.rightStickDeadzone ?? 16,
      leftStickInvertY: Boolean(cal.leftStickInvertY),
      rightStickInvertY: Boolean(cal.rightStickInvertY),
      touchpadSensitivity: cal.touchpadSensitivity ?? 50,
      reticleAimSpeed: cal.reticleAimSpeed ?? 50,
      ringPanSpeed: cal.ringPanSpeed ?? 70
    });

    saveSettings(appState);
    isProfileDirty = false;

    refreshProfileDropdown();
    syncCalibrationSliders();
    renderMappingTable();
    renderRemoteTable();
    if (typeof renderMicroTable === 'function') renderMicroTable();
    if (typeof syncMicroStateUI === 'function') syncMicroStateUI();

    if (showToast) {
      showToastBanner(`PROFILE LOADED: "${prof.name.toUpperCase()}"`);
    }
  }

  function handleSaveProfile() {
    const activeId = appState.activeControllerProfile || 'default';
    const customMap = appState.customControllerProfiles || {};

    // If active profile is a built-in factory preset, prompt user to Save as New Custom Profile
    if (!customMap[activeId]) {
      const builtIn = BUILT_IN_PROFILES[activeId] || BUILT_IN_PROFILES.default;
      openProfileModal(`${builtIn.name} (Custom)`);
      return;
    }

    // Save changes back to the active custom profile
    const prof = customMap[activeId];
    prof.bindings = JSON.parse(JSON.stringify(getActiveBindings()));
    prof.ringKeyMap = JSON.parse(JSON.stringify(appState.ringKeyMap || {}));
    prof.calibration = {
      leftStickDeadzone: appState.leftStickDeadzone ?? 16,
      rightStickDeadzone: appState.rightStickDeadzone ?? 16,
      leftStickInvertY: Boolean(appState.leftStickInvertY),
      rightStickInvertY: Boolean(appState.rightStickInvertY),
      touchpadSensitivity: appState.touchpadSensitivity ?? 50,
      reticleAimSpeed: appState.reticleAimSpeed ?? 50,
      ringPanSpeed: appState.ringPanSpeed ?? 70
    };
    prof.updatedAt = Date.now();

    updateState({ customControllerProfiles: { ...customMap } });
    saveSettings(appState);
    isProfileDirty = false;

    refreshProfileDropdown();
    showToastBanner(`PROFILE SAVED: "${prof.name.toUpperCase()}"`);
  }

  function openProfileModal(defaultName = '') {
    if (!modalProfileName || !inputNewProfileName) return;
    const count = Object.keys(appState.customControllerProfiles || {}).length + 1;
    inputNewProfileName.value = defaultName || `Custom Profile ${count}`;
    modalProfileName.classList.remove('hidden');
    setTimeout(() => {
      inputNewProfileName.focus();
      inputNewProfileName.select();
    }, 60);
  }

  function closeProfileModal() {
    if (modalProfileName) {
      modalProfileName.classList.add('hidden');
    }
  }

  function confirmCreateProfile() {
    if (!inputNewProfileName) return;
    const name = inputNewProfileName.value.trim();
    if (!name) {
      showToastBanner('PLEASE ENTER A VALID PROFILE NAME');
      return;
    }

    const id = `custom_${Date.now()}`;
    const customMap = appState.customControllerProfiles || {};

    customMap[id] = {
      id,
      name,
      isBuiltIn: false,
      createdAt: Date.now(),
      bindings: JSON.parse(JSON.stringify(getActiveBindings())),
      ringKeyMap: JSON.parse(JSON.stringify(appState.ringKeyMap || {})),
      calibration: {
        leftStickDeadzone: appState.leftStickDeadzone ?? 16,
        rightStickDeadzone: appState.rightStickDeadzone ?? 16,
        leftStickInvertY: Boolean(appState.leftStickInvertY),
        rightStickInvertY: Boolean(appState.rightStickInvertY),
        touchpadSensitivity: appState.touchpadSensitivity ?? 50,
        reticleAimSpeed: appState.reticleAimSpeed ?? 50,
      ringPanSpeed: appState.ringPanSpeed ?? 70
      }
    };

    updateState({
      customControllerProfiles: { ...customMap },
      activeControllerProfile: id
    });
    saveSettings(appState);
    isProfileDirty = false;

    closeProfileModal();
    refreshProfileDropdown();
    showToastBanner(`CREATED PROFILE: "${name.toUpperCase()}"`);
  }

  function handleDeleteProfile() {
    const activeId = appState.activeControllerProfile;
    const customMap = appState.customControllerProfiles || {};
    const prof = customMap[activeId];
    if (!prof) {
      showToastBanner('CANNOT DELETE BUILT-IN FACTORY PRESETS');
      return;
    }

    const confirmed = window.confirm(`Delete profile "${prof.name}"?`);
    if (!confirmed) return;

    delete customMap[activeId];
    updateState({
      customControllerProfiles: { ...customMap },
      activeControllerProfile: 'default'
    });
    saveSettings(appState);
    loadProfile('default', false);
    showToastBanner(`DELETED PROFILE: "${prof.name.toUpperCase()}"`);
  }

  function exportProfilesJson() {
    const exportData = {
      app: 'SPOTR',
      type: 'controller_profiles',
      version: '2.0',
      exportedAt: new Date().toISOString(),
      activeProfile: appState.activeControllerProfile || 'default',
      customProfiles: appState.customControllerProfiles || {},
      activeConfiguration: {
        bindings: getActiveBindings(),
        ringKeyMap: appState.ringKeyMap || {},
        calibration: {
          leftStickDeadzone: appState.leftStickDeadzone ?? 16,
          rightStickDeadzone: appState.rightStickDeadzone ?? 16,
          leftStickInvertY: Boolean(appState.leftStickInvertY),
          rightStickInvertY: Boolean(appState.rightStickInvertY),
          touchpadSensitivity: appState.touchpadSensitivity ?? 50,
          reticleAimSpeed: appState.reticleAimSpeed ?? 50,
      ringPanSpeed: appState.ringPanSpeed ?? 70
        }
      }
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spotr-controller-profiles-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToastBanner('EXPORTED PROFILES TO JSON FILE');
  }

  function handleImportFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);
        let importedCount = 0;
        const customMap = { ...(appState.customControllerProfiles || {}) };
        const forbiddenIds = new Set(['__proto__', 'constructor', 'prototype', ...Object.keys(BUILT_IN_PROFILES)]);

        if (data.customProfiles && typeof data.customProfiles === 'object') {
          Object.entries(data.customProfiles).forEach(([id, prof]) => {
            if (forbiddenIds.has(id)) return;
            if (prof && prof.name && (prof.bindings || prof.ringKeyMap)) {
              customMap[id] = prof;
              importedCount++;
            }
          });
        }
        if (importedCount === 0 && data.activeConfiguration && (data.activeConfiguration.bindings || data.activeConfiguration.ringKeyMap)) {
          const id = `custom_${Date.now()}`;
          customMap[id] = {
            id,
            name: data.name || file.name.replace(/\.json$/i, ''),
            isBuiltIn: false,
            createdAt: Date.now(),
            bindings: data.activeConfiguration.bindings || {},
            ringKeyMap: data.activeConfiguration.ringKeyMap || {},
            calibration: data.activeConfiguration.calibration || {}
          };
          importedCount = 1;
        } else if (importedCount === 0 && (data.bindings || data.ringKeyMap)) {
          const id = `custom_${Date.now()}`;
          customMap[id] = {
            id,
            name: data.name || file.name.replace(/\.json$/i, ''),
            isBuiltIn: false,
            createdAt: Date.now(),
            bindings: data.bindings || {},
            ringKeyMap: data.ringKeyMap || {},
            calibration: data.calibration || {}
          };
          importedCount = 1;
        }

        if (importedCount === 0) {
          showToastBanner('NO VALID PROFILES FOUND IN FILE');
          return;
        }

        updateState({ customControllerProfiles: { ...customMap } });
        saveSettings(appState);
        refreshProfileDropdown();
        showToastBanner(`IMPORTED ${importedCount} PROFILE${importedCount > 1 ? 'S' : ''} SUCCESSFULLY`);
      } catch (err) {
        showToastBanner('ERROR: FAILED TO PARSE JSON FILE');
      }
    };
    reader.readAsText(file);
  }

  // Profile Event Listeners
  selectProfile?.addEventListener('change', (e) => {
    loadProfile(e.target.value);
  });

  btnNewProfile?.addEventListener('click', () => openProfileModal());
  btnSaveProfile?.addEventListener('click', () => handleSaveProfile());
  btnDeleteProfile?.addEventListener('click', () => handleDeleteProfile());
  btnExportProfile?.addEventListener('click', () => exportProfilesJson());
  btnImportProfile?.addEventListener('click', () => inputImportProfile?.click());
  inputImportProfile?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (file) {
      handleImportFile(file);
      e.target.value = '';
    }
  });

  // Modal dialog listeners
  btnCloseProfileModal?.addEventListener('click', () => closeProfileModal());
  btnCancelProfileModal?.addEventListener('click', () => closeProfileModal());
  btnConfirmProfileModal?.addEventListener('click', () => confirmCreateProfile());
  inputNewProfileName?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmCreateProfile();
    if (e.key === 'Escape') closeProfileModal();
  });

  // Reset to default
  btnResetDefaults?.addEventListener('click', () => {
    const defaultBindings = JSON.parse(JSON.stringify(BUILT_IN_PROFILES.default.bindings));
    const defaultRingMap = JSON.parse(JSON.stringify(DEFAULT_RING_KEY_MAP));
    updateState({
      activeControllerProfile: 'default',
      controllerBindings: defaultBindings,
      microSlotActions: {},
      ringKeyMap: defaultRingMap,
      leftStickDeadzone: 16,
      rightStickDeadzone: 16,
      leftStickInvertY: false,
      rightStickInvertY: false,
      touchpadSensitivity: 50,
      reticleAimSpeed: 50,
      ringPanSpeed: 70
    });
    saveSettings(appState);
    isProfileDirty = false;
    refreshProfileDropdown();
    syncCalibrationSliders();
    renderMappingTable();
    renderRemoteTable();
    if (typeof renderMicroTable === 'function') renderMicroTable();
    if (typeof syncMicroStateUI === 'function') syncMicroStateUI();
    showToastBanner('ALL MAPPINGS & CALIBRATION RESET TO FACTORY DEFAULTS');
  });

  // Category filter buttons
  categoryFilters.forEach((btn) => {
    btn.addEventListener('click', () => {
      categoryFilters.forEach((b) => b.classList.remove('radar-btn-active'));
      btn.classList.add('radar-btn-active');
      activeCategoryFilter = btn.dataset.cat || 'all';
      renderMappingTable();
    });
  });

  // Stick Deadzone & Sensitivity listeners
  sliderLeftDeadzone?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (valLeftDeadzone) valLeftDeadzone.textContent = `${v}%`;
    updateState({ leftStickDeadzone: v });
    saveSettings(appState);
    markProfileDirty();
  });

  sliderRightDeadzone?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (valRightDeadzone) valRightDeadzone.textContent = `${v}%`;
    updateState({ rightStickDeadzone: v });
    saveSettings(appState);
    markProfileDirty();
  });

  btnInvertLeftY?.addEventListener('click', () => {
    const nextVal = !appState.leftStickInvertY;
    updateState({ leftStickInvertY: nextVal });
    btnInvertLeftY.textContent = nextVal ? 'INVERTED (ON)' : 'NORMAL (OFF)';
    btnInvertLeftY.classList.toggle('radar-btn-active', nextVal);
    saveSettings(appState);
    markProfileDirty();
  });

  btnInvertRightY?.addEventListener('click', () => {
    const nextVal = !appState.rightStickInvertY;
    updateState({ rightStickInvertY: nextVal });
    btnInvertRightY.textContent = nextVal ? 'INVERTED (ON)' : 'NORMAL (OFF)';
    btnInvertRightY.classList.toggle('radar-btn-active', nextVal);
    saveSettings(appState);
    markProfileDirty();
  });

  sliderTouchpadSens?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (valTouchpadSens) valTouchpadSens.textContent = `${v}%`;
    updateState({ touchpadSensitivity: v });
    saveSettings(appState);
    markProfileDirty();
  });

  sliderAimSpeed?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (valAimSpeed) valAimSpeed.textContent = `${v}%`;
    updateState({ reticleAimSpeed: v });
    saveSettings(appState);
    markProfileDirty();
  });

  sliderRemotePanSpeed?.addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (valRemotePanSpeed) valRemotePanSpeed.textContent = `${v}%`;
    updateState({ ringPanSpeed: v });
    saveSettings(appState);
    markProfileDirty();
  });

  function syncCalibrationSliders() {
    if (sliderLeftDeadzone && valLeftDeadzone) {
      sliderLeftDeadzone.value = appState.leftStickDeadzone ?? 16;
      valLeftDeadzone.textContent = `${appState.leftStickDeadzone ?? 16}%`;
    }
    if (sliderRightDeadzone && valRightDeadzone) {
      sliderRightDeadzone.value = appState.rightStickDeadzone ?? 16;
      valRightDeadzone.textContent = `${appState.rightStickDeadzone ?? 16}%`;
    }
    if (btnInvertLeftY) {
      btnInvertLeftY.textContent = appState.leftStickInvertY ? 'INVERTED (ON)' : 'NORMAL (OFF)';
      btnInvertLeftY.classList.toggle('radar-btn-active', Boolean(appState.leftStickInvertY));
    }
    if (btnInvertRightY) {
      btnInvertRightY.textContent = appState.rightStickInvertY ? 'INVERTED (ON)' : 'NORMAL (OFF)';
      btnInvertRightY.classList.toggle('radar-btn-active', Boolean(appState.rightStickInvertY));
    }
    if (sliderTouchpadSens && valTouchpadSens) {
      sliderTouchpadSens.value = appState.touchpadSensitivity ?? 50;
      valTouchpadSens.textContent = `${appState.touchpadSensitivity ?? 50}%`;
    }
    if (sliderAimSpeed && valAimSpeed) {
      sliderAimSpeed.value = appState.reticleAimSpeed ?? 50;
      valAimSpeed.textContent = `${appState.reticleAimSpeed ?? 50}%`;
    }
    if (sliderRemotePanSpeed && valRemotePanSpeed) {
      sliderRemotePanSpeed.value = appState.ringPanSpeed ?? 70;
      valRemotePanSpeed.textContent = `${appState.ringPanSpeed ?? 70}%`;
    }
  }

  // Keyboard capture for rebinding (Gamepad matrix + 8BitDo Micro 16-slot matrix)
  window.addEventListener('keydown', (e) => {
    if (appState.currentScreen !== 'controller') return;
    if (microLearnSlotId) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') {
        microLearnSlotId = null;
        renderMicroTable();
        showToastBanner('MICRO KEY LEARNING CANCELLED');
        return;
      }
      const learnedCode = e.code || e.key;
      const slot = MICRO_BUTTON_DEFS.find((d) => d.id === microLearnSlotId);
      const actionId = getMicroSlotAction(microLearnSlotId);
      const nextBindings = JSON.parse(JSON.stringify(getActiveBindings()));
      const def = ACTION_DEFINITIONS.find((a) => a.id === actionId);
      if (!nextBindings[actionId]) {
        nextBindings[actionId] = { gamepad: def?.defaultGamepad || 'none', key: learnedCode };
      } else {
        nextBindings[actionId].key = learnedCode;
      }
      microLearnSlotId = null;
      updateState({ controllerBindings: nextBindings });
      saveSettings(appState);
      markProfileDirty();
      renderMicroTable();
      renderMappingTable();
      showToastBanner(`MICRO [${slot?.label || actionId}] → ${formatKeyLabel(learnedCode)}`);
      return;
    }

    if (activeRebindActionId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRebinding();
        return;
      }
      if (activeRebindType === 'key') {
        e.preventDefault();
        assignBinding(activeRebindActionId, 'key', e.code || e.key);
      }
    }
  });

  // Global keyboard shortcuts driven by active bindings (screen-scoped so Setup/Calibration aren't hijacked)
  const CONTINUOUS_ACTIONS = new Set([
    'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
    'reticle_scale_up', 'reticle_scale_down', 'step_forward', 'step_backward'
  ]);
  const NAV_ONLY_ACTIONS = new Set(['open_settings', 'return_live']);

  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return;
    if (activeRebindActionId || microLearnSlotId) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.key === 'F12') return;

    const screen = appState.currentScreen;
    const code = e.code || e.key;
    const currentBindings = getActiveBindings();

    // Direct support for ArrowKeys (aim_reticle) & WASD (pan_view) only on Live feed
    if (screen === 'live') {
      if (currentBindings.aim_reticle?.key === 'ArrowKeys' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(code)) {
        e.preventDefault();
        const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
        const [dx, dy] = map[code];
        steerViewOrLoupe('aim', dx, dy);
        return;
      }
      if (currentBindings.pan_view?.key === 'KeyW/A/S/D' && ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(code)) {
        e.preventDefault();
        const map = { KeyW: [0, -1], KeyS: [0, 1], KeyA: [-1, 0], KeyD: [1, 0] };
        const [dx, dy] = map[code];
        steerViewOrLoupe('pan', dx, dy);
        return;
      }
    }

    const matchingEntries = Object.entries(currentBindings).filter(([actId, b]) => {
      if (!b.key || b.key === 'none') return false;
      return b.key === code || b.key === e.key;
    });

    let entry = null;
    if (matchingEntries.length === 1) {
      entry = matchingEntries[0];
    } else if (matchingEntries.length > 1) {
      if (screen === 'gallery') {
        entry = matchingEntries.find(([id]) => ACTION_DEFINITIONS.find((a) => a.id === id)?.category === 'playback') || matchingEntries[0];
      } else {
        entry = matchingEntries.find(([id]) => ACTION_DEFINITIONS.find((a) => a.id === id)?.category !== 'playback') || matchingEntries[0];
      }
    }

    if (entry) {
      const actionId = entry[0];
      // Prevent Live-only shortcuts from firing behind Setup/Reticle/Calibration/Controller screens
      if (screen !== 'live' && screen !== 'gallery' && !NAV_ONLY_ACTIONS.has(actionId)) {
        return;
      }
      if (e.repeat && !CONTINUOUS_ACTIONS.has(actionId)) {
        e.preventDefault();
        return;
      }
      e.preventDefault();

      // Glow matching 8BitDo Micro schematic button if visible
      const matchedMicro = MICRO_BUTTON_DEFS.find((d) => getMicroSlotAction(d.id) === actionId);
      if (matchedMicro) {
        const vBtn = document.querySelector(`.micro-visual-btn[data-micro-btn="${matchedMicro.id}"]`);
        if (vBtn) {
          vBtn.classList.add('micro-active-glow');
          setTimeout(() => vBtn.classList.remove('micro-active-glow'), 240);
        }
        const sigEl = document.getElementById('microLastSignal');
        if (sigEl) sigEl.textContent = `${matchedMicro.label} (${formatKeyLabel(code)}) → ${actionId.toUpperCase()}`;
      }

      executeMappedAction(actionId);
    }
  });

  function renderMappingTable() {
    if (!mappingTableBody) return;
    const currentBindings = getActiveBindings();

    const filtered = ACTION_DEFINITIONS.filter((act) => {
      if (activeCategoryFilter !== 'all' && act.category !== activeCategoryFilter) return false;
      const boundCheck = currentBindings[act.id] || { gamepad: act.defaultGamepad, key: act.defaultKey };
      if (activeSchematicFilter && (boundCheck.gamepad || 'none') !== activeSchematicFilter) return false;
      if (activeSearchQuery) {
        const hay = `${act.name} ${act.desc} ${boundCheck.gamepad || ''} ${boundCheck.key || ''}`.toLowerCase();
        if (!hay.includes(activeSearchQuery)) return false;
      }
      return true;

    });

    let html = '';
    filtered.forEach((act) => {
      const bound = currentBindings[act.id] || { gamepad: act.defaultGamepad, key: act.defaultKey };
      const gpBadge = formatBindingLabel(bound.gamepad || 'none');
      const keyBadge = formatKeyLabel(bound.key || 'none');
      const isRebindingGp = activeRebindActionId === act.id && activeRebindType === 'gamepad';
      const isRebindingKey = activeRebindActionId === act.id && activeRebindType === 'key';

      html += `
        <tr class="mapping-row ${isRebindingGp || isRebindingKey ? 'row-rebinding' : ''}" data-act="${act.id}">
          <td class="action-cell">
            <div class="action-name">${act.name}</div>
            <div class="action-desc">${act.desc}</div>
          </td>
          <td class="binding-cell">
            <button class="rebind-btn gp-rebind-btn ${isRebindingGp ? 'rebinding-pulse' : ''}" data-act="${act.id}" data-type="gamepad" title="Click to rebind controller button">
              ${isRebindingGp ? '⚡ PRESS BUTTON...' : gpBadge}
            </button>
          </td>
          <td class="binding-cell">
            <button class="rebind-btn key-rebind-btn ${isRebindingKey ? 'rebinding-pulse' : ''}" data-act="${act.id}" data-type="key" title="Click to rebind keyboard key">
              ${isRebindingKey ? '⚡ PRESS KEY...' : keyBadge}
            </button>
          </td>
          <td class="action-ops-cell">
            <button class="radar-btn radar-btn-sm btn-reset-single" data-act="${act.id}" title="Reset to default">↺</button>
          </td>
        </tr>
      `;
    });

    mappingTableBody.innerHTML = html;

    // Attach click listeners for rebind buttons
    mappingTableBody.querySelectorAll('.gp-rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actId = btn.dataset.act;
        startRebinding(actId, 'gamepad');
      });
    });

    mappingTableBody.querySelectorAll('.key-rebind-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actId = btn.dataset.act;
        startRebinding(actId, 'key');
      });
    });

    mappingTableBody.querySelectorAll('.btn-reset-single').forEach((btn) => {
      btn.addEventListener('click', () => {
        const actId = btn.dataset.act;
        const actDef = ACTION_DEFINITIONS.find((a) => a.id === actId);
        if (actDef) {
          const current = getActiveBindings();
          current[actId] = { gamepad: actDef.defaultGamepad, key: actDef.defaultKey };
          updateState({ controllerBindings: current });
          saveSettings(appState);
          markProfileDirty();
          renderMappingTable();
          showToastBanner(`RESET "${actDef.name.toUpperCase()}" TO DEFAULT`);
        }
      });
    });
  }

  function startRebinding(actionId, type) {
    activeRebindActionId = actionId;
    activeRebindType = type;
    renderMappingTable();
    const actDef = ACTION_DEFINITIONS.find((a) => a.id === actionId);
    const target = type === 'gamepad' ? 'ANY CONTROLLER BUTTON / TRIGGER' : 'ANY KEYBOARD KEY';
    showToastBanner(`REBINDING: PRESS ${target} FOR "${actDef?.name.toUpperCase()}" (OR ESC TO CANCEL)`);

    clearTimeout(rebindTimeout);
    rebindTimeout = setTimeout(() => {
      cancelRebinding();
    }, 15000); // 15s timeout
  }

  function cancelRebinding() {
    let cancelledAny = false;
    if (activeRebindActionId) {
      activeRebindActionId = null;
      activeRebindType = null;
      clearTimeout(rebindTimeout);
      renderMappingTable();
      cancelledAny = true;
    }
    if (microLearnSlotId) {
      microLearnSlotId = null;
      if (typeof renderMicroTable === 'function') renderMicroTable();
      cancelledAny = true;
    }
    if (getLearningAction()) {
      setLearningAction(null);
      if (typeof renderRemoteTable === 'function') renderRemoteTable();
      cancelledAny = true;
    }
    if (cancelledAny) {
      showToastBanner('REBINDING CANCELLED');
    }
  }

  function assignBinding(actionId, type, rawValue) {
    const actDef = ACTION_DEFINITIONS.find((a) => a.id === actionId);
    if (!actDef) return;

    const current = getActiveBindings();
    if (!current[actionId]) {
      current[actionId] = { gamepad: actDef.defaultGamepad, key: actDef.defaultKey };
    }

    if (type === 'gamepad') {
      current[actionId].gamepad = rawValue;
    } else {
      current[actionId].key = rawValue;
    }

    activeRebindActionId = null;
    activeRebindType = null;
    clearTimeout(rebindTimeout);

    updateState({ controllerBindings: current });
    saveSettings(appState);
    markProfileDirty();
    renderMappingTable();
    showToastBanner(`BOUND ${rawValue.toUpperCase()} TO "${actDef.name.toUpperCase()}"`);
  }

  // Cache .cm-visual-btn badges to avoid 250Hz DOM queries during WebHID streaming
  const visualBtnCache = new Map();
  document.querySelectorAll('.cm-visual-btn[data-gp]').forEach((el) => {
    if (el.dataset.gp) visualBtnCache.set(el.dataset.gp, el);
  });

  // Export internal API for gamepadController to feed button presses when rebinding
  window.controllerMappingAPI = {
    isRebinding: () => Boolean(activeRebindActionId && activeRebindType === 'gamepad'),
    captureGamepadButton: (role) => {
      if (activeRebindActionId && activeRebindType === 'gamepad') {
        assignBinding(activeRebindActionId, 'gamepad', role);
        return true;
      }
      return false;
    },
    highlightGamepadInput: (role, pressed) => {
      const badge = visualBtnCache.get(role);
      if (badge) {
        badge.classList.toggle('cm-active-glow', pressed);
      }
    },
    updateLiveActionBanner: (role, mappedActionName) => {
      const banner = document.getElementById('cmLiveActionBanner');
      if (banner) {
        banner.textContent = `LAST INPUT: ${role.toUpperCase()} → ${mappedActionName ? mappedActionName.toUpperCase() : 'NO ACTION BOUND'}`;
      }
    }
  };

  syncCalibrationSliders();
  renderMappingTable();

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // CONSOLIDATED BLUETOOTH RING & REMOTE INTEGRATION (Option B: Tactical Matrix)
  // -------------------------------------------------------------------------
  const tabBtnGamepad = document.getElementById('tabBtnGamepad');
  const tabBtnRemote = document.getElementById('tabBtnRemote');
  const tabBtnMicro = document.getElementById('tabBtnMicro');
  const viewGamepadConfig = document.getElementById('viewGamepadConfig');
  const viewRemoteConfig = document.getElementById('viewRemoteConfig');
  const viewMicroConfig = document.getElementById('viewMicroConfig');
  const microMappingTableBody = document.getElementById('microMappingTableBody');
  const btnMicroDpadMode = document.getElementById('btnMicroDpadMode');
  const btnApplyMicroPreset = document.getElementById('btnApplyMicroPreset');
  const btnResetMicroPreset = document.getElementById('btnResetMicroPreset');
  const microSvgContainer = document.getElementById('microSvgContainer');
  const remoteMappingTableBody = document.getElementById('remoteMappingTableBody');
  const btnToggleRingEnabled = document.getElementById('btnToggleRingEnabled');
  const ringIsolationNotice = document.getElementById('ringIsolationNotice');
  const btnToggleFfpTab = document.getElementById('btnToggleFfpTab');
  const btnResetRemoteTabMap = document.getElementById('btnResetRemoteTabMap');
  const remoteLastSignalText = document.getElementById('remoteLastSignalText');
  const remoteSvgContainer = document.getElementById('remoteSvgContainer');

  btnToggleRingEnabled?.addEventListener('click', () => {
    const next = !appState.ringEnabled;
    if (next && appState.activeControllerProfile === '8bitdo_micro') {
      // Switch away from 8BitDo Micro profile so Ring and Micro never conflict
      updateState({ ringEnabled: true, activeControllerProfile: 'default' });
      refreshProfileDropdown();
      showToastBanner('BLUETOOTH RING ENABLED (ISOLATED FROM 8BITDO MICRO)');
    } else {
      updateState({ ringEnabled: next });
      showToastBanner(next ? 'BLUETOOTH RING ENABLED' : 'BLUETOOTH RING ISOLATED (OFF)');
    }
    saveSettings(appState);
    syncRemoteStateUI();
  });

  // Wire interactive click listeners to all buttons on the unified Option B schematic
  remoteSvgContainer?.querySelectorAll('.remote-visual-btn').forEach((vBtn) => {
    vBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const act = vBtn.dataset.remoteAct;
      if (getLearningAction() === act) {
        setLearningAction(null);
      } else {
        setLearningAction(act);
        showToastBanner(`PRESS BUTTON [${act}] ON RING TO BIND (ESC TO CANCEL)`);
      }
      renderRemoteTable();
    });
  });

  function syncRemoteStateUI() {
    const activeMode = getActiveRemoteMode();
    const remoteSingleModeBadge = document.getElementById('remoteSingleModeBadge');
    if (remoteSingleModeBadge) {
      remoteSingleModeBadge.textContent = appState.ringEnabled ? `[ 1:1 ${activeMode} ]` : '[ ISOLATED / OFF ]';
    }
    if (btnToggleRingEnabled) {
      const enabled = Boolean(appState.ringEnabled && appState.activeControllerProfile !== '8bitdo_micro');
      btnToggleRingEnabled.textContent = enabled ? 'BT Ring: ON' : 'BT Ring: OFF (Isolated)';
      btnToggleRingEnabled.classList.toggle('radar-btn-active', enabled);
    }
    if (ringIsolationNotice) {
      const enabled = Boolean(appState.ringEnabled && appState.activeControllerProfile !== '8bitdo_micro');
      ringIsolationNotice.textContent = enabled
        ? 'Bluetooth Ring is ACTIVE on Live & Playback. Keyboard/8BitDo Micro keys matching Ring bindings are routed to the Ring.'
        : 'Bluetooth Ring is ISOLATED (OFF) so 8BitDo Micro and keyboard shortcuts are never hijacked. Enable above when pairing a Ring.';
    }
    if (btnToggleFfpTab) {
      const isLocked = Boolean(appState.reticleFfpMode);
      btnToggleFfpTab.textContent = isLocked ? 'LOCKED 🔒' : 'MANUAL 🔓';
      btnToggleFfpTab.classList.toggle('radar-btn-active', isLocked);
    }
  }

  function renderRemoteTable() {
    if (!remoteMappingTableBody) return;
    const customMap = appState.ringKeyMap || {};
    const activeLearningAct = getLearningAction();

    remoteMappingTableBody.innerHTML = REMOTE_BUTTON_DEFS.map((def) => {
      const isCustom = Boolean(customMap[def.id]);
      const boundKey = customMap[def.id] || def.defaultCodes;
      const isLearning = activeLearningAct === def.id;

      let keyPillsHtml = '';
      if (isLearning) {
        keyPillsHtml = '<span class="remote-key-tag learning">PRESS KEY ON RING/REMOTE...</span>';
      } else {
        const keyList = boundKey.split(',').map((k) => k.trim()).filter(Boolean);
        keyPillsHtml = keyList.map((k, idx) => {
          const pillClass = isCustom ? 'custom' : (idx === 0 ? 'primary' : '');
          return `<span class="remote-key-tag ${pillClass}">${escapeHtmlStr(k)}</span>`;
        }).join('');
      }

      return `
        <tr>
          <td>
            <div style="display:flex; align-items:center; gap:8px;">
              <span class="cm-badge" style="background:rgba(255,107,0,0.15); border:1px solid rgba(255,107,0,0.4); color:var(--radar-primary); font-size:10px; padding:2px 6px; border-radius:4px;">${def.badge}</span>
              <strong style="color:var(--radar-text); font-size:12px;">${def.name}</strong>
            </div>
          </td>
          <td>
            <span style="font-size:12px; color:var(--radar-text-muted);">${def.desc}</span>
          </td>
          <td>
            <div class="remote-key-tags-cell">
              ${keyPillsHtml}
            </div>
          </td>
          <td style="text-align:center;">
            <button class="radar-btn radar-btn-sm remote-learn-btn ${isLearning ? 'radar-btn-active' : ''}" data-remote-act="${def.id}" style="font-size:11px; height:26px; padding:0 10px;">
              ${isLearning ? 'WAITING...' : 'LEARN'}
            </button>
          </td>
        </tr>
      `;
    }).join('');

    remoteMappingTableBody.querySelectorAll('.remote-learn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.remoteAct;
        if (getLearningAction() === act) {
          setLearningAction(null);
        } else {
          setLearningAction(act);
          showToastBanner(`PRESS BUTTON [${act}] ON RING TO CALIBRATE (ESC TO CANCEL)`);
        }
        renderRemoteTable();
      });
    });
  }

  function getMicroSlotAction(slotId) {
    const saved = appState.microSlotActions;
    if (saved && saved[slotId]) return saved[slotId];
    const def = MICRO_BUTTON_DEFS.find((d) => d.id === slotId);
    return def ? def.defaultAction : 'none';
  }

  function syncMicroStateUI() {
    if (!btnMicroDpadMode) return;
    const isAim = appState.dpadMode === 'aim';
    btnMicroDpadMode.textContent = isAim ? 'D-Pad: AIM LOUPE' : 'D-Pad: PAN VIEW';
    btnMicroDpadMode.classList.toggle('radar-btn-active', true);
  }

  function renderMicroTable() {
    if (!microMappingTableBody) return;
    const bindings = getActiveBindings();
    const bindableActions = ACTION_DEFINITIONS.filter((a) => !a.isAnalog);

    microMappingTableBody.innerHTML = MICRO_BUTTON_DEFS.map((def) => {
      const curActionId = getMicroSlotAction(def.id);
      const curKey = bindings[curActionId]?.key || def.defaultKey;
      const isLearning = microLearnSlotId === def.id;
      const optionsHtml = bindableActions.map((a) => (
        `<option value="${a.id}" ${a.id === curActionId ? 'selected' : ''}>${a.name}</option>`
      )).join('');

      return `
        <tr>
          <td><strong style="font-size:12px; font-family:var(--font-mono);">${def.label}</strong></td>
          <td>
            <select class="radar-select micro-action-select" data-micro-btn="${def.id}" style="height:28px; font-size:11px; width:100%;">
              ${optionsHtml}
            </select>
          </td>
          <td>
            <span class="remote-key-tag ${isLearning ? 'learning' : 'primary'}">${isLearning ? 'PRESS KEY...' : formatKeyLabel(curKey)}</span>
          </td>
          <td style="text-align:center;">
            <button type="button" class="radar-btn radar-btn-sm micro-learn-btn ${isLearning ? 'radar-btn-active' : ''}" data-micro-btn="${def.id}" style="font-size:11px; height:26px; padding:0 10px;">
              ${isLearning ? 'WAIT...' : 'LEARN'}
            </button>
          </td>
        </tr>
      `;
    }).join('');

    microMappingTableBody.querySelectorAll('.micro-action-select').forEach((sel) => {
      sel.addEventListener('change', () => {
        const slotId = sel.dataset.microBtn;
        const prevActionId = getMicroSlotAction(slotId);
        const nextSlotMap = Object.assign({}, appState.microSlotActions || {}, { [slotId]: sel.value });
        const slot = MICRO_BUTTON_DEFS.find((d) => d.id === slotId);
        if (slot) {
          const nextBindings = JSON.parse(JSON.stringify(getActiveBindings()));
          const targetAction = sel.value;
          const actDef = ACTION_DEFINITIONS.find((a) => a.id === targetAction);
          // Reassign the slot's physical key cleanly from old action -> new action
          const physicalKey = (prevActionId && nextBindings[prevActionId]?.key && nextBindings[prevActionId].key !== 'none')
            ? nextBindings[prevActionId].key
            : slot.defaultKey;
          if (prevActionId && prevActionId !== targetAction && nextBindings[prevActionId]?.key === physicalKey) {
            nextBindings[prevActionId].key = 'none';
          }
          if (!nextBindings[targetAction]) {
            nextBindings[targetAction] = { gamepad: actDef?.defaultGamepad || 'none', key: physicalKey };
          } else {
            nextBindings[targetAction].key = physicalKey;
          }
          updateState({ controllerBindings: nextBindings, microSlotActions: nextSlotMap });
          saveSettings(appState);
          markProfileDirty();
          renderMappingTable();
        } else {
          updateState({ microSlotActions: nextSlotMap });
          saveSettings(appState);
        }
        renderMicroTable();
      });
    });

    microMappingTableBody.querySelectorAll('.micro-learn-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const slotId = btn.dataset.microBtn;
        microLearnSlotId = microLearnSlotId === slotId ? null : slotId;
        renderMicroTable();
        if (microLearnSlotId) {
          showToastBanner(`PRESS MICRO BUTTON [${slotId.toUpperCase()}] TO BIND KEY (ESC TO CANCEL)`);
        }
      });
    });
  }

  microSvgContainer?.querySelectorAll('.micro-visual-btn').forEach((vBtn) => {
    vBtn.addEventListener('click', () => {
      const slotId = vBtn.dataset.microBtn;
      if (!slotId) return;
      microLearnSlotId = microLearnSlotId === slotId ? null : slotId;
      renderMicroTable();
      if (microLearnSlotId) {
        showToastBanner(`PRESS MICRO BUTTON [${slotId.toUpperCase()}] IN K-MODE TO BIND KEY`);
      }
    });
  });

  btnMicroDpadMode?.addEventListener('click', () => {
    executeMappedAction('toggle_dpad_mode');
    syncMicroStateUI();
  });

  btnApplyMicroPreset?.addEventListener('click', () => {
    updateState({ microSlotActions: {} });
    loadProfile('8bitdo_micro', true);
    renderMicroTable();
    syncMicroStateUI();
  });

  btnResetMicroPreset?.addEventListener('click', () => {
    updateState({ microSlotActions: {} });
    loadProfile('8bitdo_micro', true);
    renderMicroTable();
    syncMicroStateUI();
  });

  subscribeState((state, patch) => {
    if (patch.currentScreen !== undefined && state.currentScreen !== 'controller') {
      cancelRebinding();
    }
    if (patch.dpadMode !== undefined) {
      syncMicroStateUI();
    }
    if (patch.ringEnabled !== undefined || patch.activeControllerProfile !== undefined) {
      syncRemoteStateUI();
    }
  });

  function switchControllerTab(tab) {
    tabBtnGamepad?.classList.toggle('active', tab === 'gamepad');
    tabBtnRemote?.classList.toggle('active', tab === 'remote');
    tabBtnMicro?.classList.toggle('active', tab === 'micro');

    viewGamepadConfig?.classList.toggle('hidden', tab !== 'gamepad');
    viewRemoteConfig?.classList.toggle('hidden', tab !== 'remote');
    viewMicroConfig?.classList.toggle('hidden', tab !== 'micro');

    if (tab === 'remote') {
      renderRemoteTable();
      syncRemoteStateUI();
    } else if (tab === 'micro') {
      renderMicroTable();
      syncMicroStateUI();
    }
  }

  tabBtnGamepad?.addEventListener('click', () => switchControllerTab('gamepad'));
  tabBtnRemote?.addEventListener('click', () => switchControllerTab('remote'));
  tabBtnMicro?.addEventListener('click', () => switchControllerTab('micro'));

  btnToggleFfpTab?.addEventListener('click', () => {
    const nextFfp = !appState.reticleFfpMode;
    updateState({ reticleFfpMode: nextFfp });
    saveSettings(appState);
    syncRemoteStateUI();
    showToastBanner(nextFfp ? 'FIRST FOCAL PLANE (FFP) LOCKED 🔒' : 'RETICLE SET TO MANUAL SFP 🔓');
  });

  btnResetRemoteTabMap?.addEventListener('click', () => {
    setLearningAction(null);
    updateState({ ringKeyMap: {} });
    saveSettings(appState);
    markProfileDirty();
    renderRemoteTable();
    showToastBanner('RING & REMOTE BUTTON MAPPINGS RESET TO DEFAULTS');
  });

  // Listen for real-time remote button signals (strictly gated to Controller screen UI)
  window.addEventListener('spotr-remote-button', (e) => {
    if (appState.currentScreen !== 'controller') return;
    const { action, signalCode, isLearned, isCancelled } = e.detail;

    // A. Re-render table if button was learned or cancelled
    if (isLearned) {
      markProfileDirty();
      renderRemoteTable();
      showToastBanner(`BOUND [${action}] TO ${signalCode}`);
    } else if (isCancelled) {
      renderRemoteTable();
      showToastBanner('LEARNING CANCELLED');
    }

    // B. Real-time visual button glow on SVG schematic
    if (action) {
      const visualBtn = document.querySelector(`.remote-visual-btn[data-remote-act="${action}"]`);
      if (visualBtn) {
        visualBtn.classList.add('remote-active-glow');
        setTimeout(() => visualBtn.classList.remove('remote-active-glow'), 260);
      }
    }

    // C. LED indicator flash
    const led = document.getElementById('remoteLedDot');
    if (led) {
      led.classList.add('active');
      setTimeout(() => led.classList.remove('active'), 260);
    }

    // D. Update diagnostic telemetry banner
    if (remoteLastSignalText) {
      remoteLastSignalText.textContent = `${signalCode} → [${action || 'UNMAPPED'}]`;
    }
    const liveBanner = document.getElementById('cmLiveActionBanner');
    if (liveBanner) {
      liveBanner.textContent = `REMOTE SIGNAL: [${action || 'RAW'}] ${signalCode} (${new Date().toLocaleTimeString()})`;
    }

    syncRemoteStateUI();
  });

  // Initial render of profiles, remote table and state
  refreshProfileDropdown();
  renderRemoteTable();
  syncRemoteStateUI();
}

function escapeHtmlStr(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToastBanner(msg) {
  const el = document.getElementById('cmToastBanner');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 250);
  }, 3200);
}

function formatBindingLabel(role) {
  const map = {
    'cross': '✕ CROSS',
    'circle': '◯ CIRCLE',
    'square': '▢ SQUARE',
    'triangle': '△ TRIANGLE',
    'l1': 'L1 BUMPER',
    'r1': 'R1 BUMPER',
    'l2': 'L2 TRIGGER',
    'r2': 'R2 TRIGGER',
    'dpad-up': '▲ D-PAD UP',
    'dpad-down': '▼ D-PAD DOWN',
    'dpad-left': '◀ D-PAD LEFT',
    'dpad-right': '▶ D-PAD RIGHT',
    'share': 'SHARE / CREATE',
    'options': 'OPTIONS',
    'l3': 'L3 (STICK CLICK)',
    'r3': 'R3 (STICK CLICK)',
    'ps': 'PS BUTTON',
    'touchpad': 'TOUCHPAD CLICK',
    'left-stick': 'LEFT STICK (ANALOG)',
    'right-stick': 'RIGHT STICK (ANALOG)',
    'none': 'UNASSIGNED'
  };
  return map[role.toLowerCase()] || role.toUpperCase();
}

function formatKeyLabel(code) {
  if (!code || code === 'none') return 'UNASSIGNED';
  return code
    .replace('Key', '')
    .replace('Digit', '')
    .replace('Arrow', 'ARROW ')
    .toUpperCase();
}

/**
 * Steers either the magnified main viewport pan ('pan') or Aim Loupe reticle ('aim') by one step.
 */
function steerViewOrLoupe(mode, dx, dy) {
  if (mode === 'aim') {
    const aimScale = ((appState.reticleAimSpeed ?? 50) / 100) * 0.022;
    const nextX = Math.max(0.03, Math.min(0.97, (appState.roiX ?? 0.5) + dx * aimScale));
    const nextY = Math.max(0.03, Math.min(0.97, (appState.roiY ?? 0.5) + dy * aimScale));
    updateState({
      roiX: nextX,
      roiY: nextY,
      pipEnabled: true,
      roiTargetVisible: true
    });
    return;
  }

  const zoom = appState.mainZoom || 1.0;
  if (zoom <= 1.01) return;
  const maxPan = Math.max(0, (1 - 1 / zoom) / 2);
  const speedRatio = (appState.ringPanSpeed ?? 70) / 100;
  const panStep = Math.max(0.002, (0.024 * speedRatio) / zoom);
  const nx = Math.max(-maxPan, Math.min(maxPan, (appState.mainPanX || 0) + dx * panStep));
  const ny = Math.max(-maxPan, Math.min(maxPan, (appState.mainPanY || 0) + dy * panStep));
  updateState({ mainPanX: nx, mainPanY: ny });
}

/**
 * Executes a mapped action in the application interface
 */
export function executeMappedAction(actionId) {
  const screen = appState.currentScreen;

  switch (actionId) {
    case 'toggle_overlay':
      document.getElementById('btnToggleOverlayTop')?.click();
      break;

    case 'toggle_pip':
      document.getElementById('btnTogglePip')?.click();
      break;

    case 'toggle_heatmap':
      document.getElementById('btnToggleHeatmap')?.click();
      break;

    case 'toggle_voice':
      document.getElementById('btnToggleVoiceAnnounce')?.click();
      break;

    case 'toggle_declutter':
      updateState({ uiDecluttered: !appState.uiDecluttered });
      break;

    case 'toggle_hud':
      updateState({ hudOpen: !appState.hudOpen });
      break;

    case 'zoom_in':
      document.getElementById('mainZoomPlus')?.click();
      break;

    case 'zoom_out':
      document.getElementById('mainZoomMinus')?.click();
      break;

    case 'zoom_reset':
      document.getElementById('mainZoomBadge')?.click();
      break;

    case 'instant_replay':
      document.getElementById('btnReplay20s')?.click();
      break;

    case 'play_pause':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryPlayPause')?.click();
      }
      break;

    case 'step_forward':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStep')?.click();
      }
      break;

    case 'step_backward':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStepBack')?.click();
      }
      break;

    case 'toggle_slowmo':
      if (screen === 'gallery') {
        document.getElementById('btnGallerySlowMo')?.click();
      }
      break;

    case 'open_settings':
      if (screen === 'settings') {
        document.getElementById('btnSettingsBackToLive')?.click();
      } else {
        document.getElementById('btnToggleOptions')?.click();
      }
      break;

    case 'return_live':
      if (screen === 'gallery') {
        document.getElementById('btnBackToLive')?.click();
      } else if (screen === 'settings') {
        document.getElementById('btnSettingsBackToLive')?.click();
      } else if (screen === 'reticle') {
        document.getElementById('btnReticleBackToLive')?.click();
      } else if (screen === 'controller') {
        document.getElementById('btnControllerBackToLive')?.click();
      } else if (screen === 'calibration') {
        document.getElementById('btnCalibBackToLive')?.click();
      }
      break;

    case 'theme_cycle':
      cycleTheme(1);
      break;

    case 'reticle_scale_up':
    case 'reticle_scale_down': {
      const deltaSign = actionId === 'reticle_scale_up' ? 1 : -1;
      if (appState.overlayType === 'custom') {
        const nextScale = Math.max(25, Math.min(200, (Number(appState.overlayScale) || 100) + deltaSign));
        updateState({ overlayScale: nextScale });
        saveSettings(appState);
        showReticleFfpToast(`OVERLAY SCALE: ${nextScale}%`);
        break;
      }
      const cfg = appState.reticleConfig || {};
      const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
      const curSpacing = Number(cfg.clickSpacing) || Math.max(8, Math.floor(240 / clicks));

      const vpEl = screen === 'reticle'
        ? document.getElementById('reticlePreviewStage')
        : screen === 'gallery'
          ? (appState.galleryArchiveTab === 'hits'
              ? document.getElementById('hitsMapViewport')
              : document.getElementById('galleryClipsStage'))
          : document.getElementById('viewportContainer');
      const vw = vpEl?.clientWidth || window.innerWidth || 1920;
      const vh = vpEl?.clientHeight || window.innerHeight || 1080;
      const baseScale = Math.min(Math.max(1, vw) / 800, Math.max(1, vh) / 500);
      const ffpFactor = (screen === 'live' ? appState.reticleFfpMode : false)
        ? Math.max(1.0, Number(appState.mainZoom) || 1.0)
        : 1.0;
      const pxPerSvgUnit = Math.max(0.25, baseScale * ((Number(appState.overlayScale) || 100) / 100) * ffpFactor);

      // Step so the outermost tick (full `clicks` arm) moves by 1 CSS pixel per press for ranging precision
      const svgDelta = deltaSign / (pxPerSvgUnit * clicks);
      const nextSpacing = Math.max(4, Math.min(100, Number((curSpacing + svgDelta).toFixed(4))));
      const tickPx = nextSpacing * pxPerSvgUnit;
      const armPx = Math.round(tickPx * clicks);
      const nextCfg = Object.assign({}, cfg, { clickSpacing: nextSpacing });
      updateState({ reticleConfig: nextCfg });
      saveSettings(appState);
      const modeStr = appState.reticleFfpMode ? 'FFP SYNC' : 'SFP';
      showReticleFfpToast(`RETICLE ARM: ${armPx}px (${tickPx.toFixed(1)}px/tick · ${modeStr})`);
      break;
    }

    case 'reticle_ffp_toggle': {
      const nextFfp = !appState.reticleFfpMode;
      updateState({ reticleFfpMode: nextFfp });
      saveSettings(appState);
      showReticleFfpToast(nextFfp ? 'FIRST FOCAL PLANE: LOCKED (FFP ON)' : 'FIRST FOCAL PLANE: UNLOCKED (SFP FIXED)');
      break;
    }

    case 'reticle_center_cycle': {
      const styles = ['empty', 'dot', 'cross', 'chevron'];
      const cur = (appState.reticleConfig?.centerStyle || 'empty').toLowerCase();
      const nextIdx = (styles.indexOf(cur) + 1) % styles.length;
      const nextStyle = styles[nextIdx];
      const nextCfg = Object.assign({}, appState.reticleConfig, { centerStyle: nextStyle });
      updateState({ reticleConfig: nextCfg });
      saveSettings(appState);
      showReticleFfpToast(`CENTER POINT: ${nextStyle.toUpperCase()}`);
      break;
    }

    case 'quick_tool_cycle_next':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStep')?.click();
      } else {
        cycleQuickTool(1);
      }
      break;

    case 'quick_tool_cycle_prev':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStepBack')?.click();
      } else {
        cycleQuickTool(-1);
      }
      break;

    case 'quick_tool_toggle':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryPlayPause')?.click();
      } else {
        toggleQuickTool();
      }
      break;

    case 'toggle_dpad_mode': {
      const nextMode = appState.dpadMode === 'aim' ? 'pan' : 'aim';
      updateState({ dpadMode: nextMode });
      saveSettings(appState);
      showReticleFfpToast(nextMode === 'aim' ? 'D-PAD: AIM LOUPE' : 'D-PAD: PAN VIEW');
      break;
    }

    case 'snap_loupe_last_hit': {
      const snapped = snapLoupeToLatestHit();
      showReticleFfpToast(snapped ? '🎯 LOUPE SNAPPED TO LATEST HIT' : 'NO HITS LOGGED YET');
      break;
    }

    case 'rezero_heatmap':
      rezeroHeatmap();
      showReticleFfpToast('DETECTOR RE-ZEROED');
      break;

    case 'capture_snapshot':
      captureAnnotatedSnapshot();
      showReticleFfpToast('📷 SNAPSHOT SAVED');
      break;

    case 'dpad_up':
      steerViewOrLoupe(appState.dpadMode === 'aim' ? 'aim' : 'pan', 0, -1);
      break;

    case 'dpad_down':
      steerViewOrLoupe(appState.dpadMode === 'aim' ? 'aim' : 'pan', 0, 1);
      break;

    case 'dpad_left':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStepBack')?.click();
      } else {
        steerViewOrLoupe(appState.dpadMode === 'aim' ? 'aim' : 'pan', -1, 0);
      }
      break;

    case 'dpad_right':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStep')?.click();
      } else {
        steerViewOrLoupe(appState.dpadMode === 'aim' ? 'aim' : 'pan', 1, 0);
      }
      break;

    default:
      break;
  }
}

export const QUICK_TOOLS = [
  {
    id: 'heatmap',
    name: 'HITS DETECTION',
    check: (s) => s.heatmapEnabled,
    toggle: () => document.getElementById('btnToggleHeatmap')?.click()
  },
  {
    id: 'voice',
    name: 'VOICE ANNOUNCEMENTS',
    check: (s) => s.heatmapSpeechEnabled,
    toggle: () => document.getElementById('btnToggleVoiceAnnounce')?.click()
  },
  {
    id: 'reticle',
    name: 'RETICLE OVERLAY',
    check: (s) => s.overlayEnabled,
    toggle: () => document.getElementById('btnToggleOverlayTop')?.click()
  },
  {
    id: 'center_style',
    name: 'CENTER POINT',
    check: (s) => (s.reticleConfig?.centerStyle || 'empty') !== 'empty',
    toggle: () => executeMappedAction('reticle_center_cycle')
  },
  {
    id: 'ffp',
    name: 'FFP ZOOM LOCK',
    check: (s) => s.reticleFfpMode,
    toggle: () => executeMappedAction('reticle_ffp_toggle')
  },
  {
    id: 'pip',
    name: 'PIP LOUPE WINDOW',
    check: (s) => s.pipEnabled,
    toggle: () => document.getElementById('btnTogglePip')?.click()
  },
  {
    id: 'declutter',
    name: 'DECLUTTER SIGHT',
    check: (s) => s.uiDecluttered,
    toggle: () => updateState({ uiDecluttered: !appState.uiDecluttered })
  },
  {
    id: 'hud',
    name: 'TELEMETRY HUD',
    check: (s) => s.hudOpen,
    toggle: () => updateState({ hudOpen: !appState.hudOpen })
  }
];

export function updateQuickToolPillUI() {
  const pill = document.getElementById('quickToolPill');
  const badge = document.getElementById('quickToolBadge');
  const status = document.getElementById('quickToolStatus');
  if (!pill || !badge || !status) return;

  const toolIdx = ((appState.activeQuickToolIndex || 0) % QUICK_TOOLS.length + QUICK_TOOLS.length) % QUICK_TOOLS.length;
  const tool = QUICK_TOOLS[toolIdx];
  const isActive = Boolean(tool.check(appState));

  badge.textContent = tool.name;
  status.textContent = isActive ? 'ON' : 'OFF';
  status.className = `quick-tool-status ${isActive ? 'status-on' : 'status-off'}`;

  pill.classList.remove('hidden');
  pill.style.opacity = '1';

  clearTimeout(pill._fadeTimer);
  pill._fadeTimer = setTimeout(() => {
    pill.style.opacity = '0';
    setTimeout(() => pill.classList.add('hidden'), 350);
  }, 3200);
}

export function cycleQuickTool(dir) {
  const current = appState.activeQuickToolIndex || 0;
  const next = ((current + dir) % QUICK_TOOLS.length + QUICK_TOOLS.length) % QUICK_TOOLS.length;
  updateState({ activeQuickToolIndex: next });
  updateQuickToolPillUI();
}

export function toggleQuickTool() {
  const toolIdx = ((appState.activeQuickToolIndex || 0) % QUICK_TOOLS.length + QUICK_TOOLS.length) % QUICK_TOOLS.length;
  const tool = QUICK_TOOLS[toolIdx];
  if (tool) {
    tool.toggle();
    updateQuickToolPillUI();
  }
}

export function showReticleFfpToast(msg) {
  const el = document.getElementById('reticleFfpToast');
  const txt = document.getElementById('reticleFfpText');
  if (!el || !txt) return;
  txt.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  clearTimeout(el._fadeTimer);
  el._fadeTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 250);
  }, 2600);
}
