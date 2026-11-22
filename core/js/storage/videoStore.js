/**
 * IndexedDB Storage & Disk Export for Saved Video Clips
 *
 * Separates lightweight clip metadata (`clipMeta`) from heavy JPEG frame
 * buffers (`clipFrames`) so listing clips is instantaneous regardless of
 * archive size, and encodes a standard .webm video file when exporting.
 */
import { appState } from '../state.js';
import { drawDisplayTimestampOnCanvas, sampleSourceRegionLuma } from '../renderer/timestampOverlay.js';

const DB_NAME = 'SPOTRVideoDB';
const DB_VERSION = 4;
const LEGACY_STORE = 'clips';
const META_STORE = 'clipMeta';
const FRAMES_STORE = 'clipFrames';

let cachedDbInstance = null;
let openDbPromise = null;

function openDB() {
  if (cachedDbInstance) return Promise.resolve(cachedDbInstance);
  if (openDbPromise) return openDbPromise;
  openDbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onblocked = () => {
      console.warn('[SPOTRVideoDB] Database upgrade blocked by another open tab.');
    };
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const tx = event.target.transaction;

      let metaStore;
      if (!db.objectStoreNames.contains(META_STORE)) {
        metaStore = db.createObjectStore(META_STORE, { keyPath: 'id' });
        metaStore.createIndex('createdAt', 'createdAt', { unique: false });
      } else {
        metaStore = tx.objectStore(META_STORE);
      }

      const framesStore = db.objectStoreNames.contains(FRAMES_STORE)
        ? tx.objectStore(FRAMES_STORE)
        : db.createObjectStore(FRAMES_STORE, { keyPath: 'id' });

      // Migrate v3 single-store clips into split metadata/frames stores without data loss
      if (db.objectStoreNames.contains(LEGACY_STORE)) {
        const legacyStore = tx.objectStore(LEGACY_STORE);
        const cursorReq = legacyStore.openCursor();
        cursorReq.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const item = cursor.value;
            const frames = Array.isArray(item.jpegFrames) ? item.jpegFrames : [];
            if (frames.length > 0) {
              metaStore.put({
                id: item.id,
                name: item.name,
                createdAt: item.createdAt,
                fps: item.fps || 15,
                durationSec: item.durationSec,
                sizeBytes: item.sizeBytes,
                width: item.width || 1920,
                height: item.height || 1080,
                frameCount: frames.length,
                timeline: item.timeline || { soundPeaks: [], events: [] }
              });
              framesStore.put({
                id: item.id,
                jpegFrames: frames,
                frameTimestamps: item.frameTimestamps || null
              });
            }
            cursor.continue();
          } else {
            db.deleteObjectStore(LEGACY_STORE);
          }
        };
      }
    };
    req.onsuccess = () => {
      cachedDbInstance = req.result;
      openDbPromise = null;
      cachedDbInstance.onclose = () => { cachedDbInstance = null; };
      cachedDbInstance.onversionchange = () => {
        if (cachedDbInstance) cachedDbInstance.close();
        cachedDbInstance = null;
      };
      resolve(cachedDbInstance);
    };
    req.onerror = () => {
      openDbPromise = null;
      reject(req.error);
    };
  });
  return openDbPromise;
}

