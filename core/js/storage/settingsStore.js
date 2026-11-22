/**
 * Persists user overlay, recording buffer, heatmap & theme preferences in localStorage
 */
const STORAGE_KEY = 'spotr_settings_v2';
let pendingSaveTimer = null;
let pendingSaveState = null;

function clampNum(val, min, max, fallback, round = false) {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  return round ? Math.round(clamped) : clamped;
}

export function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return null;

    parsed.pipEnabled = parsed.pipEnabled !== false;
    parsed.pipZoom = clampNum(parsed.pipZoom, 1.5, 12.0, 3.0);
    parsed.overlayEnabled = parsed.overlayEnabled !== false;
    parsed.overlayOpacity = clampNum(parsed.overlayOpacity, 0, 100, 75, true);
    parsed.overlayScale = clampNum(parsed.overlayScale, 25, 300, 100, true);
    parsed.autoAimLoupe = Boolean(parsed.autoAimLoupe);
    if (parsed.overlayType === 'custom' && !parsed.customOverlayUrl) {
      parsed.overlayType = 'crosshair';
    }
    parsed.brightness = clampNum(parsed.brightness, 25, 200, 100, true);
    parsed.contrast = clampNum(parsed.contrast, 25, 200, 100, true);
    parsed.saturation = clampNum(parsed.saturation, 0, 200, 100, true);
    parsed.uiOpacity = clampNum(parsed.uiOpacity, 20, 100, 100, true);
    parsed.detectionCalloutMode = parsed.detectionCalloutMode === 'poa' ? 'poa' : 'poi';
    parsed.bufferEnabled = parsed.bufferEnabled !== false;
    parsed.bufferMaxSeconds = clampNum(parsed.bufferMaxSeconds, 5, 60, 20, true);
    parsed.bufferTargetFps = clampNum(parsed.bufferTargetFps, 5, 30, 15, true);
    parsed.bufferFastQuality = parsed.bufferFastQuality !== false;
    parsed.bufferMicEnabled = Boolean(parsed.bufferMicEnabled);
    parsed.heatmapSensitivity = clampNum(parsed.heatmapSensitivity, 10, 95, 60, true);
    parsed.heatmapDuration = clampNum(parsed.heatmapDuration, 0.5, 9999, 30.0);
    parsed.heatmapMinCells = clampNum(parsed.heatmapMinCells, 1, 20, 2, true);
    const minAreaPct = ((parsed.heatmapMinCells + 1) / 14400) * 100;
    parsed.heatmapMaxAreaPct = clampNum(parsed.heatmapMaxAreaPct, minAreaPct, 20, 5);
    parsed.heatmapShakeGatePct = clampNum(parsed.heatmapShakeGatePct, 5, 50, 18, true);
    parsed.voicePitch = clampNum(parsed.voicePitch, 0.75, 1.6, 1.25);
    parsed.voiceRate = clampNum(parsed.voiceRate, 0.6, 1.3, 0.80);
    parsed.touchpadSensitivity = clampNum(parsed.touchpadSensitivity, 15, 150, 50, true);
    parsed.reticleAimSpeed = clampNum(parsed.reticleAimSpeed, 15, 150, 50, true);
    parsed.ringPanSpeed = clampNum(parsed.ringPanSpeed, 10, 150, 70, true);
    parsed.leftStickDeadzone = clampNum(parsed.leftStickDeadzone, 5, 30, 16, true);
    parsed.rightStickDeadzone = clampNum(parsed.rightStickDeadzone, 5, 30, 16, true);
    parsed.rtspOnvifPort = clampNum(parsed.rtspOnvifPort, 1, 65535, 554, true);
    parsed.ringEnabled = Boolean(parsed.ringEnabled);
    parsed.showDisplayTimestamp = parsed.showDisplayTimestamp !== false;
    parsed.timestampPosition = [
      'top-left', 'top-center', 'top-right',
      'bottom-left', 'bottom-center', 'bottom-right'
    ].includes(parsed.timestampPosition)
      ? parsed.timestampPosition
      : 'bottom-right';
    parsed.timestampOpacity = clampNum(parsed.timestampOpacity, 15, 100, 60, true);
    parsed.timestampAdaptive = parsed.timestampAdaptive !== false;
    parsed.showHitTimestamps = Boolean(parsed.showHitTimestamps);
    if (parsed.reticleConfig) {
      parsed.reticleConfig = Object.assign(
        {
          clickCount: 10,
          clickSpacing: 32,
          centerGap: 64,
          centerStyle: 'empty',
          majorInterval: 5,
          minorTickLen: 10,
          majorTickLen: 18,
          showLabels: true,
          labelSize: 10,
          concentricRings: false,
          ringInterval: 5,
          svdRangefinder: false,
          strokeWidth: 1.8,
          reticleColor: ''
        },
        parsed.reticleConfig
      );
    }
    return parsed;
  } catch {
    return null;
  }
}

