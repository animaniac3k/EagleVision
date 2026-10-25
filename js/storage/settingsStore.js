/**
 * Persists user overlay, recording buffer, heatmap & theme preferences in localStorage
 */
const STORAGE_KEY = 'eaglevision_settings_v2';

export function loadSavedSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
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
      heatmapSensitivity: state.heatmapSensitivity,
      heatmapDuration: state.heatmapDuration || 2.0,
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
