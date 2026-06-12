import { test, expect, type Page } from '@playwright/test';

type ProviderType = 'opencode' | 'gemini' | 'codex' | 'claude' | 'acp';

async function installFakeDashboard(page: Page) {
  let provider: { type: ProviderType; command?: string; args?: string[]; model?: string; runtimeMode?: string; thinkingMode?: string } = { type: 'opencode' };
  let processing = false;
  let aborts = 0;

  await page.addInitScript(() => {
    class MockEventSource extends EventTarget {
      url: string;
      readyState = 1;
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string) {
        super();
        this.url = url;
        (window as any).__mockEventSources = (window as any).__mockEventSources || [];
        (window as any).__mockEventSources.push(this);
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }

      close() {
        this.readyState = 2;
      }
    }
    (window as any).EventSource = MockEventSource;
    (window as any).__emitSse = (eventName: string, data: unknown) => {
      const sources = (window as any).__mockEventSources || [];
      for (const source of sources) {
        source.dispatchEvent(new MessageEvent(eventName, { data: JSON.stringify(data) }));
      }
    };
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    if (path === '/api/health') {
      return json({
        contextPct: 12,
        turns: 4,
        model: provider.model || (provider.type === 'claude' ? 'claude-opus-4-6' : provider.type === 'codex' ? 'gpt-5.5' : provider.type),
        provider,
        providerType: provider.type,
        runtime: provider.type === 'acp' ? `${provider.command} ${(provider.args || []).join(' ')}`.trim() : provider.type,
        killSwitches: {
          WARROOM_TEXT_ENABLED: true,
          WARROOM_VOICE_ENABLED: true,
          LLM_SPAWN_ENABLED: true,
          DASHBOARD_MUTATIONS_ENABLED: true,
          MISSION_AUTO_ASSIGN_ENABLED: true,
          SCHEDULER_ENABLED: true,
        },
        killSwitchRefusals: {},
      });
    }
    if (path === '/api/provider/status') {
      return json({
        provider,
        providerType: provider.type,
        label: provider.type === 'claude' ? 'Claude' : provider.type === 'opencode' ? 'OpenCode' : provider.type === 'gemini' ? 'Gemini' : provider.type === 'codex' ? 'Codex' : 'ACP',
        runtime: provider.type === 'acp' ? `${provider.command} ${(provider.args || []).join(' ')}`.trim() : provider.type,
        model: provider.model || (provider.type === 'claude' ? 'claude-opus-4-6' : provider.type === 'codex' ? 'gpt-5.5' : provider.type === 'gemini' ? 'Gemini CLI default' : 'OpenCode default'),
      });
    }
    if (path === '/api/security/status') return json({});
    if (path === '/api/agents') {
      return json({
        agents: [
          { id: 'main', name: 'Main', description: '', model: 'fake-model', running: true, todayTurns: 2, todayCost: 0, provider },
        ],
      });
    }
    if (path === '/api/chat/history') return json({ turns: [] });
    if (path === '/api/agents/main/tokens') return json({ todayCost: 0, todayTurns: 0, allTimeCost: 0 });
    if (path === '/api/providers/models') {
      const selected = url.searchParams.get('provider') || 'opencode';
      return json({
        provider: selected,
        models: selected === 'codex'
          ? [{ id: 'gpt-5.5', label: 'GPT-5.5' }, { id: 'gpt-5.3-codex', label: 'GPT-5.3 Codex' }]
          : selected === 'claude'
            ? [{ id: 'claude-opus-4-6', label: 'Opus 4.6' }]
            : [{ id: selected + '-default', label: selected + ' default' }],
        defaultModel: selected === 'codex' ? 'gpt-5.5' : selected + '-default',
        selectable: true,
        allowCustom: true,
      });
    }
    if (path === '/api/providers/runtime-options') {
      const selected = url.searchParams.get('provider') || 'opencode';
      return json({
        provider: selected,
        source: selected === 'claude' ? 'static' : 'provider',
        modeOptions: selected === 'codex'
          ? []
          : [{ id: 'fast', label: 'Fast' }, { id: 'normal', label: 'Normal' }, { id: 'deep', label: 'Deep' }],
        thinkingOptions: selected === 'codex'
          ? [{ id: 'low', label: 'Low' }, { id: 'medium', label: 'Medium' }, { id: 'high', label: 'High' }, { id: 'xhigh', label: 'Extra high' }]
          : [{ id: 'auto', label: 'Auto' }, { id: 'off', label: 'Off' }, { id: 'on', label: 'On' }],
      });
    }
    if (path === '/api/agents/main/provider' && req.method() === 'PATCH') {
      const body = JSON.parse(req.postData() || '{}');
      provider = body.provider;
      return json({ ok: true, agent: 'main', provider, restartRequired: false });
    }
    if (path === '/api/chat/send' && req.method() === 'POST') {
      processing = true;
      return json({ ok: true });
    }
    if (path === '/api/chat/abort' && req.method() === 'POST') {
      aborts += 1;
      processing = false;
      await page.evaluate(() => {
        (window as any).__emitSse('processing', { processing: false });
      });
      return json({ ok: true, aborted: true, aborts });
    }

    return json({ ok: true, processing });
  });
}

