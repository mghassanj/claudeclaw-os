// Turn any inbound WhatsApp message into what the agents need:
//   - text:        a description the agent can act on (transcript, extracted
//                  or OCR'd document text, location, contact card, poll…);
//   - image:       one picture for vision (photo, sticker, video frame, first
//                  page of a scanned PDF), used by the group reply agent;
//   - attachments: the original file plus derived images, forwarded to the
//                  main agent over the self-chat bridge so it can open them.
//
// Every download/processing step degrades to a note in `text` instead of
// throwing, so an attachment problem is explained to the user rather than
// silently producing no reply.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type InboundKind =
  | "text" | "voice" | "audio" | "image" | "sticker" | "video" | "document"
  | "location" | "contact" | "poll" | "event" | "other";

export interface Attachment {
  base64: string;
  mime: string;
  filename: string;
  /** original = the file as sent; derived = frames / rendered pages. */
  role: "original" | "derived";
}

export interface InboundMedia {
  kind: InboundKind;
  text: string;
  image?: { base64: string; mime: string };
  attachments: Attachment[];
}

export interface DownloadedMedia { data: string; mimetype: string; filename?: string | null }

/** Minimal message shape (whatsapp-web.js Message), so tests can fake it. */
export interface InboundMsg {
  type: string;
  body?: string;
  hasMedia?: boolean;
  duration?: string | number;
  location?: { latitude?: number | string; longitude?: number | string; name?: string; address?: string; url?: string; description?: string };
  vCards?: string[];
  pollName?: string;
  pollOptions?: Array<{ name?: string } | string>;
  downloadMedia(): Promise<DownloadedMedia | undefined>;
}

/** Processing steps, injectable for tests. */
export interface MediaDeps {
  transcribe(bytes: Buffer, mime: string): Promise<string>;
  extractDocument(bytes: Buffer, mime: string, filename: string): Promise<string>;
  /** Render + OCR a PDF with no text layer. Returns text and page images. */
  ocrPdf(bytes: Buffer): Promise<{ text: string; pages: Buffer[] }>;
  /** Transcode any audio (or a video's audio track) to mp3; null if no audio. */
  toMp3(bytes: Buffer, ext: string): Promise<Buffer | null>;
  /** Evenly spaced JPEG frames of a video, plus its duration in seconds. */
  videoFrames(bytes: Buffer, ext: string): Promise<{ frames: Buffer[]; seconds: number | null }>;
  /** First frame of a (possibly animated) sticker as PNG; null if it can't. */
  stickerToPng(bytes: Buffer): Promise<Buffer | null>;
}

/** Message types that carry nothing to answer (system events, edits, reactions). */
const SKIP_TYPES = new Set([
  "revoked", "reaction", "protocol", "ciphertext", "e2e_notification", "notification",
  "notification_template", "gp2", "group_notification", "broadcast_notification",
  "call_log", "debug", "album",
]);

/** Below this many characters, a PDF's text layer is treated as missing (scanned). */
const SCANNED_PDF_MIN_CHARS = 40;

const TEXT_DOC_EXT = /\.(txt|csv|tsv|md|json|xml|html?|log|ya?ml|ini|srt|vtt)$/i;

/** Raw bytes of forwarded files per bridge request. The dashboard caps the
 *  main-turn body at 25 MB; base64 adds a third, so ~17 MB of files fit. */
export const BRIDGE_ATTACH_BUDGET = Number(process.env.WA_BRIDGE_ATTACH_BYTES ?? 17 * 1024 * 1024);