export async function saveVideoClip({
  jpegFrames,
  frameTimestamps = null,
  startWallMs = null,
  fps,
  durationSec,
  sizeBytes,
  width,
  height,
  timeline
}) {
  const db = await openDB();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const id = `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const metaRecord = {
    id,
    name: `CLIP_${stamp}.WEBM`,
    createdAt: Date.now(),
    startWallMs: Number.isFinite(startWallMs) ? startWallMs : Date.now() - Math.round((durationSec || 0) * 1000),
    fps: fps || 15,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: sizeBytes || jpegFrames.reduce((acc, b) => acc + b.byteLength, 0),
    width: width || 1920,
    height: height || 1080,
    frameCount: jpegFrames.length,
    timeline: timeline || { soundPeaks: [], events: [] }
  };

  const framesRecord = {
    id,
    jpegFrames,
    frameTimestamps: Array.isArray(frameTimestamps) ? frameTimestamps : null
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, FRAMES_STORE], 'readwrite');
    tx.objectStore(META_STORE).put(metaRecord);
    tx.objectStore(FRAMES_STORE).put(framesRecord);
    tx.oncomplete = () => resolve(metaRecord);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB save transaction aborted (quota exceeded?)'));
  });
}

export async function listVideoClips() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(META_STORE, 'readonly');
    const req = tx.objectStore(META_STORE).getAll();
    req.onsuccess = () => {
      const items = (req.result || []).filter((item) => (item.frameCount || 0) > 0);
      items.sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    req.onerror = () => reject(req.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB list transaction aborted'));
  });
}

export async function getVideoClip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, FRAMES_STORE], 'readonly');
    const metaReq = tx.objectStore(META_STORE).get(id);
    const framesReq = tx.objectStore(FRAMES_STORE).get(id);
    let meta = null;
    let frames = null;

    metaReq.onsuccess = () => { meta = metaReq.result || null; };
    framesReq.onsuccess = () => { frames = framesReq.result || null; };

    tx.oncomplete = () => {
      if (!meta || !frames) {
        resolve(null);
        return;
      }
      resolve({
        ...meta,
        jpegFrames: frames.jpegFrames || [],
        frameTimestamps: frames.frameTimestamps || null
      });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB read transaction aborted'));
  });
}

export async function deleteVideoClip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([META_STORE, FRAMES_STORE], 'readwrite');
    tx.objectStore(META_STORE).delete(id);
    tx.objectStore(FRAMES_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB delete transaction aborted'));
  });
}

/**
 * Exports a stored clip to a standard .webm (or supported container) video file on disk.
 * Requests showSaveFilePicker upfront while transient user activation is still active.
 */
export async function exportClipToDisk(clip) {
  const frames = clip?.jpegFrames || [];
  if (!frames.length) return;
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('MediaRecorder is not supported in this browser.');
  }

  const supportedMimes = [
    'video/webm;codecs=vp8',
    'video/webm;codecs=vp9',
    'video/webm',
    'video/mp4'
  ];
  const chosenMime = supportedMimes.find((m) => MediaRecorder.isTypeSupported(m)) || '';
  const isMp4 = chosenMime.startsWith('video/mp4');
  const rawName = (clip.name || 'clip.webm').toLowerCase();
  const filename = isMp4 ? rawName.replace(/\.webm$/i, '.mp4') : rawName;

  // Acquire file handle BEFORE encoding starts so Chromium's 5s user-activation window never expires
  let fileHandle = null;
  if ('showSaveFilePicker' in window) {
    try {
      fileHandle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [
          isMp4
            ? { description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }
            : { description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }
        ]
      });
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      fileHandle = null;
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = clip.width || 1920;
  canvas.height = clip.height || 1080;
  const ctx = canvas.getContext('2d', { alpha: false }) || canvas.getContext('2d');

  const exportFps = clip.fps || 15;
  const stream = canvas.captureStream(exportFps);
  const recorderOpts = chosenMime
    ? { mimeType: chosenMime, videoBitsPerSecond: 3_500_000 }
    : { videoBitsPerSecond: 3_500_000 };
  const recorder = new MediaRecorder(stream, recorderOpts);
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const blobPromise = new Promise((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: chosenMime || 'video/webm' }));
    recorder.onerror = (ev) => reject(ev?.error || new Error('MediaRecorder encoding failed'));
  });

  recorder.start();

  const timestamps = Array.isArray(clip.frameTimestamps) && clip.frameTimestamps.length === frames.length
    ? clip.frameTimestamps
    : null;
  const baseWallMs = Number.isFinite(clip.startWallMs)
    ? clip.startWallMs
    : (clip.createdAt || Date.now()) - Math.round((clip.durationSec || 0) * 1000);
  const frameIntervalMs = 1000 / exportFps;
  const startMs = performance.now();

  let nextBitmapPromise = createImageBitmap(new Blob([frames[0]], { type: 'image/jpeg' })).catch(() => null);
  let cachedExportLuma = 30;

  try {
    for (let i = 0; i < frames.length; i++) {
      const bmp = await nextBitmapPromise;
      nextBitmapPromise = i + 1 < frames.length
        ? createImageBitmap(new Blob([frames[i + 1]], { type: 'image/jpeg' })).catch(() => null)
        : null;

      if (bmp) {
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        if (appState.showDisplayTimestamp !== false) {
          const offsetMs = timestamps ? timestamps[i] * 1000 : i * frameIntervalMs;
          const pos = appState.timestampPosition || 'bottom-right';
          const adaptive = appState.timestampAdaptive !== false;
          if (adaptive && (i % 6 === 0)) {
            cachedExportLuma = sampleSourceRegionLuma(bmp, pos);
          }
          drawDisplayTimestampOnCanvas(ctx, canvas.width, canvas.height, baseWallMs + offsetMs, {
            position: pos,
            opacity: Math.max(0.15, Math.min(1, Number(appState.timestampOpacity ?? 60) / 100)),
            adaptive,
            bgLuma: adaptive ? cachedExportLuma : 30,
            isLive: false
          });
        }
        if (bmp.close) bmp.close();
      }

      const targetElapsedMs = timestamps
        ? (i + 1 < frames.length
          ? timestamps[i + 1] * 1000
          : Math.max((clip.durationSec || 0) * 1000, timestamps[i] * 1000 + frameIntervalMs))
        : (i + 1) * frameIntervalMs;
      const waitMs = startMs + targetElapsedMs - performance.now();
      if (waitMs > 2) {
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  } finally {
    if (nextBitmapPromise) {
      nextBitmapPromise.then((b) => { try { b?.close?.(); } catch {} }).catch(() => {});
    }
    if (recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
    }
    stream.getTracks().forEach((t) => {
      try { t.stop(); } catch {}
    });
  }
  const webmBlob = await blobPromise;

  let savedViaPicker = false;
  if (fileHandle) {
    try {
      const writable = await fileHandle.createWritable();
      await writable.write(webmBlob);
      await writable.close();
      savedViaPicker = true;
    } catch (err) {
      console.warn('File picker write failed, falling back to download:', err);
    }
  }

  if (!savedViaPicker) {
    const url = URL.createObjectURL(webmBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Export companion sidecar metadata JSON if timeline data exists
  if (clip.timeline && (clip.timeline.soundPeaks?.length || clip.timeline.events?.length)) {
    const metaJson = JSON.stringify(
      {
        name: clip.name,
        createdAt: clip.createdAt,
        fps: clip.fps,
        durationSec: clip.durationSec,
        width: clip.width,
        height: clip.height,
        timeline: clip.timeline
      },
      null,
      2
    );
    const metaBlob = new Blob([metaJson], { type: 'application/json' });
    const metaUrl = URL.createObjectURL(metaBlob);
    const metaLink = document.createElement('a');
    metaLink.href = metaUrl;
    metaLink.download = filename.replace(/\.(webm|mp4)$/i, '') + '.meta.json';
    document.body.appendChild(metaLink);
    metaLink.click();
    metaLink.remove();
    setTimeout(() => URL.revokeObjectURL(metaUrl), 5000);
  }
}
