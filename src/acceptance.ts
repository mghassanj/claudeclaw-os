/**
 * Decide whether a finished task's output satisfies its acceptance check.
 *
 * An acceptance check is an opt-in, per-task string the agent's output must
 * contain (case-insensitive substring) for the run to count as a success.
 *
 * When a task has no acceptance check (the default, and every pre-existing
 * task), every run passes — this preserves the prior scheduler behaviour
 * exactly. When a check is set, a run whose output does not contain the
 * expected marker is NOT a success: a turn returning is not the same as the
 * task's goal being met.
 */
export function evaluateAcceptance(
  acceptanceCheck: string | null | undefined,
  output: string,
): boolean {
  const needle = acceptanceCheck?.trim();
  if (!needle) return true;
  return output.toLowerCase().includes(needle.toLowerCase());
}
