/**
 * SPOTR 7-Button Wireless Bluetooth Remote / Ring Controller Integration
 *
 * Designed for one-finger tactical operation:
 * - Button 1 (⏻ 1): Instant Replay In / Out toggle (Always 1-click in/out)
 * - Button 2 (2)  : Discrete Mode Switcher cycling 3 live modes:
 *     1. [PAN VIEW]    : ▲/▼/◀/▶ pans the magnified live video stream, ● re-centers pan (0,0)
 *     2. [ZOOM VIEW]   : ▲/▼ zooms main live stream in/out (+/−0.25x), ● resets zoom to 1.0x
 *     3. [RETICLE CAL] : ▲/▼/◀/▶ expands/contracts crosshair hashmark spacing, ● Locks / Unlocks FFP mode 🔒
 * - Center (▶||)  : Context-sensitive action (Re-center / Reset 1:1 / Lock FFP / Video Play-Pause)
 * - Auto-Player Mode in Instant Replay / Gallery:
 *     - ● CENTER : Play / Pause
 *     - ◀ / ▶    : Step -1 / +1 Frame for forensic frame-by-frame review
 *     - ▲ / ▼    : Restart Replay / Exit to Live
 *     - BTN 2    : Toggle 0.5x Slow-Motion
 *
 * Includes live hardware signal diagnostics, visual button glowing,
 * and a one-click "Learn Button" calibration tool in the Controller Screen.
 */

