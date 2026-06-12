#!/usr/bin/env tsx
import crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { setMainProviderConfig, type ProviderConfig, type ProviderType } from '../src/provider.js';

import { getVenvPython, getVenvPip } from '../src/platform.js';

// ── ANSI helpers ────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
  blue: '\x1b[34m',
};

const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * When a Windows step can't finish, print a copy-paste Claude Code prompt
 * so the user can self-serve a fix without filing a GitHub issue or waiting.
 * Inline to avoid a build-time dep on src/platform.ts.
 */
function printWindowsHandoff(what: string, err?: string, file?: string): void {
  console.log();
  console.log(`  ${c.yellow}We couldn't finish this step on your machine. Open Claude Code here${c.reset}`);
  console.log(`  ${c.yellow}and let it patch the repo for you:${c.reset}`);
  console.log();
  console.log(`  ${c.bold}1.${c.reset} Install Claude Code: ${c.cyan}https://claude.ai/code${c.reset}`);
  console.log(`  ${c.bold}2.${c.reset} Open a terminal in: ${c.cyan}${PROJECT_ROOT}${c.reset}`);
  console.log(`  ${c.bold}3.${c.reset} Run: ${c.cyan}claude${c.reset}`);
  console.log(`  ${c.bold}4.${c.reset} Paste this prompt:`);
  console.log();
  console.log(`  ${c.gray}─────────────────────────────────────────────${c.reset}`);
  console.log(`  ${c.white}I'm running ClaudeClaw on Windows. ${what} failed.${c.reset}`);
  if (err) console.log(`  ${c.white}The error was: ${err}${c.reset}`);
  if (file) console.log(`  ${c.white}Start by reading ${file} and adapt it to my machine.${c.reset}`);
  else console.log(`  ${c.white}Adapt the Windows paths in this repo to work on my machine.${c.reset}`);
  console.log(`  ${c.white}Verify by running the failing step again.${c.reset}`);
  console.log(`  ${c.gray}─────────────────────────────────────────────${c.reset}`);
  console.log();
}

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') return path.join(os.homedir(), p.slice(1));
  return p;
}

// ── Banner ───────────────────────────────────────────────────────────────────
function loadBanner(): string {
  try {
    return fs.readFileSync(path.join(PROJECT_ROOT, 'banner.txt'), 'utf-8');
  } catch {
    return '\n  ClaudeClaw\n';
  }
}

// ── Shared readline ──────────────────────────────────────────────────────────
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

async function ask(question: string, defaultVal?: string): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultVal ? ` ${c.gray}(${defaultVal})${c.reset}` : '';
    rl.question(`  ${c.bold}${question}${c.reset}${hint} › `, (ans) => {
      resolve(ans.trim() || defaultVal || '');
    });
  });
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ans = await ask(`${question} [${hint}]`);
    if (!ans) return defaultYes;
    const lower = ans.toLowerCase();
    if (lower === 'y' || lower === 'yes') return true;
    if (lower === 'n' || lower === 'no') return false;
    console.log(`  ${c.gray}Please enter y or n.${c.reset}`);
  }
}

function section(title: string) {
  console.log();
  console.log(`  ${c.bold}${c.white}${title}${c.reset}`);
  console.log(`  ${c.gray}${'─'.repeat(title.length + 2)}${c.reset}`);
  console.log();
}

function info(msg: string) {
  console.log(`  ${c.gray}${msg}${c.reset}`);
}

function ok(msg: string) {
  console.log(`  ${c.green}✓${c.reset}  ${msg}`);
}

function warn(msg: string) {
  console.log(`  ${c.yellow}⚠${c.reset}  ${msg}`);
}

function fail(msg: string) {
  console.log(`  ${c.red}✗${c.reset}  ${msg}`);
}

function bullet(msg: string) {
  console.log(`  ${c.cyan}•${c.reset}  ${msg}`);
}

function spinner(label: string): { stop: (status: 'ok' | 'fail' | 'warn', msg?: string) => void } {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  const iv = setInterval(() => {
    process.stdout.write(`\r  ${c.cyan}${frames[i++ % frames.length]}${c.reset}  ${label}   `);
  }, 80);
  return {
    stop(status, msg) {
      clearInterval(iv);
      const icon = status === 'ok' ? `${c.green}✓${c.reset}` : status === 'warn' ? `${c.yellow}⚠${c.reset}` : `${c.red}✗${c.reset}`;
      process.stdout.write(`\r  ${icon}  ${msg ?? label}\n`);
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parseEnvFile(filePath: string): Record<string, string> {
  const result: Record<string, string> = {};
  let content: string;
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return result; }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }
  return result;
}

async function validateBotToken(token: string): Promise<{ valid: boolean; username?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result) return { valid: true, username: data.result.username };
    return { valid: false };
  } catch {
    return { valid: false };
  }
}

function commandExists(command: string): boolean {
  const check = PLATFORM === 'win32' ? ['where', command] : ['which', command];
  return spawnSync(check[0], [check[1]], { stdio: 'pipe' }).status === 0;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

function getOpenCodeCredentialCount(): number | null {
  const result = spawnSync('opencode', ['providers', 'list'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) return null;
  const output = stripAnsi(`${result.stdout}\n${result.stderr}`);
  const match = output.match(/(\d+)\s+credentials?/i);
  if (match) return parseInt(match[1], 10);
  return output.toLowerCase().includes('credentials') ? 0 : null;
}

function getOpenCodeModels(): string[] {
  const result = spawnSync('opencode', ['models'], { stdio: 'pipe', encoding: 'utf-8' });
  if (result.status !== 0) return [];
  return stripAnsi(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(line));
}

async function selectOpenCodeModel(): Promise<string | null> {
  const models = getOpenCodeModels();
  if (models.length === 0) {
    warn('Could not load OpenCode models. You can still enter a model id manually.');
    const manual = await ask('OpenCode default model (provider/model, or Enter to keep current)');
    return manual || null;
  }

  info('Available OpenCode models:');
  console.log();
  models.forEach((model, idx) => {
    console.log(`  ${c.cyan}${String(idx + 1).padStart(2, ' ')}.${c.reset} ${model}`);
  });
  console.log();
  info('Press Enter to keep OpenCode\'s current default model.');
  const answer = await ask('Select model number, or type a model id');
  if (!answer) return null;

  const numeric = parseInt(answer, 10);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= models.length) {
    return models[numeric - 1];
  }
  if (/^[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(answer)) return answer;

  warn(`Unknown model selection "${answer}". Keeping OpenCode's current default model.`);
  return null;
}

function updateOpenCodeDefaultModel(model: string): void {
  const configDir = path.join(os.homedir(), '.config', 'opencode');
  const configPath = path.join(configDir, 'opencode.jsonc');
  fs.mkdirSync(configDir, { recursive: true });

  let raw: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf-8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      raw = JSON.parse(content) as Record<string, unknown>;
    } catch {
      warn(`Could not parse ${configPath}; writing a clean config with the model setting.`);
    }
  }
  raw['model'] = model;
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf-8');
}

function ensureAgentsMdSymlink(dir: string): boolean {
  const claudeMd = path.join(dir, 'CLAUDE.md');
  const agentsMd = path.join(dir, 'AGENTS.md');
  if (!fs.existsSync(claudeMd) || fs.existsSync(agentsMd)) return false;

  try {
    fs.symlinkSync('CLAUDE.md', agentsMd);
    return true;
  } catch {
    return false;
  }
}

type SetupProviderType = Extract<ProviderType, 'claude' | 'opencode' | 'gemini' | 'codex' | 'acp'>;

