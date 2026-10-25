/**
 * Persists user overlay & filter preferences in localStorage
 */
const STORAGE_KEY = 'eaglevision_settings_v1';

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
      overlayType: state.overlayType === 'custom' ? 'crosshair' : state.overlayType,
      overlayOpacity: state.overlayOpacity,
      overlayScale: state.overlayScale,
      bufferEnabled: state.bufferEnabled,
      themeColor: state.themeColor || '#2dd4bf'
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(subset));
  } catch {
    // Ignore storage quota errors
  }
}