import { appState, updateState, subscribeState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { isSplashScreenActive, dismissSplashScreen } from './splashScreen.js';

export const REMOTE_MODES = ['PAN VIEW', 'ZOOM VIEW', 'RETICLE CAL'];

export const DEFAULT_KEY_MAP = {
  UP: ['ArrowUp', 'PageUp', 'KeyW'],
  DOWN: ['ArrowDown', 'PageDown', 'KeyS'],
  LEFT: ['ArrowLeft', 'MediaTrackPrevious', 'KeyA'],
  RIGHT: ['ArrowRight', 'MediaTrackNext', 'KeyD'],
  CENTER: ['Enter', 'NumpadEnter', 'Space', 'MediaPlayPause', 'KeyF'],
  BTN1: ['AudioVolumeUp', 'KeyX', 'KeyR', 'F12'],
  BTN2: ['AudioVolumeDown', 'KeyM', 'KeyT', 'Tab', 'KeyB']
};

let modeIndex = 0;
let learningAction = null;
let hudFadeTimer = null;
let lastWheelMs = 0;

export function getActiveRemoteMode() {
  if (appState.currentScreen === 'gallery' || appState.replayActive) {
    return 'PLAYER';
  }
  return REMOTE_MODES[modeIndex];
}

export function setRemoteMode(idx) {
  modeIndex = ((idx % REMOTE_MODES.length) + REMOTE_MODES.length) % REMOTE_MODES.length;
}

export function initRingController() {
  const customMap = appState.ringKeyMap || {};

  const ringHudPill = document.getElementById('ringHudPill');
  const ringModeBadge = document.getElementById('ringModeBadge');
  const ringActionText = document.getElementById('ringActionText');
  const ringLastSignalEl = document.getElementById('ringLastSignal');
  const btnResetRingMap = document.getElementById('btnResetRingMap');
  const learnButtons = document.querySelectorAll('.ring-learn-btn');

  function flashRingHud(actionSummary) {
    const modeName = getActiveRemoteMode();
    if (ringModeBadge) {
      ringModeBadge.textContent = `REMOTE: ${modeName}`;
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

  function getModeHint(mode) {
    if (mode === 'PAN VIEW') return '[ 1/3 PAN ] ▲▼◀▶ PAN LIVE FEED • ● CENTER';
    if (mode === 'ZOOM VIEW') return `[ 2/3 ZOOM ] ▲▼ ZOOM FEED • ● 1:1 RESET ${appState.reticleFfpMode ? '(FFP 🔒)' : ''}`;
    if (mode === 'RETICLE CAL') return `[ 3/3 RETICLE ] ▲▼ MILS • ● ${appState.reticleFfpMode ? 'FFP LOCKED 🔒' : 'LOCK FFP'}`;
    return '● PLAY/PAUSE • ◀▶ STEP 1 FRAME • BTN1 EXIT';
  }

  function updateLearnButtonsUI() {
    learnButtons.forEach((btn) => {
      const act = btn.dataset.ringAct;
      const isLearning = learningAction === act;
      btn.classList.toggle('radar-btn-active', isLearning);
      const customCode = customMap[act];
      const baseLabel = btn.dataset.baseLabel || act;
      btn.textContent = isLearning
        ? 'PRESS REMOTE...'
        : customCode
          ? `${baseLabel} [${customCode.replace('Key', '').replace('Arrow', '')}]`
          : baseLabel;
    });

    // Also update remote tab calibration buttons if present
    const remoteLearnBtns = document.querySelectorAll('.remote-learn-btn');
    remoteLearnBtns.forEach((btn) => {
      const act = btn.dataset.remoteAct;
      const isLearning = learningAction === act;
      btn.classList.toggle('radar-btn-active', isLearning);
      const customCode = customMap[act];
      const currentLabel = btn.querySelector('.btn-bound-key');
      if (currentLabel) {
        currentLabel.textContent = isLearning
          ? 'PRESS REMOTE...'
          : customCode
            ? customCode.replace('Key', '').replace('Arrow', '')
            : (DEFAULT_KEY_MAP[act]?.[0] || 'NONE');
      }
    });
  }

  // Allow clicking the top Ring HUD pill to manually cycle modes too
  if (ringHudPill) {
    ringHudPill.addEventListener('click', () => {
      if (appState.currentScreen === 'gallery' || appState.replayActive) return;
      modeIndex = (modeIndex + 1) % REMOTE_MODES.length;
      flashRingHud(getModeHint(REMOTE_MODES[modeIndex]));
    });
  }

  // Set up interactive "Learn Ring Buttons"
  learnButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.ringAct;
      learningAction = learningAction === act ? null : act;
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = learningAction
          ? `WAITING FOR [${learningAction}] PRESS ON REMOTE...`
          : 'READY (7-BTN REMOTE)';
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
        ringLastSignalEl.textContent = 'DEFAULT MAPPINGS RESTORED';
      }
      updateLearnButtonsUI();
    });
  }

  function resolveRingAction(codeOrKey) {
    // 1. Check custom learned key first
    for (const [act, boundCode] of Object.entries(customMap)) {
      if (boundCode === codeOrKey) return act;
    }
    // 2. Check built-in multi-protocol remote bindings
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

  // -------------------------------------------------------------------------
  // ACTION EXECUTION (One-Finger Ergonomics)
  // -------------------------------------------------------------------------

  function executeBtn1() {
    // Button 1 (⏻ 1): Instant Replay In / Out toggle
    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnBackToLive')?.click();
      flashRingHud('BTN 1: RETURN TO LIVE FEED');
      return;
    }

    if (appState.replayActive) {
      document.getElementById('btnCloseReplay')?.click();
      flashRingHud('BTN 1: RETURN TO LIVE FEED');
      return;
    }

    // Enter Instant Replay
    document.getElementById('btnReplay20s')?.click();
    flashRingHud('BTN 1: INSTANT REPLAY');
  }

  function executeBtn2() {
    // Button 2 (2): Mode Switcher / Replay Slow-Mo
    if (appState.replayActive) {
      document.getElementById('btnReplaySlowMo')?.click();
      flashRingHud('BTN 2: TOGGLE SLOW-MO (0.5x)');
      return;
    }

    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnGallerySlowMo')?.click();
      flashRingHud('BTN 2: TOGGLE SLOW-MO (0.5x)');
      return;
    }

    // Live Mode: Cycle through 3 discrete modes
    modeIndex = (modeIndex + 1) % REMOTE_MODES.length;
    const nextMode = REMOTE_MODES[modeIndex];
    flashRingHud(getModeHint(nextMode));
  }

  function executeCenter() {
    // In Gallery
    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnGalleryPlayPause')?.click();
      flashRingHud('● PLAY / PAUSE');
      return;
    }

    // In Instant Replay
    if (appState.replayActive) {
      document.getElementById('btnReplayPlayPause')?.click();
      flashRingHud('● REPLAY PLAY / PAUSE');
      return;
    }

    // In Live Mode: Contextual behavior depending on current remote mode
    const mode = REMOTE_MODES[modeIndex];

    if (mode === 'PAN VIEW') {
      // Re-center pan coordinates to dead center (0,0)
      updateState({ mainPanX: 0, mainPanY: 0 });
      flashRingHud('● PAN RE-CENTERED (0, 0)');
      return;
    }

    if (mode === 'ZOOM VIEW') {
      // Reset whole-image zoom to 1.0x native view
      updateState({ mainZoom: 1.0, mainPanX: 0, mainPanY: 0 });
      flashRingHud('● ZOOM RESET (1.0x)');
      return;
    }

    if (mode === 'RETICLE CAL') {
      // Toggle First Focal Plane (FFP) Lock
      const nextFfp = !appState.reticleFfpMode;
      updateState({ reticleFfpMode: nextFfp });
      saveSettings(appState);
      flashRingHud(nextFfp ? '● FFP LOCKED 🔒 (AUTO-SYNC)' : '● RETICLE MANUAL 🔓 (SFP)');
      return;
    }
  }

  function executeDirectionalAction(act) {
    // A. Fullscreen Saved Video Gallery Player
    if (appState.currentScreen === 'gallery') {
      if (act === 'LEFT') {
        const scrubber = document.getElementById('galleryScrubber');
        scrubRangeElement(scrubber, -1);
        flashRingHud('◀ REWIND');
      } else if (act === 'RIGHT') {
        document.getElementById('btnGalleryStep')?.click();
        flashRingHud('▶ STEP +1 FRAME');
      } else if (act === 'UP') {
        document.getElementById('btnGallerySlowMo')?.click();
        flashRingHud('▲ TOGGLE 0.5x SLOW-MO');
      } else if (act === 'DOWN') {
        document.getElementById('btnToggleGalleryDrawer')?.click();
        flashRingHud('▼ TOGGLE CLIPS LIST');
      }
      return;
    }

    // B. Instant Replay Active on Live Screen
    if (appState.replayActive) {
      const scrubber = document.getElementById('replayScrubber');
      if (act === 'LEFT') {
        scrubRangeElement(scrubber, -1);
        flashRingHud('◀ STEP BACK (-1 FRAME)');
      } else if (act === 'RIGHT') {
        scrubRangeElement(scrubber, 1);
        flashRingHud('▶ STEP FORWARD (+1 FRAME)');
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

    // C. Live Camera Feed — Execute based on current Remote Mode
    const mode = REMOTE_MODES[modeIndex];

    // 1. PAN VIEW (Move live feed across magnified viewport)
    if (mode === 'PAN VIEW') {
      let zoom = appState.mainZoom || 1.0;
      // If at 1.0x native view, gently bump to 1.25x so pan has visual effect
      if (zoom <= 1.01) {
        zoom = 1.25;
        updateState({ mainZoom: zoom });
      }

      const maxPan = Math.max(0, (1 - 1 / zoom) / 2);
      const panStep = Math.max(0.015, 0.05 / zoom);

      let nx = appState.mainPanX || 0;
      let ny = appState.mainPanY || 0;

      if (act === 'UP') ny = Math.max(-maxPan, ny - panStep);
      if (act === 'DOWN') ny = Math.min(maxPan, ny + panStep);
      if (act === 'LEFT') nx = Math.max(-maxPan, nx - panStep);
      if (act === 'RIGHT') nx = Math.min(maxPan, nx + panStep);

      updateState({ mainPanX: nx, mainPanY: ny });
      flashRingHud(`PAN (${Math.round(nx * 100)}, ${Math.round(ny * 100)}) [${zoom.toFixed(1)}x]`);
      return;
    }

    // 2. ZOOM VIEW (Adjust main camera digital zoom)
    if (mode === 'ZOOM VIEW') {
      const curZoom = appState.mainZoom || 1.0;
      if (act === 'UP') {
        const nextZoom = Math.min(5.0, Math.round((curZoom + 0.25) * 100) / 100);
        updateState({ mainZoom: nextZoom });
        flashRingHud(`▲ ZOOM ${nextZoom.toFixed(2)}x ${appState.reticleFfpMode ? '(FFP 🔒)' : ''}`);
      } else if (act === 'DOWN') {
        const nextZoom = Math.max(1.0, Math.round((curZoom - 0.25) * 100) / 100);
        const maxPan = Math.max(0, (1 - 1 / nextZoom) / 2);
        const nx = Math.max(-maxPan, Math.min(maxPan, appState.mainPanX || 0));
        const ny = Math.max(-maxPan, Math.min(maxPan, appState.mainPanY || 0));
        updateState({ mainZoom: nextZoom, mainPanX: nx, mainPanY: ny });
        flashRingHud(`▼ ZOOM ${nextZoom.toFixed(2)}x ${appState.reticleFfpMode ? '(FFP 🔒)' : ''}`);
      } else if (act === 'LEFT') {
        // Step zoom down coarser (-0.5x)
        const nextZoom = Math.max(1.0, Math.round((curZoom - 0.5) * 100) / 100);
        updateState({ mainZoom: nextZoom });
        flashRingHud(`◀ ZOOM ${nextZoom.toFixed(2)}x`);
      } else if (act === 'RIGHT') {
        // Step zoom up coarser (+0.5x)
        const nextZoom = Math.min(5.0, Math.round((curZoom + 0.5) * 100) / 100);
        updateState({ mainZoom: nextZoom });
        flashRingHud(`▶ ZOOM ${nextZoom.toFixed(2)}x`);
      }
      return;
    }

    // 3. RETICLE CAL (Adjust crosshair hashmark spacing & scale)
    if (mode === 'RETICLE CAL') {
      const cfg = appState.reticleConfig || {};
      const curSpacing = cfg.clickSpacing || 32;

      if (act === 'UP') {
        const nextSpacing = Math.min(100, curSpacing + 1);
        updateState({ reticleConfig: { ...cfg, clickSpacing: nextSpacing } });
        saveSettings(appState);
        flashRingHud(`▲ RETICLE SPACING: ${nextSpacing}px (+1)`);
      } else if (act === 'DOWN') {
        const nextSpacing = Math.max(8, curSpacing - 1);
        updateState({ reticleConfig: { ...cfg, clickSpacing: nextSpacing } });
        saveSettings(appState);
        flashRingHud(`▼ RETICLE SPACING: ${nextSpacing}px (-1)`);
      } else if (act === 'LEFT') {
        const nextSpacing = Math.max(8, curSpacing - 5);
        updateState({ reticleConfig: { ...cfg, clickSpacing: nextSpacing } });
        saveSettings(appState);
        flashRingHud(`◀ RETICLE SPACING: ${nextSpacing}px (-5)`);
      } else if (act === 'RIGHT') {
        const nextSpacing = Math.min(100, curSpacing + 5);
        updateState({ reticleConfig: { ...cfg, clickSpacing: nextSpacing } });
        saveSettings(appState);
        flashRingHud(`▶ RETICLE SPACING: ${nextSpacing}px (+5)`);
      }
      return;
    }
  }

  function handleRingSignal(signalCode) {
    if (ringLastSignalEl) {
      ringLastSignalEl.textContent = `SIGNAL: ${signalCode}`;
    }

    // If user is currently calibrating/learning a button in Controller Screen or Settings
    if (learningAction) {
      customMap[learningAction] = signalCode;
      updateState({ ringKeyMap: { ...customMap } });
      saveSettings(appState);
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = `BOUND [${learningAction}] → ${signalCode}`;
      }
      const actLearned = learningAction;
      learningAction = null;
      updateLearnButtonsUI();

      // Dispatch event so UI can flash success
      window.dispatchEvent(
        new CustomEvent('spotr-remote-button', {
          detail: { action: actLearned, signalCode, isLearned: true }
        })
      );
      return true;
    }

    const action = resolveRingAction(signalCode);

    // Notify any listening UI (such as the Remote Configurator tab in Screen 5)
    window.dispatchEvent(
      new CustomEvent('spotr-remote-button', {
        detail: { action, signalCode, isLearned: false }
      })
    );

    if (!action) return false;

    if (action === 'BTN1') {
      executeBtn1();
      return true;
    }

    if (action === 'BTN2') {
      executeBtn2();
      return true;
    }

    if (action === 'CENTER') {
      executeCenter();
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

      // Do not hijack typing if focus is inside an input, textarea, select, or editable element
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (
        !learningAction &&
        (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl?.isContentEditable)
      ) {
        return;
      }

      const code = e.code || e.key;
      const handled = handleRingSignal(code);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  // 2. Listen for Bluetooth Ring Scroll-Wheel ticks
  window.addEventListener(
    'wheel',
    (e) => {
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

  // Sync HUD label whenever screen, replay, or FFP state changes
  subscribeState(() => {
    if (ringModeBadge) {
      ringModeBadge.textContent = `REMOTE: ${getActiveRemoteMode()}`;
    }
  });

  updateLearnButtonsUI();
}
