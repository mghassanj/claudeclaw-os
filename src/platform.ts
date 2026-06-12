/**
 * Cross-platform shims for process management and paths.
 *
 * Windows does not support POSIX signals or pgrep. Instead of sprinkling
 * os.platform() checks everywhere, route through these helpers.
 */

import os from 'os';
import path from 'path';
import { execSync, spawn } from 'child_process';

export const IS_WINDOWS = os.platform() === 'win32';
export const IS_MACOS = os.platform() === 'darwin';
export const IS_LINUX = os.platform() === 'linux';

/**
 * Send a graceful termination signal to a process.
 * On POSIX: SIGTERM. On Windows: taskkill without /F (requests close).
 * Returns true if the kill command was issued without throwing.
 */
export function killProcess(pid: number, force = false): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (IS_WINDOWS) {
      const flag = force ? '/F' : '';
      execSync(`taskkill ${flag} /PID ${pid}`, { stdio: 'ignore', windowsHide: true });
      return true;
    }
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a process with the given PID is alive.
 * Uses signal 0 on POSIX. Uses tasklist on Windows.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    if (IS_WINDOWS) {
      const out = execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
        stdio: 'pipe',
        encoding: 'utf-8',
        windowsHide: true,
      });
      // tasklist prints "INFO: No tasks..." on stderr when missing, and an empty
      // result on stdout. A live process produces a CSV row containing the PID.
      return out.includes(`"${pid}"`);
    }
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find PIDs whose command line matches the given substring.
 * POSIX uses pgrep -f; Windows uses wmic.
 * Returns an empty array on any error.
 */
export async function findProcessesByPattern(pattern: string): Promise<number[]> {
  return new Promise((resolve) => {
    try {
      if (IS_WINDOWS) {
        // wmic was removed from Windows 11 22H2+ and every failed spawn cost
        // ~100ms before the fallback. PowerShell's Get-CimInstance ships in
        // every supported Windows version, so use it directly.
        try {
          const ps = execSync(
            `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${pattern.replace(/'/g, "''")}*' } | Select-Object -ExpandProperty ProcessId"`,
            { encoding: 'utf-8', stdio: 'pipe', windowsHide: true },
          );
          resolve(
            ps.split(/\r?\n/)
              .map((s) => parseInt(s.trim(), 10))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid),
          );
        } catch {
          resolve([]);
        }
      } else {
        const p = spawn('pgrep', ['-f', pattern]);
        let out = '';
        p.stdout.on('data', (chunk) => { out += chunk.toString(); });
        p.on('close', () => {
          resolve(
            out.trim().split(/\s+/)
              .map((s) => parseInt(s, 10))
              .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid),
          );
        });
        p.on('error', () => resolve([]));
      }
    } catch {
      resolve([]);
    }
  });
}

/**
 * Resolve the Python executable inside a local .venv directory.
 * POSIX: <venvDir>/bin/python. Windows: <venvDir>\Scripts\python.exe.
 */
export function getVenvPython(venvDir: string): string {
  return IS_WINDOWS
    ? path.join(venvDir, 'Scripts', 'python.exe')
    : path.join(venvDir, 'bin', 'python');
}

/**
 * Resolve the pip executable inside a local .venv directory.
 * POSIX: <venvDir>/bin/pip. Windows: <venvDir>\Scripts\pip.exe.
 */
export function getVenvPip(venvDir: string): string {
  return IS_WINDOWS
    ? path.join(venvDir, 'Scripts', 'pip.exe')
    : path.join(venvDir, 'bin', 'pip');
}

/**
 * A tmpdir that is actually writable on every platform. os.tmpdir() is
 * correct on Windows (%TEMP%), but callers that previously used "/tmp"
 * verbatim should switch to this.
 */
export function tmpDir(): string {
  return os.tmpdir();
}

/**
 * Service label convention used by activate/restart/deactivate across
 * all three platforms. Matching this exactly keeps the kill-switch
 * enumeration simple on every OS.
 */
export function agentServiceLabel(agentId: string): string {
  return `com.claudeclaw.${agentId}`;
}

/**
 * When a Windows-specific code path fails (schtasks, service registration,
 * native module build), we don't want the user staring at a raw error.
 * Return a block of copy-paste instructions pointing them at Claude Code
 * so they can patch the repo against their own machine.
 *
 * Pass the project root so the user doesn't have to figure out where to
 * cd. Pass what failed so the AI knows what to fix.
 */
export function claudeCodeHandoff(opts: {
  projectRoot: string;
  what: string;           // short description of what failed
  error?: string;         // the underlying error message if any
  file?: string;          // file the user's AI should look at first
}): string {
  const lines: string[] = [];
  lines.push('');
  lines.push("We couldn't finish this step on your machine. You can fix it");
  lines.push('in one shot by handing the repo to Claude Code:');
  lines.push('');
  lines.push('  1. Install Claude Code if you haven\'t: https://claude.ai/code');
  lines.push(`  2. Open a terminal in: ${opts.projectRoot}`);
  lines.push('  3. Run:  claude');
  lines.push('  4. Paste this prompt:');
  lines.push('');
  lines.push('  ─────────────────────────────────────────────');
  lines.push(`  I'm running ClaudeClaw on Windows. ${opts.what} failed.`);
  if (opts.error) {
    lines.push(`  The error was: ${opts.error}`);
  }
  if (opts.file) {
    lines.push(`  Start by reading ${opts.file} and adapt it to my machine.`);
  } else {
    lines.push('  Adapt the Windows paths in this repo to work on my machine.');
  }
  lines.push('  Verify by running the failing step again.');
  lines.push('  ─────────────────────────────────────────────');
  lines.push('');
  lines.push('Claude Code will read your setup, patch the relevant files,');
  lines.push('and re-run the step until it works.');
  return lines.join('\n');
}
