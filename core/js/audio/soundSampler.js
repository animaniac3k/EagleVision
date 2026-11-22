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
let initInProgress = false;
let samplerGen = 0;
let dataArray = null;

function resumeSamplerAudioContext() {
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
}

if (typeof window !== 'undefined') {
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, resumeSamplerAudioContext, { passive: true });
  });
}

export async function initSoundSampler() {
  if (isListening) {
    resumeSamplerAudioContext();
    return true;
  }
  if (initInProgress) return false;

  const myGen = ++samplerGen;
  initInProgress = true;
  let acquiredStream = null;
  let createdCtx = null;

  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      return false;
    }
    acquiredStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    // If stopSoundSampler() or a newer init ran while permission prompt was open, discard cleanly
    if (myGen !== samplerGen) {
      acquiredStream.getTracks().forEach((t) => t.stop());
      return false;
    }

    createdCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = createdCtx.createMediaStreamSource(acquiredStream);
    const analyser = createdCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.25;
    source.connect(analyser);

    micStream = acquiredStream;
    audioCtx = createdCtx;
    analyserNode = analyser;
    dataArray = new Uint8Array(analyserNode.frequencyBinCount);
    isListening = true;
    resumeSamplerAudioContext();
    return true;
  } catch (err) {
    if (acquiredStream) {
      acquiredStream.getTracks().forEach((t) => t.stop());
    }
    if (createdCtx && createdCtx.state !== 'closed') {
      try { createdCtx.close(); } catch {}
    }
    isListening = false;
    return false;
  } finally {
    if (myGen === samplerGen) {
      initInProgress = false;
    }
  }
}

export function getSoundPeak() {
  if (!isListening || !analyserNode || !dataArray) return 0.0;
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
    return 0.0;
  }
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

export function stopSoundSampler() {
  samplerGen += 1;
  initInProgress = false;
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