async function configureProvider(): Promise<SetupProviderType> {
  // Setup configures Claude. See the DISCLAIMER in README.md for ENABLE_ACP
  // and non-Claude provider details. The original multi-provider picker is
  // preserved in the commented block below — to re-enable it, remove the
  // early-return and uncomment the original implementation.
  section('Provider');
  info('Setup configures Claude as the agent provider.');
  info('See the DISCLAIMER in README.md for ENABLE_ACP and non-Claude providers.');
  setMainProviderConfig({ type: 'claude', model: 'claude-opus-4-6' });
  ok('Provider set to Claude');
  return 'claude';

  /* ── ORIGINAL MULTI-PROVIDER PICKER (re-enable by removing the early
   *    return above and uncommenting this block) ───────────────────────
  section('Provider');
  info('Choose the agent backend ClaudeClaw should use for the main bot.');
  info('Claude is the default. Non-Claude providers are BETA and gated by ENABLE_ACP=true');
  info('in .env — picking one below opts you in.');
  console.log();

  bullet('1. Claude (default, stable)');
  bullet('2. OpenCode (beta)');
  bullet('3. Gemini CLI (beta)');
  bullet('4. Codex ACP adapter (beta)');
  bullet('5. Custom ACP command (beta)');
  console.log();

  const answer = (await ask('Select provider', '1')).toLowerCase();
  let choice: SetupProviderType;
  if (answer === '1' || answer === 'claude' || answer === 'c') {
    choice = 'claude';
  } else if (answer === '2' || answer === 'opencode' || answer === 'o') {
    choice = 'opencode';
  } else if (answer === '3' || answer === 'gemini' || answer === 'g') {
    choice = 'gemini';
  } else if (answer === '4' || answer === 'codex') {
    choice = 'codex';
  } else if (answer === '5' || answer === 'acp' || answer === 'custom') {
    choice = 'acp';
  } else {
    warn(`Unknown provider "${answer}". Using Claude.`);
    choice = 'claude';
  }

  if (choice === 'claude') {
    setMainProviderConfig({ type: 'claude', model: 'claude-opus-4-6' });
    ok('Provider set to Claude');
    return 'claude';
  }

  if (choice === 'gemini') {
    if (!commandExists('gemini')) {
      fail('Gemini CLI not found');
      info('Install and authenticate Gemini CLI first, then re-run setup.');
      process.exit(1);
    }
    ok('Gemini CLI found');
    info('Gemini auth and model selection are managed by the Gemini CLI.');
    setMainProviderConfig({ type: 'gemini' });
    ok('Provider set to Gemini CLI');
    return 'gemini';
  }

  if (choice === 'codex') {
    if (!commandExists('codex-acp')) {
      fail('codex-acp adapter not found');
      info('Install and authenticate the Codex ACP adapter first, then re-run setup.');
      process.exit(1);
    }
    ok('codex-acp adapter found');
    info('Codex auth and model selection are managed by the adapter/Codex config.');
    setMainProviderConfig({ type: 'codex' });
    ok('Provider set to Codex ACP adapter');
    return 'codex';
  }

  if (choice === 'acp') {
    const command = await ask('ACP command');
    if (!command) {
      fail('Custom ACP provider requires a command');
      process.exit(1);
    }
    const argsRaw = await ask('ACP arguments', '--acp');
    const provider: ProviderConfig = { type: 'acp', command, args: splitArgs(argsRaw) };
    if (!commandExists(command)) warn(`Command "${command}" was not found on PATH right now.`);
    setMainProviderConfig(provider);
    ok('Provider set to custom ACP');
    return 'acp';
  }

  if (!commandExists('opencode')) {
    fail('OpenCode CLI not found');
    info('Install OpenCode first, then re-run setup. See: https://opencode.ai');
    process.exit(1);
  }
  ok('OpenCode CLI found');

  const credentialCount = getOpenCodeCredentialCount();
  if (credentialCount && credentialCount > 0) {
    ok(`OpenCode auth found (${credentialCount} credential${credentialCount === 1 ? '' : 's'})`);
    info('OpenCode lists model provider credentials here, not an "OpenCode" account.');
  } else if (await confirm('Run OpenCode auth login now?', true)) {
    const result = spawnSync('opencode', ['auth', 'login'], { stdio: 'inherit' });
    if (result.status === 0) ok('OpenCode auth flow completed');
    else warn('OpenCode auth did not complete. You can run: opencode auth login');
  } else {
    info('Run this before starting the bot: opencode auth login');
  }

  if (await confirm('Choose an OpenCode model now?', false)) {
    const model = await selectOpenCodeModel();
    if (model) {
      updateOpenCodeDefaultModel(model);
      ok(`OpenCode default model set to ${model}`);
    } else {
      ok('Keeping OpenCode current default model');
    }
  } else {
    ok('Keeping OpenCode current default model');
  }

  setMainProviderConfig({ type: 'opencode' });
  ok('Provider set to OpenCode');
  return 'opencode';
  */
}

