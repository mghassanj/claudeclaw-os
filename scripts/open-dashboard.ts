#!/usr/bin/env tsx
import { spawnSync } from 'child_process';
import { readEnvFile } from '../src/env.js';

const env = readEnvFile([
  'DASHBOARD_TOKEN',
  'DASHBOARD_PORT',
  'DASHBOARD_URL',
  'ALLOWED_CHAT_ID',
]);

const token = process.env.DASHBOARD_TOKEN || env.DASHBOARD_TOKEN || '';
const port = process.env.DASHBOARD_PORT || env.DASHBOARD_PORT || '3141';
const publicBase = process.env.DASHBOARD_URL || env.DASHBOARD_URL || '';
const chatId = process.env.ALLOWED_CHAT_ID || env.ALLOWED_CHAT_ID || '';

if (!token) {
  console.error('DASHBOARD_TOKEN is not set. Run npm run setup or add DASHBOARD_TOKEN to .env.');
  process.exit(1);
}

const base = publicBase || `http://localhost:${port}`;
const url = `${base}/?token=${encodeURIComponent(token)}${chatId ? `&chatId=${encodeURIComponent(chatId)}` : ''}`;

console.log(url);

const command =
  process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open';
const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
const result = spawnSync(command, args, { stdio: 'ignore' });

if (result.status !== 0) {
  console.error('Could not open a browser automatically. Open the URL above manually.');
  process.exit(1);
}
