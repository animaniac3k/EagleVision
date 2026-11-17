/**
 * Persists user overlay, recording buffer, heatmap & theme preferences in localStorage
 */
const STORAGE_KEY = 'spotr_settings_v2';

export function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed) return null;
    parsed.playbackReticleEnabled = Boolean(parsed.playbackReticleEnabled);
    parsed.hitsReticleEnabled = parsed.hitsReticleEnabled !== false;
    parsed.autoAimLoupe = Boolean(parsed.autoAimLoupe);
    if (parsed.overlayType === 'custom' && !parsed.customOverlayUrl) {
      parsed.overlayType = 'crosshair';
    }
    parsed.detectionCalloutMode = parsed.detectionCalloutMode === 'poa' ? 'poa' : 'poi';
    parsed.bufferFastQuality = parsed.bufferFastQuality !== false;
    parsed.bufferMicEnabled = Boolean(parsed.bufferMicEnabled);
    parsed.heatmapMinCells = Number.isFinite(Number(parsed.heatmapMinCells))
      ? Math.max(1, Math.min(20, Number(parsed.heatmapMinCells)))
      : 2;
    const minAreaPct = ((parsed.heatmapMinCells + 1) / 14400) * 100;
    parsed.heatmapMaxAreaPct = Number.isFinite(Number(parsed.heatmapMaxAreaPct))
      ? Math.max(minAreaPct, Math.min(20, Number(parsed.heatmapMaxAreaPct)))
      : 5;
    parsed.heatmapShakeGatePct = Number.isFinite(Number(parsed.heatmapShakeGatePct))
      ? Math.max(5, Math.min(50, Math.round(Number(parsed.heatmapShakeGatePct))))
      : 18;
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

export function saveSettings(state) {
  try {
    const subset = {
      pipEnabled: state.pipEnabled,
      pipZoom: state.pipZoom,
      autoAimLoupe: Boolean(state.autoAimLoupe),
      overlayEnabled: state.overlayEnabled,
      playbackReticleEnabled: Boolean(state.playbackReticleEnabled),
      hitsReticleEnabled: state.hitsReticleEnabled !== false,
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
  } catch {
    // Ignore storage quota errors
  }
}
