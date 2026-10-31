/**
 * SPOTR Tactical Splash Screen Controller
 *
 * Displays the SPOTR brand logo & identification screen on app launch.
 * Automatically dismisses after 3.5s (in 3-4s window) or immediately
 * when skipped silently via Space, Gamepad / Controller button, Ring click, or Tap.
 */

let isSplashActive = true;
let dismissTimer = null;
let splashEl = null;

export function isSplashScreenActive() {
  return isSplashActive;
}

export function initSplashScreen() {
  splashEl = document.getElementById('splashScreen');
  if (!splashEl) {
    isSplashActive = false;
    return;
  }

  // 1. Auto-dismiss after 3.5 seconds
  dismissTimer = setTimeout(() => {
    dismissSplashScreen('timeout');
  }, 3500);

  // 2. Skip on tap / click anywhere on splash screen
  splashEl.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    dismissSplashScreen('pointer');
  });

  // 3. Skip on Space / Enter / Escape key
  const onKeyDown = (e) => {
    if (!isSplashActive) return;
    if (e.code === 'Space' || e.key === ' ' || e.code === 'Enter' || e.code === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      dismissSplashScreen('keyboard');
    }
  };
  window.addEventListener('keydown', onKeyDown, { capture: true });
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
    // Remove element from layout once fade-out transition completes
    setTimeout(() => {
      splashEl.style.display = 'none';
    }, 480);
  }
}
