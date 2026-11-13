/**
 * Persists user overlay, recording buffer, heatmap & theme preferences in localStorage
 */
const STORAGE_KEY = 'spotr_settings_v2';

export function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return null;
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
          concentricRings: false,
          ringInterval: 5,
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

export function saveSettings(state) {
  try {
    const subset = {
      pipEnabled: state.pipEnabled,
      pipZoom: state.pipZoom,
      overlayEnabled: state.overlayEnabled,
      overlayType: state.overlayType || 'crosshair',
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
      heatmapSpeechEnabled: Boolean(state.heatmapSpeechEnabled),
      voicePitch: state.voicePitch || 1.25,
      voiceRate: state.voiceRate || 0.80,
      voiceAlertKeyword: state.voiceAlertKeyword || 'Detection',
      voiceUnitKeyword: state.voiceUnitKeyword || 'clicks',
      bufferEnabled: state.bufferEnabled,
      bufferMaxSeconds: state.bufferMaxSeconds,
      bufferTargetFps: state.bufferTargetFps,
      themeColor: state.themeColor || '#f97316',
      uiOpacity: state.uiOpacity ?? 100,
      touchpadSensitivity: state.touchpadSensitivity ?? 50,
      reticleAimSpeed: state.reticleAimSpeed ?? 50,
      ringPanSpeed: state.ringPanSpeed ?? 70,
      leftStickDeadzone: state.leftStickDeadzone ?? 16,
      rightStickDeadzone: state.rightStickDeadzone ?? 16,
      leftStickInvertY: Boolean(state.leftStickInvertY),
      rightStickInvertY: Boolean(state.rightStickInvertY),
      activeControllerProfile: state.activeControllerProfile || 'default',
      customControllerProfiles: state.customControllerProfiles || {},
      controllerBindings: state.controllerBindings || null,
      ringKeyMap: state.ringKeyMap || {},
      rtspSourceMode: state.rtspSourceMode || 'usb',
      rtspPreset: state.rtspPreset || 'bresser',
      rtspCameraIp: state.rtspCameraIp || '192.168.0.1',
      rtspChannel: state.rtspChannel || 'ch0',
      rtspGatewayHost: state.rtspGatewayHost || '',
      rtspOnvifPort: state.rtspOnvifPort || 554,
      rtspOnvifPath: state.rtspOnvifPath || '/onvif1',
      rtspOnvifUser: state.rtspOnvifUser || '',
      rtspCustomUrl: state.rtspCustomUrl || ''
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subset));
  } catch {
    // Ignore storage quota errors
  }
}
