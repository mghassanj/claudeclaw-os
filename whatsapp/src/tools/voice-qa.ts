// Voice/avatar artifact QA hard gate (Fix #4).
//
// Before sending any Tier 6 (avatar video) or Tier 7 (podcast audio) artifact
// over WhatsApp, re-transcribe the rendered media via Gemini and compare
// against the original script the bot composed. If similarity is low or a
// factual delta is detected (year, number), the send is BLOCKED.
//
// Flip off via VOICE_QA_HARD_GATE=false in .env (default = true).
//
// Uses Gemini REST API directly (no @google/genai SDK in this package).

import fs from "node:fs/promises";
import path from "node:path";

const VOICE_QA_MODEL = process.env.VOICE_QA_MODEL || "gemini-2.0-flash";
export const VOICE_QA_THRESHOLD = parseFloat(process.env.VOICE_QA_THRESHOLD || "0.85");

function mimeForPath(p: string): string {
  const ext = path.extname(p).toLowerCase();
  if (ext === ".mp4" || ext === ".m4v") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  if (ext === ".ogg" || ext === ".oga" || ext === ".opus") return "audio/ogg";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".wav") return "audio/wav";
  if (ext === ".m4a") return "audio/mp4";
  return "application/octet-stream";
}

/** True if this artifact is voice or avatar — the only kinds the gate inspects. */
export function isVoiceOrAvatarArtifact(filePath: string): boolean {
  const m = mimeForPath(filePath);
  return m.startsWith("audio/") || m.startsWith("video/");
}

async function transcribeForQA(mediaPath: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_API_KEY not set — required for voice-QA gate");
  const data = (await fs.readFile(mediaPath)).toString("base64");
  const mt = mimeForPath(mediaPath);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VOICE_QA_MODEL}:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      role: "user",
      parts: [
        { inline_data: { mime_type: mt, data } },
        { text: "Transcribe the spoken audio in this media verbatim. Output transcript text ONLY, no preamble, no commentary, no markdown. If silent, output an empty string." },
      ],
    }],
    generationConfig: { temperature: 0 },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Gemini ${res.status}: ${txt.slice(0, 300)}`);
  }
  const j = await res.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  const text = j.candidates?.[0]?.content?.parts?.map(p => p.text ?? "").join("") ?? "";
  return text.trim();
}

function normalizeForCompare(s: string): string {
  return s
    .toLowerCase()
    .replace(/[،؛؟ً-ْ]/g, "")
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
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

function normalizedSimilarity(a: string, b: string): number {
  const na = normalizeForCompare(a);
  const nb = normalizeForCompare(b);
  if (!na && !nb) return 1;
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

function factualDelta(scriptText: string, transcript: string): string | null {
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

export async function checkVoiceArtifact(
  scriptText: string,
  mediaPath: string,
): Promise<VoiceQaResult> {
  const flag = (process.env.VOICE_QA_HARD_GATE ?? "true").toLowerCase();
  const hardGateEnabled = flag !== "false" && flag !== "0";

  let transcript = "";
  try {
    transcript = await transcribeForQA(mediaPath);
  } catch (err) {
    console.warn("[voice-qa] transcribeForQA failed:", (err as Error).message);
    return {
      passed: !hardGateEnabled,
      similarity: 0,
      threshold: VOICE_QA_THRESHOLD,
      reason: "transcription_failed: " + (err as Error).message?.slice(0, 200),
      transcript: "",
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
