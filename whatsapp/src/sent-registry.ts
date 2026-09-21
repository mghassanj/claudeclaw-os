// In-memory registry of message IDs the bot has sent, so the message_create
// handler can ignore the bot's own outbound messages when self-chat /
// self-reply processing is on. The 🤖 text prefix only covers text and
// captioned media; voice notes and uncaptioned media have no body to prefix,
// so without this they would be reprocessed as user input — an infinite loop.
const sentIds = new Set<string>();
const MAX = 1000;

export function markSent(id: string | undefined | null): void {
  if (!id) return;
  sentIds.add(id);
  if (sentIds.size > MAX) {
    const drop = Math.floor(MAX * 0.2);
    let i = 0;
    for (const v of sentIds) {
      sentIds.delete(v);
      if (++i >= drop) break;
    }
  }
}

export function wasSentByBot(id: string | undefined | null): boolean {
  return !!id && sentIds.has(id);
}
