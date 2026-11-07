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
  isRtspStream: false,
  rtspSourceMode: 'usb',       // 'usb' | 'rtsp'
  rtspPreset: 'bresser',       // 'bresser' | 'onvif' | 'custom'
  rtspCameraIp: '192.168.0.1', // Default Bresser Eyepiece HD IP
  rtspChannel: 'ch0',          // Default highest res channel (1080p Full HD)
  rtspOnvifPort: 554,
  rtspOnvifPath: '/onvif1',
  rtspOnvifUser: '',
  rtspOnvifPass: '',
  rtspCustomUrl: '',
  rtspWakeStatus: 'idle',      // 'idle' | 'waking' | 'live' | 'error'
  rtspAvailableChannels: [],

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

  // UI Windows Visibility & Active Screen ('live' | 'gallery' | 'settings' | 'reticle')
  optionsOpen: false,
  hudOpen: false,
  currentScreen: 'live',
  galleryDrawerOpen: true,

  // Superimposed Overlay Guide & Reticle Customization
  overlayEnabled: true,
  overlayType: 'crosshair',
  overlayOpacity: 75,
  overlayScale: 100,
  reticleFfpMode: true,    // First Focal Plane: scales reticle in lockstep with image zoom
  customOverlayUrl: null,
  activeQuickToolIndex: 0, // Cyclic Quick Tool index (0..6)
  reticleConfig: {
    clickCount: 10,        // Number of clicks/indents per arm (2..30)
    clickSpacing: 32,      // SVG units between clicks (8..100)
    centerGap: 64,         // Unobstructed center gap (0..280)
    centerStyle: 'empty',  // Center point: 'empty' | 'dot' | 'cross' | 'chevron'
    majorInterval: 5,      // Major tick every N clicks (0 for none)
    minorTickLen: 10,      // Minor tick length (4..16)
    majorTickLen: 18,      // Major tick length (8..26)
    showLabels: true,      // Click numbers on arms (1, 2, 3... or 5, 10)
    concentricRings: false,// Concentric range circles
    ringInterval: 5,       // Circle every N clicks
    strokeWidth: 1.8,      // Reticle stroke thickness (0.5..5.0)
    reticleColor: ''       // Empty string = dynamic radar theme color
  },

  // Image Manipulation Filters
  brightness: 100,
  contrast: 100,
  saturation: 100,
  invert: false,
  grayscale: false,

  // Localized Micro-Change Heatmap (ignores global camera shake)
  heatmapEnabled: false,
  heatmapSensitivity: 60, // 10 (low) to 95 (high)
  heatmapDuration: 30.0,  // Adjustable: 0.5s to 9999s / Infinity
  heatmapSpeechEnabled: false, // Voice callouts ("Detection! 11 o'clock, 3 clicks")
  voicePitch: 1.25,       // Female voice pitch (1.0..1.6)
  voiceRate: 0.80,        // Voice speech rate (0.6..1.0)
  voiceAlertKeyword: 'Detection', // Customizable alert keyword (e.g. Contact, Target, Alert)
  voiceUnitKeyword: 'clicks',     // Customizable distance unit (e.g. clicks, mils, marks, units)

  // Configurable In-Memory Rolling Recording Buffer
  bufferEnabled: true,
  bufferMaxSeconds: 20, // Adjustable: 5s to 60s
  bufferTargetFps: 15,  // Adjustable: 5 FPS to 30 FPS
  bufferedSeconds: 0,
  bufferBytes: 0,
  replayActive: false,

  // Interface Theme Color, Global UI Opacity, Declutter Mode, Gamepad & 5-Button Bluetooth Ring
  themeColor: '#f97316',
  uiOpacity: 100,
  uiDecluttered: false,
  touchpadSensitivity: 50, // 15% to 150%, default 50% (50% less for precision)
  reticleAimSpeed: 50,     // 15% to 150%, default 50% (50% max speed for pinpoint reticle positioning)
  leftStickDeadzone: 16,   // 5% to 30% deadzone
  rightStickDeadzone: 16,  // 5% to 30% deadzone
  leftStickInvertY: false, // Invert left stick vertical axis
  rightStickInvertY: false,// Invert right stick vertical axis
  activeControllerProfile: 'default', // 'default' | 'simplified' | 'flight'
  controllerBindings: null,// User-configured controller & key mappings
  ringKeyMap: {},
  gamepadConnected: false,
  gamepadName: '',
  lastGamepadAction: ''
};

export function updateState(patch) {
  Object.assign(appState, patch);
  for (const fn of listeners) {
    fn(appState, patch);
  }
}

export function subscribeState(fn) {
  listeners.add(fn);
  try {
    fn(appState, {});
  } catch (err) {
    console.warn('[subscribeState initial error]', err);
  }
  return () => listeners.delete(fn);
}
