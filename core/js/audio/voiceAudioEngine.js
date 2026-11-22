/**
 * SPOTR Embedded Voice Audio Engine
 * 
 * 100% Host-Independent, Offline Studio Female Voice Synthesizer
 * Uses Web Audio API + Pre-rendered 24kHz Jenny (en-US) Studio Voice Sprites.
 * 
 * Guarantees bit-for-bit identical, high-definition female voice playback
 * across Windows 10/11, Chromebook (IdeaPad Duet 3), Linux, and mobile devices.
 */
import { VOICE_SPRITE_SRC, VOICE_MANIFEST } from './voiceManifest.js';
import { appState } from '../state.js';

let audioCtx = null;
let masterGain = null;
let spriteAudioBuffer = null;
let loadPromise = null;
let isLoaded = false;
let activeSources = [];
let speakGeneration = 0;

/**
 * Acquire or initialize the Web Audio Context with auto-resume
 */
export function getVoiceAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    audioCtx = new AudioContextClass();
    masterGain = audioCtx.createGain();
    masterGain.gain.value = 1.0;
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume().catch(() => {});
  }
  return audioCtx;
}

/**
 * Preload and decode the embedded audio sprite buffer into RAM
 */
export async function preloadVoiceAudio() {
  if (isLoaded && spriteAudioBuffer) return spriteAudioBuffer;
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      const ctx = getVoiceAudioContext();
      if (!ctx) return null;
      const resp = await fetch(VOICE_SPRITE_SRC);
      if (!resp.ok) {
        throw new Error(`Failed to load voice sprite: HTTP ${resp.status}`);
      }
      const arrayBuf = await resp.arrayBuffer();
      spriteAudioBuffer = await ctx.decodeAudioData(arrayBuf);
      isLoaded = true;
      return spriteAudioBuffer;
    } catch (err) {
      console.warn('[VoiceAudioEngine] Failed to decode voice sprite:', err);
      return null;
    } finally {
      loadPromise = null;
    }
  })();

  return loadPromise;
}

/**
 * Cancel any ongoing speech immediately
 */
export function stopVoiceAnnouncement() {
  speakGeneration += 1;
  if (activeSources.length > 0) {
    activeSources.forEach((src) => {
      try {
        src.stop();
        src.disconnect();
      } catch (_) {}
    });
    activeSources = [];
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.cancel();
    } catch (_) {}
  }
}

/**
 * Speaks short UI mode announcements (e.g. "Point of Impact", "Point of Aim")
 * via Web Speech API while respecting user pitch/rate settings.
 */
export function speakModeAnnouncement(phrase) {
  if (!phrase || typeof window === 'undefined' || !('speechSynthesis' in window)) return;
  try {
    stopVoiceAnnouncement();
    const u = new SpeechSynthesisUtterance(phrase);
    u.lang = 'en-US';
    u.pitch = Math.max(0.75, Math.min(1.6, Number(appState.voicePitch) || 1.25));
    u.rate = Math.max(0.65, Math.min(1.25, (Number(appState.voiceRate) || 0.80) + 0.15));
    const voices = window.speechSynthesis.getVoices?.() || [];
    const enVoice =
      voices.find((v) => /en[-_]US/i.test(v.lang) && /jenny|aria|samantha|zira|female/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang));
    if (enVoice) u.voice = enVoice;
    window.speechSynthesis.speak(u);
  } catch (_) {}
}

/**
 * Synthesizes a subtle high-tech alert chime for unmapped custom keywords
 */
function scheduleAlertChime(ctx, startTime) {
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(987.77, startTime); // B5
    osc.frequency.exponentialRampToValueAtTime(1318.51, startTime + 0.08); // E6
    gain.gain.setValueAtTime(0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.09);
    osc.connect(gain);
    gain.connect(masterGain || ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + 0.10);
    activeSources.push(osc);
  } catch (_) {}
}

const AXIS_PAUSE_TOKEN = '__axis_pause__';
const AXIS_PAUSE_SEC = 0.18;

