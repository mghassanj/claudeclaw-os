// WhatsApp formatting for bot replies.
//
// The main agent writes GitHub-flavoured Markdown (it was tuned for Telegram
// and the dashboard). WhatsApp has its own, smaller syntax: *bold*, _italic_,
// ~strike~, ```monospace``` and `inline code`. Markdown that WhatsApp doesn't
// understand shows up literally ("**x**", "# Heading", pipe tables), which is
// what 5 of 16 self-chat replies looked like on 2026-09-21.
//
// formatForWhatsApp() rewrites the Markdown it can, drops what it can't
// (HTML tags, horizontal rules), and never touches the inside of code spans.
// splitForWhatsApp() breaks long replies at paragraph boundaries so a phone
// screen gets several readable messages instead of one wall of text.
//
// Everything here is plain string work over code points: Arabic/RTL text and
// emoji pass through untouched, and hard splits never cut a surrogate pair
// or an emoji ZWJ sequence.

/** Default max characters per WhatsApp message before splitting. */
export const WA_SPLIT_AT = 1500;

type Segment = { code: boolean; text: string };

/** Split text into fenced-code and prose segments (fences kept in the code text). */
function splitFences(text: string): Segment[] {
  const out: Segment[] = [];
  const re = /```[^\n]*\n[\s\S]*?```/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ code: false, text: text.slice(last, idx) });
    out.push({ code: true, text: normalizeFence(m[0]) });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** ```ts\ncode``` -> ```\ncode``` (WhatsApp has no language tags; it would print "ts"). */
