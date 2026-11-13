/**
 * SPOTR 7-Button Wireless Bluetooth Remote / Ring Controller Integration
 *
 * Single 1-to-1 Mode for One-Finger Operation:
 * - ▲ / ▼ / ◀ / ▶ : Pan Live View (when zoomed > 1.0x via Center button)
 * - Center (●)    : Cycle Zoom (1.0x → 1.5x → 2.0x → 2.5x → 3.0x → 1.0x & re-center)
 * - Button 2 (2)  : Instant Replay In / Out toggle (recommended on ChromeOS)
 * - Button 1 (⏻1) : Instant Replay In / Out toggle (alternate)
 * - Auto-Player Mode when Instant Replay or Gallery is active:
 *     - ● CENTER     : Play / Pause
 *     - ◀ / ▶        : Step -1 / +1 Frame
 *     - ▲            : Restart Replay
 *     - ▼ / BTN2 / 1 : Exit back to Live View
 *
 * Supports HID Keyboard/Media keys, Scroll-Wheel ticks, Mouse/Aux buttons,
 * and HID Touch/Pointer Swipes & Taps (such as TikTok/e-reader Bluetooth rings
 * like the Yiser-J6 on ChromeOS), with live hardware signal diagnostics,
 * visual button glowing, and a one-click "Learn Button" calibration tool.
 */

import { appState, updateState } from '../state.js';
import { saveSettings } from '../storage/settingsStore.js';
import { isSplashScreenActive, dismissSplashScreen } from './splashScreen.js';

export const ZOOM_CYCLE_STOPS = [1.0, 1.5, 2.0, 2.5, 3.0];

export const DEFAULT_KEY_MAP = {
  UP: ['ArrowUp', 'PageUp', 'KeyW'],
  DOWN: ['ArrowDown', 'PageDown', 'KeyS'],
  LEFT: ['ArrowLeft', 'MediaTrackPrevious', 'KeyA'],
  RIGHT: ['ArrowRight', 'MediaTrackNext', 'KeyD'],
  CENTER: ['Enter', 'NumpadEnter', 'Space', 'MediaPlayPause', 'KeyF'],
  BTN1: ['AudioVolumeUp', 'KeyX', 'KeyR', 'F12'],
  BTN2: ['AudioVolumeDown', 'KeyM', 'KeyT', 'Tab', 'KeyB']
};

export const RING_SWIPE_MAX_MS = 420;
const RING_SWIPE_MIN_DIST_PX = 12;
const SUPPRESS_CLICK_MS = 450;

let learningAction = null;
let hudFadeTimer = null;
let lastWheelMs = 0;
let lastKeyDownMs = 0;
let suppressNextClickUntil = 0;
let suppressNextAuxUntil = 0;

export function hasMappedSwipeSignals() {
  const map = appState.ringKeyMap || {};
  return Object.values(map).some((v) => typeof v === 'string' && v.includes('Swipe'));
}

export function shouldHoldCanvasPan(panStartTime) {
  return hasMappedSwipeSignals() && performance.now() - panStartTime <= RING_SWIPE_MAX_MS;
}

export function getActiveRemoteMode() {
  if (appState.currentScreen === 'gallery' || appState.replayActive) {
    return 'REPLAY';
  }
  return 'DIRECT';
}

export function getLearningAction() {
  return learningAction;
}

export function setLearningAction(act) {
  learningAction = act;
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
  }
  const screenController = document.getElementById('screenController');
  if (screenController) {
    screenController.classList.toggle('remote-learning-active', Boolean(learningAction));
  }
  const ringLastSignalEl = document.getElementById('ringLastSignal');
  if (ringLastSignalEl) {
    ringLastSignalEl.textContent = learningAction
      ? `WAITING FOR [${learningAction}] PRESS ON RING/REMOTE... (ESC TO CANCEL)`
      : 'READY (CLICK ANY BUTTON TO CALIBRATE)';
  }
  document.querySelectorAll('.remote-learn-btn').forEach((btn) => {
    const a = btn.dataset.remoteAct;
    const isLearning = learningAction === a;
    btn.classList.toggle('radar-btn-active', isLearning);
    btn.textContent = isLearning ? 'WAITING...' : 'LEARN';
  });
  document.querySelectorAll('.remote-visual-btn').forEach((vBtn) => {
    const a = vBtn.dataset.remoteAct;
    vBtn.classList.toggle('remote-learning-pulse', learningAction === a);
  });
}

