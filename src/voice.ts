import fs, { mkdirSync } from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';
import { readEnvFile } from './env.js';
import { GoogleGenAI, createPartFromBase64 } from '@google/genai';

const execFileAsync = promisify(execFile);

// Cache ffmpeg availability check (only needs to run once)
let _ffmpegAvailable: boolean | null = null;
async function hasFfmpeg(): Promise<boolean> {
  if (_ffmpegAvailable !== null) return _ffmpegAvailable;
  try {
    await execFileAsync('ffmpeg', ['-version']);
    _ffmpegAvailable = true;
  } catch {
    _ffmpegAvailable = false;
  }
  return _ffmpegAvailable;
}

// ── Upload directory ────────────────────────────────────────────────────────

export const UPLOADS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'workspace',
  'uploads',
);

mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Make an HTTPS request and return the response body as a Buffer.
 */
function httpsRequest(
  url: string,
  options: https.RequestOptions,
  body?: Buffer | string,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Convenience wrapper for HTTPS GET that returns a Buffer.
 */
function httpsGet(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      // Follow a single redirect if present
      if (
        res.statusCode &&
        res.statusCode >= 300 &&
        res.statusCode < 400 &&
        res.headers.location
      ) {
        https.get(res.headers.location, (res2) => {
          const chunks: Buffer[] = [];
          res2.on('data', (chunk: Buffer) => chunks.push(chunk));
          res2.on('end', () => resolve(Buffer.concat(chunks)));
          res2.on('error', reject);
        }).on('error', reject);
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            new Error(
              `HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 500)}`,
            ),
          );
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

// ── STT: Groq Whisper ───────────────────────────────────────────────────────

/**
 * Download a Telegram file to a local temp path and return the path.
 * Uses the Telegram Bot API file download endpoint.
 */
export async function downloadTelegramFile(
  botToken: string,
  fileId: string,
  destDir: string,
): Promise<string> {
  mkdirSync(destDir, { recursive: true });

  // Step 1: Get the file path from Telegram
  const infoUrl = `https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`;
  const infoBuffer = await httpsGet(infoUrl);
  const info = JSON.parse(infoBuffer.toString('utf-8')) as {
    ok: boolean;
    result?: { file_path?: string };
  };

  if (!info.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${infoBuffer.toString('utf-8').slice(0, 300)}`);
  }

  // Step 2: Download the actual file
  const downloadUrl = `https://api.telegram.org/file/bot${botToken}/${info.result.file_path}`;
  const fileBuffer = await httpsGet(downloadUrl);

  // Step 3: Save locally
  // Telegram sends voice as .oga — Groq requires .ogg. Rename transparently.
  const rawExt = path.extname(info.result.file_path) || '.ogg';
  const ext = rawExt === '.oga' ? '.ogg' : rawExt;
  const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`;
  const localPath = path.join(destDir, filename);
  fs.writeFileSync(localPath, fileBuffer);

  return localPath;
}

/**
 * Transcribe an audio file using Groq's Whisper API.
 * Supports .ogg, .mp3, .wav, .m4a.
 */
/**
 * Detect Whisper transcription hallucinations. When audio is mostly silence
 * or noise, the STT model sometimes emits one syllable on infinite repeat
 * for the entire audio length (we observed 131K chars from a 30s clip).
 *
 * Length guard: rejects > 5000 chars (~5min legit transcript fits comfortably).
 * Repetition guard: rejects when fewer than 15% of words are unique.
 */
function looksLikeHallucination(text: string): { hallucinated: boolean; reason?: string } {
  if (!text) return { hallucinated: false };
  if (text.length > 5000) {
    return { hallucinated: true, reason: 'length=' + text.length + ' (>5000)' };
  }
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 10) return { hallucinated: false };
  const unique = new Set(words);
  const ratio = unique.size / words.length;
  if (ratio < 0.15) {
    return {
      hallucinated: true,
      reason: 'uniqueRatio=' + ratio.toFixed(3) + ' (' + unique.size + '/' + words.length + ')',
    };
  }
  return { hallucinated: false };
}

export class TranscriptionHallucinationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionHallucinationError';
  }
}

async function transcribeAudioGroq(filePath: string): Promise<string> {
  const env = readEnvFile(['GROQ_API_KEY']);
  const apiKey = env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY not set in .env');
  }

  const fileBuffer = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  const boundary = `----FormBoundary${crypto.randomBytes(16).toString('hex')}`;

  // Build multipart/form-data body manually
  const parts: Buffer[] = [];

  // File field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: audio/ogg\r\n\r\n`,
    ),
  );
  parts.push(fileBuffer);
  parts.push(Buffer.from('\r\n'));

  // Model field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-large-v3\r\n`,
    ),
  );

  // Response format field
  parts.push(
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="response_format"\r\n\r\n` +
        `json\r\n`,
    ),
  );

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`));

  const body = Buffer.concat(parts);

  const responseBuffer = await httpsRequest(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length.toString(),
      },
    },
    body,
  );

  const response = JSON.parse(responseBuffer.toString('utf-8')) as {
    text?: string;
  };

  return response.text ?? '';
}

