/**
 * Turn-outcome honesty helpers (PA enhancement #8).
 *
 * Pure functions shared by the main-turn bridge, the orchestrator and the
 * scheduler so an aborted / timed-out / blocked run is never reported as a
 * plain success ("Done.", 'completed', last_status='success').
 */

/** Human label for a timeout, e.g. 900000 -> "15m", 45000 -> "45s". */
export function formatTimeoutLabel(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

/**
 * Reply text for a turn whose AbortController fired. `timedOut` means our own
 * watchdog fired; otherwise the user stopped it (/stop, dashboard abort).
 * Any partial text the agent produced is kept, clearly labelled.
 */
export function formatAbortedReply(
  partialText: string | null | undefined,
  opts: { timedOut: boolean; timeoutMs: number },
): string {
  const partial = (partialText ?? '').trim();
  if (opts.timedOut) {
    const label = formatTimeoutLabel(opts.timeoutMs);
    return partial
      ? `⏱ Timed out after ${label} — partial result:\n${partial}`
      : `⏱ Timed out after ${label} — no result was produced.`;
  }
  return partial ? `Stopped — partial result:\n${partial}` : 'Stopped.';
}

// ── Scheduled-task STATUS line ────────────────────────────────────────

export type TaskReportedStatus = 'ok' | 'blocked' | 'failed';

export interface ParsedTaskStatus {
  status: TaskReportedStatus;
  reason: string;
}

// `STATUS: ok|blocked|failed` optionally followed by a separator (em/en dash,
// hyphen, colon) and a free-text reason. Markdown bold/backticks tolerated.
const STATUS_LINE_RE = /^[*_`\s]*STATUS[*_`\s]*:[*_`\s]*(ok|blocked|failed)\b[*_`]*\s*(?:[—–:-]+\s*)?(.*)$/i;

/**
 * Find the machine-readable status line a scheduled task was asked to emit.
 * Only the LAST non-empty line is considered, so a task that quotes the
 * instruction mid-output can't accidentally flip its own status. Returns null
 * when absent (caller keeps the pre-existing behavior).
 */
export function parseTaskStatus(output: string | null | undefined): ParsedTaskStatus | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const last = lines[lines.length - 1];
  if (!last) return null;
  const m = last.match(STATUS_LINE_RE);
  if (!m) return null;
  return {
    status: m[1].toLowerCase() as TaskReportedStatus,
    reason: m[2].replace(/[*_`]+$/g, '').trim(),
  };
}

export const SCHEDULED_STATUS_INSTRUCTION =
  '[Scheduler: end your final reply with exactly one line `STATUS: ok|blocked|failed — <short reason>`. ' +
  'Use blocked when you could not do the task because something outside your control stopped you ' +
  '(missing access, expired credential, unavailable service), failed when you tried and it went wrong, ok otherwise.]';

/** Wrap a scheduled task prompt with the STATUS-line instruction. */
export function wrapScheduledPrompt(prompt: string): string {
  return `${prompt}\n\n${SCHEDULED_STATUS_INSTRUCTION}`;
}

export type ScheduledLastStatus = 'success' | 'failed' | 'timeout' | 'blocked' | 'interrupted';

/**
 * Resolve the scheduled task's last_status from the reported STATUS line and
 * the acceptance check. An explicit blocked/failed always wins; an explicit ok
 * still loses to a failed acceptance check; no STATUS line keeps the old
 * acceptance-only behavior.
 */
export function resolveScheduledStatus(
  reported: ParsedTaskStatus | null,
  acceptancePassed: boolean,
): 'success' | 'failed' | 'blocked' {
  if (reported?.status === 'blocked') return 'blocked';
  if (reported?.status === 'failed') return 'failed';
  return acceptancePassed ? 'success' : 'failed';
}

/**
 * Alert once on a transition INTO blocked/failed; stay quiet while a task
 * remains in the same bad state run after run.
 */
export function shouldAlertStatusChange(
  previous: string | null | undefined,
  next: string,
): boolean {
  if (next !== 'blocked' && next !== 'failed') return false;
  return previous !== next;
}

/** Escape text for Telegram's HTML parse mode (the scheduler's sender uses it). */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