const KNOWN_UNITS = [
  'click', 'clicks', 'mil', 'mils', 'mark', 'marks',
  'unit', 'units', 'degree', 'degrees', 'meter', 'meters', 'yard', 'yards'
];

function pushCountTokens(tokens, countNum) {
  if (countNum === null || Number.isNaN(countNum)) return;
  if (countNum >= 1 && countNum <= 100) {
    tokens.push(String(countNum));
  } else if (countNum > 100 && countNum < 200) {
    tokens.push('100');
    const rem = countNum - 100;
    if (rem > 0 && rem <= 100) {
      tokens.push(String(rem));
    }
  } else if (countNum >= 200) {
    tokens.push('100');
  }
}

function appendAxisMatches(tokens, lower, regex, dirFirst) {
  let match;
  let found = false;
  while ((match = regex.exec(lower)) !== null) {
    if (found) {
      tokens.push(AXIS_PAUSE_TOKEN);
    }
    found = true;
    const countNum = parseInt(dirFirst ? match[2] : match[1], 10);
    const maybeUnit = (dirFirst ? match[3] : match[2]) || '';
    const dir = (dirFirst ? match[1] : match[3]).toLowerCase();
    if (dirFirst && VOICE_MANIFEST[dir]) {
      tokens.push(dir);
    }
    pushCountTokens(tokens, countNum);
    if (maybeUnit && KNOWN_UNITS.includes(maybeUnit)) {
      tokens.push(maybeUnit);
    }
    if (!dirFirst && VOICE_MANIFEST[dir]) {
      tokens.push(dir);
    }
  }
  return found;
}

/**
 * Parses detection announcements and callout phrases into sprite tokens.
 * Supports Style A Cartesian callouts ("Detection! 3 clicks right, 2 clicks up"),
 * single-axis callouts ("Detection! 1 click left"), "Detection! Center", and status phrases.
 */
