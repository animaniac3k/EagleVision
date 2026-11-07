/**
 * SPOTR Tactical Splash Screen Controller
 *
 * Displays the SPOTR brand logo & identification screen on app launch.
 * Sequences soft word loading (RECON • DETECT • ALERT), followed by loading bar fill.
 * Automatically dismisses at 2.5s (smooth 2.2s sequence + fade),
 * or immediately when skipped via any Tap, Click, Keypress, Gamepad, or Ring input.
 */

let isSplashActive = true;
let dismissTimer = null;
let splashEl = null;

export function isSplashScreenActive() {
  return isSplashActive;
}

export function dismissSplashScreen(source = 'unknown') {
  if (!isSplashActive) return;
  isSplashActive = false;

  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }

  if (splashEl) {
    splashEl.classList.add('splash-hidden');
    splashEl.style.pointerEvents = 'none';
    splashEl.style.opacity = '0';
    setTimeout(() => {
      splashEl.style.display = 'none';
    }, 350);
  }
}

export function initSplashScreen() {
  splashEl = document.getElementById('splashScreen');
  if (!splashEl) {
    isSplashActive = false;
    return;
  }

  // Check URL query override (?nosplash)
  if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('nosplash')) {
    splashEl.style.display = 'none';
    splashEl.classList.add('splash-hidden');
    isSplashActive = false;
    return;
  }

  // 1. Auto-dismiss after 2.5s (tagline & progress complete cleanly in 2.2s)
  dismissTimer = setTimeout(() => {
    dismissSplashScreen('timeout');
  }, 2500);

  // 2. Immediate dismissal handlers on any user interaction
  const onDismissEvent = () => {
    if (!isSplashActive) return;
    dismissSplashScreen('user-action');
  };

  // Attach to splash element
  splashEl.addEventListener('click', onDismissEvent);
  splashEl.addEventListener('pointerdown', onDismissEvent);
  splashEl.addEventListener('touchstart', onDismissEvent, { passive: true });

  // Attach global capturing listeners to window for instant response
  window.addEventListener('click', onDismissEvent, { capture: true, once: true });
  window.addEventListener('pointerdown', onDismissEvent, { capture: true, once: true });
  window.addEventListener('keydown', onDismissEvent, { capture: true, once: true });
}
