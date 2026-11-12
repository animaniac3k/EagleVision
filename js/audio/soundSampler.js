/**
 * Real-Time Sound Peak Sampler for EagleVision / SPOTR
 *
 * Samples ambient / range audio via the Web Audio API AnalyserNode.
 * Returns normalized 0.0 to 1.0 amplitude values for gunshot and loud sound visualization.
 * If microphone access is unavailable or denied, gracefully defaults to silent (0.0) peaks.
 */
let audioCtx = null;
let analyserNode = null;
let micStream = null;
let isListening = false;
let dataArray = null;

export async function initSoundSampler() {
  if (isListening) return true;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(micStream);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 256;
    analyserNode.smoothingTimeConstant = 0.25;
    source.connect(analyserNode);
    dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    isListening = true;
    return true;
  } catch (err) {
    // Microphone not granted, denied or unavailable - gracefully silent
    isListening = false;
    return false;
  }
}

export function getSoundPeak() {
  if (!isListening || !analyserNode || !dataArray) return 0.0;
  try {
    analyserNode.getByteTimeDomainData(dataArray);
    let sumSquares = 0;
    const len = dataArray.length;
    for (let i = 0; i < len; i++) {
      const norm = (dataArray[i] - 128) / 128;
      sumSquares += norm * norm;
    }
    const rms = Math.sqrt(sumSquares / len);
    // Amplify RMS for clear tactical spikes on gunshot / loud impact
    return Math.min(1.0, Number((rms * 3.6).toFixed(2)));
  } catch {
    return 0.0;
  }
}

export function isSoundSamplerActive() {
  return isListening;
}

export function stopSoundSampler() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    try { audioCtx.close(); } catch {}
    audioCtx = null;
  }
  analyserNode = null;
  dataArray = null;
  isListening = false;
}
