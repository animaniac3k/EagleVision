/**
 * Central Reactive State Store for EagleVision
 */
const listeners = new Set();

export const appState = {
  // Camera & Stream
  activeDeviceId: 'auto',
  activeDeviceLabel: 'INITIALIZING...',
  streamWidth: 1920,
  streamHeight: 1080,
  fps: 60,
  isSimulatedStream: false,

  // Main Viewport Zoom & Pan
  mainZoom: 1.0,
  mainPanX: 0,
  mainPanY: 0,

  // Digital Zoom Window (PiP) & ROI Target Crosshair
  pipEnabled: true,
  pipZoom: 3.0,
  roiTargetVisible: true,
  roiX: 0.5,
  roiY: 0.5,

  // UI Windows Visibility
  optionsOpen: true,
  hudOpen: false,
  currentScreen: 'live',

  // Superimposed Overlay Guide
  overlayEnabled: true,
  overlayType: 'crosshair',
  overlayOpacity: 75,
  overlayScale: 100,
  customOverlayUrl: null,

  // Image Manipulation Filters
  brightness: 100,
  contrast: 100,
  saturation: 100,
  invert: false,
  grayscale: false,

  // Temporal Compare (Chrono-Ghost & Change-Radar)
  temporalMode: 'off', // 'off' | 'ghost' | 'delta'
  temporalDelaySec: 2.0,

  // 20-Second Rolling In-Memory Buffer
  bufferEnabled: true,
  bufferedSeconds: 0,
  bufferBytes: 0,
  replayActive: false,

  // Interface Theme Color
  themeColor: '#2dd4bf'
};

export function updateState(patch) {
  Object.assign(appState, patch);
  for (const fn of listeners) {
    fn(appState, patch);
  }
}

export function subscribeState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
