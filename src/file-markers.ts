// [SEND_FILE:...] / [SEND_PHOTO:...] marker parsing, shared by the Telegram
// bot and the WhatsApp self-chat bridge (main-turn.ts). Moved out of bot.ts so
// the bridge can use it without loading the Telegram bot; bot.ts re-exports it.

// ── File marker types ─────────────────────────────────────────────────
export interface FileMarker {
  type: 'document' | 'photo';
  filePath: string;
  caption?: string;
}

export interface ExtractResult {
  text: string;
  files: FileMarker[];
}

/**
 * Extract [SEND_FILE:path] and [SEND_PHOTO:path] markers from Claude's response.
 * Supports optional captions via pipe: [SEND_FILE:/path/to/file.pdf|Here's your report]
 *
 * Tolerant of common malformed variants observed in the wild:
 *   - Pipe used as the primary separator instead of colon
 *     ([SEND_PHOTO|https://...] or SEND_PHOTO|https://...)
 *   - Missing surrounding brackets entirely
 *   - http(s) URLs in addition to filesystem paths
 *
 * Returns the cleaned text (markers stripped) and an array of file descriptors.
 */
export function extractFileMarkers(text: string): ExtractResult {
  const files: FileMarker[] = [];

  // Canonical bracketed form: [SEND_FILE:/abs/path|caption]
  // Tolerant variants: pipe instead of colon, optional brackets, URL paths.
  // The bracketed form is preferred (it's documented in CLAUDE.md), but the
  // bare/pipe forms are recognized so a malformed agent reply still gets
  // its image rendered instead of leaking the raw command string into chat.
  const patterns: RegExp[] = [
    /\[SEND_(FILE|PHOTO)[:|]\s*([^\]|]+?)(?:\s*\|\s*([^\]]*))?\]/g,
    /(?:^|\s)SEND_(FILE|PHOTO)\s*[:|]\s*((?:https?:\/\/|\/)[^\s|\]]+)(?:\s*\|\s*([^\n]+))?/g,
  ];

  let cleaned = text;
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, (_match: string, kind: string, filePath: string, caption?: string) => {
      files.push({
        type: kind === 'PHOTO' ? 'photo' : 'document',
        filePath: filePath.trim(),
        caption: caption?.trim() || undefined,
      });
      return '';
    });
  }

  // Collapse extra blank lines left by stripped markers
  const trimmed = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { text: trimmed, files };
}
