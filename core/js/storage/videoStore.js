/**
 * IndexedDB Storage & Disk Export for Saved 20-Second Video Clips
 *
 * Stores frame-accurate compressed JPEG buffers in IndexedDB for 100% reliable
 * playback, slow-motion, and frame-stepping in the Stored Video Viewer, and
 * encodes a standard .webm video file when exporting to disk.
 */
const DB_NAME = 'SPOTRVideoDB';
const DB_VERSION = 3;
const STORE_NAME = 'clips';

let cachedDbInstance = null;

function openDB() {
  if (cachedDbInstance) return Promise.resolve(cachedDbInstance);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE_NAME)) {
        db.deleteObjectStore(STORE_NAME);
      }
      const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      store.createIndex('createdAt', 'createdAt', { unique: false });
    };
    req.onsuccess = () => {
      cachedDbInstance = req.result;
      cachedDbInstance.onclose = () => { cachedDbInstance = null; };
      cachedDbInstance.onversionchange = () => {
        if (cachedDbInstance) cachedDbInstance.close();
        cachedDbInstance = null;
      };
      resolve(cachedDbInstance);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveVideoClip({ jpegFrames, fps, durationSec, sizeBytes, width, height, timeline }) {
  const db = await openDB();
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

  const record = {
    id: `clip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name: `CLIP_${stamp}.WEBM`,
    createdAt: Date.now(),
    fps: fps || 15,
    durationSec: Number(durationSec.toFixed(1)),
    sizeBytes: sizeBytes || jpegFrames.reduce((acc, b) => acc + b.byteLength, 0),
    width: width || 1920,
    height: height || 1080,
    jpegFrames,
    timeline: timeline || { soundPeaks: [], events: [] }
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listVideoClips() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const items = [];
    const req = store.openCursor();
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        const item = cursor.value;
        const frameCount = Array.isArray(item.jpegFrames) ? item.jpegFrames.length : 0;
        if (frameCount > 0) {
          items.push({
            id: item.id,
            name: item.name,
            createdAt: item.createdAt,
            fps: item.fps || 15,
            durationSec: item.durationSec,
            sizeBytes: item.sizeBytes,
            width: item.width || 1920,
            height: item.height || 1080,
            frameCount
          });
        }
        cursor.continue();
      } else {
        items.sort((a, b) => b.createdAt - a.createdAt);
        resolve(items);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getVideoClip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteVideoClip(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Exports a stored clip to a standard .webm video file on disk.
 */
export async function exportClipToDisk(clip) {
  const filename = clip.name.toLowerCase();
  const canvas = document.createElement('canvas');
  canvas.width = clip.width || 1920;
  canvas.height = clip.height || 1080;
  const ctx = canvas.getContext('2d');

  const stream = canvas.captureStream(clip.fps || 15);
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp8')
    ? 'video/webm;codecs=vp8'
    : 'video/webm';
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 3_500_000 });
  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const blobPromise = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
  });

  recorder.start();
  const frameIntervalMs = Math.round(1000 / (clip.fps || 15));
  for (const buf of clip.jpegFrames) {
    const bmp = await createImageBitmap(new Blob([buf], { type: 'image/jpeg' }));
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    if (bmp.close) bmp.close();
    await new Promise((r) => setTimeout(r, frameIntervalMs));
  }
  recorder.stop();
  const webmBlob = await blobPromise;

  if ('showSaveFilePicker' in window) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }]
      });
      const writable = await handle.createWritable();
      await writable.write(webmBlob);
      await writable.close();
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }

  const url = URL.createObjectURL(webmBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

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
    metaLink.download = filename.replace(/\.webm$/i, '') + '.meta.json';
    document.body.appendChild(metaLink);
    metaLink.click();
    metaLink.remove();
    setTimeout(() => URL.revokeObjectURL(metaUrl), 5000);
  }
}