export function saveSettingsNow(state) {
  if (pendingSaveTimer) {
    clearTimeout(pendingSaveTimer);
    pendingSaveTimer = null;
  }
  pendingSaveState = null;
  try {
    const customUrl = typeof state.customOverlayUrl === 'string' &&
      state.customOverlayUrl.startsWith('data:') &&
      state.customOverlayUrl.length <= 1_500_000
      ? state.customOverlayUrl
      : null;

    const subset = {
      pipEnabled: state.pipEnabled,
      pipZoom: state.pipZoom,
      autoAimLoupe: Boolean(state.autoAimLoupe),
      overlayEnabled: state.overlayEnabled !== false,
      overlayType: state.overlayType || 'crosshair',
      customOverlayUrl: customUrl,
      overlayOpacity: state.overlayOpacity,
      overlayScale: state.overlayScale,
      reticleFfpMode: state.reticleFfpMode !== false,
      reticleBackdrop: state.reticleBackdrop || 'night',
      reticleConfig: state.reticleConfig || {},
      brightness: state.brightness ?? 100,
      contrast: state.contrast ?? 100,
      saturation: state.saturation ?? 100,
      invert: Boolean(state.invert),
      grayscale: Boolean(state.grayscale),
      heatmapEnabled: Boolean(state.heatmapEnabled),
      heatmapSensitivity: state.heatmapSensitivity,
      heatmapDuration: state.heatmapDuration || 30.0,
      heatmapMaxAreaPct: state.heatmapMaxAreaPct ?? 5,
      heatmapShakeGatePct: state.heatmapShakeGatePct ?? 18,
      heatmapMinCells: state.heatmapMinCells ?? 2,
      heatmapSpeechEnabled: Boolean(state.heatmapSpeechEnabled),
      heatmapAutoSave: Boolean(state.heatmapAutoSave),
      heatmapIgnoreMasks: Array.isArray(state.heatmapIgnoreMasks) ? state.heatmapIgnoreMasks : [],
      voicePitch: state.voicePitch || 1.25,
      voiceRate: state.voiceRate || 0.80,
      voiceAlertKeyword: state.voiceAlertKeyword || 'Detection',
      voiceUnitKeyword: state.voiceUnitKeyword || 'clicks',
      detectionCalloutMode: state.detectionCalloutMode === 'poa' ? 'poa' : 'poi',
      bufferEnabled: state.bufferEnabled,
      bufferMaxSeconds: state.bufferMaxSeconds,
      bufferTargetFps: state.bufferTargetFps,
      bufferFastQuality: state.bufferFastQuality !== false,
      bufferMicEnabled: Boolean(state.bufferMicEnabled),
      themeColor: state.themeColor || '#f97316',
      uiOpacity: state.uiOpacity ?? 100,
      showDisplayTimestamp: state.showDisplayTimestamp !== false,
      timestampPosition: state.timestampPosition || 'bottom-right',
      timestampOpacity: state.timestampOpacity ?? 60,
      timestampAdaptive: state.timestampAdaptive !== false,
      showHitTimestamps: Boolean(state.showHitTimestamps),
      touchpadSensitivity: state.touchpadSensitivity ?? 50,
      reticleAimSpeed: state.reticleAimSpeed ?? 50,
      ringPanSpeed: state.ringPanSpeed ?? 70,
      dpadMode: state.dpadMode === 'aim' ? 'aim' : 'pan',
      leftStickDeadzone: state.leftStickDeadzone ?? 16,
      rightStickDeadzone: state.rightStickDeadzone ?? 16,
      leftStickInvertY: Boolean(state.leftStickInvertY),
      rightStickInvertY: Boolean(state.rightStickInvertY),
      activeControllerProfile: state.activeControllerProfile || 'default',
      customControllerProfiles: state.customControllerProfiles || {},
      controllerBindings: state.controllerBindings || null,
      microSlotActions: state.microSlotActions || {},
      ringEnabled: Boolean(state.ringEnabled),
      ringKeyMap: state.ringKeyMap || {},
      rtspSourceMode: state.rtspSourceMode || 'usb',
      rtspPreset: state.rtspPreset || 'bresser',
      rtspCameraIp: state.rtspCameraIp || '192.168.0.1',
      rtspChannel: state.rtspChannel || 'ch0',
      rtspGatewayHost: state.rtspGatewayHost || '',
      rtspOnvifIp: state.rtspOnvifIp || '192.168.1.100',
      rtspOnvifPort: state.rtspOnvifPort || 554,
      rtspOnvifPath: state.rtspOnvifPath || '/onvif1',
      rtspOnvifUser: state.rtspOnvifUser || '',
      rtspCustomUrl: state.rtspCustomUrl || ''
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subset));
  } catch (err) {
    console.warn('[SPOTR] Failed to persist settings (storage quota?):', err);
  }
}

/**
 * Debounced settings save (250ms) to avoid 60Hz synchronous JSON.stringify/localStorage churn on slider drags.
 * Flushes immediately on pagehide/beforeunload.
 */
export function saveSettings(state, immediate = false) {
  if (immediate) {
    saveSettingsNow(state);
    return;
  }
  pendingSaveState = state;
  if (pendingSaveTimer) clearTimeout(pendingSaveTimer);
  pendingSaveTimer = setTimeout(() => {
    if (pendingSaveState) saveSettingsNow(pendingSaveState);
  }, 250);
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    if (pendingSaveState) saveSettingsNow(pendingSaveState);
  });
}
