/**
 * Live FPS Counter & Stream Telemetry Tracker
 */
import { appState, updateState } from '../state.js';

let frameCount = 0;
let lastMark = performance.now();

export function recordRenderedFrame(videoEl) {
  if (appState.isRtspStream) {
    frameCount = 0;
    lastMark = performance.now();
    return;
  }
  const now = performance.now();
  const elapsed = now - lastMark;
  // Reset counter cleanly after returning from hidden/non-live screens so FPS never spikes to 0
  if (elapsed > 2500) {
    frameCount = 1;
    lastMark = now;
    return;
  }

  frameCount += 1;
  if (elapsed >= 500) {
    const fps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastMark = now;

    const patch = {};
    if (fps !== appState.fps) {
      patch.fps = fps;
    }
    if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
      if (videoEl.videoWidth !== appState.streamWidth) patch.streamWidth = videoEl.videoWidth;
      if (videoEl.videoHeight !== appState.streamHeight) patch.streamHeight = videoEl.videoHeight;
    }
    if (Object.keys(patch).length > 0) {
      updateState(patch);
    }
  }
}