// ── STT: whisper-cpp (local fallback) ────────────────────────────────────────

/**
 * Transcribe an audio file using local whisper-cpp binary.
 * Converts to WAV first (whisper-cpp requires WAV input).
 */
async function transcribeAudioLocal(filePath: string): Promise<string> {
  const env = readEnvFile(['WHISPER_CPP_PATH', 'WHISPER_MODEL_PATH']);
  const whisperPath = env.WHISPER_CPP_PATH || 'whisper-cpp';
  const modelPath = env.WHISPER_MODEL_PATH;
  if (!modelPath) throw new Error('WHISPER_MODEL_PATH not set');

  // whisper-cpp needs WAV input — convert from ogg/mp3/etc.
  const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
  await execFileAsync('ffmpeg', ['-i', filePath, '-ar', '16000', '-ac', '1', '-y', wavPath]);

  try {
    const { stdout } = await execFileAsync(whisperPath, [
      '-m', modelPath,
      '-f', wavPath,
      '--output-json',
      '--no-timestamps',
      '-l', 'auto',
    ]);
    const result = JSON.parse(stdout);
    return (result.transcription || []).map((s: { text: string }) => s.text).join(' ').trim();
  } finally {
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

// ── STT: Cascade (Groq → whisper-cpp local) ─────────────────────────────────

/**
 * Transcribe an audio file using the first available provider.
 * Priority: Groq Whisper (cloud) → whisper-cpp (local).
 */
export async function transcribeAudio(filePath: string): Promise<string> {
  const env = readEnvFile(['GROQ_API_KEY', 'WHISPER_MODEL_PATH']);

  // Try Groq first (cloud, fast)
  if (env.GROQ_API_KEY) {
    try {
      const text = await transcribeAudioGroq(filePath);
      if (text) {
        const check = looksLikeHallucination(text);
        if (check.hallucinated) {
          logger.warn(
            { reason: check.reason, sample: text.slice(0, 120) },
            'Groq transcription looks hallucinated, trying local whisper',
          );
        } else {
          return text;
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Groq Whisper failed, trying local whisper-cpp');
    }
  }

  // Fallback: local whisper-cpp — if even this hallucinates, give up
  const text = await transcribeAudioLocal(filePath);
  const check = looksLikeHallucination(text);
  if (check.hallucinated) {
    throw new TranscriptionHallucinationError(
      'Transcription appears to be a hallucination (' + (check.reason || 'unknown') + '). The audio may be silent, too noisy, or corrupted. Please re-record and try again.',
    );
  }
  return text;
}

// ── TTS: ElevenLabs (primary) ────────────────────────────────────────────────

/**
 * Convert text to speech using ElevenLabs and return the audio as a Buffer.
 */
async function synthesizeSpeechElevenLabs(text: string): Promise<Buffer> {
  const env = readEnvFile(['ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID']);
  const apiKey = env.ELEVENLABS_API_KEY;
  const voiceId = env.ELEVENLABS_VOICE_ID;

  if (!apiKey) throw new Error('ELEVENLABS_API_KEY not set');
  if (!voiceId) throw new Error('ELEVENLABS_VOICE_ID not set');

  const payload = JSON.stringify({
    text,
    model_id: 'eleven_turbo_v2_5',
    voice_settings: {
      stability: 0.5,
      similarity_boost: 0.75,
    },
  });

  return await httpsRequest(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    },
    payload,
  );
}

// ── TTS: Gradium AI (alternative) ────────────────────────────────────────────

/**
 * Convert text to speech using Gradium AI and return the audio as a Buffer.
 * Returns OGG Opus directly.
 */
async function synthesizeSpeechGradium(text: string): Promise<Buffer> {
  const env = readEnvFile(['GRADIUM_API_KEY', 'GRADIUM_VOICE_ID']);
  const apiKey = env.GRADIUM_API_KEY;
  const voiceId = env.GRADIUM_VOICE_ID;

  if (!apiKey) throw new Error('GRADIUM_API_KEY not set');
  if (!voiceId) throw new Error('GRADIUM_VOICE_ID not set');

  const payload = JSON.stringify({
    text,
    voice_id: voiceId,
    output_format: 'opus',
    only_audio: true,
  });

  return await httpsRequest(
    'https://eu.api.gradium.ai/api/post/speech/tts',
    {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    },
    payload,
  );
}

// ── TTS: Local OpenAI-compatible (Kokoro) ────────────────────────────────────

/**
 * Convert text to speech using a local OpenAI-compatible TTS server.
 * Kokoro (https://github.com/remsky/Kokoro-FastAPI) is the reference
 * implementation, but any server supporting /v1/audio/speech works.
 * Returns OGG Opus audio.
 */
async function synthesizeSpeechKokoro(text: string): Promise<Buffer> {
  const env = readEnvFile(['KOKORO_URL', 'KOKORO_VOICE', 'KOKORO_MODEL']);
  const baseUrl = env.KOKORO_URL || 'http://localhost:8880';

  const payload = JSON.stringify({
    model: env.KOKORO_MODEL || 'kokoro',
    input: text,
    voice: env.KOKORO_VOICE || 'af_heart',
    response_format: 'opus',
  });

  const url = new URL('/v1/audio/speech', baseUrl);

  return new Promise((resolve, reject) => {
    const protocol = url.protocol === 'https:' ? https : http;
    const req = protocol.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload).toString(),
      },
    }, (res: import('http').IncomingMessage) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Kokoro HTTP ${res.statusCode}: ${buf.toString('utf-8').slice(0, 300)}`));
          return;
        }
        resolve(buf);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── TTS: macOS say + ffmpeg (local fallback) ─────────────────────────────────

/**
 * Convert text to speech using macOS `say` + ffmpeg.
 * Returns an OGG Opus buffer suitable for Telegram voice messages.
 * Only works on macOS with ffmpeg installed.
 */
export async function synthesizeSpeechLocal(text: string): Promise<Buffer> {
  if (process.platform !== 'darwin') {
    throw new Error('Local TTS only available on macOS');
  }
  if (!(await hasFfmpeg())) {
    throw new Error('ffmpeg not installed — required for local TTS');
  }

  const env = readEnvFile(['TTS_VOICE']);
  const voice = env.TTS_VOICE || 'Thomas';
  const id = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const tmpDir = path.join(UPLOADS_DIR, '..', 'tmp');
  mkdirSync(tmpDir, { recursive: true });
  const aiffPath = path.join(tmpDir, `tts_${id}.aiff`);
  const oggPath = path.join(tmpDir, `tts_${id}.ogg`);

  try {
    await execFileAsync('/usr/bin/say', ['-v', voice, '-o', aiffPath, text]);
    await execFileAsync('ffmpeg', [
      '-i', aiffPath,
      '-c:a', 'libopus',
      '-b:a', '48k',
      '-y',
      oggPath,
    ]);
    return fs.readFileSync(oggPath);
  } finally {
    try { fs.unlinkSync(aiffPath); } catch { /* ignore */ }
    try { fs.unlinkSync(oggPath); } catch { /* ignore */ }
  }
}

// ── TTS: Cascade (ElevenLabs → Gradium → Kokoro → macOS say) ────────────────

/**
 * Convert text to speech using the first available provider.
 * Priority: ElevenLabs → Gradium AI → Kokoro (local) → macOS say + ffmpeg.
 */
export async function synthesizeSpeech(text: string): Promise<Buffer> {
  const env = readEnvFile([
    'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
    'GRADIUM_API_KEY', 'GRADIUM_VOICE_ID',
    'KOKORO_URL',
  ]);

  const hasElevenLabs = !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID);
  const hasGradium = !!(env.GRADIUM_API_KEY && env.GRADIUM_VOICE_ID);

  if (hasElevenLabs) {
    try {
      return await synthesizeSpeechElevenLabs(text);
    } catch (err) {
      logger.warn({ err }, 'ElevenLabs TTS failed, trying next provider');
    }
  }

  if (hasGradium) {
    try {
      return await synthesizeSpeechGradium(text);
    } catch (err) {
      logger.warn({ err }, 'Gradium TTS failed, trying next provider');
    }
  }

  // Kokoro - local OpenAI-compatible TTS (no API key needed)
  if (env.KOKORO_URL) {
    try {
      return await synthesizeSpeechKokoro(text);
    } catch (err) {
      logger.warn({ err }, 'Kokoro TTS failed, trying local fallback');
    }
  }

  return await synthesizeSpeechLocal(text);
}

// ── Capabilities check ──────────────────────────────────────────────────────

/**
 * Check whether voice mode is available (all required env vars are set).
 * TTS is available if any provider is configured or macOS say is available.
 */
export function voiceCapabilities(): { stt: boolean; tts: boolean } {
  const env = readEnvFile([
    'GROQ_API_KEY',
    'WHISPER_MODEL_PATH',
    'ELEVENLABS_API_KEY', 'ELEVENLABS_VOICE_ID',
    'GRADIUM_API_KEY', 'GRADIUM_VOICE_ID',
    'KOKORO_URL',
  ]);

  return {
    stt: !!env.GROQ_API_KEY || !!env.WHISPER_MODEL_PATH,
    tts: !!(env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID)
      || !!(env.GRADIUM_API_KEY && env.GRADIUM_VOICE_ID)
      || !!env.KOKORO_URL
      || process.platform === 'darwin',
  };
}

// ── QA: Gemini re-transcription hard gate (Fix #4) ──────────────────────────
//
// Before sending any avatar/voice artifact (Tier 6 video, Tier 7 podcast, or
// any Telegram voice reply), re-transcribe the rendered media via Gemini and
// compare against the *original script text* the bot composed. If similarity
// is low, the send is blocked: the voice/video gen layer hallucinated facts
// (years, numbers, named entities) and the artifact is unsafe to ship.
//
// Flip off via VOICE_QA_HARD_GATE=false in .env (default = true).


const VOICE_QA_MODEL = process.env.VOICE_QA_MODEL || 'gemini-2.0-flash';
// Normalized-Levenshtein similarity threshold. < 0.85 → block.
export const VOICE_QA_THRESHOLD = parseFloat(process.env.VOICE_QA_THRESHOLD || '0.85');

let _qaClient: GoogleGenAI | null = null;
function qaGeminiClient(): GoogleGenAI {
  if (_qaClient) return _qaClient;
  const env = readEnvFile(['GOOGLE_API_KEY']);
  const key = env.GOOGLE_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) throw new Error('GOOGLE_API_KEY not set — required for voice-QA gate');
  _qaClient = new GoogleGenAI({ apiKey: key });
  return _qaClient;
}

function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
  if (ext === '.webm') return 'video/webm';
  if (ext === '.mov') return 'video/quicktime';
  if (ext === '.ogg' || ext === '.oga' || ext === '.opus') return 'audio/ogg';
  if (ext === '.mp3') return 'audio/mpeg';
  if (ext === '.wav') return 'audio/wav';
  if (ext === '.m4a') return 'audio/mp4';
  return 'application/octet-stream';
}

/** True if the path is an audio or video artifact this gate should inspect. */
export function isVoiceOrAvatarArtifact(filePath: string): boolean {
  const m = mimeForPath(filePath);
  return m.startsWith('audio/') || m.startsWith('video/');
}

/**
 * Re-transcribe a voice/avatar media file via Gemini for QA.
 * Returns the transcript text Gemini extracts from the actual rendered media.
 */
export async function transcribeForQA(mediaPath: string, mimeType?: string): Promise<string> {
  const ai = qaGeminiClient();
  const data = fs.readFileSync(mediaPath).toString('base64');
  const mt = mimeType || mimeForPath(mediaPath);
  const res = await ai.models.generateContent({
    model: VOICE_QA_MODEL,
    contents: [{
      role: 'user',
      parts: [
        createPartFromBase64(data, mt),
        { text: 'Transcribe the spoken audio in this media verbatim. Output transcript text ONLY, no preamble, no commentary, no markdown. If silent, output an empty string.' },
      ],
    }],
    config: { temperature: 0 },
  });
  return (res.text ?? '').trim();
}

/** Normalize text for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[،؛؟ً-ْ]/g, '') // arabic punct + tashkeel
    .replace(/[\p{P}\p{S}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Tiny iterative Levenshtein (O(n*m), small alloc). */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  let curr = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/** Normalized similarity in [0,1]. 1 = identical. */
export function normalizedSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na && !nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

/**
 * Detect specific high-risk factual deltas between script and transcript.
 * Returns a reason string if a delta is found, else null. Years and standalone
 * 2-4 digit numbers are checked: any number present in EITHER side that does
 * not appear in the OTHER side counts as a delta.
 */
export function factualDelta(scriptText: string, transcript: string): string | null {
  const numsScript = new Set((scriptText.match(/\b\d{2,4}\b/g) ?? []));
  const numsTrans = new Set((transcript.match(/\b\d{2,4}\b/g) ?? []));
  for (const n of numsScript) if (!numsTrans.has(n)) return `script-only number: ${n}`;
  for (const n of numsTrans) if (!numsScript.has(n)) return `transcript-only number: ${n}`;
  return null;
}

export interface VoiceQaResult {
  passed: boolean;
  similarity: number;
  threshold: number;
  reason?: string;
  transcript: string;
  hardGateEnabled: boolean;
}

/**
 * Hard QA gate: re-transcribe the artifact, compare against script.
 * Caller MUST block the send when `passed === false` and the hard gate is on.
 */
export async function checkVoiceArtifact(
  scriptText: string,
  mediaPath: string,
  mimeType?: string,
): Promise<VoiceQaResult> {
  const env = readEnvFile(['VOICE_QA_HARD_GATE']);
  const flag = (env.VOICE_QA_HARD_GATE ?? process.env.VOICE_QA_HARD_GATE ?? 'true').toLowerCase();
  const hardGateEnabled = flag !== 'false' && flag !== '0';

  let transcript = '';
  try {
    transcript = await transcribeForQA(mediaPath, mimeType);
  } catch (err) {
    // If Gemini itself fails, fail-CLOSED when hard gate is on.
    logger.error({ err, mediaPath }, 'voice-qa: transcribeForQA threw');
    return {
      passed: !hardGateEnabled,
      similarity: 0,
      threshold: VOICE_QA_THRESHOLD,
      reason: 'transcription_failed: ' + (err as Error).message?.slice(0, 200),
      transcript: '',
      hardGateEnabled,
    };
  }

  const similarity = normalizedSimilarity(scriptText, transcript);
  const delta = factualDelta(scriptText, transcript);
  const lowSim = similarity < VOICE_QA_THRESHOLD;
  if (lowSim || delta) {
    const reason = delta
      ? `factual-delta: ${delta}; similarity=${similarity.toFixed(3)}`
      : `similarity ${similarity.toFixed(3)} < ${VOICE_QA_THRESHOLD}`;
    return { passed: false, similarity, threshold: VOICE_QA_THRESHOLD, reason, transcript, hardGateEnabled };
  }
  return { passed: true, similarity, threshold: VOICE_QA_THRESHOLD, transcript, hardGateEnabled };
}