test.beforeEach(async ({ page }) => {
  await installFakeDashboard(page);
});

test('provider picker switches built-in and custom providers', async ({ page }) => {
  await page.goto('/settings?token=test&chatId=e2e');

  await expect(page.getByText('Agent provider')).toBeVisible();
  const picker = page.getByLabel('Provider', { exact: true });

  for (const provider of ['claude', 'opencode', 'gemini', 'codex'] as ProviderType[]) {
    await picker.selectOption(provider);
    if (provider === 'codex') {
      await page.getByLabel('Model').selectOption('gpt-5.5');
      await expect(page.getByRole('button', { name: 'Extra high' })).toBeVisible();
      await page.getByRole('button', { name: 'Extra high' }).click();
    }
    await page.getByRole('button', { name: /save provider/i }).click();
    await expect(page.getByText('Provider saved').first()).toBeVisible();
  }

  await page.goto('/chat?token=test&chatId=e2e');
  await expect(page.getByRole('main').getByText('gpt-5.5')).toBeVisible();

  await page.goto('/settings?token=test&chatId=e2e');
  const customPicker = page.getByLabel('Provider', { exact: true });
  await customPicker.selectOption('acp');
  await page.getByPlaceholder('my-acp-agent').fill('fake-acp');
  await page.getByPlaceholder('--acp').fill('--stdio --verbose');
  await page.getByRole('button', { name: /save provider/i }).click();
  await expect(page.getByText('Provider saved').first()).toBeVisible();
});

test('dashboard status shows active provider and model in chat', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await expect(page.getByText('Stream live')).toBeVisible();
  await expect(page.getByRole('main').getByText('Model')).toBeVisible();
  await expect(page.getByRole('main').getByText('opencode')).toBeVisible();

  await page.getByLabel('Switch main provider').selectOption('codex');
  await expect(page.getByText('Provider set to Codex')).toBeVisible();
  await expect(page.getByText('Runtime').locator('..').getByText('Codex')).toBeVisible();
  await expect(page.getByRole('main').getByText('gpt-5.5')).toBeVisible();
});

test('chat sends a message, renders progress, streamed text, and keeps text selectable', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.getByPlaceholder('Type a message. Shift+Enter for newline.').fill('use the fake provider');
  await page.getByRole('button', { name: /send/i }).click();
  await page.evaluate(() => {
    (window as any).__emitSse('user_message', { content: 'use the fake provider', source: 'dashboard' });
    (window as any).__emitSse('processing', { processing: true });
    (window as any).__emitSse('progress', {
      description: 'Inspect fake plan',
      progressKind: 'plan',
      status: 'in_progress',
      planEntries: [{ content: 'Inspect fake plan', status: 'in_progress', priority: 'high' }],
      timestamp: Date.now(),
    });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-1',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now(),
    });
  });

  await expect(page.getByText('Inspect fake plan')).toBeVisible();
  await expect(page.getByText('Running fake tool').first()).toBeVisible();
  await expect(page.getByText('README.md:12')).toBeVisible();

  await page.evaluate(() => {
    (window as any).__emitSse('assistant_message', {
      content: 'Fake streamed provider reply with selectable text.',
      source: 'dashboard',
    });
    (window as any).__emitSse('processing', { processing: false });
  });
  const reply = page.getByText('Fake streamed provider reply with selectable text.');
  await expect(reply).toBeVisible();

  const selectable = await reply.evaluate((node) => getComputedStyle(node.closest('.select-text') || node).userSelect);
  expect(selectable).toBe('text');
});

test('provider tool progress renders once per tool id', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.getByPlaceholder('Type a message. Shift+Enter for newline.').fill('dedupe fake tool progress');
  await page.getByRole('button', { name: /send/i }).click();
  await page.evaluate(() => {
    (window as any).__emitSse('user_message', { content: 'dedupe fake tool progress', source: 'dashboard' });
    (window as any).__emitSse('processing', { processing: true });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-dedupe',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now(),
    });
    (window as any).__emitSse('progress', {
      description: 'Running fake tool',
      progressKind: 'tool_active',
      status: 'pending',
      toolCallId: 'tool-dedupe',
      locations: [{ path: 'README.md', line: 12 }],
      timestamp: Date.now() + 1,
    });
  });

  await expect(page.getByText('Running fake tool')).toHaveCount(2);
  await expect(page.getByText('README.md:12')).toHaveCount(1);
});

test('stop button aborts an active fake-provider turn', async ({ page }) => {
  await page.goto('/chat?token=test&chatId=e2e');

  await page.evaluate(() => {
    (window as any).__emitSse('processing', { processing: true });
  });
  await page.getByRole('button', { name: /stop/i }).click();
  await expect(page.getByRole('button', { name: /send/i })).toBeVisible();
});
