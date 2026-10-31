/**
 * Persists user overlay, recording buffer, heatmap & theme preferences in localStorage
 */
const STORAGE_KEY = 'eaglevision_settings_v2';

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
          innerBrackets: true,
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
      overlayType: state.overlayType === 'custom' ? 'crosshair' : 'crosshair',
      overlayOpacity: state.overlayOpacity,
      overlayScale: state.overlayScale,
      reticleConfig: state.reticleConfig || {},
      heatmapSensitivity: state.heatmapSensitivity,
      heatmapDuration: state.heatmapDuration || 30.0,
      heatmapSpeechEnabled: Boolean(state.heatmapSpeechEnabled),
      voicePitch: state.voicePitch || 1.25,
      voiceRate: state.voiceRate || 1.1,
      bufferEnabled: state.bufferEnabled,
      bufferMaxSeconds: state.bufferMaxSeconds,
      bufferTargetFps: state.bufferTargetFps,
      themeColor: state.themeColor || '#2dd4bf',
      uiOpacity: state.uiOpacity ?? 100,
      ringKeyMap: state.ringKeyMap || {}
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subset));
  } catch {
    // Ignore storage quota errors
  }
}
