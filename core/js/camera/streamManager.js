/**
 * USB Camera Enumeration, Stream Acquisition & Simulated Inspection Signal Fallback
 */
import { appState, updateState } from '../state.js';

let activeMediaStream = null;
let simCanvas = null;
let staticBgCanvas = null;
let simTimer = null;
let rtspImg = null;
let rtspCanvas = null;
let rtspAnimTimer = null;
let rtspDrawLoopActive = false;
let rtspAbortController = null;

export function getGatewayBaseUrl() {
  const host = (appState.rtspGatewayHost || '').trim();
  if (!host) return '';
  return host.replace(/\/+$/, '');
}

/**
 * Wake the camera hardware media pipeline (e.g. Bresser Eyepiece HD /app/getmediainfo)
 */
export async function wakeCameraPipeline(ip = '192.168.0.1', path = '/app/getmediainfo') {
  const gatewayBase = getGatewayBaseUrl();
  const wakeUrl = `${gatewayBase}/api/rtsp/wake?ip=${encodeURIComponent(ip)}&path=${encodeURIComponent(path)}`;

  // 1. First attempt trigger via RTSP Gateway server
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    const res = await fetch(wakeUrl, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (err) {
    console.warn('[streamManager] RTSP Gateway wake attempt failed or timed out:', err);
  }

  // 2. Direct Camera HTTP Trigger fallback (useful when device is directly on Bresser Wi-Fi)
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const directUrl = `http://${ip}${path.startsWith('/') ? path : '/' + path}`;
    const directRes = await fetch(directUrl, { signal: controller.signal }).catch(() => null);
    clearTimeout(timer);
    if (directRes && directRes.ok) {
      const data = await directRes.json().catch(() => null);
      return {
        success: true,
        ip,
        message: 'Camera pipeline awakened directly',
        declaredRtsp: data?.info?.rtsp,
        channels: [
          { id: 'ch0', name: 'Main Stream (1080p Full HD)', url: `rtsp://${ip}/live/tcp/ch0` },
          { id: 'ch1', name: 'Sub Stream (540p High Speed)', url: `rtsp://${ip}/live/tcp/ch1` }
        ]
      };
    }
  } catch (directErr) {
    console.warn('[streamManager] Direct camera wake attempt failed:', directErr);
  }

  return {
    success: false,
    error: `Could not reach Gateway or Camera at ${ip}. Ensure device is connected to camera Wi-Fi and server.py is running if using RTSP bridge.`
  };
}

/**
 * Check if the Python RTSP streaming gateway is active on the host
 */
export async function checkRtspGatewayStatus() {
  const gatewayBase = getGatewayBaseUrl();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const res = await fetch(`${gatewayBase}/api/rtsp/status`, { cache: 'no-store', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { available: false };
    return await res.json();
  } catch {
    return { available: false };
  }
}

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

export async function startCameraStream(videoEl, preferredDeviceId = 'auto', customLabel = null) {
  stopCurrentStream();

  // Route network / RTSP streams to the dedicated RTSP canvas bridge
  if (typeof preferredDeviceId === 'string' && (preferredDeviceId.startsWith('rtsp:') || preferredDeviceId.startsWith('rtsp://'))) {
    let cleanUrl = preferredDeviceId;
    while (cleanUrl.startsWith('rtsp:')) {
      cleanUrl = cleanUrl.slice(5);
    }
    if (cleanUrl.startsWith('//')) {
      cleanUrl = 'rtsp:' + cleanUrl;
    } else if (!cleanUrl.startsWith('rtsp://')) {
      cleanUrl = 'rtsp://' + cleanUrl;
    }
    return startRtspStream(videoEl, cleanUrl, customLabel || 'RTSP STREAM');
  }

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

    const getUserMediaPromise = navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
      audio: false
    });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Camera acquisition timeout')), 10000)
    );

    const stream = await Promise.race([getUserMediaPromise, timeoutPromise]);

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
  ctx.fillText('SPOTR-SOC-X1', 960, 495);
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
    isSimulatedStream: true,
    isRtspStream: false
  });

  return stream;
}

/**
 * Connect to an RTSP network stream via the SPOTR local Python streaming gateway
 */
let rtspStatusPollTimer = null;

