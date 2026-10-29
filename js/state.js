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
  galleryDrawerOpen: true,

  // Superimposed Overlay Guide (Only 'crosshair' or 'custom')
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

  // Localized Micro-Change Heatmap (ignores global camera shake)
  heatmapEnabled: false,
  heatmapSensitivity: 60, // 10 (low) to 95 (high)
  heatmapDuration: 2.0,   // Adjustable: 0.5s to 60.0s display duration
  heatmapSpeechEnabled: false, // Voice callouts ("Detection, 12 o'clock, 3 ticks")

  // Configurable In-Memory Rolling Recording Buffer
  bufferEnabled: true,
  bufferMaxSeconds: 20, // Adjustable: 5s to 60s
  bufferTargetFps: 15,  // Adjustable: 5 FPS to 30 FPS
  bufferedSeconds: 0,
  bufferBytes: 0,
  replayActive: false,

  // Interface Theme Color, Global UI Opacity, Declutter Mode & 5-Button Bluetooth Ring
  themeColor: '#2dd4bf',
  uiOpacity: 100,
  uiDecluttered: false,
  ringKeyMap: {}
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
