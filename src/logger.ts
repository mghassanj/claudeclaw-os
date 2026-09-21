import pino from 'pino';

// grammy's HttpError/FetchError messages embed the full Bot API URL
// (https://api.telegram.org/bot<id>:<secret>/method), which put live bot
// tokens into journald. Scrub them from every serialized log line.
const TELEGRAM_TOKEN_RE = /bot\d+:[A-Za-z0-9_-]{30,}/g;

export function redactSecrets(line: string): string {
  return line.replace(TELEGRAM_TOKEN_RE, 'bot<redacted>');
}

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  hooks: { streamWrite: redactSecrets },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});