export function parsePhraseToTokens(phrase) {
  if (!phrase || typeof phrase !== 'string') return [];
  const raw = phrase.trim();
  const lower = raw.toLowerCase();
  const tokens = [];

  // Check for status messages
  if (lower.includes('callouts active') || lower.includes('voice callouts active')) {
    const prefixMatch = raw.match(/^([A-Za-z0-9_-]+)[!:,]/);
    if (prefixMatch) {
      const p = prefixMatch[1].toLowerCase();
      if (VOICE_MANIFEST[p]) tokens.push(p);
    }
    tokens.push('callouts_active');
    return tokens;
  }

  if (lower.includes('callouts muted') || lower.includes('voice callouts muted')) {
    tokens.push('callouts_muted');
    return tokens;
  }

  // 1. Extract Alert Prefix (e.g. "Detection!", "Contact:", "Target")
  const prefixMatch = raw.match(/^([A-Za-z0-9_-]+)[!:,]?/);
  if (prefixMatch) {
    const candidate = prefixMatch[1].toLowerCase();
    tokens.push(VOICE_MANIFEST[candidate] ? candidate : '__custom_chime__');
  }

  // 2. Center callout
  if (/\bcenter\b/i.test(lower)) {
    tokens.push('center');
    return tokens;
  }

  // 3. Cartesian Left / Right / Up / Down clauses (Style A: "3 clicks right, 2 clicks up",
  //    or direction-first fallback: "Left, 3 clicks. Down, 3 clicks")
  if (
    appendAxisMatches(tokens, lower, /(\d+)\s+(?:([a-z]+)\s+)?(left|right|up|down)\b/gi, false) ||
    appendAxisMatches(tokens, lower, /\b(left|right|up|down)\s*,?\s*(\d+)(?:\s+([a-z]+))?\b/gi, true)
  ) {
    return tokens;
  }

  // 4. Legacy clock fallback if an external caller passes o'clock phrasing
  const clockMatch = lower.match(/\b([1-9]|1[0-2])\s*o'?clock\b/);
  if (clockMatch) {
    tokens.push(`${clockMatch[1]}_oclock`);
  }
  const countMatch = lower.match(/,\s*(\d+)/) || lower.match(/\b(\d+)\b/);
  if (countMatch) {
    pushCountTokens(tokens, parseInt(countMatch[1], 10));
  }
  for (const u of KNOWN_UNITS) {
    if (new RegExp(`\\b${u}\\b`, 'i').test(lower)) {
      tokens.push(u);
      break;
    }
  }

  return tokens;
}

/**
 * Primary speech announcement interface.
 * Replaces window.speechSynthesis.speak() with deterministic, host-independent Web Audio playback.
 */
export async function speakDetectionAnnouncement(phrase) {
  if (!phrase) return;

  const myGen = ++speakGeneration;
  const ctx = getVoiceAudioContext();
  if (!ctx) return;

  if (ctx.state === 'suspended') {
    try { await ctx.resume(); } catch (_) {}
  }
  if (myGen !== speakGeneration) return;

  // Ensure audio sprite is in memory
  if (!spriteAudioBuffer) {
    await preloadVoiceAudio();
  }
  if (myGen !== speakGeneration) return;

  if (!spriteAudioBuffer) {
    // Fallback: if sprite failed to fetch, try native speech if available
    if ('speechSynthesis' in window) {
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(phrase.replace(/,\s+/g, '. '));
        u.pitch = Number(appState.voicePitch) || 1.25;
        u.rate = Number(appState.voiceRate) || 0.80;
        window.speechSynthesis.speak(u);
      } catch (_) {}
    }
    return;
  }

  const tokens = parsePhraseToTokens(phrase);
  if (!tokens || tokens.length === 0) return;

  // Interrupt prior active sources without bumping myGen
  if (activeSources.length > 0) {
    activeSources.forEach((src) => {
      try { src.stop(); src.disconnect(); } catch (_) {}
    });
    activeSources = [];
  }
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (_) {}
  }

  const rate = Math.max(0.50, Math.min(1.5, Number(appState.voiceRate) || 0.80));
  const pitchMultiplier = Math.max(0.75, Math.min(1.5, Number(appState.voicePitch) || 1.25));
  // Standard semitone detune: 1200 * log2(pitch). Effective buffer consumption speed is rate * pitchMultiplier.
  const detuneCents = Math.round(1200 * Math.log2(pitchMultiplier));
  const effectiveSpeed = Math.max(0.45, Math.min(2.0, rate * pitchMultiplier));

  let scheduledTime = ctx.currentTime + 0.03; // 30ms scheduling lookahead

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];

    if (token === '__custom_chime__') {
      scheduleAlertChime(ctx, scheduledTime);
      scheduledTime += 0.12 / rate;
      continue;
    }

    if (token === AXIS_PAUSE_TOKEN) {
      scheduledTime += AXIS_PAUSE_SEC / rate;
      continue;
    }

    const slice = VOICE_MANIFEST[token];
    if (!slice) continue;

    const [startSec, durSec] = slice;
    const source = ctx.createBufferSource();
    source.buffer = spriteAudioBuffer;
    source.playbackRate.value = rate;
    if (source.detune) {
      source.detune.value = detuneCents;
    }

    source.connect(masterGain || ctx.destination);
    source.start(scheduledTime, startSec, durSec);
    activeSources.push(source);

    // Account for true playback speed (rate * pitchMultiplier) so words neither collide nor leave wide gaps
    const effectiveDur = durSec / effectiveSpeed;
    const gap = (i === 0 ? 0.08 : 0.045) / rate;
    scheduledTime += effectiveDur + gap;
  }
}

/**
 * Keep AudioContext unlocked across Android/Bluetooth suspension transitions without
 * eagerly decoding the 98.5s sprite (~19-38MB RAM) until voice callouts are enabled.
 */
if (typeof window !== 'undefined') {
  const unlockEvents = ['pointerdown', 'keydown', 'touchstart', 'click'];
  const unlockHandler = () => {
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    } else if (!audioCtx && appState.heatmapSpeechEnabled) {
      getVoiceAudioContext();
      preloadVoiceAudio();
    }
  };
  unlockEvents.forEach((ev) => window.addEventListener(ev, unlockHandler, { passive: true }));
}
