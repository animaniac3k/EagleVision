/**
 * Stream Telemetry HUD Controller
 */
import { appState, subscribeState } from '../state.js';

export function initHudController() {
  const hudOverlay = document.getElementById('hudOverlay');
  const hudFps = document.getElementById('hudFps');
  const hudSource = document.getElementById('hudSource');
  const hudResolution = document.getElementById('hudResolution');
  const hudMainZoom = document.getElementById('hudMainZoom');
  const hudPipZoom = document.getElementById('hudPipZoom');
  const hudBufferText = document.getElementById('hudBufferText');

  function updateHud(state) {
    hudOverlay.classList.toggle('hidden', !state.hudOpen);
    if (!state.hudOpen) return;

    hudFps.textContent = `${state.fps} FPS`;
    hudSource.textContent = state.activeDeviceLabel;
    hudResolution.textContent = `${state.streamWidth}×${state.streamHeight}`;
    hudMainZoom.textContent = `${state.mainZoom.toFixed(1)}x`;
    hudPipZoom.textContent = state.pipEnabled ? `${state.pipZoom.toFixed(1)}x` : 'OFF';

    if (state.bufferEnabled) {
      const mb = (state.bufferBytes / (1024 * 1024)).toFixed(1);
      hudBufferText.textContent = `${state.bufferedSeconds.toFixed(1)}s / ${state.bufferMaxSeconds}s (${mb} MB)`;
    } else {
      hudBufferText.textContent = 'DISABLED';
    }
  }

  updateHud(appState);
  subscribeState(updateHud);
}