export function initRingController() {
  const ringHudPill = document.getElementById('ringHudPill');
  const ringModeBadge = document.getElementById('ringModeBadge');
  const ringActionText = document.getElementById('ringActionText');
  const ringLastSignalEl = document.getElementById('ringLastSignal');
  const ringRawSignalLogEl = document.getElementById('ringRawSignalLog');
  let lastPrimaryRawMs = 0;

  function logRawSignal(summary, isFallback = false) {
    const now = performance.now();
    if (isFallback && now - lastPrimaryRawMs < 120) return;
    if (!isFallback) lastPrimaryRawMs = now;
    if (ringRawSignalLogEl && appState.currentScreen === 'controller') {
      ringRawSignalLogEl.textContent = `RAW: ${summary}`;
    }
  }

  function getCustomRingMap() {
    return appState.ringKeyMap && typeof appState.ringKeyMap === 'object' ? appState.ringKeyMap : {};
  }

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

  function parseTouchTapCoords(code) {
    if (typeof code !== 'string' || !code.startsWith('TouchTap@')) return null;
    const parts = code.slice('TouchTap@'.length).split('x');
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  }

  function formatTouchTapSignal(x, y) {
    const w = window.innerWidth || 1;
    const h = window.innerHeight || 1;
    const qx = Math.max(0, Math.min(100, Math.round(((x / w) * 100) / 5) * 5));
    const qy = Math.max(0, Math.min(100, Math.round(((y / h) * 100) / 5) * 5));
    return `TouchTap@${qx}x${qy}`;
  }

  function resolveRingAction(codeOrKey) {
    const customMap = getCustomRingMap();
    // 1. Check exact custom learned signal first
    for (const [act, boundCode] of Object.entries(customMap)) {
      if (!boundCode) continue;
      const codes = String(boundCode).split(',').map((s) => s.trim()).filter(Boolean);
      if (codes.includes(codeOrKey)) return act;
    }
    // 2. Coordinate-tolerant match for TouchTap@qx,qy (10% radius), then legacy TouchTap fallback
    const tapCoords = parseTouchTapCoords(codeOrKey);
    if (tapCoords) {
      let bestAct = null;
      let bestDist = 10.01;
      for (const [act, boundCode] of Object.entries(customMap)) {
        if (!boundCode) continue;
        const codes = String(boundCode).split(',').map((s) => s.trim()).filter(Boolean);
        for (const token of codes) {
          const boundCoords = parseTouchTapCoords(token);
          if (!boundCoords) continue;
          const d = Math.hypot(tapCoords.x - boundCoords.x, tapCoords.y - boundCoords.y);
          if (d <= 10 && d < bestDist) {
            bestDist = d;
            bestAct = act;
          }
        }
      }
      if (bestAct) return bestAct;

      for (const [act, boundCode] of Object.entries(customMap)) {
        if (!boundCode) continue;
        const codes = String(boundCode).split(',').map((s) => s.trim()).filter(Boolean);
        if (codes.includes('TouchTap')) return act;
      }
    }
    // 3. Check built-in multi-protocol remote bindings
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

  function toggleInstantReplay(label) {
    if (appState.currentScreen === 'gallery') {
      document.getElementById('btnBackToLive')?.click();
      flashRingHud(`${label}: RETURN TO LIVE FEED`);
      return;
    }

    if (appState.replayActive) {
      document.getElementById('btnCloseReplay')?.click();
      flashRingHud(`${label}: RETURN TO LIVE FEED`);
      return;
    }

    document.getElementById('btnReplay20s')?.click();
    flashRingHud(`${label}: INSTANT REPLAY`);
  }

  function executeBtn1() {
    toggleInstantReplay('BTN 1');
  }

  function executeBtn2() {
    toggleInstantReplay('BTN 2');
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

    // Live Mode: Single-mode Zoom Cycle (1.0x → 1.5x → 2.0x → 2.5x → 3.0x → 1.0x)
    const curZoom = appState.mainZoom || 1.0;
    const nextZoom = ZOOM_CYCLE_STOPS.find((z) => z > curZoom + 0.05) ?? 1.0;
    if (nextZoom <= 1.01) {
      updateState({ mainZoom: 1.0, mainPanX: 0, mainPanY: 0 });
      flashRingHud('● ZOOM 1.0x (RESET)');
      return;
    }

    const maxPan = Math.max(0, (1 - 1 / nextZoom) / 2);
    const nx = Math.max(-maxPan, Math.min(maxPan, appState.mainPanX || 0));
    const ny = Math.max(-maxPan, Math.min(maxPan, appState.mainPanY || 0));
    updateState({ mainZoom: nextZoom, mainPanX: nx, mainPanY: ny });
    flashRingHud(`● ZOOM ${nextZoom.toFixed(1)}x`);
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

    // C. Live Camera Feed — Direct 1-to-1 Pan (only when already zoomed in via Center)
    const zoom = appState.mainZoom || 1.0;
    if (zoom <= 1.01) {
      return;
    }

    const maxPan = Math.max(0, (1 - 1 / zoom) / 2);
    const speedRatio = (appState.ringPanSpeed ?? 70) / 100;
    const panStep = Math.max(0.002, (0.024 * speedRatio) / zoom);

    let nx = appState.mainPanX || 0;
    let ny = appState.mainPanY || 0;

    if (act === 'UP') ny = Math.max(-maxPan, ny - panStep);
    if (act === 'DOWN') ny = Math.min(maxPan, ny + panStep);
    if (act === 'LEFT') nx = Math.max(-maxPan, nx - panStep);
    if (act === 'RIGHT') nx = Math.min(maxPan, nx + panStep);

    updateState({ mainPanX: nx, mainPanY: ny });
    flashRingHud(`PAN (${Math.round(nx * 100)}, ${Math.round(ny * 100)}) [${zoom.toFixed(1)}x]`);
  }

  function handleRingSignal(signalCode) {
    if (ringLastSignalEl) {
      ringLastSignalEl.textContent = `SIGNAL: ${signalCode}`;
    }

    // If user is currently calibrating/learning a button in Controller Screen
    if (learningAction) {
      const nextMap = { ...getCustomRingMap() };
      const learnedCoords = parseTouchTapCoords(signalCode);
      for (const [act, boundCode] of Object.entries(nextMap)) {
        if (act === learningAction) continue;
        const trimmed = String(boundCode).trim();
        if (trimmed === signalCode) {
          delete nextMap[act];
          continue;
        }
        if (learnedCoords) {
          const otherCoords = parseTouchTapCoords(trimmed);
          if (otherCoords && Math.hypot(learnedCoords.x - otherCoords.x, learnedCoords.y - otherCoords.y) <= 6) {
            delete nextMap[act];
          }
        }
      }
      nextMap[learningAction] = signalCode;
      updateState({ ringKeyMap: nextMap });
      saveSettings(appState);
      if (ringLastSignalEl) {
        ringLastSignalEl.textContent = `BOUND [${learningAction}] → ${signalCode}`;
      }
      const actLearned = learningAction;
      setLearningAction(null);

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

  function extractKeySignal(e) {
    if (e.code && e.code !== 'Unidentified') return e.code;
    if (e.key && e.key !== 'Unidentified') return e.key;
    if (e.keyCode || e.which) return `KeyCode${e.keyCode || e.which}`;
    return null;
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

      // Cancel learning mode on Escape key
      if (learningAction && (e.key === 'Escape' || e.code === 'Escape')) {
        e.preventDefault();
        e.stopPropagation();
        setLearningAction(null);
        window.dispatchEvent(
          new CustomEvent('spotr-remote-button', {
            detail: { action: null, signalCode: 'ESC', isCancelled: true }
          })
        );
        return;
      }

      logRawSignal(`keydown code=${e.code || '-'} key=${e.key || '-'} keyCode=${e.keyCode || 0}`);

      // Do not hijack typing if focus is inside an input, textarea, select, or editable element
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (
        !learningAction &&
        (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl?.isContentEditable)
      ) {
        return;
      }

      const code = extractKeySignal(e);
      if (!code) return;
      lastKeyDownMs = performance.now();

      const handled = handleRingSignal(code);
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  // Fallback for ChromeOS/Android HID consumer keys that dispatch only keyup
  window.addEventListener(
    'keyup',
    (e) => {
      logRawSignal(`keyup code=${e.code || '-'} key=${e.key || '-'} keyCode=${e.keyCode || 0}`, true);
      if (performance.now() - lastKeyDownMs <= 300) return;
      const activeEl = document.activeElement;
      const tag = activeEl?.tagName;
      if (
        !learningAction &&
        (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || activeEl?.isContentEditable)
      ) {
        return;
      }
      const code = extractKeySignal(e);
      if (!code || code === 'Escape') return;
      logRawSignal(`keyup code=${e.code || '-'} key=${e.key || '-'} keyCode=${e.keyCode || 0}`);
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
      logRawSignal(`wheel dx=${e.deltaX.toFixed(1)} dy=${e.deltaY.toFixed(1)}`);
      const targetEl = e.target instanceof Element ? e.target : null;
      if (
        !learningAction &&
        targetEl &&
        (targetEl.closest('#optionsPanel') || targetEl.closest('#galleryDrawer'))
      ) {
        return;
      }
      const now = performance.now();
      if (!learningAction && now - lastWheelMs < 140) return;
      lastWheelMs = now;

      let wheelCode = null;
      if (Math.abs(e.deltaY) >= Math.abs(e.deltaX)) {
        if (e.deltaY < 0) wheelCode = 'WheelUp';
        else if (e.deltaY > 0) wheelCode = 'WheelDown';
      } else {
        if (e.deltaX < 0) wheelCode = 'WheelLeft';
        else if (e.deltaX > 0) wheelCode = 'WheelRight';
      }

      if (!wheelCode) return;
      logRawSignal(`wheel dx=${e.deltaX.toFixed(1)} dy=${e.deltaY.toFixed(1)} → ${wheelCode}`);

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

  // 3. Listen for Bluetooth Ring HID Touch / Pointer Swipes, Taps & Mouse Aux Buttons
  let activeSwipePointer = null;
  let recentTapMs = 0;
  let recentTapCount = 0;

  function isFormControl(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
  }

  function isLearnUiControlTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    return Boolean(
      el.closest(
        '.remote-visual-btn, .remote-learn-btn, .cm-tab-btn, .setup-nav-tab, .radar-btn, button, a, input, select, textarea'
      )
    );
  }

  function isInteractiveOverlayTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    return Boolean(
      el.closest(
        '#optionsPanel, #galleryDrawer, .pip-controls, .pip-resize-handle, .cm-table-wrap, .remote-device-box, button, a, input, select, textarea'
      )
    );
  }

  function classifySwipeCode(dx, dy) {
    if (Math.abs(dx) >= Math.abs(dy)) {
      return dx > 0 ? 'SwipeRight' : 'SwipeLeft';
    }
    return dy > 0 ? 'SwipeDown' : 'SwipeUp';
  }

  window.addEventListener(
    'pointerdown',
    (e) => {
      const onForm = isFormControl(e.target);
      if (onForm && !learningAction && appState.currentScreen !== 'controller') return;
      const now = performance.now();
      logRawSignal(
        `ptr-down(${e.pointerType || '?'}) id=${e.pointerId} btn=${e.button} @${Math.round(e.clientX)},${Math.round(e.clientY)}${onForm ? ' [form]' : ''}`
      );
      activeSwipePointer = {
        id: e.pointerId,
        pointerType: e.pointerType || 'unknown',
        button: e.button,
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        startTime: now,
        target: e.target,
        startedOnForm: onForm
      };
    },
    { capture: true, passive: true }
  );

  window.addEventListener(
    'pointermove',
    (e) => {
      if (!activeSwipePointer || e.pointerId !== activeSwipePointer.id) return;
      activeSwipePointer.lastX = e.clientX;
      activeSwipePointer.lastY = e.clientY;
      const dx = e.clientX - activeSwipePointer.startX;
      const dy = e.clientY - activeSwipePointer.startY;
      const dist = Math.hypot(dx, dy);
      if (dist >= 8) {
        logRawSignal(
          `ptr-move(${activeSwipePointer.pointerType}) dist=${Math.round(dist)}px dx=${Math.round(dx)} dy=${Math.round(dy)}`
        );
      }
    },
    { capture: true, passive: true }
  );

  function finishSwipePointer(e, isCancel) {
    if (
      !activeSwipePointer ||
      (e.pointerId !== activeSwipePointer.id &&
        (e.pointerType || 'unknown') !== activeSwipePointer.pointerType)
    ) {
      return;
    }
    const ptr = activeSwipePointer;
    activeSwipePointer = null;

    if (!isCancel && Number.isFinite(e.clientX) && Number.isFinite(e.clientY)) {
      ptr.lastX = e.clientX;
      ptr.lastY = e.clientY;
    }

    const dx = ptr.lastX - ptr.startX;
    const dy = ptr.lastY - ptr.startY;
    const dist = Math.hypot(dx, dy);
    const now = performance.now();
    const elapsed = now - ptr.startTime;

    let tapInfo = '';
    if (!isCancel && dist < RING_SWIPE_MIN_DIST_PX) {
      recentTapCount = now - recentTapMs <= 500 ? recentTapCount + 1 : 1;
      recentTapMs = now;
      tapInfo = ` taps=${recentTapCount}`;
    } else {
      recentTapCount = 0;
    }

    const pctX = window.innerWidth > 0 ? Math.round((ptr.startX / window.innerWidth) * 100) : 0;
    const pctY = window.innerHeight > 0 ? Math.round((ptr.startY / window.innerHeight) * 100) : 0;

    logRawSignal(
      `ptr(${ptr.pointerType}) btn=${ptr.button} @${Math.round(ptr.startX)},${Math.round(ptr.startY)}(${pctX}%,${pctY}%) dist=${Math.round(dist)}px${tapInfo} ${Math.round(elapsed)}ms${isCancel ? ' [cancel]' : ''}`
    );

    if (ptr.startedOnForm && !learningAction) return;

    // Non-primary mouse buttons (Middle / Right / Browser Back / Browser Forward)
    if (!isCancel && ptr.button >= 1 && dist < RING_SWIPE_MIN_DIST_PX) {
      const btnCode = `MouseBtn${ptr.button}`;
      if (learningAction || resolveRingAction(btnCode)) {
        suppressNextAuxUntil = performance.now() + 200;
        handleRingSignal(btnCode);
        return;
      }
    }

    // Touch / Pointer Tap (dist < threshold)
    if (dist < RING_SWIPE_MIN_DIST_PX) {
      const tapCode = formatTouchTapSignal(ptr.startX, ptr.startY);
      if (learningAction && !isCancel && !isLearnUiControlTarget(ptr.target)) {
        suppressNextClickUntil = performance.now() + SUPPRESS_CLICK_MS;
        handleRingSignal(tapCode);
        return;
      }
      if (
        !learningAction &&
        !isCancel &&
        elapsed <= 750 &&
        !isInteractiveOverlayTarget(ptr.target) &&
        resolveRingAction(tapCode)
      ) {
        suppressNextClickUntil = performance.now() + SUPPRESS_CLICK_MS;
        handleRingSignal(tapCode);
      }
      return;
    }

    const swipeCode = classifySwipeCode(dx, dy);

    if (learningAction) {
      suppressNextClickUntil = performance.now() + SUPPRESS_CLICK_MS;
      handleRingSignal(swipeCode);
      return;
    }

    if (elapsed > RING_SWIPE_MAX_MS) return;

    if (appState.currentScreen === 'controller' && !isInteractiveOverlayTarget(ptr.target)) {
      if (ringLastSignalEl) ringLastSignalEl.textContent = `SIGNAL: ${swipeCode}`;
      if (!resolveRingAction(swipeCode)) {
        window.dispatchEvent(
          new CustomEvent('spotr-remote-button', {
            detail: { action: null, signalCode: swipeCode, isLearned: false }
          })
        );
        return;
      }
    }

    if (isInteractiveOverlayTarget(ptr.target)) return;

    if (resolveRingAction(swipeCode)) {
      suppressNextClickUntil = performance.now() + SUPPRESS_CLICK_MS;
      handleRingSignal(swipeCode);
    }
  }

  window.addEventListener('pointerup', (e) => finishSwipePointer(e, false), {
    capture: true,
    passive: true
  });
  window.addEventListener('pointercancel', (e) => finishSwipePointer(e, true), {
    capture: true,
    passive: true
  });

  // Fallback raw telemetry listeners for unusual ChromeOS HID touch/scroll/gamepad inputs
  window.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches?.[0];
      logRawSignal(
        `touchstart n=${e.touches?.length || 0} @${t ? `${Math.round(t.clientX)},${Math.round(t.clientY)}` : '?'}`,
        true
      );
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    'touchend',
    (e) => {
      const t = e.changedTouches?.[0];
      logRawSignal(
        `touchend @${t ? `${Math.round(t.clientX)},${Math.round(t.clientY)}` : '?'}`,
        true
      );
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    'scroll',
    (e) => {
      const target = e.target instanceof Element ? e.target : null;
      const label = target?.id || target?.className || 'window';
      logRawSignal(`scroll(${String(label).slice(0, 24)})`, true);
    },
    { capture: true, passive: true }
  );
  window.addEventListener('gamepadconnected', (e) => {
    logRawSignal(`gamepad: ${e.gamepad?.id || 'connected'}`, true);
  });

  window.addEventListener(
    'click',
    (e) => {
      if (e.isTrusted && performance.now() < suppressNextClickUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  window.addEventListener(
    'auxclick',
    (e) => {
      if (e.isTrusted && performance.now() < suppressNextAuxUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );

  window.addEventListener(
    'contextmenu',
    (e) => {
      if (e.isTrusted && performance.now() < suppressNextAuxUntil) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    { capture: true }
  );
}