export async function startRtspStream(videoEl, rtspUrl, label = 'RTSP STREAM') {
  stopCurrentStream();

  // Initial resolution heuristic based on channel endpoint (ch1 = 960x540, ch0 = 1920x1080)
  const isSub = rtspUrl.includes('ch1');
  const initW = isSub ? 960 : 1920;
  const initH = isSub ? 540 : 1080;

  rtspCanvas = document.createElement('canvas');
  rtspCanvas.width = initW;
  rtspCanvas.height = initH;
  const ctx = rtspCanvas.getContext('2d');

  // Fill initial dark backdrop with tactical status
  ctx.fillStyle = '#051317';
  ctx.fillRect(0, 0, initW, initH);
  ctx.fillStyle = '#2dd4bf';
  ctx.font = 'bold 24px monospace';
  ctx.textAlign = 'center';
  ctx.fillText('CONNECTING TO RTSP STREAM...', initW / 2, initH / 2);

  let lastTrackedW = initW;
  let lastTrackedH = initH;

  const syncFrameDimensions = (nw, nh) => {
    if (nw <= 0 || nh <= 0) return;
    if (rtspCanvas.width !== nw || rtspCanvas.height !== nh) {
      rtspCanvas.width = nw;
      rtspCanvas.height = nh;
    }
    if (lastTrackedW !== nw || lastTrackedH !== nh) {
      lastTrackedW = nw;
      lastTrackedH = nh;
      updateState({ streamWidth: nw, streamHeight: nh });
    }
  };

  const renderRtspDisconnect = async (errMsg = null) => {
    if (!rtspDrawLoopActive) return;
    let detailMsg = errMsg || 'Check camera Wi-Fi connection and gateway server';
    try {
      const st = await checkRtspGatewayStatus();
      if (!st || !st.available) {
        detailMsg = 'RTSP gateway offline';
      } else if (st.error) {
        detailMsg = String(st.error);
      } else if (!errMsg && st.stage) {
        detailMsg = `Stream ended at stage: ${st.stage} (rtp=${st.rtpPackets ?? 0}, frames=${st.framesDecoded ?? 0})`;
      }
    } catch {}
    if (!rtspDrawLoopActive) return;
    ctx.fillStyle = '#051317';
    ctx.fillRect(0, 0, rtspCanvas.width, rtspCanvas.height);
    ctx.fillStyle = '#fda4af';
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('RTSP STREAM DISCONNECTED / TIMEOUT', rtspCanvas.width / 2, rtspCanvas.height / 2 - 20);
    ctx.font = '15px monospace';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText(detailMsg.slice(0, 110), rtspCanvas.width / 2, rtspCanvas.height / 2 + 20);
  };

  rtspDrawLoopActive = true;

  // Periodically query gateway /api/rtsp/status to sync exact stream telemetry (dimensions & FPS)
  rtspStatusPollTimer = setInterval(async () => {
    if (!rtspDrawLoopActive) return;
    try {
      const st = await checkRtspGatewayStatus();
      if (st && st.isStreaming) {
        const patch = {};
        if (st.width && st.height && (st.width !== appState.streamWidth || st.height !== appState.streamHeight)) {
          syncFrameDimensions(st.width, st.height);
        }
        if (typeof st.fps === 'number' && st.fps > 0) {
          patch.fps = Math.round(st.fps);
          updateState(patch);
        }
      }
    } catch {}
  }, 1000);

  // Connect to the gateway multipart stream endpoint via streaming fetch + createImageBitmap
  // (avoids Chromium/WebView img.onload firing only once on off-DOM multipart/x-mixed-replace)
  const gatewayBase = getGatewayBaseUrl();
  const streamApiUrl = `${gatewayBase}/api/rtsp/stream?url=${encodeURIComponent(rtspUrl)}&transport=tcp&_t=${Date.now()}`;

  const abortCtrl = new AbortController();
  rtspAbortController = abortCtrl;

  let pendingJpeg = null;
  let decodingFrame = false;

  const scheduleDecode = () => {
    if (decodingFrame || !pendingJpeg || !rtspDrawLoopActive || abortCtrl.signal.aborted) return;
    const bytes = pendingJpeg;
    pendingJpeg = null;
    decodingFrame = true;
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    createImageBitmap(blob)
      .then((bmp) => {
        try {
          if (rtspDrawLoopActive && !abortCtrl.signal.aborted) {
            syncFrameDimensions(bmp.width, bmp.height);
            ctx.drawImage(bmp, 0, 0, rtspCanvas.width, rtspCanvas.height);
          }
        } finally {
          bmp.close();
        }
      })
      .catch(() => {})
      .finally(() => {
        decodingFrame = false;
        if (pendingJpeg && rtspDrawLoopActive && !abortCtrl.signal.aborted) scheduleDecode();
      });
  };

  const startImgFallback = () => {
    rtspImg = new Image();
    rtspImg.crossOrigin = 'anonymous';
    rtspImg.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.001;pointer-events:none;';
    document.body.appendChild(rtspImg);

    const drawLoop = () => {
      if (!rtspDrawLoopActive || !rtspImg) return;
      if (rtspImg.complete && rtspImg.naturalWidth > 0) {
        syncFrameDimensions(rtspImg.naturalWidth, rtspImg.naturalHeight);
        ctx.drawImage(rtspImg, 0, 0, rtspCanvas.width, rtspCanvas.height);
      }
      rtspAnimTimer = requestAnimationFrame(drawLoop);
    };
    rtspImg.onload = () => {
      if (!rtspAnimTimer && rtspDrawLoopActive) {
        rtspAnimTimer = requestAnimationFrame(drawLoop);
      }
    };
    rtspImg.onerror = () => renderRtspDisconnect();
    rtspImg.src = streamApiUrl;
  };

  (async () => {
    try {
      const res = await fetch(streamApiUrl, { signal: abortCtrl.signal, cache: 'no-store' });
      if (!res.ok) {
        let serverErr = `HTTP ${res.status}`;
        try {
          const j = await res.json();
          if (j?.error) serverErr = j.error;
        } catch {}
        await renderRtspDisconnect(serverErr);
        return;
      }
      if (!res.body || !res.body.getReader) {
        startImgFallback();
        return;
      }

      const reader = res.body.getReader();
      let buf = new Uint8Array(0);
      let expectedLen = -1;
      const asciiDecoder = new TextDecoder('ascii');

      const appendBytes = (a, b) => {
        if (!a.length) return b;
        const out = new Uint8Array(a.length + b.length);
        out.set(a, 0);
        out.set(b, a.length);
        return out;
      };

      const findDoubleCrlf = (arr) => {
        for (let i = 0; i <= arr.length - 4; i++) {
          if (arr[i] === 13 && arr[i + 1] === 10 && arr[i + 2] === 13 && arr[i + 3] === 10) {
            return i;
          }
        }
        return -1;
      };

      while (rtspDrawLoopActive && !abortCtrl.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) {
          buf = appendBytes(buf, value);
        }

        while (true) {
          if (expectedLen < 0) {
            const hdrEnd = findDoubleCrlf(buf);
            if (hdrEnd < 0) break;
            const hdrText = asciiDecoder.decode(buf.subarray(0, hdrEnd));
            const match = /content-length:\s*(\d+)/i.exec(hdrText);
            buf = buf.subarray(hdrEnd + 4);
            if (!match) continue;
            expectedLen = parseInt(match[1], 10);
          }
          if (expectedLen >= 0) {
            if (buf.length < expectedLen) break;
            const jpegBytes = buf.slice(0, expectedLen);
            buf = buf.subarray(expectedLen);
            expectedLen = -1;
            if (jpegBytes.length > 0) {
              pendingJpeg = jpegBytes;
              scheduleDecode();
            }
          }
        }
      }

      if (rtspDrawLoopActive && !abortCtrl.signal.aborted) {
        await renderRtspDisconnect();
      }
    } catch (err) {
      if (err?.name === 'AbortError' || abortCtrl.signal.aborted) return;
      console.warn('[streamManager] RTSP stream fetch error:', err);
      await renderRtspDisconnect(err?.message || null);
    }
  })();

  const stream = rtspCanvas.captureStream(30);
  activeMediaStream = stream;
  videoEl.srcObject = stream;
  videoEl.play().catch(() => {});

  updateState({
    activeDeviceId: 'rtsp:' + rtspUrl,
    activeDeviceLabel: label.slice(0, 24).toUpperCase(),
    streamWidth: initW,
    streamHeight: initH,
    isSimulatedStream: false,
    isRtspStream: true
  });

  return stream;
}

export function stopCurrentStream() {
  if (simTimer) {
    clearInterval(simTimer);
    simTimer = null;
  }
  if (rtspStatusPollTimer) {
    clearInterval(rtspStatusPollTimer);
    rtspStatusPollTimer = null;
  }
  if (rtspAnimTimer) {
    cancelAnimationFrame(rtspAnimTimer);
    rtspAnimTimer = null;
  }
  rtspDrawLoopActive = false;
  if (rtspAbortController) {
    rtspAbortController.abort();
    rtspAbortController = null;
  }
  if (rtspImg) {
    rtspImg.onload = null;
    rtspImg.onerror = null;
    rtspImg.src = '';
    rtspImg.remove();
    rtspImg = null;
  }
  if (activeMediaStream) {
    activeMediaStream.getTracks().forEach((t) => t.stop());
    activeMediaStream = null;
  }
  // Only notify local Python server to release RTSP socket if an RTSP stream was active
  if (appState.isRtspStream) {
    updateState({ isRtspStream: false });
    const gatewayBase = getGatewayBaseUrl();
    fetch(`${gatewayBase}/api/rtsp/stop`, { method: 'POST' }).catch(() => {});
  }
}

export function getRtspCanvas() {
  return rtspCanvas;
}
