import OpenAI from "openai";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function transcribeVoice(
  audioBytes: Buffer, mimeHint = "audio/ogg",
): Promise<{ text: string; durationMs: number; costEstimate: number }> {
  const t0 = Date.now();
  const ext = mimeHint.includes("mp3") ? "mp3" : mimeHint.includes("ogg") ? "ogg" : "m4a";
  const tmp = path.join(os.tmpdir(), `wa-voice-${Date.now()}.${ext}`);
  await fs.writeFile(tmp, audioBytes);
  try {
    const r = await client.audio.transcriptions.create({
      file: createReadStream(tmp),
      model: "whisper-1",
    });
    const durationMs = Date.now() - t0;
    const costEstimate = 0.006;  // ~$0.006/min, approximate
    return { text: r.text, durationMs, costEstimate };
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}
