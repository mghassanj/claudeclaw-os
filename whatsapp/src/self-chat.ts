// Helpers for the WhatsApp self-chat -> main agent bridge (service.ts).
// Kept free of whatsapp-web.js so they can be unit-tested.
import fs from "node:fs/promises";
import type { MainBridgeFile } from "./main-bridge.js";

/**
 * Sent when the bridge call fails (dashboard restarting, agent error, or the
 * wait ran out). The turn may still be running on the main session and its
 * result is kept in the shared conversation, so resending would run the task
 * twice. English + Najdi Arabic.
 */
export const BRIDGE_FALLBACK_TEXT = [
  "⚠️ I didn't get a reply from the main agent. The task may still be running in the background, so please don't resend it; ask me for its status in a few minutes instead.",
  "",
  "⚠️ ما وصلني رد من الوكيل الرئيسي. يمكن المهمة للحين شغالة بالخلفية، فلا تعيد ترسلها؛ اسألني عن وضعها بعد كم دقيقة.",
].join("\n");

/**
 * The text sent to the main agent for a self-chat message:
 * - voice notes get the same "[Voice transcribed]: " tag Telegram uses, so the
 *   agent treats them as spoken commands (main CLAUDE.md "Message Format");
 * - images send only the caption (the image itself travels in the metadata and
 *   the server wraps it as "Photo received. File saved at: …");
 * - everything else (text, extracted documents) is passed as is.
 */
export function bridgeInboundText(
  inboundType: "text" | "voice" | "image",
  inboundText: string,
  rawBody: string,
): string {
  if (inboundType === "voice") return `[Voice transcribed]: ${inboundText.trim()}`;
  if (inboundType === "image") return rawBody.trim();
  return inboundText;
}

export interface DeliveredFiles {
  /** Paths that were sent. */
  sent: string[];
  /** Paths that were missing or failed to send. */
  failed: string[];
  /** WhatsApp id of the first media message sent, if any. */
  firstMsgId: string | null;
}

/**
 * Send the files the agent attached with [SEND_FILE:…]/[SEND_PHOTO:…] markers.
 * A missing or failing file gets a short note instead of breaking the reply,
 * matching the Telegram path ("Could not send file: … (not found)").
 */
export async function deliverBridgeFiles(
  files: MainBridgeFile[],
  sendMedia: (filePath: string, caption?: string) => Promise<string | null>,
  sendNote: (text: string) => Promise<unknown>,
): Promise<DeliveredFiles> {
  const out: DeliveredFiles = { sent: [], failed: [], firstMsgId: null };
  for (const f of files) {
    // Only local absolute paths: URLs and relative paths aren't supported here.
    if (!f.filePath.startsWith("/")) {
      out.failed.push(f.filePath);
      await sendNote(`Could not send file: ${f.filePath} (not a local path)`).catch(() => {});
      continue;
    }
    try {
      await fs.access(f.filePath);
    } catch {
      out.failed.push(f.filePath);
      await sendNote(`Could not send file: ${f.filePath} (not found)`).catch(() => {});
      continue;
    }
    try {
      const id = await sendMedia(f.filePath, f.caption);
      out.sent.push(f.filePath);
      if (!out.firstMsgId) out.firstMsgId = id;
    } catch (e) {
      console.warn("[wa] bridge file send failed:", f.filePath, e);
      out.failed.push(f.filePath);
      await sendNote(`Failed to send file: ${f.filePath}`).catch(() => {});
    }
  }
  return out;
}