function normalizeFence(block: string): string {
  return block.replace(/^```[^\n]*\n/, "```\n");
}

function isTableRow(line: string): boolean {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|") && t.length > 1;
}

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function isPipeSeparator(line: string): boolean {
  return line.includes("|") && isTableSeparator(line);
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Markdown pipe tables -> one "• a — b" line per row; header row in bold. */
function convertTables(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isTableRow(lines[i]) || isPipeSeparator(lines[i])) {
      const block: string[] = [];
      while (i < lines.length && (isTableRow(lines[i]) || isPipeSeparator(lines[i]))) {
        block.push(lines[i]);
        i++;
      }
      const hasHeader = block.length >= 2 && isPipeSeparator(block[1]);
      block.forEach((row, n) => {
        if (isPipeSeparator(row)) return;
        const cells = tableCells(row).filter((c) => c.length > 0);
        if (cells.length === 0) return;
        const joined = cells.join(" — ");
        out.push(hasHeader && n === 0 ? `*${stripEmphasis(joined)}*` : `• ${joined}`);
      });
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join("\n");
}

function stripEmphasis(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, "$1").replace(/__(.+?)__/g, "$1").replace(/(^|\s)\*(\S(?:.*?\S)?)\*(?=\s|$)/g, "$1$2");
}

/** Convert one prose (non-code) segment. Inline `code` spans are protected. */
function formatProse(text: string): string {
  // Protect inline code: WhatsApp renders `x` as inline code, and nothing
  // inside it should be rewritten.
  const inline: string[] = [];
  let t = text.replace(/`[^`\n]+`/g, (m) => {
    inline.push(m);
    return `\u0000${inline.length - 1}\u0000`;
  });

  // HTML: line breaks become newlines, every other tag is dropped. The tag
  // pattern requires a letter after "<" so "a < b", "<3" and "->" survive.
  t = t.replace(/<br\s*\/?>/gi, "\n");
  t = t.replace(/<\/?(?:p|div|li|ul|ol|h[1-6])\b[^<>]*>/gi, "\n");
  t = t.replace(/<\/?[a-zA-Z][a-zA-Z0-9-]*(?:\s[^<>]*)?\/?>/g, "");

  t = convertTables(t);

  // Headings -> bold line.
  t = t.replace(/^[ \t]*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, (_m, h: string) => `*${stripEmphasis(h)}*`);

  // Horizontal rules -> blank line.
  t = t.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "");

  // Bullets "- x" / "* x" / "+ x" -> "• x" (a leading "* " would otherwise
  // be read as an opening bold marker by WhatsApp).
  t = t.replace(/^([ \t]*)[-*+][ \t]+(?=\S)/gm, "$1• ");

  // Emphasis. Bold first so "**x**" doesn't get treated as two italics.
  t = t.replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, "*$1*");
  t = t.replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, "_$1_");
  t = t.replace(/~~(?=\S)([^~\n]+?)(?<=\S)~~/g, "~$1~");

  // Links: [text](url) -> "text (url)"; bare-text links where text == url -> url.
  t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) =>
    label.trim() === url ? url : `${label} (${url})`);

  // Restore inline code.
  t = t.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => inline[Number(n)]);
  return t;
}

/** Rewrite Markdown/HTML into WhatsApp's formatting syntax. Idempotent for WhatsApp-native text. */
export function formatForWhatsApp(input: string): string {
  const text = (input ?? "").replace(/\r\n?/g, "\n");
  const formatted = splitFences(text)
    .map((s) => (s.code ? s.text : formatProse(s.text)))
    .join("");
  return formatted
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Splitting ─────────────────────────────────────────────────────────

/** Length in code points (what a reader counts), not UTF-16 units. */
function cpLen(s: string): number {
  return Array.from(s).length;
}

/** User-perceived characters (keeps emoji ZWJ sequences and combining marks whole). */
function graphemes(s: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: object) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(s), (x) => x.segment);
  return Array.from(s);
}

/** Last-resort split of a single overlong run: at a space if possible, else by grapheme. */
function hardSplit(s: string, max: number): string[] {
  const out: string[] = [];
  let rest = s;
  while (cpLen(rest) > max) {
    const g = graphemes(rest);
    let cut = 0;
    let taken = 0;
    for (let i = 0; i < g.length; i++) {
      const n = cpLen(g[i]);
      if (taken + n > max) break;
      taken += n;
      cut = i + 1;
    }
    let head = g.slice(0, Math.max(cut, 1)).join("");
    const sp = head.lastIndexOf(" ");
    if (sp > head.length * 0.5) head = head.slice(0, sp);
    out.push(head.trimEnd());
    rest = rest.slice(head.length).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

/** Split an overlong paragraph by lines, then sentences, then words. */
function splitParagraph(p: string, max: number): string[] {
  if (cpLen(p) <= max) return [p];
  const isFence = p.startsWith("```") && p.endsWith("```");
  if (isFence) {
    // Re-wrap each piece in its own fence so every message renders as code.
    const body = p.replace(/^```\n?/, "").replace(/\n?```$/, "");
    return packUnits(body.split("\n"), max - 8, "\n").flatMap((c) => hardSplit(c, max - 8)).map((c) => "```\n" + c + "\n```");
  }
  const lines = p.split("\n");
  if (lines.length > 1) return packUnits(lines, max, "\n").flatMap((c) => splitParagraph(c, max));
  const sentences = p.match(/[^.!?؟。]+[.!?؟。]*\s*/g) ?? [p];
  if (sentences.length > 1) return packUnits(sentences.map((s) => s.trim()), max, " ").flatMap((c) => hardSplit(c, max));
  return hardSplit(p, max);
}

/** Greedily pack units into chunks of at most `max`, joined by `sep`. */
function packUnits(units: string[], max: number, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const u of units) {
    if (!cur) { cur = u; continue; }
    if (cpLen(cur) + cpLen(sep) + cpLen(u) <= max) cur += sep + u;
    else { out.push(cur); cur = u; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Paragraphs, keeping fenced code blocks (which may contain blank lines) whole. */
function paragraphs(text: string): string[] {
  const out: string[] = [];
  for (const seg of splitFences(text)) {
    if (seg.code) { out.push(seg.text.trim()); continue; }
    for (const p of seg.text.split(/\n{2,}/)) if (p.trim()) out.push(p.trim());
  }
  return out;
}

/**
 * Split text into messages of at most `max` code points, breaking at paragraph
 * boundaries first. Short text comes back as a single-element array.
 */
export function splitForWhatsApp(text: string, max = WA_SPLIT_AT): string[] {
  const t = (text ?? "").trim();
  if (!t) return [];
  if (cpLen(t) <= max) return [t];
  const units = paragraphs(t).flatMap((p) => splitParagraph(p, max));
  return packUnits(units, max, "\n\n");
}

/** Format then split: the messages a bot reply should be sent as. */
export function prepareWhatsAppMessages(text: string, max = WA_SPLIT_AT): string[] {
  return splitForWhatsApp(formatForWhatsApp(text), max);
}
