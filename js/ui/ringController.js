/**
 * 5-Button Bluetooth Scrolling Ring Controller Integration
 * (Targeted for Wireless Bluetooth Scrolling Ring — Up / Down / Left / Right / Center)
 *
 * How 5 buttons control the entire EagleVision interface hands-free:
 * - Single-Press CENTER (●): Cycles Ring Mode on Live Feed:
 *     1. [AIM ROI]  : ▲/▼/◀/▶ moves the Zoom Window Target Crosshair across the image
 *     2. [ZOOM]     : ▲/▼ adjusts Zoom Window (+/−), ◀/▶ adjusts Main Whole-Image Zoom (−/+)
 *     3. [TOOLS]    : ▲ toggles Heatmap, ▼ toggles Crosshair Guide, ◀ toggles Settings, ▶ triggers Instant Replay
 * - Double-Press CENTER (●●): Immediately triggers INSTANT REPLAY from any mode (or exits Replay back to Live).
 * - Automatic Video Player Mode (during Instant Replay or Fullscreen Saved Clips):
 *     - ● CENTER    : Play / Pause (Double-press exits to Live Feed)
 *     - ◀ / ▶       : Step / Scrub backward & forward through the recording
 *     - ▲ UP        : Toggle 0.5x Slow-Motion (or restart replay)
 *     - ▼ DOWN      : Close Replay / Toggle Saved Clips Drawer
 *
 * Includes a built-in "LEARN RING BUTTONS" calibration utility in Settings so any
 * Bluetooth HID mode (Keyboard Arrow/Page keys, Media Volume/Track keys, or Wheel ticks)
 * can be custom-bound on the fly.
 */
import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { isSplashScreenActive, dismissSplashScreen } from './splashScreen.js';

const RING_MODES = ['AIM ROI', 'ZOOM', 'TOOLS'];

const DEFAULT_KEY_MAP = {
  UP: ['ArrowUp', 'PageUp', 'AudioVolumeUp', 'KeyW'],
  DOWN: ['ArrowDown', 'PageDown', 'AudioVolumeDown', 'KeyS'],
  LEFT: ['ArrowLeft', 'MediaTrackPrevious', 'KeyA'],
  RIGHT: ['ArrowRight', 'MediaTrackNext', 'KeyD'],
  CENTER: ['Enter', 'NumpadEnter', 'Space', 'MediaPlayPause', 'KeyF']
};