function splitArgs(input: string): string[] {
  const matches = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  return matches.map((part) => part.replace(/^["']|["']$/g, ''));
}

const PLATFORM = process.platform;

function isWSL(): boolean {
  if (PLATFORM !== 'linux') return false;
  try {
    const rel = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf-8');
    return /microsoft/i.test(rel);
  } catch { return false; }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {

  // ── 1. Banner + intro ────────────────────────────────────────────────────
  console.log(`${c.cyan}${c.bold}${loadBanner()}${c.reset}`);
  console.log(`  ${c.bold}Welcome to ClaudeClaw.${c.reset}`);
  console.log();
  info('This wizard will get you set up in about 5 minutes.');
  info('Press Ctrl+C at any time to exit. You can re-run this at any time with: npm run setup');
  console.log();

  // ── 2. What is ClaudeClaw ────────────────────────────────────────────────
  section('What is ClaudeClaw?');

  console.log(`  ClaudeClaw bridges ${c.bold}Claude Code${c.reset} to Telegram.`);
  console.log(`  You message your bot from your phone. ClaudeClaw runs Claude`);
  console.log(`  on your computer — with your skills, tools, and context —`);
  console.log(`  and sends the result back to you.`);
  console.log();
  console.log(`  ${c.bold}It is not a chatbot wrapper.${c.reset} It runs a real local provider.`);
  console.log(`  Everything you can do in your terminal, you can do from your phone.`);
  console.log();
  console.log(`  ${c.gray}See the DISCLAIMER in README.md for non-Claude (ACP) providers.${c.reset}`);
  console.log();

  bullet('Text, voice, photos, documents, and videos');
  bullet('All your installed Claude Code skills auto-load');
  bullet('Persistent memory across messages');
  bullet('Scheduled autonomous tasks (cron)');
  bullet('Optional WhatsApp bridge');
  console.log();

  console.log(`  ${c.bold}FAQ${c.reset}`);
  console.log();
  console.log(`  ${c.cyan}Q:${c.reset} Does this cost anything?`);
  info('ClaudeClaw itself is free. Authenticate Claude on this machine via');
  info('claude login (any plan), or set ANTHROPIC_API_KEY for pay-per-token.');
  info('Optional features (voice, video) have their own free tiers.');
  console.log();
  console.log(`  ${c.cyan}Q:${c.reset} Does my computer need to stay on?`);
  info('Yes. ClaudeClaw runs on your machine. When your computer sleeps or shuts');
  info('down, the bot goes offline. Messages queue in Telegram and arrive when');
  info('you restart.');
  console.log();
  console.log(`  ${c.cyan}Q:${c.reset} Is it safe? Can someone else use my bot?`);
  info('Your bot is locked to your Telegram chat ID. No one else can use it.');
  info('Optional PIN lock adds a second layer. An emergency kill phrase lets you');
  info('shut everything down instantly from your phone.');
  console.log();
  console.log(`  ${c.cyan}Q:${c.reset} Can I run this on a server / VPS?`);
  info('Yes. Authenticate Claude on the server first via claude login,');
  info('or set ANTHROPIC_API_KEY for pay-per-token. See the README cloud');
  info('deployment section for long-lived OAuth tokens.');
  console.log();

  const understood = await confirm('Ready to continue?');
  if (!understood) {
    console.log();
    info('Come back when you\'re ready. Run npm run setup to start again.');
    return;
  }

  // ── 3. System checks ─────────────────────────────────────────────────────
  section('System checks');

  // Windows is fully supported. Offer WSL as a neutral alternative, default Yes to continue native.
  if (PLATFORM === 'win32') {
    ok('Windows detected. Native Windows is fully supported (Task Scheduler for auto-start).');
    info('WSL2 is also available if you prefer a POSIX environment.');
    console.log();
    const continueNative = await confirm('Continue with native Windows?', true);
    if (!continueNative) {
      console.log();
      info('To set up under WSL2:');
      info('  1. Open PowerShell as Administrator');
      console.log(`  ${c.cyan}  wsl --install -d Ubuntu${c.reset}`);
      info('  2. Reboot, then open the Ubuntu terminal');
      info('  3. Clone ClaudeClaw inside the Ubuntu filesystem (not /mnt/c)');
      info('  4. Run "npm run setup" from the new clone');
      process.exit(0);
    }
  }
  if (isWSL()) {
    ok('WSL2 detected. Treating as Linux; systemd services will be used for auto-start.');
    console.log();
  }

  // Node
  const nodeMajor = parseInt(process.version.slice(1).split('.')[0], 10);
  if (nodeMajor >= 20) {
    ok(`Node.js ${process.version}`);
  } else {
    fail(`Node.js ${process.version} — version 20+ required`);
    info('Download: https://nodejs.org');
    process.exit(1);
  }

  const selectedProvider = await configureProvider();

  // Claude CLI
  if (selectedProvider === 'claude') {
    const claudeCmd = PLATFORM === 'win32' ? 'where claude' : 'which claude';
    try {
      execSync(claudeCmd, { stdio: 'pipe' });
      let version = '';
      try { version = execSync('claude --version', { stdio: 'pipe' }).toString().trim(); } catch { }
      ok(`Claude CLI ${version}`);
    } catch {
      fail('Claude CLI not found');
      console.log();
      info('Install it:');
      info('  npm install -g @anthropic-ai/claude-code');
      info('  claude login');
      console.log();
      const proceed = await confirm('Install Claude Code now and re-run setup later?', false);
      if (proceed) {
        console.log();
        info('Running: npm install -g @anthropic-ai/claude-code');
        const result = spawnSync('npm', ['install', '-g', '@anthropic-ai/claude-code'], { stdio: 'inherit', shell: PLATFORM === 'win32' });
        if (result.status === 0) {
          ok('Claude Code installed. Run claude login, then npm run setup again.');
        } else {
          fail('Install failed. Run manually: npm install -g @anthropic-ai/claude-code');
        }
      }
      process.exit(1);
    }

    // Claude auth — check if user has logged in via OAuth or API key
    const claudeDir = path.join(os.homedir(), '.claude');
    const hasClaudeDir = fs.existsSync(claudeDir);
    if (hasClaudeDir && fs.readdirSync(claudeDir).length > 1) {
      ok('Claude auth — logged in');
    } else {
      warn('Not logged in. Run: claude login');
      info('The bot needs Claude Code auth to work. Log in before starting.');
    }
  }

  // Git config (user.name and user.email)
  let gitName = '';
  let gitEmail = '';
  try { gitName = execSync('git config user.name', { stdio: 'pipe' }).toString().trim(); } catch { }
  try { gitEmail = execSync('git config user.email', { stdio: 'pipe' }).toString().trim(); } catch { }
  if (gitName && gitEmail) {
    ok(`Git identity: ${gitName} <${gitEmail}>`);
  } else {
    warn('Git identity not configured — this will cause errors later');
    console.log();
    info('Run these two commands (use your own name and email):');
    console.log(`  ${c.cyan}git config --global user.name "Your Name"${c.reset}`);
    console.log(`  ${c.cyan}git config --global user.email "you@email.com"${c.reset}`);
    console.log();
    const fixNow = await confirm('Set them now?', true);
    if (fixNow) {
      const name = await ask('Your name');
      const email = await ask('Your email');
      if (name) { try { spawnSync('git', ['config', '--global', 'user.name', name], { stdio: 'pipe' }); } catch { } }
      if (email) { try { spawnSync('git', ['config', '--global', 'user.email', email], { stdio: 'pipe' }); } catch { } }
      if (name && email) ok(`Git identity set: ${name} <${email}>`);
    }
  }

  // Build check
  const distExists = fs.existsSync(path.join(PROJECT_ROOT, 'dist', 'index.js'));
  if (distExists) {
    ok('Build output found (dist/)');
  } else {
    warn('Not built yet — building now...');
    const build = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: PLATFORM === 'win32' });
    if (build.status === 0) {
      ok('Build complete');
    } else {
      fail('Build failed. Fix TypeScript errors, then re-run setup.');
      process.exit(1);
    }
  }

  // ── 4. What do you want to enable? ──────────────────────────────────────
  section('Choose your features');

  info('ClaudeClaw OS has several optional features. Tell us what you want.');
  info('You can always add more later by editing .env and restarting.');
  console.log();

  const wantVoiceIn = await confirm('Voice input? (send voice messages instead of typing, free)', true);
  const wantVoiceOut = wantVoiceIn
    ? await confirm('Voice output? (the bot talks back to you in a custom voice, requires setup)', false)
    : false;
  const wantVideo = await confirm('Video analysis? (send video clips and ask questions about them)', false);
  const wantWarRoom = await confirm('War Room? (live voice boardroom with your agent team, experimental)', false);
  const wantWhatsApp = await confirm('WhatsApp bridge? (view and reply to WhatsApp from Telegram, highly experimental)', false);

  // WhatsApp explanation if they said yes
  if (wantWhatsApp) {
    console.log();
    console.log(`  ${c.bold}How the WhatsApp bridge works:${c.reset}`);
    console.log();
    info('ClaudeClaw uses whatsapp-web.js to connect to your existing WhatsApp');
    info('account via the Linked Devices feature (same as WhatsApp Web).');
    console.log();
    info('A separate process (wa-daemon) runs in the background:');
    bullet('Keeps a Puppeteer browser session alive');
    bullet('Stores incoming messages to SQLite');
    bullet('Exposes an HTTP API on port 4242');
    console.log();
    info('First run: a QR code prints to your terminal. Scan it from');
    info('WhatsApp → Settings → Linked Devices. Session saves after that.');
    console.log();
    info('No API key needed — it uses your existing WhatsApp account.');
    console.log();

    console.log(`  ${c.bold}Message security:${c.reset}`);
    console.log();
    bullet('All message bodies are encrypted at rest (AES-256-GCM)');
    bullet('Messages auto-delete after 3 days');
    bullet('The database and session files are gitignored and never committed');
    bullet('Encryption key is stored in your .env (auto-generated if not set)');
    console.log();

    warn('Note: WhatsApp may occasionally disconnect and require a re-scan.');
    console.log();
  }

  // War Room explanation and Python venv setup
  let warRoomReady = false;
  if (wantWarRoom) {
    console.log();
    console.log(`  ${c.bold}How the War Room works:${c.reset}`);
    console.log();
    info('The War Room is a live voice boardroom in your browser. You speak,');
    info('Gemini Live processes your voice in real time, and your agents respond');
    info('with their own distinct voices. You can talk to one agent at a time');
    info('(Direct mode) or let Gemini route your questions to the best agent');
    info('automatically (Auto mode).');
    console.log();
    info('It requires Python 3.10-3.13 and a Google API key (free tier works).');
    console.log();

    // Detect uv (fast Python package manager). If available, prefer it for venv + pip.
    let hasUv = false;
    try {
      const uvCheck = spawnSync('uv', ['--version'], { stdio: 'pipe' });
      if (uvCheck.status === 0) {
        hasUv = true;
        ok(`uv detected (${uvCheck.stdout?.toString().trim()}). Will use it for faster setup.`);
      }
    } catch { /* not installed */ }

    // Find a compatible Python (3.10-3.13). onnxruntime doesn't ship wheels for 3.14+.
    const PYTHON_MAX_MINOR = 13;
    const PYTHON_MIN_MINOR = 10;

    function findCompatiblePython(): { bin: string; version: string } | null {
      // Try specific versioned binaries first (most reliable), then generic fallbacks.
      // Windows uses "python" and the "py" launcher; POSIX uses "python3.x" / "python3".
      const candidates = PLATFORM === 'win32'
        ? ['py -3.13', 'py -3.12', 'py -3.11', 'py -3.10', 'python']
        : ['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'];
      for (const bin of candidates) {
        // "py -3.13" is a single command with args — split and invoke directly (no shell needed)
        const parts = bin.split(' ');
        const check = spawnSync(parts[0], [...parts.slice(1), '--version'], {
          stdio: 'pipe',
        });
        if (check.status !== 0) continue;
        const ver = (check.stdout?.toString().trim() || check.stderr?.toString().trim() || '');
        const match = ver.match(/Python\s+3\.(\d+)/);
        if (!match) continue;
        const minor = parseInt(match[1], 10);
        if (minor >= PYTHON_MIN_MINOR && minor <= PYTHON_MAX_MINOR) {
          return { bin, version: ver };
        }
      }
      return null;
    }

    const pyResult = findCompatiblePython();
    if (pyResult) {
      ok(`${pyResult.version} (${pyResult.bin})`);

      // Check if venv already exists and deps are installed
      const venvDir = path.join(PROJECT_ROOT, 'warroom', '.venv');
      const venvPython = getVenvPython(venvDir);
      const depsInstalled = (): boolean => {
        if (!fs.existsSync(venvPython)) return false;
        const check = spawnSync(venvPython, ['-c', 'import pipecat'], { stdio: 'pipe', timeout: 10000 });
        return check.status === 0;
      };

      if (depsInstalled()) {
        ok('War Room Python venv already set up.');
        warRoomReady = true;
      } else {
        const needsVenv = !fs.existsSync(venvPython);
        const setupVenv = await confirm('Set up the War Room Python environment now? (takes ~60 seconds)', true);
        if (setupVenv) {
          let venvOk = !needsVenv;
          if (needsVenv) {
            // spawnSync blocks the event loop, so use a static message instead of a spinner
            let venvResult: ReturnType<typeof spawnSync>;
            if (hasUv) {
              info('Creating Python virtual environment with uv...');
              venvResult = spawnSync('uv', ['venv', '--python', pyResult.bin, venvDir], { stdio: 'pipe' });
            } else {
              info('Creating Python virtual environment...');
              venvResult = spawnSync(pyResult.bin, ['-m', 'venv', venvDir], { stdio: 'pipe' });
            }
            if (venvResult.status === 0) {
              ok('Virtual environment created');
              venvOk = true;
            } else {
              warn('Could not create venv. You can set it up manually later:');
              if (hasUv) {
                info(`  uv venv --python ${pyResult.bin} warroom/.venv`);
              } else {
                info(`  ${pyResult.bin} -m venv warroom/.venv`);
              }
              if (PLATFORM === 'win32') {
                info('  In PowerShell:     .\\warroom\\.venv\\Scripts\\Activate.ps1');
                info('  In Command Prompt: warroom\\.venv\\Scripts\\activate.bat');
              } else {
                info('  source warroom/.venv/bin/activate');
              }
              info('  pip install -r warroom/requirements.txt');
            }
          }
          if (venvOk) {
            // Use stdio: 'inherit' so the user sees pip/uv output in real time.
            // spawnSync blocks the event loop, so a spinner would never animate.
            console.log();
            const reqsFile = path.join(PROJECT_ROOT, 'warroom', 'requirements.txt');
            let pipResult: ReturnType<typeof spawnSync>;
            if (hasUv) {
              info('Installing War Room dependencies with uv...');
              console.log();
              pipResult = spawnSync(
                'uv', ['pip', 'install', '--python', venvPython, '-r', reqsFile],
                { stdio: 'inherit', timeout: 300000 },
              );
            } else {
              info('Installing War Room dependencies (this may take ~60 seconds)...');
              console.log();
              pipResult = spawnSync(
                getVenvPip(venvDir),
                ['install', '-r', reqsFile],
                { stdio: 'inherit', timeout: 300000 },
              );
            }
            if (pipResult.status === 0) {
              ok('War Room dependencies installed');
              warRoomReady = true;
            } else {
              warn('pip install failed. War Room will be disabled until deps are installed.');
              console.log();
              info('To fix, run these commands and then re-run npm run setup:');
              console.log();
              console.log(`  ${c.cyan}cd ${PROJECT_ROOT}${c.reset}`);
              if (hasUv) {
                console.log(`  ${c.cyan}uv pip install --python ${venvPython} -r warroom/requirements.txt${c.reset}`);
              } else {
                if (PLATFORM === 'win32') {
                  console.log(`  ${c.cyan}# In PowerShell:${c.reset}`);
                  console.log(`  ${c.cyan}.\\warroom\\.venv\\Scripts\\Activate.ps1${c.reset}`);
                  console.log(`  ${c.cyan}# Or in Command Prompt:${c.reset}`);
                  console.log(`  ${c.cyan}warroom\\.venv\\Scripts\\activate.bat${c.reset}`);
                } else {
                  console.log(`  ${c.cyan}source warroom/.venv/bin/activate${c.reset}`);
                }
                console.log(`  ${c.cyan}pip install -r warroom/requirements.txt${c.reset}`);
              }
            }
          }
        }
      }
    } else {
      // Check if they have Python but it's too new
      const fallbackBin = PLATFORM === 'win32' ? 'python' : 'python3';
      const anyPy = spawnSync(fallbackBin, ['--version'], { stdio: 'pipe' });
      if (anyPy.status === 0) {
        const ver = anyPy.stdout?.toString().trim() || anyPy.stderr?.toString().trim() || '';
        warn(`${ver} found, but War Room requires Python 3.10-3.13.`);
        info('onnxruntime (used for voice activity detection) doesn\'t support 3.14+ yet.');
        info('Install a compatible version:');
      } else {
        warn('Python 3 not found. You need Python 3.10-3.13 for the War Room.');
        info('Install Python:');
      }
      // Show install instructions — uv first if available, then platform-specific
      if (hasUv) {
        bullet('uv python install 3.13');
        info('(uv will download and manage the Python version for you)');
      } else if (PLATFORM === 'win32') {
        bullet('Windows: Download from https://www.python.org/downloads/');
        bullet('  or: winget install Python.Python.3.13');
        bullet('  Make sure "Add python.exe to PATH" is checked during install.');
      } else if (PLATFORM === 'darwin') {
        bullet('Mac: brew install python@3.13');
      } else {
        bullet('Linux: sudo apt install python3.13 python3.13-venv');
      }
      info('Then re-run npm run setup to enable the War Room.');
    }

    if (!warRoomReady) {
      console.log();
      warn('War Room will be disabled in .env. Re-run npm run setup after fixing the Python environment.');
    }
    console.log();
  }

  // Ecosystem section removed — users can find alternatives in README "Other Channels".

  // ── 6. Config directory (CLAUDECLAW_CONFIG) ──────────────────────────────
  section('Config directory (CLAUDECLAW_CONFIG)');

  info('Personal config files (CLAUDE.md, agent configs) live outside the repo');
  info('so they are never accidentally committed. Defaults to ~/.claudeclaw');
  console.log();

  const envForConfig = parseEnvFile(path.join(PROJECT_ROOT, '.env'));
  const defaultConfigDir = expandHome(
    envForConfig.CLAUDECLAW_CONFIG || '~/.claudeclaw',
  );
  info(`Current path: ${defaultConfigDir}`);
  console.log();

  let claudeclawConfigDir = defaultConfigDir;
  const configInput = await ask('Config directory (Enter to keep default)', defaultConfigDir);
  const trimmedConfig = configInput.trim();
  if (trimmedConfig && trimmedConfig !== defaultConfigDir) {
    // Guard against accidental single-letter paths (e.g. typing "y" to confirm)
    // Accept Unix paths (/..., ~/..., ./...) and Windows drive paths (C:\...)
    const looksLikePath = trimmedConfig.startsWith('/') || trimmedConfig.startsWith('~') || trimmedConfig.startsWith('.') || /^[A-Za-z]:[\\/]/.test(trimmedConfig);
    if (trimmedConfig.length < 3 || !looksLikePath) {
      warn(`"${trimmedConfig}" doesn't look like a directory path. Using default: ${defaultConfigDir}`);
    } else {
      claudeclawConfigDir = expandHome(trimmedConfig);
    }
  }

  // If the chosen directory already exists, just confirm
  if (fs.existsSync(claudeclawConfigDir)) {
    const hasClaudeMd = fs.existsSync(path.join(claudeclawConfigDir, 'CLAUDE.md'));
    ok(`Using ${claudeclawConfigDir}${hasClaudeMd ? ' (CLAUDE.md found)' : ''}`);
  }

  // Create the directory if needed
  if (!fs.existsSync(claudeclawConfigDir)) {
    fs.mkdirSync(claudeclawConfigDir, { recursive: true });
    ok(`Created ${claudeclawConfigDir}`);
  }

  if (ensureAgentsMdSymlink(claudeclawConfigDir)) {
    ok(`Created AGENTS.md symlink → ${path.join(claudeclawConfigDir, 'AGENTS.md')}`);
  }

  // ── 6b. Main agent identity (agent.yaml) ───────────────────────────────
  const mainAgentDir = path.join(claudeclawConfigDir, 'agents', 'main');
  const mainYamlDest = path.join(mainAgentDir, 'agent.yaml');
  if (fs.existsSync(mainYamlDest)) {
    ok(`agent.yaml exists at ${mainYamlDest}`);
  } else {
    fs.mkdirSync(mainAgentDir, { recursive: true });
    console.log();
    info('Your main bot can have a display name shown on the dashboard and in chats.');
    const mainName = await ask('Name for your main agent (Enter for "Main")') || 'Main';
    const mainDesc = await ask('Short description (Enter to skip)') || '';

    const yamlLines = [
      '# Main agent configuration',
      `name: ${mainName}`,
    ];
    if (mainDesc) {
      yamlLines.push(`description: ${mainDesc}`);
    }
    yamlLines.push('');
    yamlLines.push('# The main agent uses TELEGRAM_BOT_TOKEN from .env (no override needed).');
    yamlLines.push('# telegram_bot_token_env: TELEGRAM_BOT_TOKEN');
    yamlLines.push('');
    yamlLines.push("# NOTE: the main bot's model/provider are NOT read from this file.");
    yamlLines.push('# Configure them in the dashboard (persisted to store/main-config.json),');
    yamlLines.push('# or per-chat with /model in Telegram. (Sub-agents DO take model from agent.yaml.)');
    yamlLines.push('');
    yamlLines.push('# Obsidian integration (optional).');
    yamlLines.push('# obsidian:');
    yamlLines.push('#   vault: /path/to/your/obsidian/vault');
    yamlLines.push('#   folders:');
    yamlLines.push('#     - FolderA/');
    yamlLines.push('');

    fs.writeFileSync(mainYamlDest, yamlLines.join('\n'), 'utf-8');
    ok(`Created agent.yaml for main agent → ${mainYamlDest}`);
    if (mainName !== 'Main') {
      info(`Dashboard and chats will show "${mainName}" instead of "Main".`);
    }
  }

  // ── 6c. CLAUDE.md personalization ──────────────────────────────────────
  section('Personalize your assistant (CLAUDE.md)');

  info('CLAUDE.md is the personality and context file loaded into every session.');
  info('It defines who your assistant is, what you do, and how it communicates.');
  console.log();

  // CLAUDE.md lives in the agent subfolder (same pattern as sub-agents).
  // For backward compatibility, check the root-level location too.
  const agentClaudeMdDest = path.join(mainAgentDir, 'CLAUDE.md');
  const legacyClaudeMdDest = path.join(claudeclawConfigDir, 'CLAUDE.md');
  let claudeMdDest: string;

  if (fs.existsSync(agentClaudeMdDest)) {
    claudeMdDest = agentClaudeMdDest;
    ok(`CLAUDE.md exists at ${claudeMdDest}`);
  } else if (fs.existsSync(legacyClaudeMdDest)) {
    // Existing install with root-level CLAUDE.md — leave it in place.
    // index.ts resolveAgentClaudeMd checks agent subfolder first, then falls back.
    claudeMdDest = legacyClaudeMdDest;
    ok(`CLAUDE.md exists at ${claudeMdDest} (legacy location)`);
  } else {
    // Fresh install — create in the agent subfolder
    claudeMdDest = agentClaudeMdDest;
    const exampleSrc = path.join(PROJECT_ROOT, 'CLAUDE.md.example');
    if (fs.existsSync(exampleSrc)) {
      fs.copyFileSync(exampleSrc, claudeMdDest);
      ok(`Created CLAUDE.md from template → ${claudeMdDest}`);
    } else {
      warn(`No CLAUDE.md.example found — create ${claudeMdDest} manually`);
    }
  }

  // Read the agent name from the yaml we just created (or an existing one)
  let assistantName = 'Main';
  try {
    const yamlText = fs.readFileSync(path.join(mainAgentDir, 'agent.yaml'), 'utf-8');
    const nameMatch = yamlText.match(/^name:\s*(.+)$/m);
    if (nameMatch) assistantName = nameMatch[1].trim();
  } catch { /* use default */ }

  const ownerName = await ask('Your name (so the bot knows who it\'s talking to)') || '';

  // Replace placeholders in CLAUDE.md if we have values
  if (fs.existsSync(claudeMdDest)) {
    let claudeContent = fs.readFileSync(claudeMdDest, 'utf-8');
    let replaced = false;
    if (assistantName && assistantName !== 'Main' && claudeContent.includes('[YOUR ASSISTANT NAME]')) {
      claudeContent = claudeContent.replace(/\[YOUR ASSISTANT NAME\]/g, assistantName);
      replaced = true;
    }
    if (ownerName && claudeContent.includes('[YOUR NAME]')) {
      claudeContent = claudeContent.replace(/\[YOUR NAME\]/g, ownerName);
      replaced = true;
    }
    if (replaced) {
      fs.writeFileSync(claudeMdDest, claudeContent, 'utf-8');
      ok('Updated CLAUDE.md with your names');
    }
  }

  console.log();
  info('You can further personalize CLAUDE.md at any time. Useful things to add:');
  bullet('Your projects and work context');
  bullet('Communication preferences');
  bullet('Obsidian vault path (if you use one)');
  console.log();
  console.log(`  ${c.bold}Your CLAUDE.md is here:${c.reset}`);
  console.log();
  console.log(`  ${c.cyan}${claudeMdDest}${c.reset}`);
  console.log();
  info('Edit it in any text editor, or just ask the bot via Telegram to');
  info('update it for you. It has full access to the file.');

  // ── 7. Skills to install ─────────────────────────────────────────────────
  section('Skills you might want');

  info('ClaudeClaw auto-loads every skill in ~/.claude/skills/.');
  info('Here are the most useful ones to install:');
  console.log();

  console.log(`  ${c.bold}Core skills (for everyone):${c.reset}`);
  bullet('gmail           — read, triage, reply to email');
  bullet('google-calendar — schedule meetings, check availability');
  bullet('todo            — read tasks from Obsidian or text files');
  bullet('agent-browser   — browse the web, fill forms, scrape data');
  bullet('maestro         — run tasks in parallel with sub-agents');
  console.log();

  if (wantVideo) {
    console.log(`  ${c.bold}Gemini skill (required for video analysis):${c.reset}`);
    console.log();
    info('ClaudeClaw\'s video analysis uses the gemini-api-dev skill from Google.');
    info('It handles text, images, audio, video, function calling, and structured output.');
    info('Install it from: https://github.com/google-gemini/gemini-skills');
    console.log();
    bullet('Skill docs:  github.com/google-gemini/gemini-skills/blob/main/skills/gemini-api-dev/SKILL.md');
    bullet('Requires:    GOOGLE_API_KEY in .env (get free at aistudio.google.com)');
    bullet('Install:     Copy the skill folder into ~/.claude/skills/gemini-api-dev/');
    console.log();
  }

  info('Full skills catalog: https://github.com/anthropics/claude-code/tree/main/skills');
  console.log();

  // ── 8. API keys ───────────────────────────────────────────────────────────
  section('Telegram');

  const envPath = path.join(PROJECT_ROOT, '.env');
  const env: Record<string, string> = fs.existsSync(envPath) ? parseEnvFile(envPath) : {};

  // Persist CLAUDECLAW_CONFIG determined in section 6
  env.CLAUDECLAW_CONFIG = claudeclawConfigDir;

  let botUsername = '';
  if (env.TELEGRAM_BOT_TOKEN) {
    const s = spinner('Validating existing bot token...');
    const r = await validateBotToken(env.TELEGRAM_BOT_TOKEN);
    if (r.valid) {
      botUsername = r.username || '';
      s.stop('ok', `Bot: @${botUsername}`);
    } else {
      s.stop('fail', 'Existing token invalid — enter a new one');
      delete env.TELEGRAM_BOT_TOKEN;
    }
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    console.log();
    info('You need a Telegram bot token. Get one from @BotFather:');
    bullet('Open Telegram → search @BotFather');
    bullet('Send /newbot');
    bullet('Follow the prompts, copy the token it gives you');
    console.log();

    let valid = false;
    while (!valid) {
      const token = await ask('Paste your bot token');
      if (!token) { console.log(`  ${c.red}Required.${c.reset}`); continue; }
      const s = spinner('Validating...');
      const r = await validateBotToken(token);
      if (r.valid) {
        env.TELEGRAM_BOT_TOKEN = token;
        botUsername = r.username || '';
        s.stop('ok', `Bot: @${botUsername}`);
        valid = true;
      } else {
        s.stop('fail', 'Invalid token. Try again.');
      }
    }
  }

  console.log();
  if (env.ALLOWED_CHAT_ID) {
    ok(`Chat ID: ${env.ALLOWED_CHAT_ID}`);
  } else {
    info('Your chat ID locks the bot so only YOU can talk to it.');
    info('We\'ll detect it automatically. Just message your bot on Telegram:');
    console.log();
    bullet('Open Telegram on your phone or desktop');
    bullet(`Search for your bot: @${botUsername || 'your_bot_username'}`);
    bullet('Tap Start or send any message to it');
    console.log();

    const wantAuto = await confirm('Ready? Send a message to your bot, then press Y');

    if (wantAuto) {
      const s = spinner('Waiting for your message...');
      let detected = '';
      for (let attempt = 0; attempt < 30; attempt++) {
        await sleep(2000);
        try {
          const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getUpdates?limit=5&timeout=0`);
          const data = (await res.json()) as { ok: boolean; result?: Array<{ message?: { chat?: { id?: number } } }> };
          if (data.ok && data.result?.length) {
            const chatId = data.result[data.result.length - 1]?.message?.chat?.id;
            if (chatId) {
              detected = String(chatId);
              break;
            }
          }
        } catch { /* retry */ }
      }

      if (detected) {
        s.stop('ok', `Detected chat ID: ${detected}`);
        env.ALLOWED_CHAT_ID = detected;
      } else {
        s.stop('warn', 'No message detected. You can add ALLOWED_CHAT_ID to .env later.');
        info('The bot will show your chat ID the first time you message it.');
      }
    } else {
      info('No problem. The bot will show your chat ID the first time you');
      info('message it. Add it to .env and restart.');
    }
  }

  // ── 9. Security ──────────────────────────────────────────────────────────
  section('Secure your bot');

  info('ClaudeClaw has full access to your machine. If someone gets into');
  info('your Telegram account, they control the bot. These layers protect you.');
  console.log();

  // Dashboard token (always generate)
  if (!env.DASHBOARD_TOKEN) {
    env.DASHBOARD_TOKEN = crypto.randomBytes(24).toString('hex');
  }
  ok('Dashboard token set');

  // PIN lock
  console.log();
  info('PIN lock: like a password for the bot. Even if someone opens your');
  info('Telegram, they can\'t use the bot without the PIN.');
  console.log();

  if (env.SECURITY_PIN_HASH) {
    ok('PIN lock already configured');
  } else {
    let pinSet = false;
    // Single prompt: type a PIN to enable, or Enter to skip
    while (!pinSet) {
      const pin = await ask('Choose a PIN (4+ characters, or Enter to skip)');
      if (!pin) {
        info('No PIN set. Add SECURITY_PIN_HASH to .env later if you change your mind.');
        break;
      }
      if (pin.length < 4) {
        console.log(`  ${c.red}PIN must be at least 4 characters.${c.reset}`);
        continue;
      }
      const pinConfirm = await ask('Confirm PIN');
      if (pin !== pinConfirm) {
        console.log(`  ${c.red}PINs don't match. Try again.${c.reset}`);
        continue;
      }
      // Salted hash: "salt:hash"
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.createHash('sha256').update(salt + pin).digest('hex');
      env.SECURITY_PIN_HASH = `${salt}:${hash}`;
      ok('PIN set. Bot will start locked, send the PIN to unlock.');
      pinSet = true;

      // Idle timeout (only ask when PIN is set)
      console.log();
      info('Auto-lock re-locks the bot after a period of inactivity.');
      const idleMin = await ask('Lock after how many minutes idle?', '30');
      const idleVal = parseInt(idleMin) || 0;
      if (idleVal > 0) {
        env.IDLE_LOCK_MINUTES = String(idleVal);
        ok(`Auto-lock after ${idleVal}m of inactivity`);
      }
    }
  }

  // Emergency kill phrase (auto-generate with option to customize)
  console.log();
  if (env.EMERGENCY_KILL_PHRASE) {
    ok('Emergency kill phrase already configured');
  } else {
    info('Kill phrase: a word you send to immediately shut down all agents.');
    info('Useful if something goes wrong or you suspect unauthorized access.');
    console.log();
    const defaultPhrase = 'EMERGENCY_STOP_' + crypto.randomBytes(3).toString('hex').toUpperCase();
    const killPhrase = await ask('Kill phrase (Enter for auto-generated)', defaultPhrase);
    if (killPhrase && killPhrase.length >= 4) {
      env.EMERGENCY_KILL_PHRASE = killPhrase;
      ok('Kill phrase saved');
      info(`Remember it: ${killPhrase}`);
    }
  }

  // ── 10. Voice keys ────────────────────────────────────────────────────────
  if (wantVoiceIn || wantVoiceOut) {
    section('Voice configuration');
  }

  if (wantVoiceIn) {
    if (env.GROQ_API_KEY) {
      ok('Groq STT already configured');
    } else {
      info('Groq provides free voice transcription (Whisper large-v3).');
      info('Sign up free at: console.groq.com → API Keys');
      console.log();
      const key = await ask('Groq API key (Enter to skip)');
      if (key) env.GROQ_API_KEY = key;
    }
  }

  if (wantVoiceOut) {
    if (env.ELEVENLABS_API_KEY && env.ELEVENLABS_VOICE_ID) {
      ok('ElevenLabs TTS already configured');
    } else {
      console.log();
      info('ElevenLabs generates spoken responses in your cloned voice.');
      info('Sign up at elevenlabs.io → clone your voice under Voice Lab.');
      console.log();
      if (!env.ELEVENLABS_API_KEY) {
        const key = await ask('ElevenLabs API key (Enter to skip)');
        if (key) env.ELEVENLABS_API_KEY = key;
      }
      if (env.ELEVENLABS_API_KEY && !env.ELEVENLABS_VOICE_ID) {
        info('Voice ID is the string ID in ElevenLabs, not the voice name.');
        const vid = await ask('ElevenLabs Voice ID (Enter to skip)');
        if (vid) env.ELEVENLABS_VOICE_ID = vid;
      }
    }
  }

  // ── 10. Google API key (video analysis + War Room + memory consolidation) ──
  if (wantVideo || wantWarRoom) {
    section('Google API key');

    const reasons: string[] = [];
    if (wantVideo) reasons.push('video analysis');
    if (wantWarRoom) reasons.push('War Room voice');
    info(`Needed for: ${reasons.join(' and ')}. Also powers memory consolidation.`);
    console.log();

    if (env.GOOGLE_API_KEY) {
      ok('Google API key already configured');
    } else {
      info('Get a free key at: aistudio.google.com → Get API key');
      console.log();
      const key = await ask('Google API key (Enter to skip)');
      if (key) env.GOOGLE_API_KEY = key;
    }
  }

  // ── 11. Optional Claude API key ───────────────────────────────────────────
  section('Claude authentication');

  info('By default, ClaudeClaw uses your existing claude login (Max plan).');
  info('This is fine for personal use on your own machine.');
  console.log();
  info('Set an API key if you\'re deploying on a server, or want pay-per-token');
  info('billing instead of using your subscription limits.');
  console.log();

  if (env.ANTHROPIC_API_KEY) {
    ok('API key already configured');
  } else {
    const key = await ask('Anthropic API key — optional (Enter to skip)');
    if (key) env.ANTHROPIC_API_KEY = key;
  }

  // ── Write .env ────────────────────────────────────────────────────────
  console.log();
  const sw = spinner('Saving .env...');
  await sleep(300);

  const lines = [
    '# ClaudeClaw — generated by setup wizard',
    '# Edit freely. Re-run: npm run setup',
    '',
    '# ── Required ──────────────────────────────────────────────────',
    `TELEGRAM_BOT_TOKEN=${env.TELEGRAM_BOT_TOKEN || ''}`,
    `ALLOWED_CHAT_ID=${env.ALLOWED_CHAT_ID || ''}`,
    '',
    '# ── Config directory (personal config, never committed) ───────',
    `CLAUDECLAW_CONFIG=${env.CLAUDECLAW_CONFIG || ''}`,
    '',
    '# ── Claude auth (optional — uses claude login by default) ─────',
    `ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY || ''}`,
    '',
    '# ── Voice ─────────────────────────────────────────────────────',
    `GROQ_API_KEY=${env.GROQ_API_KEY || ''}`,
    `ELEVENLABS_API_KEY=${env.ELEVENLABS_API_KEY || ''}`,
    `ELEVENLABS_VOICE_ID=${env.ELEVENLABS_VOICE_ID || ''}`,
    '',
    '# ── Integrations ──────────────────────────────────────────────',
    `GOOGLE_API_KEY=${env.GOOGLE_API_KEY || ''}`,
    '',
    '# ── Features ──────────────────────────────────────────────────',
    (wantWarRoom && warRoomReady) ? 'WARROOM_ENABLED=true' : '# WARROOM_ENABLED=false',
    wantWhatsApp ? 'WHATSAPP_ENABLED=true' : '# WHATSAPP_ENABLED=false',
    '# Provider selection (beta). Set to true to expose OpenCode/Gemini/Codex/custom ACP.',
    selectedProvider === 'claude' ? 'ENABLE_ACP=false' : 'ENABLE_ACP=true',
    '',
    '# ── Dashboard ─────────────────────────────────────────────────',
    `DASHBOARD_TOKEN=${env.DASHBOARD_TOKEN || ''}`,
    `DASHBOARD_PORT=${env.DASHBOARD_PORT || '3141'}`,
    env.DASHBOARD_URL ? `DASHBOARD_URL=${env.DASHBOARD_URL}` : '# DASHBOARD_URL=',
    '',
    '# ── Security ──────────────────────────────────────────────────',
    env.SECURITY_PIN_HASH ? `SECURITY_PIN_HASH=${env.SECURITY_PIN_HASH}` : '# SECURITY_PIN_HASH=',
    env.IDLE_LOCK_MINUTES ? `IDLE_LOCK_MINUTES=${env.IDLE_LOCK_MINUTES}` : '# IDLE_LOCK_MINUTES=30',
    env.EMERGENCY_KILL_PHRASE ? `EMERGENCY_KILL_PHRASE=${env.EMERGENCY_KILL_PHRASE}` : '# EMERGENCY_KILL_PHRASE=',
    '',
    '# ── Database Encryption ───────────────────────────────────────',
    '# Auto-generated. DO NOT share or commit.',
    `DB_ENCRYPTION_KEY=${env.DB_ENCRYPTION_KEY || crypto.randomBytes(32).toString('hex')}`,
  ];

  // Preserve unknown keys
  const known = new Set(['TELEGRAM_BOT_TOKEN','ALLOWED_CHAT_ID','CLAUDECLAW_CONFIG','ANTHROPIC_API_KEY','GROQ_API_KEY','ELEVENLABS_API_KEY','ELEVENLABS_VOICE_ID','GOOGLE_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','WHATSAPP_ENABLED','WARROOM_ENABLED','ENABLE_ACP','DB_ENCRYPTION_KEY','DASHBOARD_TOKEN','DASHBOARD_PORT','DASHBOARD_URL','SECURITY_PIN_HASH','IDLE_LOCK_MINUTES','EMERGENCY_KILL_PHRASE','DESTRUCTIVE_CONFIRM']);
  for (const [k, v] of Object.entries(env)) {
    if (!known.has(k) && v) lines.push(`${k}=${v}`);
  }

  fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf-8');

  const written = parseEnvFile(envPath);
  const keyCount = Object.values(written).filter(Boolean).length;
  sw.stop('ok', `.env saved (${keyCount} key${keyCount !== 1 ? 's' : ''} configured)`);

  // ── 13. Auto-start service ───────────────────────────────────────────────
  if (PLATFORM === 'darwin') {
    await setupMacOS();
  } else if (PLATFORM === 'linux') {
    if (isWSL()) {
      ok('WSL2 detected. Using systemd user services (keep the Ubuntu terminal open or enable WSL2 systemd).');
    }
    await setupLinux();
  } else if (PLATFORM === 'win32') {
    await setupWindows();
  } else {
    section('Auto-start');
    info('Unknown platform. Start manually: npm start');
    info('Or use PM2: pm2 start dist/index.js --name claudeclaw && pm2 save');
  }

  // ── macOS permissions warning ──────────────────────────────────────────
  if (PLATFORM === 'darwin') {
    console.log();
    warn('macOS may show "Node wants to access..." permission dialogs on first run.');
    info('Keep an eye on your Mac screen and click Allow when prompted.');
    info('If the bot hangs with no response, check for pending permission dialogs.');
  }

  // ── 14. WhatsApp daemon reminder ─────────────────────────────────────────
  if (wantWhatsApp) {
    section('WhatsApp — next steps');
    info('To start the WhatsApp daemon:');
    console.log();
    console.log(`  ${c.cyan}npx tsx scripts/wa-daemon.ts${c.reset}`);
    console.log();
    info('A QR code will appear. Scan it from:');
    info('  WhatsApp → Settings → Linked Devices → Link a Device');
    console.log();
    info('The session saves to store/waweb/ and persists across restarts.');
    info('Then use /wa in Telegram to access your chats.');
    console.log();
    ok('Message bodies are encrypted at rest and auto-deleted after 3 days.');
    ok('The store/ directory is gitignored and will never be committed.');
  }

  // ── 15. Multi-agent setup (optional) ────────────────────────────────────
  section('Agent team (optional)');

  info('ClaudeClaw can run specialist agents alongside the main bot.');
  info('Each agent is its own Telegram bot with a focused role, its own');
  info('context window, and its own chat on your phone.');
  console.log();
  bullet('Each agent gets its own 1M context window (separate from main)');
  bullet('Agents default to Sonnet (cheaper) — use /model opus when needed');
  bullet('Each agent has its own CLAUDE.md personality and Obsidian folders');
  bullet('A shared hive mind lets agents see what others have done');
  bullet('All agents inherit every feature: voice, files, skills, scheduling');
  console.log();

  const wantAgents = await confirm('Set up specialist agents?', false);
  if (wantAgents) {
    const templates: { id: string; label: string; desc: string }[] = [
      { id: 'comms', label: 'comms', desc: 'email, Slack, WhatsApp, YouTube comments, community forums, LinkedIn' },
      { id: 'content', label: 'content', desc: 'YouTube scripts, LinkedIn posts, trend research' },
      { id: 'ops', label: 'ops', desc: 'calendar, billing, Stripe, Gumroad, admin' },
      { id: 'research', label: 'research', desc: 'deep web research, academic, competitive intel' },
    ];

    console.log();
    info('You can use the built-in templates or create custom agents.');
    info('Each agent needs its own Telegram bot from @BotFather.');
    info('Type "done" at any time to finish and move on.');
    console.log();

    console.log(`  ${c.bold}Available templates:${c.reset}`);
    for (const t of templates) {
      console.log(`  ${c.cyan}${t.label}${c.reset} ${c.gray}— ${t.desc}${c.reset}`);
    }
    console.log(`  ${c.cyan}custom${c.reset} ${c.gray}— create your own with a custom name${c.reset}`);
    console.log();

    const createdAgents: string[] = [];

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const input = await ask('Add an agent (template name, "custom", or "done")');
      if (!input || input.toLowerCase() === 'done') break;

      let agentId: string;
      let templateId: string;

      if (input.toLowerCase() === 'custom') {
        const customId = await ask('Agent ID (lowercase, no spaces, e.g. "finance")');
        if (!customId || customId.toLowerCase() === 'done') break;
        agentId = customId.toLowerCase().replace(/[^a-z0-9_-]/g, '');
        if (!agentId || agentId.length < 2) {
          warn('ID must be at least 2 lowercase characters. Try again.');
          continue;
        }
        templateId = '_template';
      } else {
        const match = templates.find((t) => t.id === input.toLowerCase());
        if (!match) {
          warn(`Unknown template "${input}". Use one of: ${templates.map((t) => t.label).join(', ')}, custom, or done.`);
          continue;
        }
        agentId = match.id;
        templateId = match.id;
      }

      if (createdAgents.includes(agentId)) {
        warn(`"${agentId}" already added. Try a different one.`);
        continue;
      }

      console.log();
      info(`Create a Telegram bot for ${agentId}:`);
      console.log(`    1. Open Telegram, message ${c.bold}@BotFather${c.reset}`);
      console.log(`    2. Send ${c.bold}/newbot${c.reset}`);
      console.log(`    3. Name it whatever you like (e.g. "My ${agentId.charAt(0).toUpperCase() + agentId.slice(1)} Agent")`);
      console.log(`    4. Copy the token BotFather gives you`);
      console.log();

      const envKey = `${agentId.toUpperCase()}_BOT_TOKEN`;
      const existingToken = env[envKey];
      let token = '';

      if (existingToken) {
        ok(`${envKey} already set in .env`);
        const reuse = await confirm('Keep the existing token?', true);
        if (reuse) token = existingToken;
      }

      if (!token) {
        token = await ask(`Paste the bot token (Enter to skip)`);
      }

      if (!token) {
        info(`Skipped. You can add it later with: npm run agent:create`);
        console.log();
        continue;
      }

      // Check for duplicate token (same as main bot or another agent)
      if (token === env.TELEGRAM_BOT_TOKEN) {
        warn('This is the same token as your main bot. Each agent needs its own bot.');
        info('Create a new bot from @BotFather and try again.');
        console.log();
        continue;
      }
      const dupeAgent = createdAgents.find((id) => env[`${id.toUpperCase()}_BOT_TOKEN`] === token);
      if (dupeAgent) {
        warn(`This token is already used by agent "${dupeAgent}". Each agent needs its own bot.`);
        console.log();
        continue;
      }

      // Validate token
      try {
        const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
        const data = await resp.json() as { ok: boolean; result?: { username?: string } };
        if (data.ok) {
          ok(`Bot verified: @${data.result?.username}`);
        } else {
          warn('Token did not validate. Saving anyway (you can fix it in .env later).');
        }
      } catch {
        warn('Could not verify token (no internet?). Saving anyway.');
      }

      // Save token to env
      env[envKey] = token;

      // Create agent config directory
      const configDir = env.CLAUDECLAW_CONFIG || path.join(os.homedir(), '.claudeclaw');
      const agentDir = path.join(configDir, 'agents', agentId);
      fs.mkdirSync(agentDir, { recursive: true });

      // Copy template CLAUDE.md
      const templateClaudeMd = path.join(PROJECT_ROOT, 'agents', templateId, 'CLAUDE.md');
      const destClaudeMd = path.join(agentDir, 'CLAUDE.md');
      if (fs.existsSync(templateClaudeMd) && !fs.existsSync(destClaudeMd)) {
        fs.copyFileSync(templateClaudeMd, destClaudeMd);
      }
      ensureAgentsMdSymlink(agentDir);

      // Create agent.yaml from example
      const exampleYaml = path.join(PROJECT_ROOT, 'agents', templateId, 'agent.yaml.example');
      const destYaml = path.join(agentDir, 'agent.yaml');
      if (fs.existsSync(exampleYaml) && !fs.existsSync(destYaml)) {
        let yamlContent = fs.readFileSync(exampleYaml, 'utf-8');
        yamlContent = yamlContent.replace(/telegram_bot_token_env:.*/, `telegram_bot_token_env: ${envKey}`);
        if (templateId === '_template') {
          yamlContent = yamlContent.replace(/name:.*/, `name: ${agentId.charAt(0).toUpperCase() + agentId.slice(1)}`);
        }
        fs.writeFileSync(destYaml, yamlContent, 'utf-8');
      }

      ok(`Agent "${agentId}" configured at ${agentDir}`);
      createdAgents.push(agentId);
      console.log();
    }

    if (createdAgents.length > 0) {
      console.log();
      ok(`${createdAgents.length} agent(s) configured: ${createdAgents.join(', ')}`);
      console.log();
      info('After setup finishes, start each agent in its own terminal:');
      console.log();
      for (const id of createdAgents) {
        console.log(`  ${c.cyan}npm start -- --agent ${id}${c.reset}`);
      }
      console.log();
      info('Or install as background services:');
      for (const id of createdAgents) {
        console.log(`  ${c.cyan}bash scripts/agent-service.sh install ${id}${c.reset}`);
      }
    } else {
      info('No agents created. You can add them later with:');
      console.log(`  ${c.cyan}npm run agent:create${c.reset}`);
    }

    // Re-write .env with agent tokens appended
    if (createdAgents.length > 0) {
      let envContent = fs.readFileSync(envPath, 'utf-8');
      for (const id of createdAgents) {
        const key = `${id.toUpperCase()}_BOT_TOKEN`;
        if (env[key] && !envContent.includes(`${key}=`)) {
          envContent += `\n# Agent: ${id}\n${key}=${env[key]}\n`;
        }
      }
      fs.writeFileSync(envPath, envContent, 'utf-8');
    }
    console.log();
  }

  // ── 16. Summary ───────────────────────────────────────────────────────────
  console.log();
  console.log(`  ${c.cyan}╔════════════════════════════════════════════╗${c.reset}`);
  console.log(`  ${c.cyan}║${c.reset}${c.bold}           ClaudeClaw is ready!             ${c.reset}${c.cyan}║${c.reset}`);
  console.log(`  ${c.cyan}╚════════════════════════════════════════════╝${c.reset}`);
  console.log();

  ok(`Bot: @${botUsername || '(configure TELEGRAM_BOT_TOKEN)'}`);
  env.ALLOWED_CHAT_ID ? ok(`Chat ID: ${env.ALLOWED_CHAT_ID}`) : warn('Chat ID: not set (bot will tell you on first message)');
  env.ANTHROPIC_API_KEY ? ok('Provider: Claude Code API key (pay-per-token)') : ok('Provider: Claude Code login / subscription');
  wantVoiceIn && env.GROQ_API_KEY ? ok('Voice input: Groq Whisper ✓') : wantVoiceIn ? warn('Voice input: GROQ_API_KEY not set') : info('Voice input: not enabled');
  wantVoiceOut && env.ELEVENLABS_API_KEY ? ok('Voice output: ElevenLabs ✓') : wantVoiceOut ? warn('Voice output: ElevenLabs keys not set') : info('Voice output: not enabled');
  wantVideo && env.GOOGLE_API_KEY ? ok('Video analysis: Gemini ✓') : wantVideo ? warn('Video analysis: GOOGLE_API_KEY not set') : info('Video analysis: not enabled');
  (wantWarRoom && warRoomReady && env.GOOGLE_API_KEY) ? ok('War Room: enabled ✓') : wantWarRoom && !warRoomReady ? warn('War Room: Python deps not installed (disabled)') : wantWarRoom ? warn('War Room: GOOGLE_API_KEY not set') : info('War Room: not enabled');
  wantWhatsApp ? ok('WhatsApp: run npx tsx scripts/wa-daemon.ts to connect') : info('WhatsApp: not enabled');

  console.log();
  info('Edit CLAUDE.md any time to change personality, add context, or update skills.');
  info('Re-run npm run setup to change API keys or service settings.');
  console.log();

  // Offer to start the bot right now
  const startNow = await confirm('Start the bot now?');
  if (startNow) {
    console.log();
    // Rebuild to ensure dist/ matches current source
    info('Building...');
    const buildResult = spawnSync('npm', ['run', 'build'], { cwd: PROJECT_ROOT, stdio: 'inherit', shell: PLATFORM === 'win32' });
    if (buildResult.status !== 0) {
      warn('Build failed. Run npm run build to see errors, then npm start.');
    } else {
      ok('Build complete');
      console.log();
      info('Starting ClaudeClaw... (press Ctrl+C to stop)');
      console.log();
      // Close readline before handing off to the bot process
      rl.close();
      try {
        execSync('npm start', { stdio: 'inherit', cwd: PROJECT_ROOT });
      } catch {
        // User hit Ctrl+C or process exited
      }
      return;
    }
  }

  console.log();
  console.log(`  ${c.bold}Start the bot:${c.reset}`);
  console.log();
  console.log(`  ${c.cyan}npm start${c.reset}                    # production (compiled)`);
  console.log(`  ${c.cyan}npm run dev${c.reset}                  # development (tsx, no build needed)`);
  console.log();
  console.log(`  ${c.bold}Check health:${c.reset}`);
  console.log(`  ${c.cyan}npm run status${c.reset}`);
  console.log();
  if (PLATFORM === 'darwin') {
    info('Logs: tail -f /tmp/claudeclaw.log');
  } else if (PLATFORM === 'linux') {
    info('Logs: journalctl --user -u claudeclaw -f');
  }
  console.log();
}

// ── Platform: macOS ──────────────────────────────────────────────────────────
async function setupMacOS() {
  section('Auto-start (macOS)');

  const dest = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.claudeclaw.app.plist');
  const installed = fs.existsSync(dest);

  if (installed) {
    ok('launchd service already installed');
    const reinstall = await confirm('Reinstall / update paths?', false);
    if (!reinstall) return;
  } else {
    const install = await confirm('Install as background service (starts automatically on login)?');
    if (!install) { info('Start manually: npm start'); return; }
  }

  const s = spinner('Installing launchd service...');
  try {
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.claudeclaw.app</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${path.join(PROJECT_ROOT, 'dist', 'index.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${PROJECT_ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>/tmp/claudeclaw.log</string>
  <key>StandardErrorPath</key><string>/tmp/claudeclaw.err</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key><string>production</string>
    <key>PATH</key><string>${process.env.PATH ?? '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin'}</string>
    <key>HOME</key><string>${os.homedir()}</string>
  </dict>
</dict>
</plist>`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, plist, 'utf-8');
    execSync(`launchctl load "${dest}"`, { stdio: 'pipe' });
    s.stop('ok', 'Service installed — starts automatically on login');
    info('Logs: tail -f /tmp/claudeclaw.log');
  } catch {
    s.stop('warn', 'Could not install automatically');
    info(`Manual install: launchctl load "${dest}"`);
  }
}

// ── Platform: Linux ──────────────────────────────────────────────────────────
async function setupLinux() {
  section('Auto-start (Linux)');

  const install = await confirm('Install as a systemd user service?');
  if (!install) {
    info('Start manually: npm start');
    info('Or: pm2 start dist/index.js --name claudeclaw && pm2 save');
    return;
  }

  const s = spinner('Installing systemd service...');
  try {
    const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
    const servicePath = path.join(serviceDir, 'claudeclaw.service');
    const service = `[Unit]
Description=ClaudeClaw Telegram Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=${PROJECT_ROOT}
ExecStart=${process.execPath} ${path.join(PROJECT_ROOT, 'dist', 'index.js')}
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
Environment=NODE_ENV=production
Environment=HOME=${os.homedir()}

[Install]
WantedBy=default.target
`;
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.writeFileSync(servicePath, service, 'utf-8');
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable claudeclaw', { stdio: 'pipe' });
    execSync('systemctl --user start claudeclaw', { stdio: 'pipe' });
    s.stop('ok', `Service installed at ${servicePath}`);
    info('Logs: journalctl --user -u claudeclaw -f');
  } catch {
    s.stop('warn', 'Could not install automatically');
    info('See README.md for manual systemd setup instructions.');
  }
}

// ── Platform: Windows ────────────────────────────────────────────────────────
async function setupWindows() {
  section('Auto-start (Windows)');

  info('Windows Task Scheduler is the recommended way to auto-start ClaudeClaw.');
  info('It runs at logon, requires no elevated privileges, and has no extra dependencies.');
  console.log();

  // Check if PM2 is already installed (offer as alternative for users who prefer it)
  let pm2Available = false;
  try {
    execSync('pm2 --version', { stdio: 'pipe' });
    pm2Available = true;
  } catch { /* not installed */ }

  // If PM2 is already installed, offer it as an alternative
  if (pm2Available) {
    info('PM2 detected. You can use PM2 instead if you prefer (restart-on-crash, log rotation).');
    const usePm2 = await confirm('Use PM2 instead of Task Scheduler?', false);
    if (usePm2) {
      const s = spinner('Configuring PM2...');
      try {
        const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');

        // Stop any existing instance
        try { execSync('pm2 delete claudeclaw', { stdio: 'ignore' }); } catch { /* not running */ }

        // Start with PM2
        execSync(
          `pm2 start "${entry}" --name claudeclaw --cwd "${PROJECT_ROOT}" --env NODE_ENV=production`,
          { stdio: 'pipe' },
        );

        // Save process list
        execSync('pm2 save', { stdio: 'pipe' });
        s.stop('ok', 'ClaudeClaw is running under PM2');

        console.log();
        info('Manage it with:');
        console.log(`  ${c.cyan}pm2 status${c.reset}              ${c.gray}# check status${c.reset}`);
        console.log(`  ${c.cyan}pm2 logs claudeclaw${c.reset}     ${c.gray}# view logs${c.reset}`);
        console.log(`  ${c.cyan}pm2 restart claudeclaw${c.reset}  ${c.gray}# restart${c.reset}`);
        console.log(`  ${c.cyan}pm2 stop claudeclaw${c.reset}     ${c.gray}# stop${c.reset}`);
        console.log();
        info('To start PM2 automatically on boot:');
        console.log(`  ${c.cyan}pm2 startup${c.reset}`);
        info('Follow the instructions it prints, then run:');
        console.log(`  ${c.cyan}pm2 save${c.reset}`);
        return;
      } catch (err) {
        s.stop('warn', 'PM2 setup encountered an issue');
        const errMsg = err instanceof Error ? err.message : String(err);
        info(`Error: ${errMsg}`);
        console.log();
        info('Falling back to Task Scheduler...');
        console.log();
      }
    }
  }

  // Primary: Task Scheduler
  const installTask = await confirm('Install a Task Scheduler auto-start entry?', true);
  if (!installTask) {
    info('Skipped. You can start the bot manually with: npm start');
    info('Or re-run "npm run setup" later to configure auto-start.');
    return;
  }

  const s = spinner('Registering Windows scheduled task...');
  try {
    const winDir = path.join(PROJECT_ROOT, 'win');
    fs.mkdirSync(winDir, { recursive: true });

    const label = 'com.claudeclaw.main';
    const batPath = path.join(winDir, `${label}.bat`);
    const entry = path.join(PROJECT_ROOT, 'dist', 'index.js');
    const logsDir = path.join(PROJECT_ROOT, 'logs');
    const logFile = path.join(logsDir, 'main.log');

    const q = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const bat = `@echo off\r
REM ClaudeClaw main bot wrapper\r
set NODE_ENV=production\r
cd /d ${q(PROJECT_ROOT)}\r
if not exist ${q(logsDir)} mkdir ${q(logsDir)}\r
${q(process.execPath)} ${q(entry)} >> ${q(logFile)} 2>&1\r
`;
    fs.writeFileSync(batPath, bat, 'utf-8');

    // Delete any prior registration idempotently
    try { execSync(`schtasks /Delete /TN "${label}" /F`, { stdio: 'ignore' }); } catch { /* not registered */ }

    // Register the task (runs on logon, interactive user context)
    execSync(
      `schtasks /Create /SC ONLOGON /TN "${label}" /TR "\\"${batPath}\\"" /F /IT`,
      { stdio: 'pipe' },
    );
    // Kick it off now so the bot comes online without a reboot.
    execSync(`schtasks /Run /TN "${label}"`, { stdio: 'pipe' });
    s.stop('ok', `Scheduled task installed: ${label}`);

    console.log();
    info('Manage it with:');
    console.log(`  ${c.cyan}schtasks /Query /TN "${label}"${c.reset}`);
    console.log(`  ${c.cyan}schtasks /End /TN "${label}"${c.reset}     ${c.gray}# stop${c.reset}`);
    console.log(`  ${c.cyan}schtasks /Run /TN "${label}"${c.reset}     ${c.gray}# start${c.reset}`);
    console.log(`  ${c.cyan}schtasks /Delete /TN "${label}" /F${c.reset}  ${c.gray}# uninstall${c.reset}`);
    console.log();
    info(`Logs: ${logFile}`);
  } catch (err) {
    s.stop('warn', 'Could not register scheduled task automatically');
    const errMsg = err instanceof Error ? err.message : String(err);
    printWindowsHandoff('Installing the ClaudeClaw auto-start scheduled task', errMsg, 'scripts/setup.ts (setupWindows function)');
    info('You can start the bot manually with: npm start');
  }
}

main()
  .catch((err) => {
    console.error(`\n  ${c.red}Setup failed:${c.reset}`, err);
    process.exit(1);
  })
  .finally(() => rl.close());
