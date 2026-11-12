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

import { appState, updateState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { cycleTheme } from '../input/gamepadController.js';
import { REMOTE_MODES, getActiveRemoteMode, setRemoteMode, getLearningAction, setLearningAction } from './ringController.js';

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

  // DETECTION & HEATMAP
  {
    id: 'toggle_heatmap',
    category: 'vision',
    name: 'Toggle Heatmap Engine',
    desc: 'Toggle 60 FPS micro-motion detection layer',
    defaultGamepad: 'triangle',
    defaultKey: 'KeyH'
  },
  {
    id: 'toggle_voice',
    category: 'vision',
    name: 'Mute / Unmute Voice',
    desc: 'Toggle directional speech target announcements',
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
  }
];

// Unified Bluetooth Ring & Remote Button Definitions (Option B: Tactical Grid Matrix)
export const REMOTE_BUTTON_DEFS = [
  {
    id: 'UP',
    name: 'UP (▲)',
    badge: 'DIRECTION',
    desc: 'Pan Up • Zoom In (+0.25x) • Reticle Spacing +1px • Replay Restart',
    defaultCodes: 'ArrowUp, PageUp, KeyW'
  },
  {
    id: 'DOWN',
    name: 'DOWN (▼)',
    badge: 'DIRECTION',
    desc: 'Pan Down • Zoom Out (-0.25x) • Reticle Spacing -1px • Replay Exit to Live',
    defaultCodes: 'ArrowDown, PageDown, KeyS'
  },
  {
    id: 'LEFT',
    name: 'LEFT (◀)',
    badge: 'DIRECTION',
    desc: 'Pan Left • Zoom Coarse (-0.5x) • Reticle Spacing -5px • Replay Step -1 Frame',
    defaultCodes: 'ArrowLeft, MediaTrackPrevious, KeyA'
  },
  {
    id: 'RIGHT',
    name: 'RIGHT (▶)',
    badge: 'DIRECTION',
    desc: 'Pan Right • Zoom Coarse (+0.5x) • Reticle Spacing +5px • Replay Step +1 Frame',
    defaultCodes: 'ArrowRight, MediaTrackNext, KeyD'
  },
  {
    id: 'CENTER',
    name: 'CENTER (●)',
    badge: 'ACTION / MODE',
    desc: 'Context Action: Re-center Pan (0,0) • Reset Zoom (1.0x) • Lock/Unlock FFP 🔒 • Play/Pause Video',
    defaultCodes: 'Enter, Space, MediaPlayPause, KeyF'
  },
  {
    id: 'BTN1',
    name: 'BUTTON 1 (⏻ 1)',
    badge: 'AUX 1 (REPLAY)',
    desc: 'Instant Replay In / Out (1-click trigger in/out from any mode)',
    defaultCodes: 'AudioVolumeUp, KeyX, KeyR, F12'
  },
  {
    id: 'BTN2',
    name: 'BUTTON 2 (2)',
    badge: 'AUX 2 (MODE)',
    desc: 'Discrete Mode Switcher (PAN → ZOOM → RETICLE) • Slow-Mo in Replay',
    defaultCodes: 'AudioVolumeDown, KeyM, KeyT, Tab, KeyB'
  }
];

// Default Bluetooth Ring & Remote Key Map
export const DEFAULT_RING_KEY_MAP = {
  UP: 'ArrowUp, PageUp, KeyW',
  DOWN: 'ArrowDown, PageDown, KeyS',
  LEFT: 'ArrowLeft, MediaTrackPrevious, KeyA',
  RIGHT: 'ArrowRight, MediaTrackNext, KeyD',
  CENTER: 'Enter, Space, MediaPlayPause, KeyF',
  BTN1: 'AudioVolumeUp, KeyX, KeyR, F12',
  BTN2: 'AudioVolumeDown, KeyM, KeyT, Tab, KeyB'
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
      reticleAimSpeed: 50
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
      reticleAimSpeed: 40
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
      reticleAimSpeed: 60
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
  if (appState.controllerBindings && typeof appState.controllerBindings === 'object') {
    return appState.controllerBindings;
  }
  const prof = getProfile(appState.activeControllerProfile);
  return Object.assign({}, prof.bindings);
}

