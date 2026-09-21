// Pure helpers for the post-restart catch-up in service.ts (kept free of
// whatsapp-web.js / DB imports so they can be unit-tested).

export interface CatchUpMsg {
  timestamp: number;
  fromMe: boolean;
  body?: string;
  id: { _serialized: string };
}

/**
 * Messages worth replaying after a restart: inside the catch-up window, older
 * than READY (newer ones reach the live handler), newer than the bot's last
 * reply in that chat, and not themselves bot output.
 */
export function selectMissed<M extends CatchUpMsg>(
  recent: M[],
  opts: { cutoff: number; readyAt: number; isBotMsg: (m: M) => boolean },
): M[] {
  const lastBotTs = recent.filter(opts.isBotMsg).reduce((t, m) => Math.max(t, m.timestamp), 0);
  return recent
    .filter((m) =>
      m.timestamp >= opts.cutoff && m.timestamp < opts.readyAt && m.timestamp > lastBotTs && !opts.isBotMsg(m))
    .sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * Is this (non-group) chat the "Message Yourself" chat? Mirrors the live
 * handler's checks at chat level: own wid, same phone user, a configured
 * WHATSAPP_SELF_LIDS user-part (the self-chat uses the @lid namespace), or a
 * contact flagged isMe.
 */
export function isSelfChatCandidate(
  chat: { isGroup: boolean; id: { _serialized: string; user?: string } },
  self: { selfId?: string; selfUser?: string; selfLids: string[]; contactIsMe?: boolean },
): boolean {
  if (chat.isGroup) return false;
  const chatUser = chat.id.user;
  return (
    !!self.contactIsMe ||
    (!!self.selfId && chat.id._serialized === self.selfId) ||
    (!!self.selfUser && !!chatUser && self.selfUser === chatUser) ||
    (!!chatUser && self.selfLids.includes(chatUser))
  );
}
