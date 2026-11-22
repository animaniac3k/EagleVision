/**
 * Stream Telemetry HUD Controller
 */
import { subscribeState } from '../state.js';

const HUD_KEYS = [
  'hudOpen', 'fps', 'activeDeviceLabel', 'streamWidth', 'streamHeight',
  'mainZoom', 'pipEnabled', 'pipZoom', 'bufferEnabled', 'bufferedSeconds',
  'bufferMaxSeconds', 'bufferBytes'
];

export function initHudController() {
  const hudOverlay = document.getElementById('hudOverlay');
  const hudFps = document.getElementById('hudFps');
  const hudSource = document.getElementById('hudSource');
  const hudResolution = document.getElementById('hudResolution');
  const hudMainZoom = document.getElementById('hudMainZoom');
  const hudPipZoom = document.getElementById('hudPipZoom');
  const hudBufferText = document.getElementById('hudBufferText');

  function updateHud(state, patch) {
    const isInit = !patch || Object.keys(patch).length === 0;
    if (!isInit) {
      let relevant = false;
      for (let i = 0; i < HUD_KEYS.length; i++) {
        if (HUD_KEYS[i] in patch) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
    }

    if (!hudOverlay) return;
    hudOverlay.classList.toggle('hidden', !state.hudOpen);
    if (!state.hudOpen) return;

    if (hudFps) hudFps.textContent = `${state.fps} FPS`;
    if (hudSource) hudSource.textContent = state.activeDeviceLabel;
    if (hudResolution) hudResolution.textContent = `${state.streamWidth}×${state.streamHeight}`;
    if (hudMainZoom) hudMainZoom.textContent = `${(Number(state.mainZoom) || 1).toFixed(1)}x`;
    if (hudPipZoom) hudPipZoom.textContent = state.pipEnabled ? `${(Number(state.pipZoom) || 3).toFixed(1)}x` : 'OFF';

    if (hudBufferText) {
      if (state.bufferEnabled) {
        const mb = ((state.bufferBytes || 0) / (1024 * 1024)).toFixed(1);
        hudBufferText.textContent = `${(Number(state.bufferedSeconds) || 0).toFixed(1)}s / ${state.bufferMaxSeconds}s (${mb} MB)`;
      } else {
        hudBufferText.textContent = 'DISABLED';
      }
    }
  }

  subscribeState(updateHud);
}