let activeRebindActionId = null;
let activeRebindType = null; // 'gamepad' | 'key'
let rebindTimeout = null;
let isControllerScreenInitialized = false;

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
          return `<option value="${k}">${p.name || 'Untitled Profile'}${isMod ? ' *' : ''}</option>`;
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
    const newRingMap = JSON.parse(JSON.stringify(prof.ringKeyMap || DEFAULT_RING_KEY_MAP));
    const cal = prof.calibration || {};

    updateState({
      activeControllerProfile: profileId,
      controllerBindings: newBindings,
      ringKeyMap: newRingMap,
      leftStickDeadzone: cal.leftStickDeadzone ?? 16,
      rightStickDeadzone: cal.rightStickDeadzone ?? 16,
      leftStickInvertY: Boolean(cal.leftStickInvertY),
      rightStickInvertY: Boolean(cal.rightStickInvertY),
      touchpadSensitivity: cal.touchpadSensitivity ?? 50,
      reticleAimSpeed: cal.reticleAimSpeed ?? 50
    });

    saveSettings(appState);
    isProfileDirty = false;

    refreshProfileDropdown();
    syncCalibrationSliders();
    renderMappingTable();
    renderRemoteTable();

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
      reticleAimSpeed: appState.reticleAimSpeed ?? 50
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
        reticleAimSpeed: appState.reticleAimSpeed ?? 50
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
          reticleAimSpeed: appState.reticleAimSpeed ?? 50
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
        const customMap = appState.customControllerProfiles || {};

        if (data.customProfiles && typeof data.customProfiles === 'object') {
          Object.entries(data.customProfiles).forEach(([id, prof]) => {
            if (prof && prof.name && (prof.bindings || prof.ringKeyMap)) {
              customMap[id] = prof;
              importedCount++;
            }
          });
        } else if (data.bindings || data.ringKeyMap) {
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
      ringKeyMap: defaultRingMap,
      leftStickDeadzone: 16,
      rightStickDeadzone: 16,
      leftStickInvertY: false,
      rightStickInvertY: false,
      touchpadSensitivity: 50,
      reticleAimSpeed: 50
    });
    saveSettings(appState);
    isProfileDirty = false;
    refreshProfileDropdown();
    syncCalibrationSliders();
    renderMappingTable();
    renderRemoteTable();
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
  }

  // Keyboard capture for rebinding
  window.addEventListener('keydown', (e) => {
    if (appState.currentScreen !== 'controller') return;
    if (activeRebindActionId) {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelRebinding();
        return;
      }
      e.preventDefault();
      assignBinding(activeRebindActionId, activeRebindType, e.code || e.key);
    }
  });

  // Global keyboard shortcuts driven by active bindings
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (activeRebindActionId) return;
    if (e.key === 'F12' || (e.ctrlKey && e.shiftKey && e.key === 'I')) return;

    const currentBindings = getActiveBindings();
    const entry = Object.entries(currentBindings).find(([actId, b]) => {
      if (!b.key || b.key === 'none') return false;
      return b.key === e.code || b.key === e.key;
    });

    if (entry) {
      e.preventDefault();
      executeMappedAction(entry[0]);
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
    if (activeRebindActionId) {
      activeRebindActionId = null;
      activeRebindType = null;
      clearTimeout(rebindTimeout);
      renderMappingTable();
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
      const badge = document.querySelector(`.cm-visual-btn[data-gp="${role}"]`);
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
  const viewGamepadConfig = document.getElementById('viewGamepadConfig');
  const viewRemoteConfig = document.getElementById('viewRemoteConfig');
  const remoteMappingTableBody = document.getElementById('remoteMappingTableBody');
  const btnCycleRemoteModeTab = document.getElementById('btnCycleRemoteModeTab');
  const btnToggleFfpTab = document.getElementById('btnToggleFfpTab');
  const btnResetRemoteTabMap = document.getElementById('btnResetRemoteTabMap');
  const remoteLastSignalText = document.getElementById('remoteLastSignalText');
  const remoteSvgContainer = document.getElementById('remoteSvgContainer');

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
    if (btnCycleRemoteModeTab) {
      btnCycleRemoteModeTab.textContent = `[ ${activeMode} ]`;
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
          return `<span class="remote-key-tag ${pillClass}">${k}</span>`;
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

  function switchControllerTab(tab) {
    if (tab === 'remote') {
      tabBtnRemote?.classList.add('active');
      tabBtnGamepad?.classList.remove('active');
      viewRemoteConfig?.classList.remove('hidden');
      viewGamepadConfig?.classList.add('hidden');
      renderRemoteTable();
      syncRemoteStateUI();
    } else {
      tabBtnGamepad?.classList.add('active');
      tabBtnRemote?.classList.remove('active');
      viewGamepadConfig?.classList.remove('hidden');
      viewRemoteConfig?.classList.add('hidden');
    }
  }

  tabBtnGamepad?.addEventListener('click', () => switchControllerTab('gamepad'));
  const guideTextMap = {
    pan: 'Pan Mode: D-Pad pans viewport; OK toggles Quick Action; Camera swaps PiP & main view.',
    zoom: 'Zoom Mode: Up / Down zooms in or out; Left / Right cycles PiP or resets 1.0x.',
    reticle: 'Reticle Calibration: D-Pad aligns crosshair offset; OK toggles FFP / SFP lock.'
  };
  const guideStepBtns = Array.from(document.querySelectorAll('.remote-guide-step-btn[data-guide]'));
  const remoteModeGuideText = document.getElementById('remoteModeGuideText');
  const setRemoteGuideStep = (stepKey) => {
    const key = guideTextMap[stepKey] ? stepKey : 'pan';
    guideStepBtns.forEach((b) => b.classList.toggle('radar-btn-active', b.dataset.guide === key));
    if (remoteModeGuideText) remoteModeGuideText.textContent = guideTextMap[key];
  };
  guideStepBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      setRemoteGuideStep(btn.dataset.guide);
    });
  });

  tabBtnRemote?.addEventListener('click', () => switchControllerTab('remote'));

  btnCycleRemoteModeTab?.addEventListener('click', () => {
    const currentMode = getActiveRemoteMode();
    const curIdx = REMOTE_MODES.indexOf(currentMode);
    const nextIdx = (curIdx + 1) % REMOTE_MODES.length;
    setRemoteMode(nextIdx);
    syncRemoteStateUI();
    showToastBanner(`REMOTE MODE SWITCHED TO: ${REMOTE_MODES[nextIdx]}`);
  });

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

  // Listen for real-time remote button signals
  window.addEventListener('spotr-remote-button', (e) => {
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
      document.getElementById('btnToggleHud')?.click();
      break;

    case 'zoom_in':
      document.getElementById('mainZoomPlus')?.click();
      break;

    case 'zoom_out':
      document.getElementById('mainZoomMinus')?.click();
      break;

    case 'zoom_reset':
      document.getElementById('mainZoomReset')?.click();
      break;

    case 'instant_replay':
      document.getElementById('btnReplay20s')?.click();
      break;

    case 'play_pause':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryPlayPause')?.click();
      } else if (appState.replayActive) {
        document.getElementById('btnReplayPlayPause')?.click();
      } else {
        document.getElementById('ringHudPill')?.click();
      }
      break;

    case 'step_forward':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStep')?.click();
      } else if (appState.replayActive) {
        document.getElementById('btnReplayStep')?.click();
      }
      break;

    case 'step_backward':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStepBack')?.click();
      } else if (appState.replayActive) {
        document.getElementById('btnReplayStepBack')?.click();
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
      } else if (appState.replayActive) {
        document.getElementById('btnCloseReplay')?.click();
      }
      break;

    case 'theme_cycle':
      cycleTheme(1);
      break;

    case 'reticle_scale_up': {
      if (appState.overlayType === 'custom') {
        const nextScale = Math.min(200, (Number(appState.overlayScale) || 100) + 1);
        updateState({ overlayScale: nextScale });
        saveSettings(appState);
        showReticleFfpToast(`OVERLAY SCALE: ${nextScale}%`);
        break;
      }
      const cfg = appState.reticleConfig || {};
      const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
      const curSpacing = Number(cfg.clickSpacing) || Math.max(8, Math.floor(240 / clicks));
      const nextSpacing = Math.min(100, Math.round(curSpacing + 1));
      const nextCfg = Object.assign({}, cfg, { clickSpacing: nextSpacing });
      updateState({ reticleConfig: nextCfg });
      saveSettings(appState);
      const modeStr = appState.reticleFfpMode ? 'FFP SYNC' : 'SFP';
      showReticleFfpToast(`RETICLE SPACING: ${nextSpacing}px (${modeStr})`);
      break;
    }

    case 'reticle_scale_down': {
      if (appState.overlayType === 'custom') {
        const nextScale = Math.max(25, (Number(appState.overlayScale) || 100) - 1);
        updateState({ overlayScale: nextScale });
        saveSettings(appState);
        showReticleFfpToast(`OVERLAY SCALE: ${nextScale}%`);
        break;
      }
      const cfg = appState.reticleConfig || {};
      const clicks = Math.max(2, Math.min(30, Number(cfg.clickCount) || 10));
      const curSpacing = Number(cfg.clickSpacing) || Math.max(8, Math.floor(240 / clicks));
      const nextSpacing = Math.max(4, Math.round(curSpacing - 1));
      const nextCfg = Object.assign({}, cfg, { clickSpacing: nextSpacing });
      updateState({ reticleConfig: nextCfg });
      saveSettings(appState);
      const modeStr = appState.reticleFfpMode ? 'FFP SYNC' : 'SFP';
      showReticleFfpToast(`RETICLE SPACING: ${nextSpacing}px (${modeStr})`);
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
      } else if (appState.replayActive) {
        document.getElementById('btnReplayStep')?.click();
      } else {
        cycleQuickTool(1);
      }
      break;

    case 'quick_tool_cycle_prev':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryStepBack')?.click();
      } else if (appState.replayActive) {
        document.getElementById('btnReplayStepBack')?.click();
      } else {
        cycleQuickTool(-1);
      }
      break;

    case 'quick_tool_toggle':
      if (screen === 'gallery') {
        document.getElementById('btnGalleryPlayPause')?.click();
      } else if (appState.replayActive) {
        document.getElementById('btnReplayPlayPause')?.click();
      } else {
        toggleQuickTool();
      }
      break;

    default:
      break;
  }
}

export const QUICK_TOOLS = [
  {
    id: 'heatmap',
    name: 'HEATMAP DETECTION',
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
    toggle: () => document.getElementById('btnToggleHud')?.click()
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
