/**
 * Central Reactive State Store for SPOTR
 */
export const APP_VERSION = 'v0.63.0';

const listeners = new Set();

export const appState = {
  // Camera & Stream
  activeDeviceId: 'auto',
  activeDeviceLabel: 'INITIALIZING...',
  streamStatus: 'connecting',  // 'live' | 'reconnecting' | 'simulated' | 'connecting' | 'offline'
  streamWidth: 1920,
  streamHeight: 1080,
  fps: 60,
  isSimulatedStream: false,
  isRtspStream: false,
  rtspSourceMode: 'usb',       // 'usb' | 'rtsp'
  rtspPreset: 'bresser',       // 'bresser' | 'onvif' | 'custom'
  rtspCameraIp: '192.168.0.1', // Default Bresser Eyepiece HD IP
  rtspChannel: 'ch0',          // Default highest res channel (1080p Full HD)
  rtspOnvifIp: '192.168.1.100',
  rtspOnvifPort: 554,
  rtspOnvifPath: '/onvif1',
  rtspOnvifUser: '',
  rtspCustomUrl: '',
  rtspGatewayHost: '',         // Optional gateway host/IP (e.g. 'http://192.168.0.50:8080')

  // Main Viewport Zoom & Pan
  mainZoom: 1.0,
  mainPanX: 0,
  mainPanY: 0,

  // Digital Zoom Window (PiP) & ROI Target Crosshair
  pipEnabled: true,
  pipZoom: 3.0,
  autoAimLoupe: false,
  roiTargetVisible: true,
  roiX: 0.5,
  roiY: 0.5,

  // UI Windows Visibility & Active Screen ('live' | 'gallery' | 'settings' | 'reticle' | 'calibration' | 'controller')
  hudOpen: false,
  currentScreen: 'live',
  galleryDrawerOpen: false,
  reticleBackdrop: 'night',

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
    labelSize: 10,         // Click number font size in SVG units (6..24)
    concentricRings: false,// Concentric range circles
    ringInterval: 5,       // Circle every N clicks
    svdRangefinder: false, // SVD-style stadiametric rangefinder in bottom-right quadrant
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
  heatmapSetupOpen: false, // Transient calibration active flag
  replaySetupOpen: false,  // Transient live-screen replay buffer settings popover
  liveMaskDrawActive: false, // Transient mask drawing mode on calibration viewport
  liveMasksVisible: true, // Show ignore masks on calibration viewport
  heatmapSensitivity: 60, // 10 (low) to 95 (high)
  heatmapDuration: 30.0,  // Adjustable: 0.5s to 9999s / Infinity
  heatmapMaxAreaPct: 5,   // Max simultaneous changed area (% of screen, default 5% = 1/20th)
  heatmapShakeGatePct: 18,// Global camera shake rejection threshold (% of unmasked frame)
  heatmapMinCells: 2,     // Minimum changed spike cells (160x90 grid) to register a hit
  heatmapSpeechEnabled: false, // Voice callouts ("Detection! 11 o'clock, 3 clicks")
  heatmapAutoSave: false, // Auto-snapshot rolling RAM buffer on localized hit (rate-limited)
  heatmapIgnoreMasks: [], // Normalized exclude zones: Array<{ x, y, w, h }> in [0..1]
  detectionHits: [],      // Session spatial detection log: Array<{ id, timestampMs, normX, normY, clockHour, clicks, dirLabel, thumbDataUrl }>
  selectedHitId: null,    // Currently highlighted detection hit ID in Unified Review
  reviewPinMode: 'sync',  // 'sync' (reveal with video playhead) | 'all' (show full group) | 'off'
  reviewDrawerTab: 'hits',// 'hits' | 'clips' inside Screen 2 unified Review drawer
  voicePitch: 1.25,       // Female voice pitch (1.0..1.6)
  voiceRate: 0.80,        // Voice speech rate (0.6..1.0)
  voiceAlertKeyword: 'Detection', // Customizable alert keyword (e.g. Contact, Target, Alert)
  voiceUnitKeyword: 'clicks',     // Customizable distance unit (e.g. clicks, mils, marks, units)
  detectionCalloutMode: 'poi',    // 'poi' (where hit landed) | 'poa' (dial adjustment to center)

  // Configurable In-Memory Rolling Recording Buffer
  bufferEnabled: true,
  bufferMaxSeconds: 20, // Adjustable: 5s to 60s
  bufferTargetFps: 15,  // Adjustable: 5 FPS to 30 FPS
  bufferFastQuality: true, // true: 720p / 0.75q fast encode for non-RTSP streams; false: native res / 0.84q
  bufferMicEnabled: false, // Opt-in microphone peak sampling (avoids launch-time mic prompt)
  bufferedSeconds: 0,
  bufferBytes: 0,

  // Interface Theme Color, Global UI Opacity, Declutter Mode, Timestamps, Gamepad & Remote / Ring Controls
  themeColor: '#f97316',
  uiOpacity: 100,
  uiDecluttered: false,
  showDisplayTimestamp: true,
  timestampPosition: 'bottom-right', // 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right'
  timestampOpacity: 60,
  timestampAdaptive: true,
  showHitTimestamps: false,
  touchpadSensitivity: 50, // 15% to 150%, default 50% (50% less for precision)
  reticleAimSpeed: 50,     // 15% to 150%, default 50% (50% max speed for pinpoint reticle positioning)
  ringPanSpeed: 70,        // 10% to 150%, default 70% (fine step size for Bluetooth ring/remote panning)
  dpadMode: 'pan',         // 'pan' (Pan/Zoom view) | 'aim' (Steer Aim Loupe / ROI)
  leftStickDeadzone: 16,   // 5% to 30% deadzone
  rightStickDeadzone: 16,  // 5% to 30% deadzone
  leftStickInvertY: false, // Invert left stick vertical axis
  rightStickInvertY: false,// Invert right stick vertical axis
  activeControllerProfile: 'default', // 'default' | 'simplified' | 'flight' | custom profile ID
  customControllerProfiles: {},       // User custom profiles: Record<id, ProfileObject>
  controllerBindings: null,           // User-configured active controller & key mappings
  microSlotActions: {},               // Persisted 8BitDo Micro slot -> action overrides
  ringEnabled: false,                 // Explicit Bluetooth Ring / Remote isolation toggle (prevents hijacking keyboard & 8BitDo Micro)
  ringKeyMap: {},                     // User-configured active Bluetooth Ring / Remote mappings
  gamepadConnected: false,
  gamepadName: '',
  lastGamepadAction: ''
};

export function updateState(patch) {
  Object.assign(appState, patch);
  for (const fn of listeners) {
    try {
      fn(appState, patch);
    } catch (err) {
      console.warn('[updateState listener error]', err);
    }
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
