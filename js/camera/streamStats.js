/**
 * Live FPS Counter & Stream Telemetry Tracker
 */
import { updateState } from '../state.js';

let frameCount = 0;
let lastMark = performance.now();

export function recordRenderedFrame(videoEl) {
  frameCount += 1;
  const now = performance.now();
  const elapsed = now - lastMark;

  if (elapsed >= 500) {
    const fps = Math.round((frameCount * 1000) / elapsed);
    frameCount = 0;
    lastMark = now;

    const patch = { fps };
    if (videoEl && videoEl.videoWidth && videoEl.videoHeight) {
      patch.streamWidth = videoEl.videoWidth;
      patch.streamHeight = videoEl.videoHeight;
    }
    updateState(patch);
  }
}
