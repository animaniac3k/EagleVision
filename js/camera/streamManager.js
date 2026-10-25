/**
 * USB Camera Enumeration, Stream Acquisition & Simulated Inspection Signal Fallback
 */
import { updateState } from '../state.js';

let activeMediaStream = null;
let simCanvas = null;
let staticBgCanvas = null;
let simTimer = null;

export async function enumerateCameras() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
    return [{ deviceId: 'sim', label: 'RADAR TEST SIGNAL (1080p)' }];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = devices
      .filter((d) => d.kind === 'videoinput')
      .map((d, idx) => ({
        deviceId: d.deviceId,
        label: d.label || `USB / Video Camera #${idx + 1}`
      }));

    videoInputs.push({
      deviceId: 'sim',
      label: 'BUILT-IN TEST SIGNAL (1080p)'
    });
    return videoInputs;
  } catch {
    return [{ deviceId: 'sim', label: 'BUILT-IN TEST SIGNAL (1080p)' }];
  }
}

export async function startCameraStream(videoEl, preferredDeviceId = 'auto') {
  stopCurrentStream();

  if (preferredDeviceId === 'sim' || !navigator.mediaDevices?.getUserMedia) {
    return startSimulatedStream(videoEl);
  }

  try {
    const videoConstraints = {
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 }
    };

    if (preferredDeviceId && preferredDeviceId !== 'auto') {
      videoConstraints.deviceId = { exact: preferredDeviceId };
    }

    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });

    activeMediaStream = stream;
    videoEl.srcObject = stream;
    await videoEl.play();

    const track = stream.getVideoTracks()[0];
    const settings = track ? track.getSettings() : {};
    const actualDeviceId = settings.deviceId || preferredDeviceId;

    updateState({
      activeDeviceId: actualDeviceId,
      activeDeviceLabel: (track && track.label) ? track.label.slice(0, 24).toUpperCase() : 'USB CAMERA',
      streamWidth: videoEl.videoWidth || settings.width || 1920,
      streamHeight: videoEl.videoHeight || settings.height || 1080,
      isSimulatedStream: false
    });

    return stream;
  } catch (err) {
    console.warn('Camera stream unavailable, activating simulated inspection feed:', err);
    return startSimulatedStream(videoEl);
  }
}

function buildStaticBoardCanvas(w, h) {
  const bg = document.createElement('canvas');
  bg.width = w;
  bg.height = h;
  const ctx = bg.getContext('2d');

  ctx.fillStyle = '#051317';
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(45, 212, 191, 0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x < w; x += 60) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  for (let y = 0; y < h; y += 60) {
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }
  ctx.stroke();

  ctx.fillStyle = '#071d24';
  ctx.strokeStyle = '#2dd4bf';
  ctx.lineWidth = 4;
  ctx.fillRect(240, 130, 1440, 820);
  ctx.strokeRect(240, 130, 1440, 820);

  ctx.strokeStyle = 'rgba(45, 212, 191, 0.45)';
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(340, 250); ctx.lineTo(720, 250); ctx.lineTo(810, 340); ctx.lineTo(1320, 340);
  ctx.moveTo(340, 480); ctx.lineTo(620, 480); ctx.lineTo(710, 580); ctx.lineTo(1540, 580);
  ctx.moveTo(420, 820); ctx.lineTo(880, 820); ctx.lineTo(980, 710); ctx.lineTo(1560, 710);
  ctx.stroke();

  const fiducials = [[340, 250], [340, 480], [420, 820], [1540, 580], [1560, 710]];
  for (const [fx, fy] of fiducials) {
    ctx.fillStyle = '#2dd4bf';
    ctx.beginPath(); ctx.arc(fx, fy, 16, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ccfbf1';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(fx, fy, 26, 0, Math.PI * 2); ctx.stroke();
  }

  ctx.fillStyle = '#041014';
  ctx.strokeStyle = '#5eead4';
  ctx.lineWidth = 3;
  ctx.fillRect(420, 540, 230, 170);
  ctx.strokeRect(420, 540, 230, 170);
  ctx.fillStyle = '#ccfbf1';
  ctx.font = 'bold 28px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('MEM-DDR4', 535, 615);
  ctx.fillStyle = '#5eead4';
  ctx.font = '24px monospace';
  ctx.fillText('64GB-BGA', 535, 655);

  ctx.fillStyle = '#030b0e';
  ctx.strokeStyle = '#99f6e4';
  ctx.lineWidth = 4;
  ctx.fillRect(750, 380, 420, 310);
  ctx.strokeRect(750, 380, 420, 310);

  ctx.fillStyle = '#5eead4';
  for (let i = 0; i < 8; i++) {
    const px = 790 + i * 46;
    ctx.fillRect(px, 350, 16, 30);
    ctx.fillRect(px, 690, 16, 30);
  }

  ctx.fillStyle = '#ccfbf1';
  ctx.font = 'bold 38px monospace';
  ctx.fillText('EAGLE-SOC-X1', 960, 495);
  ctx.fillStyle = '#5eead4';
  ctx.font = '28px monospace';
  ctx.fillText('LENOVO DUET 3 UVC FEED', 960, 545);

  return bg;
}

function startSimulatedStream(videoEl) {
  const w = 1920;
  const h = 1080;
  if (!simCanvas) {
    simCanvas = document.createElement('canvas');
    simCanvas.width = w;
    simCanvas.height = h;
  }
  if (!staticBgCanvas) {
    staticBgCanvas = buildStaticBoardCanvas(w, h);
  }

  const ctx = simCanvas.getContext('2d');
  ctx.textAlign = 'center';
  ctx.font = '25px monospace';
  let tick = 0;

  const drawSimFrame = () => {
    tick += 1;
    ctx.drawImage(staticBgCanvas, 0, 0);

    // Dynamic timecode
    ctx.fillStyle = '#2dd4bf';
    const timecode = (tick / 30).toFixed(2);
    ctx.fillText(`PITCH 0.40MM  |  T+${timecode}s`, 960, 595);

    // Localized micro-activity on the board (ideal for testing the Micro-Change Heatmap)
    const oscX = 1360 + Math.sin(tick * 0.25) * 18;
    const oscY = 340 + Math.cos(tick * 0.25) * 18;
    ctx.fillStyle = '#ccfbf1';
    ctx.beginPath();
    ctx.arc(oscX, oscY, 10, 0, Math.PI * 2);
    ctx.fill();

    // Pulsing thermal hotspot pad on IC pin 3
    const pulse = Math.floor(128 + 127 * Math.sin(tick * 0.3));
    ctx.fillStyle = `rgb(${pulse}, ${pulse}, ${pulse})`;
    ctx.fillRect(882, 350, 16, 30);
  };

  drawSimFrame();
  simTimer = setInterval(drawSimFrame, 1000 / 30);

  const stream = simCanvas.captureStream(30);
  activeMediaStream = stream;
  videoEl.srcObject = stream;
  videoEl.play().catch(() => {});

  updateState({
    activeDeviceId: 'sim',
    activeDeviceLabel: 'TEST SIGNAL 1080P',
    streamWidth: w,
    streamHeight: h,
    isSimulatedStream: true
  });

  return stream;
}

export function stopCurrentStream() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  if (activeMediaStream) {
    activeMediaStream.getTracks().forEach((t) => t.stop());
    activeMediaStream = null;
  }
}