export function isSkippable(type: string): boolean {
  return SKIP_TYPES.has(type);
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function formatLocation(loc: InboundMsg["location"], caption = ""): string {
  const lat = num(loc?.latitude);
  const lng = num(loc?.longitude);
  if (lat === null || lng === null) return "[Location shared, but it had no coordinates]";
  const label = [loc?.name, loc?.address ?? loc?.description].filter(Boolean).join(" — ");
  return [
    `[Location shared${label ? `: ${label}` : ""}]`,
    `Coordinates: ${lat}, ${lng}`,
    `Map: https://maps.google.com/?q=${lat},${lng}`,
    loc?.url ? `Link: ${loc.url}` : "",
    caption ? `Message: ${caption}` : "",
  ].filter(Boolean).join("\n");
}

/** Pull names, phones, emails and org out of vCard text. */
export function formatVCards(vcards: string[]): string {
  const cards = vcards.map((v) => {
    const lines = v.replace(/\r\n[ \t]/g, "").split(/\r?\n/);
    const field = (re: RegExp) => lines.filter((l) => re.test(l)).map((l) => l.slice(l.indexOf(":") + 1).trim()).filter(Boolean);
    const name = field(/^FN[;:]/i)[0] ?? field(/^N[;:]/i)[0]?.split(";").filter(Boolean).reverse().join(" ") ?? "Unnamed";
    const phones = field(/^(item\d+\.)?TEL[;:]/i);
    const emails = field(/^(item\d+\.)?EMAIL[;:]/i);
    const org = field(/^ORG[;:]/i)[0]?.replace(/;+$/, "");
    return [`• ${name}`, org ? `  Org: ${org}` : "", ...phones.map((p) => `  Phone: ${p}`), ...emails.map((e) => `  Email: ${e}`)]
      .filter(Boolean).join("\n");
  });
  return [`[Contact card${vcards.length > 1 ? `s (${vcards.length})` : ""} shared]`, ...cards].join("\n");
}

export function formatPoll(name: string | undefined, options: InboundMsg["pollOptions"]): string {
  const opts = (options ?? []).map((o) => (typeof o === "string" ? o : o?.name ?? "")).filter(Boolean);
  return [`[Poll: ${name?.trim() || "(no question)"}]`, ...opts.map((o, i) => `${i + 1}. ${o}`)].join("\n");
}

/** Keep attachments in order while their raw size fits the budget; report the rest. */
export function fitAttachments(list: Attachment[], budget = BRIDGE_ATTACH_BUDGET): { kept: Attachment[]; dropped: Attachment[] } {
  const kept: Attachment[] = [];
  const dropped: Attachment[] = [];
  let used = 0;
  for (const a of list) {
    const size = Math.floor((a.base64.length * 3) / 4);
    if (used + size <= budget) { kept.push(a); used += size; } else dropped.push(a);
  }
  return { kept, dropped };
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function extOf(mime: string, filename = ""): string {
  const fromName = path.extname(filename).slice(1).toLowerCase();
  if (fromName) return fromName;
  const sub = mime.split(";")[0].split("/")[1] ?? "bin";
  const known = ({ jpeg: "jpg", "x-m4a": "m4a", mpeg: "mp3", quicktime: "mov" } as Record<string, string>)[sub];
  return known ?? (sub.replace(/[^a-z0-9]/gi, "").slice(0, 8) || "bin");
}

function withCaption(lines: string[], caption: string): string {
  return [...lines, caption ? `Message: ${caption}` : ""].filter(Boolean).join("\n");
}

async function safeDownload(msg: InboundMsg): Promise<{ media: DownloadedMedia; buf: Buffer } | { error: string }> {
  try {
    const media = await msg.downloadMedia();
    if (!media?.data) return { error: "WhatsApp returned no data (the media may have expired on the phone)" };
    return { media, buf: Buffer.from(media.data, "base64") };
  } catch (e) {
    return { error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/**
 * Describe an inbound message. Returns null for message types that should not
 * be answered at all (reactions, deletions, system notifications).
 */
export async function describeInbound(msg: InboundMsg, deps: MediaDeps = defaultDeps): Promise<InboundMedia | null> {
  const type = msg.type ?? "chat";
  const caption = (msg.body ?? "").trim();
  if (isSkippable(type)) return null;

  if (type === "location") return { kind: "location", text: formatLocation(msg.location, caption), attachments: [] };
  if (type === "vcard" || type === "multi_vcard") {
    return { kind: "contact", text: formatVCards(msg.vCards?.length ? msg.vCards : [msg.body ?? ""]), attachments: [] };
  }
  if (type === "poll_creation") return { kind: "poll", text: formatPoll(msg.pollName ?? msg.body, msg.pollOptions), attachments: [] };
  if (type === "scheduled_event_creation") return { kind: "event", text: `[Event shared: ${caption || "(untitled)"}]`, attachments: [] };

  if (!msg.hasMedia) {
    if (type === "chat") return { kind: "text", text: msg.body ?? "", attachments: [] };
    // order / product / payment / list / buttons / interactive / unknown…
    return {
      kind: "other",
      text: caption ? `[WhatsApp ${type} message] ${caption}` : `[A WhatsApp "${type}" message was received; it has no text or file the assistant can read]`,
      attachments: [],
    };
  }

  const dl = await safeDownload(msg);
  if ("error" in dl) {
    const label = type === "ptt" ? "voice note" : type;
    return {
      kind: type === "ptt" ? "voice" : "other",
      text: withCaption([`[A ${label} was attached but couldn't be downloaded: ${dl.error}. Ask the user to send it again.]`], caption),
      attachments: [],
    };
  }
  const { media, buf } = dl;
  const mime = (media.mimetype ?? "application/octet-stream").split(";")[0].trim().toLowerCase();
  const filename = media.filename || (type === "document" ? caption : "") || `whatsapp-${type}.${extOf(mime)}`;
  const ext = extOf(mime, filename);
  const original: Attachment = { base64: media.data, mime, filename, role: "original" };

  // Documents that are really images / audio / video are handled as such.
  const effective =
    type === "document" && mime.startsWith("image/") ? "image"
      : type === "document" && mime.startsWith("audio/") ? "audio"
        : type === "document" && mime.startsWith("video/") ? "video"
          : type;

  if (effective === "ptt" || effective === "audio") {
    const kind: InboundKind = effective === "ptt" ? "voice" : "audio";
    try {
      // Whisper takes ogg/mp3/m4a/wav/webm; normalise anything else first.
      const direct = ["ogg", "oga", "mp3", "m4a", "wav", "webm", "mp4", "mpeg", "mpga"].includes(ext);
      const audio = direct ? buf : await deps.toMp3(buf, ext);
      const t = audio ? await deps.transcribe(audio, direct ? mime : "audio/mpeg") : "";
      // A voice note is fully carried by its transcript.
      if (kind === "voice") return { kind, text: t, attachments: [] };
      return {
        kind,
        text: withCaption([`[Audio file attached: ${filename}, ${mb(buf.length)}]`, `Transcript: ${t.trim() || "(no speech detected)"}`], caption),
        attachments: [original],
      };
    } catch (e) {
      return { kind, text: withCaption([`[${kind === "voice" ? "Voice note" : `Audio file ${filename}`} attached, but transcription failed: ${String(e).slice(0, 150)}]`], caption), attachments: kind === "voice" ? [] : [original] };
    }
  }

  if (effective === "image") {
    return {
      kind: "image",
      text: caption || (type === "document" ? `[Image file attached: ${filename} — describe or answer based on its content]` : "[image attached — describe or answer based on its content]"),
      image: { base64: media.data, mime },
      attachments: [original],
    };
  }

  if (effective === "sticker") {
    const png = await deps.stickerToPng(buf).catch(() => null);
    const image = png ? { base64: png.toString("base64"), mime: "image/png" } : { base64: media.data, mime };
    return {
      kind: "sticker",
      text: "[Sticker sent — react to what it shows]",
      image,
      attachments: png ? [{ ...image, filename: "sticker.png", role: "original" }] : [original],
    };
  }

  if (effective === "video" || effective === "gif" || effective === "ptv") {
    const label = effective === "gif" ? "GIF" : effective === "ptv" ? "Video note" : "Video";
    let transcript = "";
    let frames: Buffer[] = [];
    let seconds: number | null = num(msg.duration);
    const problems: string[] = [];
    try {
      const vf = await deps.videoFrames(buf, ext);
      frames = vf.frames;
      seconds = vf.seconds ?? seconds;
    } catch (e) { problems.push(`frames: ${String(e).slice(0, 120)}`); }
    if (effective !== "gif") {
      try {
        const audio = await deps.toMp3(buf, ext);
        transcript = audio ? (await deps.transcribe(audio, "audio/mpeg")).trim() : "";
        if (!audio) transcript = "(no audio track)";
      } catch (e) { problems.push(`transcript: ${String(e).slice(0, 120)}`); }
    }
    const derived = frames.map((f, i): Attachment => ({ base64: f.toString("base64"), mime: "image/jpeg", filename: `frame-${i + 1}.jpg`, role: "derived" }));
    const mid = frames[Math.floor(frames.length / 2)];
    return {
      kind: "video",
      text: withCaption([
        `[${label} attached: ${filename}, ${mb(buf.length)}${seconds ? `, ${Math.round(seconds)}s` : ""}]`,
        frames.length ? `${frames.length} still frame(s) taken across the ${label.toLowerCase()} are attached.` : "",
        effective !== "gif" ? `Audio transcript: ${transcript || "(unavailable)"}` : "",
        problems.length ? `(Processing issues: ${problems.join("; ")})` : "",
      ], caption),
      image: mid ? { base64: mid.toString("base64"), mime: "image/jpeg" } : undefined,
      attachments: [original, ...derived],
    };
  }

  // Documents (and any other media type with a file).
  const header = `[Document attached: ${filename}, ${mime}, ${mb(buf.length)}]`;
  const lines: string[] = [header];
  let image: InboundMedia["image"];
  const derived: Attachment[] = [];
  let text = "";
  try {
    if (TEXT_DOC_EXT.test(filename) || mime.startsWith("text/") || mime === "application/json") {
      text = buf.toString("utf8");
    } else {
      text = await deps.extractDocument(buf, mime, filename);
    }
  } catch (e) {
    lines.push(`(Text extraction not available for this file type: ${String(e).slice(0, 120)})`);
  }
  if ((mime.includes("pdf") || ext === "pdf") && text.trim().length < SCANNED_PDF_MIN_CHARS) {
    // Scanned PDF: no text layer. OCR it (Arabic + English).
    try {
      const ocr = await deps.ocrPdf(buf);
      // A short but real text layer wins over OCR that found no more.
      if (ocr.text.trim().length > text.trim().length) {
        text = ocr.text;
        lines.push("(Scanned PDF: the text below was read with OCR and may contain errors; page images are attached.)");
      } else {
        lines.push("(Little text in this PDF; page images are attached.)");
      }
      ocr.pages.forEach((p, i) => derived.push({ base64: p.toString("base64"), mime: "image/png", filename: `page-${i + 1}.png`, role: "derived" }));
      if (ocr.pages[0]) image = { base64: ocr.pages[0].toString("base64"), mime: "image/png" };
    } catch (e) {
      lines.push(`(OCR failed: ${String(e).slice(0, 120)})`);
    }
  }
  if (text.trim()) lines.push("", "Extracted content:", text.trim());
  else lines.push("(No readable text could be extracted.)");
  lines.push("", caption && caption !== filename
    ? `Message with the document: ${caption}`
    : "Answer the question implied by the document, or summarize it if no question was asked.");
  return { kind: "document", text: lines.join("\n"), image, attachments: [original, ...derived] };
}

// ---------------------------------------------------------------------------
// Default implementations (ffmpeg / pdftoppm / tesseract on the host).

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wa-media-"));
  try { return await fn(dir); } finally { await fs.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

const EXEC_OPTS = { timeout: 180_000, maxBuffer: 64 * 1024 * 1024 };

export const defaultDeps: MediaDeps = {
  async transcribe(bytes, mime) {
    const { transcribeVoice } = await import("./tools/transcribe.js");
    return (await transcribeVoice(bytes, mime)).text;
  },
  async extractDocument(bytes, mime, filename) {
    const { extractDocument } = await import("./tools/extract_document.js");
    return (await extractDocument(bytes, mime, filename)).text;
  },
  ocrPdf: (bytes) => withTmpDir(async (dir) => {
    const pdf = path.join(dir, "in.pdf");
    await fs.writeFile(pdf, bytes);
    const maxPages = Number(process.env.WA_OCR_MAX_PAGES ?? 10);
    await run("pdftoppm", ["-r", "150", "-png", "-l", String(maxPages), pdf, path.join(dir, "p")], EXEC_OPTS);
    const files = (await fs.readdir(dir)).filter((f) => f.startsWith("p") && f.endsWith(".png")).sort();
    const pages: Buffer[] = [];
    const texts: string[] = [];
    for (const f of files) {
      const full = path.join(dir, f);
      const { stdout } = await run("tesseract", [full, "-", "-l", "ara+eng"], EXEC_OPTS);
      texts.push(stdout.trim());
      pages.push(await fs.readFile(full));
    }
    return { text: texts.filter(Boolean).join("\n\n"), pages };
  }),
  toMp3: (bytes, ext) => withTmpDir(async (dir) => {
    const input = path.join(dir, `in.${ext || "bin"}`);
    const out = path.join(dir, "out.mp3");
    await fs.writeFile(input, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", input], EXEC_OPTS);
    if (!stdout.trim()) return null;
    await run("ffmpeg", ["-y", "-v", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", out], EXEC_OPTS);
    return fs.readFile(out);
  }),
  videoFrames: (bytes, ext) => withTmpDir(async (dir) => {
    const input = path.join(dir, `in.${ext || "mp4"}`);
    await fs.writeFile(input, bytes);
    const { stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", input], EXEC_OPTS);
    const seconds = Number(stdout.trim());
    const count = Number(process.env.WA_VIDEO_FRAMES ?? 4);
    const frames: Buffer[] = [];
    const dur = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
    for (let i = 0; i < count; i++) {
      const at = dur ? (dur * (i + 0.5)) / count : i;
      const out = path.join(dir, `f${i}.jpg`);
      try {
        await run("ffmpeg", ["-y", "-v", "error", "-ss", at.toFixed(2), "-i", input, "-frames:v", "1", "-vf", "scale='min(1024,iw)':-2", "-q:v", "4", out], EXEC_OPTS);
        frames.push(await fs.readFile(out));
      } catch { /* past the end of a short clip */ }
      if (!dur) break;
    }
    return { frames, seconds: dur };
  }),
  stickerToPng: (bytes) => withTmpDir(async (dir) => {
    const input = path.join(dir, "in.webp");
    const out = path.join(dir, "out.png");
    await fs.writeFile(input, bytes);
    try {
      await run("ffmpeg", ["-y", "-v", "error", "-i", input, "-frames:v", "1", out], EXEC_OPTS);
      return await fs.readFile(out);
    } catch {
      return null;
    }
  }),
};