export function initRingController() {
  let modeIndex = 0;
  let learningAction = null; // 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | 'CENTER' | null
  let centerClickTimer = null;
  let lastCenterClickMs = 0;
  let hudFadeTimer = null;
  let lastWheelMs = 0;

  // Merge user custom learned bindings if saved
  const customMap = appState.ringKeyMap || {};

  const ringHudPill = document.getElementById('ringHudPill');
  const ringModeBadge = document.getElementById('ringModeBadge');
  const ringActionText = document.getElementById('ringActionText');
  const ringLastSignalEl = document.getElementById('ringLastSignal');
  const btnResetRingMap = document.getElementById('btnResetRingMap');
  const learnButtons = document.querySelectorAll('.ring-learn-btn');

  function getActiveModeName() {
    if (appState.currentScreen === 'gallery' || appState.replayActive) {
      return 'PLAYER';
    }
    return RING_MODES[modeIndex];
  }

  function flashRingHud(actionSummary) {
    const modeName = getActiveModeName();
    if (ringModeBadge) {
      ringModeBadge.textContent = `RING: ${modeName}`;
    }
    if (ringActionText && actionSummary) {
      ringActionText.textContent = actionSummary;
    }
    if (ringHudPill) {
      ringHudPill.classList.add('ring-hud-active');
      if (hudFadeTimer) clearTimeout(hudFadeTimer);
      hudFadeTimer = setTimeout(() => {
        ringHudPill.classList.remove('ring-hud-active');
      }, 2600);
    }
  }

  function updateLearnButtonsUI() {
    learnButtons.forEach((btn) => {
      const act = btn.dataset.ringAct;
      const isLearning = learningAction === act;
      btn.classList.toggle('radar-btn-active', isLearning);
      const customCode = customMap[act];
      const baseLabel = btn.dataset.baseLabel || act;
      btn.textContent = isLearning
        ? 'PRESS RING...'
        : customCode
          ? `${baseLabel} [${customCode.replace('Key', '').replace('Arrow', '')}]`
          : baseLabel;
    });
  }

  // Allow clicking the top Ring HUD pill to manually cycle modes too
  if (ringHudPill) {
    ringHudPill.addEventListener('click', () => {
      if (appState.currentScreen === 'gallery' || appState.replayActive) return;
      modeIndex = (modeIndex + 1) % RING_MODES.length;
      flashRingHud( getModeHint(RING_MODES[modeIndex]) );
    });
  }

  // Set up interactive "Learn Ring Buttons" in Settings
  learnButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.ringAct;
      learningAction = learningAction === act ? null : act;
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = learningAction
          ? `WAITING FOR [${learningAction}] PRESS ON RING...`
          : 'READY (5-BTN RING)';
      }
      updateLearnButtonsUI();
    });
  });

  if (btnResetRingMap) {
    btnResetRingMap.addEventListener('click', () => {
      learningAction = null;
      Object.keys(customMap).forEach((k) => delete customMap[k]);
      updateState({ ringKeyMap: {} });
      saveSettings(appState);
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = 'DEFAULT MAPPING RESTORED';
      }
      updateLearnButtonsUI();
    });
  }

  function getModeHint(mode) {
    if (mode === 'AIM ROI') return '▲▼◀▶ MOVE ROI TARGET';
    if (mode === 'ZOOM') return '▲▼ WIN ZOOM • ◀▶ MAIN ZOOM';
    if (mode === 'TOOLS') return '▲ HEAT • ▼ GUIDE • ◀ SET • ▶ REPLAY';
    return '● PLAY/PAUSE • ◀▶ SCRUB';
  }

  function resolveRingAction(codeOrKey) {
    // 1. Check custom learned key first
    for (const [act, boundCode] of Object.entries(customMap)) {
      if (boundCode === codeOrKey) return act;
    }
    // 2. Check built-in multi-protocol ring bindings
    for (const [act, codes] of Object.entries(DEFAULT_KEY_MAP)) {
      if (codes.includes(codeOrKey)) return act;
    }
    return null;
  }

  function scrubRangeElement(rangeEl, deltaSteps) {
    if (!rangeEl) return;
    const max = parseFloat(rangeEl.max) || 20;
    const cur = parseFloat(rangeEl.value) || 0;
    const step = Math.max(0.15, max / 40);
    const next = Math.max(0, Math.min(max, cur + deltaSteps * step));
    rangeEl.value = String(next);
    rangeEl.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function executeDirectionalAction(act) {
    // A. When in Fullscreen Saved Video Gallery Player
    if (appState.currentScreen === 'gallery') {
      if (act === 'LEFT') {
        const scrubber = document.getElementById('galleryScrubber');
        scrubRangeElement(scrubber, -1);
        flashRingHud('◀ REWIND');
      } else if (act === 'RIGHT') {
        const btnStep = document.getElementById('btnGalleryStep');
        btnStep?.click();
        flashRingHud('▶ STEP +1 FRAME');
      } else if (act === 'UP') {
        const btnSlowMo = document.getElementById('btnGallerySlowMo');
        btnSlowMo?.click();
        flashRingHud('▲ TOGGLE 0.5x SLOW-MO');
      } else if (act === 'DOWN') {
        const btnDrawer = document.getElementById('btnToggleGalleryDrawer');
        btnDrawer?.click();
        flashRingHud('▼ TOGGLE CLIPS LIST');
      }
      return;
    }

    // B. When Instant Replay Modal is active on Live Screen
    if (appState.replayActive) {
      const scrubber = document.getElementById('replayScrubber');
      if (act === 'LEFT') {
        scrubRangeElement(scrubber, -1);
        flashRingHud('◀ REPLAY BACK');
      } else if (act === 'RIGHT') {
        scrubRangeElement(scrubber, 1);
        flashRingHud('▶ REPLAY FWD');
      } else if (act === 'UP') {
        if (scrubber) {
          scrubber.value = '0';
          scrubber.dispatchEvent(new Event('input', { bubbles: true }));
        }
        flashRingHud('▲ RESTART REPLAY');
      } else if (act === 'DOWN') {
        document.getElementById('btnCloseReplay')?.click();
        flashRingHud('▼ RETURN TO LIVE');
      }
      return;
    }

    // C. Live Camera Feed — Act according to current Ring Mode
    const mode = RING_MODES[modeIndex];

    if (mode === 'AIM ROI') {
      const step = 0.035;
      let nx = appState.roiX;
      let ny = appState.roiY;
      if (act === 'UP') ny = Math.max(0.05, ny - step);
      if (act === 'DOWN') ny = Math.min(0.95, ny + step);
      if (act === 'LEFT') nx = Math.max(0.05, nx - step);
      if (act === 'RIGHT') nx = Math.min(0.95, nx + step);

      updateState({
        pipEnabled: true,
        roiTargetVisible: true,
        roiX: nx,
        roiY: ny
      });
      flashRingHud(`ROI TARGET (${Math.round(nx * 100)}%, ${Math.round(ny * 100)}%)`);
      return;
    }

    if (mode === 'ZOOM') {
      if (act === 'UP') {
        document.getElementById('pipZoomPlus')?.click();
        flashRingHud(`▲ WIN ZOOM ${appState.pipZoom.toFixed(1)}x`);
      } else if (act === 'DOWN') {
        document.getElementById('pipZoomMinus')?.click();
        flashRingHud(`▼ WIN ZOOM ${appState.pipZoom.toFixed(1)}x`);
      } else if (act === 'RIGHT') {
        document.getElementById('mainZoomPlus')?.click();
        flashRingHud(`▶ MAIN ZOOM ${appState.mainZoom.toFixed(1)}x`);
      } else if (act === 'LEFT') {
        document.getElementById('mainZoomMinus')?.click();
        flashRingHud(`◀ MAIN ZOOM ${appState.mainZoom.toFixed(1)}x`);
      }
      return;
    }

    if (mode === 'TOOLS') {
      if (act === 'UP') {
        document.getElementById('btnToggleHeatmap')?.click();
        flashRingHud(`▲ HEATMAP: ${appState.heatmapEnabled ? 'ON' : 'OFF'}`);
      } else if (act === 'DOWN') {
        document.getElementById('btnToggleOverlay')?.click();
        flashRingHud(`▼ CROSSHAIR: ${appState.overlayEnabled ? 'ON' : 'OFF'}`);
      } else if (act === 'LEFT') {
        document.getElementById('btnToggleOptions')?.click();
        flashRingHud(`◀ SETTINGS: ${appState.optionsOpen ? 'OPEN' : 'HIDDEN'}`);
      } else if (act === 'RIGHT') {
        document.getElementById('btnReplay20s')?.click();
        flashRingHud('▶ INSTANT REPLAY');
      }
    }
  }

  function executeCenterPress(isDoublePress) {
    if (isDoublePress) {
      // Double-press CENTER (●●):
      // - In Gallery: Return to Live Feed
      // - In Live Feed / Replay: Toggle Instant Replay (& Auto-Save)
      if (appState.currentScreen === 'gallery') {
        document.getElementById('btnBackToLive')?.click();
        flashRingHud('●● BACK TO LIVE FEED');
      } else {
        document.getElementById('btnReplay20s')?.click();
        flashRingHud(appState.replayActive ? '●● INSTANT REPLAY' : '●● LIVE FEED');
      }
      return;
    }

    // Single-press CENTER (●):
    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnGalleryPlayPause')?.click();
      flashRingHud('● PLAY / PAUSE');
      return;
    }

    if (appState.replayActive) {
      document.getElementById('btnReplayPlayPause')?.click();
      flashRingHud('● REPLAY PLAY / PAUSE');
      return;
    }

    // Cycle Ring Mode on Live Feed: AIM ROI -> ZOOM -> TOOLS
    modeIndex = (modeIndex + 1) % RING_MODES.length;
    const nextMode = RING_MODES[modeIndex];
    flashRingHud(getModeHint(nextMode));
  }

  function handleRingSignal(signalCode) {
    if (ringLastSignalEl) {
      ringLastSignalEl.textContent = `SIGNAL: ${signalCode}`;
    }

    // If user is currently calibrating/learning a ring button in Settings
    if (learningAction) {
      customMap[learningAction] = signalCode;
      updateState({ ringKeyMap: { ...customMap } });
      saveSettings(appState);
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = `BOUND [${learningAction}] → ${signalCode}`;
      }
      learningAction = null;
      updateLearnButtonsUI();
      return true;
    }

    const action = resolveRingAction(signalCode);
    if (!action) return false;

    if (action === 'CENTER') {
      const now = performance.now();
      if (now - lastCenterClickMs < 340) {
        // Double-press detected!
        if (centerClickTimer) {
          clearTimeout(centerClickTimer);
          centerClickTimer = null;
        }
        lastCenterClickMs = 0;
        executeCenterPress(true);
      } else {
        lastCenterClickMs = now;
        centerClickTimer = setTimeout(() => {
          centerClickTimer = null;
          executeCenterPress(false);
        }, 280);
      }
      return true;
    }

    executeDirectionalAction(action);
    return true;
  }

  // 1. Listen for Bluetooth HID Keyboard / Consumer Media Key events
  window.addEventListener(
    'keydown',
    (e) => {
      // Silently dismiss Splash Screen if active
      if (isSplashScreenActive()) {
        e.preventDefault();
        e.stopPropagation();
        dismissSplashScreen('ring');
        return;
      }

      // Do not hijack typing if focus is inside a select or text input
      const tag = document.activeElement?.tagName;
      if (tag === 'SELECT' && !learningAction) return;

      const code = e.code || e.key;
      const handled = handleRingSignal(code);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  // 2. Listen for Bluetooth Ring Scroll-Wheel ticks (some rings emit wheel ticks for Up/Down)
  window.addEventListener(
    'wheel',
    (e) => {
      // Ignore scrolling inside the Settings panel or Clips list
      if (
        !learningAction &&
        (e.target.closest('#optionsPanel') || e.target.closest('#galleryDrawer'))
      ) {
        return;
      }
      const now = performance.now();
      if (now - lastWheelMs < 140) return;
      lastWheelMs = now;

      let wheelCode = null;
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        if (e.deltaY < -4) wheelCode = 'WheelUp';
        else if (e.deltaY > 4) wheelCode = 'WheelDown';
      } else {
        if (e.deltaX < -4) wheelCode = 'WheelLeft';
        else if (e.deltaX > 4) wheelCode = 'WheelRight';
      }

      if (!wheelCode) return;

      // Map WheelUp/Down/Left/Right to UP/DOWN/LEFT/RIGHT by default if not overridden
      if (!learningAction && !resolveRingAction(wheelCode)) {
        const dir = wheelCode.replace('Wheel', '').toUpperCase();
        if (ringLastSignalEl) ringLastSignalEl.textContent = `SIGNAL: ${wheelCode}`;
        executeDirectionalAction(dir);
        return;
      }

      handleRingSignal(wheelCode);
    },
    { passive: true }
  );

  // Sync HUD label whenever screen or replay state changes
  subscribeState(() => {
    if (ringModeBadge) {
      ringModeBadge.textContent = `RING: ${getActiveModeName()}`;
    }
  });

  updateLearnButtonsUI();
}
