# Jira Scrum Master Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the ops agent into Jira Cloud as a scrum master — creating a Scrum board, syncing `mission_tasks` to Jira issues, and running sprint ceremonies (planning, standup, retro) as scheduled ops tasks.

**Architecture:** Jira is the project management source of truth for backlog and sprint planning. The SQLite `mission_tasks` table remains the execution engine for agents. The ops agent bridges them: issues in Jira's "In Progress" column map to running mission tasks; completed/errored mission tasks transition Jira issues to "Done". A new `src/jira.ts` client wraps the Jira REST API v3 and Agile API. A `src/jira-sync.ts` module handles the bidirectional sync. A `src/jira-cli.ts` CLI exposes board management commands the ops agent calls via Bash.

**Tech Stack:** Jira Cloud REST API v3 (`/rest/api/3/`), Jira Agile API (`/rest/agile/1.0/`), Node 20 native `fetch`, `better-sqlite3`, TypeScript ESM, vitest.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/jira.ts` | **Create** | Jira Cloud API client factory (`createJiraClient`) — all HTTP calls |
| `src/jira.test.ts` | **Create** | Unit tests for jira.ts (fetch mocked via `vi.stubGlobal`) |
| `src/jira-sync.ts` | **Create** | Bidirectional sync: mission_tasks ↔ Jira issues |
| `src/jira-sync.test.ts` | **Create** | Unit tests for jira-sync.ts (db + jira client mocked) |
| `src/jira-cli.ts` | **Create** | CLI entry point — ops agent calls `node dist/jira-cli.js <cmd>` |
| `src/config.ts` | **Modify** | Add JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, JIRA_BOARD_ID |
| `.env.example` | **Modify** | Document the five Jira vars |
| `migrations/version.json` | **Modify** | Register migration `1.2.0` |
| `migrations/1.2.0/add-jira-columns.ts` | **Create** | ALTER mission_tasks: add `jira_issue_key TEXT`, `jira_sprint_id TEXT` |

---

## Task 0: Manual Jira Prerequisite (no code)

Before Task 1, the user must complete these steps once:

- [ ] **Step 1: Create an Atlassian Cloud account (if needed)**

  Go to https://www.atlassian.com/software/jira/free — sign up or log in.

- [ ] **Step 2: Create an API token**

  Go to https://id.atlassian.com/manage-profile/security/api-tokens → **Create API token** → name it `claudeclaw` → copy the token value. You will add it to `.env` in Task 1.

- [ ] **Step 3: Note your Jira Cloud host**

  It is the subdomain in your Jira URL: `https://<host>.atlassian.net`. Example: if your URL is `https://jisr-team.atlassian.net`, the host is `jisr-team.atlassian.net`.

- [ ] **Step 4: Note your Atlassian email address**

  This is the email you log in with (e.g. `mo@jisr.net`).

---

## Task 1: Config Vars

**Files:**
- Modify: `src/config.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add five Jira vars to `.env.example`**

  Open `.env.example` and add the following block after the `# ── Slack ──` section:

  ```
  # ── Jira Scrum Master ──────────────────────────────────────────────────────────
  # Get your API token from: https://id.atlassian.com/manage-profile/security/api-tokens
  # JIRA_HOST is just the subdomain: e.g. for https://jisr-team.atlassian.net → jisr-team.atlassian.net
  JIRA_HOST=
  JIRA_EMAIL=
  JIRA_API_TOKEN=
  # Project key (all caps, 2–10 chars). Set after running: node dist/jira-cli.js setup
  JIRA_PROJECT_KEY=CC
  # Board ID (numeric). Printed by jira-cli setup. Set after setup.
  JIRA_BOARD_ID=
  ```

- [ ] **Step 2: Add the vars to `src/config.ts` readEnvFile call**

  Open `src/config.ts`. In the `readEnvFile([...])` call (lines 7–40), add five entries:

  ```typescript
  'JIRA_HOST',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_BOARD_ID',
  ```

  Add them immediately before the closing `]` of the `readEnvFile` call.

- [ ] **Step 3: Export the five Jira constants at the bottom of `src/config.ts`**

  Append to the end of the file (before the last empty line):

  ```typescript
  // ── Jira Scrum Master ────────────────────────────────────────────────
  export const JIRA_HOST =
    process.env.JIRA_HOST || envConfig.JIRA_HOST || '';
  export const JIRA_EMAIL =
    process.env.JIRA_EMAIL || envConfig.JIRA_EMAIL || '';
  export const JIRA_API_TOKEN =
    process.env.JIRA_API_TOKEN || envConfig.JIRA_API_TOKEN || '';
  export const JIRA_PROJECT_KEY =
    process.env.JIRA_PROJECT_KEY || envConfig.JIRA_PROJECT_KEY || 'CC';
  export const JIRA_BOARD_ID = parseInt(
    process.env.JIRA_BOARD_ID || envConfig.JIRA_BOARD_ID || '0',
    10,
  );
  ```

- [ ] **Step 4: Add `JIRA_API_TOKEN` to the `PROTECTED_ENV_VARS` default string in `src/config.ts`**

  Find the line that defines `PROTECTED_ENV_VARS` (currently ends with `'GOOGLE_API_KEY'`). Append `,JIRA_API_TOKEN` inside the string:

  ```typescript
  // Before:
  'ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,DB_ENCRYPTION_KEY,TELEGRAM_BOT_TOKEN,SLACK_USER_TOKEN,GROQ_API_KEY,ELEVENLABS_API_KEY,GOOGLE_API_KEY'
  // After:
  'ANTHROPIC_API_KEY,CLAUDE_CODE_OAUTH_TOKEN,DB_ENCRYPTION_KEY,TELEGRAM_BOT_TOKEN,SLACK_USER_TOKEN,GROQ_API_KEY,ELEVENLABS_API_KEY,GOOGLE_API_KEY,JIRA_API_TOKEN'
  ```

- [ ] **Step 5: Add Jira creds to the live `.env` file**

  ```bash
  # Fill in your real values — do NOT commit .env
  echo "JIRA_HOST=<your-host>.atlassian.net" >> /home/ubuntu/claudeclaw-os/.env
  echo "JIRA_EMAIL=<your-email>" >> /home/ubuntu/claudeclaw-os/.env
  echo "JIRA_API_TOKEN=<your-token>" >> /home/ubuntu/claudeclaw-os/.env
  echo "JIRA_PROJECT_KEY=CC" >> /home/ubuntu/claudeclaw-os/.env
  echo "JIRA_BOARD_ID=0" >> /home/ubuntu/claudeclaw-os/.env
  ```

  Verify (value masked):
  ```bash
  grep "^JIRA_HOST=" /home/ubuntu/claudeclaw-os/.env && echo "present"
  ```
  Expected: `JIRA_HOST=<something>` + `present`

- [ ] **Step 6: Typecheck**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npm run typecheck 2>&1 | tail -5
  ```
  Expected: zero errors.

- [ ] **Step 7: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add src/config.ts .env.example
  git commit -m "feat(jira): add Jira config vars to config.ts and .env.example"
  ```

---

## Task 2: DB Migration

**Files:**
- Create: `migrations/1.2.0/add-jira-columns.ts`
- Modify: `migrations/version.json`

- [ ] **Step 1: Create the migration directory**

  ```bash
  mkdir -p /home/ubuntu/claudeclaw-os/migrations/1.2.0
  ```

- [ ] **Step 2: Write the failing test for the migration**

  Create `src/migrations.test.ts`. Note: the existing `migrations.test.ts` tests `compareSemver`. Check it first:

  ```bash
  grep -n "." /home/ubuntu/claudeclaw-os/src/migrations.test.ts | head -20
  ```

  Add a new describe block to the *existing* test file (do not create a new one):

  ```typescript
  // Add at the end of src/migrations.test.ts
  import Database from 'better-sqlite3';
  import os from 'os';
  import path from 'path';
  import fs from 'fs';
  import { afterEach, describe, expect, it } from 'vitest';

  describe('migration: add-jira-columns', () => {
    const tmpDir = path.join(os.tmpdir(), `jira-migration-test-${Date.now()}`);
    const dbPath = path.join(tmpDir, 'claudeclaw.db');

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('adds jira_issue_key and jira_sprint_id columns to mission_tasks', async () => {
      fs.mkdirSync(path.join(tmpDir, 'store'), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE mission_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          created_at INTEGER NOT NULL
        )
      `);
      db.close();

      // Import and run the migration with the db path overridden via env
      process.env._TEST_DB_PATH = dbPath;
      const { run } = await import('../migrations/1.2.0/add-jira-columns.js');
      await run();
      delete process.env._TEST_DB_PATH;

      const db2 = new Database(dbPath);
      const cols = (db2.pragma('table_info(mission_tasks)') as Array<{ name: string }>).map(c => c.name);
      db2.close();

      expect(cols).toContain('jira_issue_key');
      expect(cols).toContain('jira_sprint_id');
    });

    it('is idempotent — running twice does not throw', async () => {
      fs.mkdirSync(path.join(tmpDir, 'store'), { recursive: true });
      const db = new Database(dbPath);
      db.exec(`
        CREATE TABLE mission_tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          created_at INTEGER NOT NULL
        )
      `);
      db.close();

      process.env._TEST_DB_PATH = dbPath;
      const mod = await import('../migrations/1.2.0/add-jira-columns.js');
      await mod.run();
      await expect(mod.run()).resolves.not.toThrow();
      delete process.env._TEST_DB_PATH;
    });
  });
  ```

- [ ] **Step 3: Run the test to confirm it fails**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/migrations.test.ts 2>&1 | tail -15
  ```
  Expected: FAIL — `Cannot find module '../migrations/1.2.0/add-jira-columns.js'`

- [ ] **Step 4: Write the migration file**

  Create `migrations/1.2.0/add-jira-columns.ts`:

  ```typescript
  import Database from 'better-sqlite3';
  import path from 'path';

  export const description = 'Add jira_issue_key and jira_sprint_id columns to mission_tasks';

  export async function run(): Promise<void> {
    // _TEST_DB_PATH is injected by tests; in production, use store/claudeclaw.db
    const dbPath = process.env._TEST_DB_PATH
      ?? path.join(process.cwd(), 'store', 'claudeclaw.db');

    const db = new Database(dbPath);
    try {
      const cols = (db.pragma('table_info(mission_tasks)') as Array<{ name: string }>)
        .map(c => c.name);

      if (!cols.includes('jira_issue_key')) {
        db.exec('ALTER TABLE mission_tasks ADD COLUMN jira_issue_key TEXT');
        console.log('  + jira_issue_key TEXT');
      } else {
        console.log('  jira_issue_key already present, skipping');
      }

      if (!cols.includes('jira_sprint_id')) {
        db.exec('ALTER TABLE mission_tasks ADD COLUMN jira_sprint_id TEXT');
        console.log('  + jira_sprint_id TEXT');
      } else {
        console.log('  jira_sprint_id already present, skipping');
      }
    } finally {
      db.close();
    }
  }
  ```

- [ ] **Step 5: Register migration in `migrations/version.json`**

  Replace the contents of `migrations/version.json`:

  ```json
  {
    "migrations": {
      "1.2.0": ["add-jira-columns"]
    }
  }
  ```

- [ ] **Step 6: Run tests — expect pass**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/migrations.test.ts 2>&1 | tail -10
  ```
  Expected: all tests PASS.

- [ ] **Step 7: Run the migration against the live DB**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npm run migrate
  ```
  Type `y` when prompted. Expected output includes:
  ```
  + jira_issue_key TEXT
  + jira_sprint_id TEXT
  ```

- [ ] **Step 8: Verify columns exist in live DB**

  ```bash
  sqlite3 /home/ubuntu/claudeclaw-os/store/claudeclaw.db \
    "SELECT name FROM pragma_table_info('mission_tasks') WHERE name LIKE 'jira%';"
  ```
  Expected:
  ```
  jira_issue_key
  jira_sprint_id
  ```

- [ ] **Step 9: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add migrations/ src/migrations.test.ts
  git commit -m "feat(jira): add jira_issue_key + jira_sprint_id to mission_tasks via migration 1.2.0"
  ```

---

## Task 3: Jira API Client

**Files:**
- Create: `src/jira.test.ts`
- Create: `src/jira.ts`

- [ ] **Step 1: Write the failing tests**

  Create `src/jira.test.ts`:

  ```typescript
  import { vi, describe, it, expect, beforeEach } from 'vitest';

  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  import { createJiraClient } from './jira.js';

  const client = createJiraClient({
    host: 'test.atlassian.net',
    email: 'user@example.com',
    apiToken: 'test-api-token',
  });

  // Expected Basic auth header value
  const expectedAuth = 'Basic ' + Buffer.from('user@example.com:test-api-token').toString('base64');

  beforeEach(() => {
    mockFetch.mockClear();
  });

  function jsonResponse(data: unknown, status = 200) {
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    });
  }

  describe('createJiraClient', () => {
    describe('createIssue', () => {
      it('POSTs to /rest/api/3/issue with correct body and returns id + key', async () => {
        mockFetch.mockReturnValueOnce(jsonResponse({ id: '10001', key: 'CC-1' }));

        const result = await client.createIssue({
          projectKey: 'CC',
          summary: 'Test task',
          issueType: 'Task',
          priority: 'Medium',
        });

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://test.atlassian.net/rest/api/3/issue');
        expect(opts.method).toBe('POST');
        expect((opts.headers as Record<string, string>)['Authorization']).toBe(expectedAuth);
        const body = JSON.parse(opts.body as string);
        expect(body.fields.summary).toBe('Test task');
        expect(body.fields.issuetype.name).toBe('Task');
        expect(body.fields.priority.name).toBe('Medium');
        expect(result).toEqual({ id: '10001', key: 'CC-1' });
      });

      it('includes description as ADF doc when provided', async () => {
        mockFetch.mockReturnValueOnce(jsonResponse({ id: '10002', key: 'CC-2' }));

        await client.createIssue({
          projectKey: 'CC',
          summary: 'With desc',
          description: 'Hello world',
        });

        const body = JSON.parse((mockFetch.mock.calls[0] as [string, RequestInit])[1].body as string);
        expect(body.fields.description).toMatchObject({
          type: 'doc',
          version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world' }] }],
        });
      });
    });

    describe('transitionIssue', () => {
      it('GETs transitions then POSTs the matching one by name', async () => {
        mockFetch
          .mockReturnValueOnce(jsonResponse({
            transitions: [
              { id: '11', name: 'To Do', to: { name: 'To Do' } },
              { id: '21', name: 'In Progress', to: { name: 'In Progress' } },
              { id: '31', name: 'Done', to: { name: 'Done' } },
            ],
          }))
          .mockReturnValueOnce(jsonResponse({}, 204));

        await client.transitionIssue('CC-1', 'In Progress');

        expect(mockFetch).toHaveBeenCalledTimes(2);
        const [postUrl, postOpts] = mockFetch.mock.calls[1] as [string, RequestInit];
        expect(postUrl).toBe('https://test.atlassian.net/rest/api/3/issue/CC-1/transitions');
        expect(postOpts.method).toBe('POST');
        expect(JSON.parse(postOpts.body as string)).toEqual({ transition: { id: '21' } });
      });

      it('throws when transition name is not found', async () => {
        mockFetch.mockReturnValueOnce(jsonResponse({ transitions: [] }));

        await expect(client.transitionIssue('CC-1', 'Nonexistent')).rejects.toThrow(
          'Transition "Nonexistent" not found on CC-1',
        );
      });
    });

    describe('searchIssues', () => {
      it('POSTs to /rest/api/3/search and returns issues array', async () => {
        const fakeIssues = [{ id: '1', key: 'CC-1', fields: { summary: 'x' } }];
        mockFetch.mockReturnValueOnce(jsonResponse({ issues: fakeIssues }));

        const result = await client.searchIssues('project = CC AND status = "To Do"');

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://test.atlassian.net/rest/api/3/search');
        expect(opts.method).toBe('POST');
        const body = JSON.parse(opts.body as string);
        expect(body.jql).toBe('project = CC AND status = "To Do"');
        expect(result).toEqual(fakeIssues);
      });
    });

    describe('getActiveSprint', () => {
      it('GETs /rest/agile/1.0/board/{boardId}/sprint?state=active and returns first sprint', async () => {
        const fakeSprint = { id: 42, name: 'Sprint 1', state: 'active', originBoardId: 1 };
        mockFetch.mockReturnValueOnce(jsonResponse({ values: [fakeSprint] }));

        const result = await client.getActiveSprint(1);

        expect(mockFetch).toHaveBeenCalledOnce();
        const [url] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://test.atlassian.net/rest/agile/1.0/board/1/sprint?state=active');
        expect(result).toEqual(fakeSprint);
      });

      it('returns null when no active sprint', async () => {
        mockFetch.mockReturnValueOnce(jsonResponse({ values: [] }));
        const result = await client.getActiveSprint(1);
        expect(result).toBeNull();
      });
    });

    describe('addIssuesToSprint', () => {
      it('POSTs issue keys to /rest/agile/1.0/sprint/{id}/issue', async () => {
        mockFetch.mockReturnValueOnce(jsonResponse({}, 204));

        await client.addIssuesToSprint(42, ['CC-1', 'CC-2']);

        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://test.atlassian.net/rest/agile/1.0/sprint/42/issue');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body as string)).toEqual({ issues: ['CC-1', 'CC-2'] });
      });
    });

    describe('error handling', () => {
      it('throws on non-ok response with status and body', async () => {
        mockFetch.mockReturnValueOnce(
          Promise.resolve({
            ok: false,
            status: 404,
            text: () => Promise.resolve('Issue does not exist'),
            json: () => Promise.resolve({}),
          }),
        );

        await expect(client.getIssue('CC-999')).rejects.toThrow('Jira API 404');
      });
    });
  });
  ```

- [ ] **Step 2: Run tests — confirm they fail**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/jira.test.ts 2>&1 | tail -10
  ```
  Expected: FAIL — `Cannot find module './jira.js'`

- [ ] **Step 3: Write the Jira client implementation**

  Create `src/jira.ts`:

  ```typescript
  /**
   * Jira Cloud REST API v3 + Agile API client.
   * Authentication: Basic Auth (email + API token).
   */

  export interface JiraClientConfig {
    host: string;       // e.g. 'mysite.atlassian.net' (no https://)
    email: string;
    apiToken: string;
  }

  export interface CreateIssueOptions {
    projectKey: string;
    summary: string;
    description?: string;
    issueType?: string;   // 'Task' | 'Story' | 'Bug' | 'Epic' — default 'Task'
    priority?: string;    // 'Highest' | 'High' | 'Medium' | 'Low' | 'Lowest' — default 'Medium'
    labels?: string[];
  }

  export interface JiraIssue {
    id: string;
    key: string;
    fields: {
      summary: string;
      status: { id: string; name: string };
      priority: { name: string };
      assignee: { displayName: string; accountId: string } | null;
      issuetype: { name: string };
      description: unknown;
    };
  }

  export interface JiraTransition {
    id: string;
    name: string;
    to: { name: string };
  }

  export interface JiraSprint {
    id: number;
    name: string;
    state: 'active' | 'closed' | 'future';
    startDate?: string;
    endDate?: string;
    originBoardId: number;
  }

  export function createJiraClient(config: JiraClientConfig) {
    const auth = Buffer.from(`${config.email}:${config.apiToken}`).toString('base64');
    const apiBase = `https://${config.host}/rest/api/3`;
    const agileBase = `https://${config.host}/rest/agile/1.0`;
    const defaultHeaders = {
      Authorization: `Basic ${auth}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    async function request<T>(url: string, opts: RequestInit = {}): Promise<T> {
      const res = await fetch(url, {
        ...opts,
        headers: { ...defaultHeaders, ...(opts.headers ?? {}) },
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Jira API ${res.status}: ${body}`);
      }
      if (res.status === 204) return undefined as unknown as T;
      return res.json() as Promise<T>;
    }

    return {
      /** Verify credentials — also returns the caller's accountId needed for createProject */
      async getMyself(): Promise<{ accountId: string; displayName: string; emailAddress: string }> {
        return request(`${apiBase}/myself`);
      },

      async createIssue(opts: CreateIssueOptions): Promise<{ id: string; key: string }> {
        const body: Record<string, unknown> = {
          fields: {
            project: { key: opts.projectKey },
            summary: opts.summary,
            issuetype: { name: opts.issueType ?? 'Task' },
            priority: { name: opts.priority ?? 'Medium' },
            ...(opts.description && {
              description: {
                type: 'doc',
                version: 1,
                content: [{
                  type: 'paragraph',
                  content: [{ type: 'text', text: opts.description }],
                }],
              },
            }),
            ...(opts.labels?.length && { labels: opts.labels }),
          },
        };
        return request(`${apiBase}/issue`, { method: 'POST', body: JSON.stringify(body) });
      },

      async getIssue(issueKey: string): Promise<JiraIssue> {
        return request(`${apiBase}/issue/${issueKey}`);
      },

      async updateIssue(issueKey: string, fields: Record<string, unknown>): Promise<void> {
        await request(`${apiBase}/issue/${issueKey}`, {
          method: 'PUT',
          body: JSON.stringify({ fields }),
        });
      },

      async getTransitions(issueKey: string): Promise<JiraTransition[]> {
        const r = await request<{ transitions: JiraTransition[] }>(
          `${apiBase}/issue/${issueKey}/transitions`,
        );
        return r.transitions;
      },

      async transitionIssue(issueKey: string, transitionName: string): Promise<void> {
        const transitions = await this.getTransitions(issueKey);
        const found = transitions.find((t) => t.name === transitionName);
        if (!found) {
          throw new Error(
            `Transition "${transitionName}" not found on ${issueKey}. Available: ${transitions.map((t) => t.name).join(', ')}`,
          );
        }
        await request(`${apiBase}/issue/${issueKey}/transitions`, {
          method: 'POST',
          body: JSON.stringify({ transition: { id: found.id } }),
        });
      },

      async searchIssues(jql: string, fields?: string[]): Promise<JiraIssue[]> {
        const body = {
          jql,
          fields: fields ?? ['summary', 'status', 'priority', 'assignee', 'issuetype', 'description'],
          maxResults: 100,
        };
        const r = await request<{ issues: JiraIssue[] }>(`${apiBase}/search`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
        return r.issues;
      },

      // ── Project + Board Setup ──────────────────────────────────────────

      async createProject(opts: {
        key: string;
        name: string;
        leadAccountId: string;
      }): Promise<{ id: string; key: string }> {
        return request(`${apiBase}/project`, {
          method: 'POST',
          body: JSON.stringify({
            key: opts.key,
            name: opts.name,
            projectTypeKey: 'software',
            leadAccountId: opts.leadAccountId,
            assigneeType: 'UNASSIGNED',
          }),
        });
      },

      async createFilter(opts: { name: string; jql: string }): Promise<{ id: string }> {
        return request(`${apiBase}/filter`, {
          method: 'POST',
          body: JSON.stringify({ name: opts.name, jql: opts.jql, favourite: false }),
        });
      },

      async createBoard(opts: { name: string; projectKey: string }): Promise<{ id: number }> {
        const filter = await this.createFilter({
          name: `${opts.name} Filter`,
          jql: `project = ${opts.projectKey} ORDER BY created DESC`,
        });
        return request(`${agileBase}/board`, {
          method: 'POST',
          body: JSON.stringify({
            name: opts.name,
            type: 'scrum',
            filterId: parseInt(filter.id, 10),
          }),
        });
      },

      // ── Sprint Management ─────────────────────────────────────────────

      async createSprint(opts: {
        boardId: number;
        name: string;
        startDate: string;   // ISO 8601
        endDate: string;     // ISO 8601
      }): Promise<JiraSprint> {
        return request(`${agileBase}/sprint`, {
          method: 'POST',
          body: JSON.stringify({
            name: opts.name,
            originBoardId: opts.boardId,
            startDate: opts.startDate,
            endDate: opts.endDate,
          }),
        });
      },

      async startSprint(sprintId: number, startDate: string, endDate: string): Promise<void> {
        await request(`${agileBase}/sprint/${sprintId}`, {
          method: 'POST',
          body: JSON.stringify({ state: 'active', startDate, endDate }),
        });
      },

      async closeSprint(sprintId: number): Promise<void> {
        await request(`${agileBase}/sprint/${sprintId}`, {
          method: 'POST',
          body: JSON.stringify({ state: 'closed' }),
        });
      },

      async getActiveSprint(boardId: number): Promise<JiraSprint | null> {
        const r = await request<{ values: JiraSprint[] }>(
          `${agileBase}/board/${boardId}/sprint?state=active`,
        );
        return r.values[0] ?? null;
      },

      async getBoardSprints(boardId: number): Promise<JiraSprint[]> {
        const r = await request<{ values: JiraSprint[] }>(
          `${agileBase}/board/${boardId}/sprint`,
        );
        return r.values;
      },

      async addIssuesToSprint(sprintId: number, issueKeys: string[]): Promise<void> {
        await request(`${agileBase}/sprint/${sprintId}/issue`, {
          method: 'POST',
          body: JSON.stringify({ issues: issueKeys }),
        });
      },

      async getBacklogIssues(boardId: number): Promise<JiraIssue[]> {
        const r = await request<{ issues: JiraIssue[] }>(
          `${agileBase}/board/${boardId}/backlog?fields=summary,status,priority,assignee,issuetype&maxResults=100`,
        );
        return r.issues;
      },

      async getSprintIssues(sprintId: number): Promise<JiraIssue[]> {
        const r = await request<{ issues: JiraIssue[] }>(
          `${agileBase}/sprint/${sprintId}/issue?fields=summary,status,priority,assignee,issuetype&maxResults=100`,
        );
        return r.issues;
      },
    };
  }

  export type JiraClient = ReturnType<typeof createJiraClient>;
  ```

- [ ] **Step 4: Run tests — confirm they pass**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/jira.test.ts 2>&1 | tail -15
  ```
  Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npm run typecheck 2>&1 | tail -5
  ```
  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add src/jira.ts src/jira.test.ts
  git commit -m "feat(jira): add JiraClient with REST API v3 + Agile API wrapper"
  ```

---

## Task 4: Jira Sync Bridge

**Files:**
- Create: `src/jira-sync.test.ts`
- Create: `src/jira-sync.ts`

- [ ] **Step 1: Write failing tests**

  Create `src/jira-sync.test.ts`:

  ```typescript
  import { vi, describe, it, expect, beforeEach } from 'vitest';
  import Database from 'better-sqlite3';
  import os from 'os';
  import path from 'path';
  import fs from 'fs';

  // ── Mock config ──────────────────────────────────────────────────────
  vi.mock('./config.js', () => ({
    JIRA_HOST: 'test.atlassian.net',
    JIRA_EMAIL: 'user@example.com',
    JIRA_API_TOKEN: 'test-token',
    JIRA_PROJECT_KEY: 'CC',
    JIRA_BOARD_ID: 1,
    STORE_DIR: '',  // will be set per test
  }));

  // ── Mock jira.ts ─────────────────────────────────────────────────────
  const mockCreateIssue = vi.fn();
  const mockTransitionIssue = vi.fn();
  vi.mock('./jira.js', () => ({
    createJiraClient: () => ({
      createIssue: mockCreateIssue,
      transitionIssue: mockTransitionIssue,
    }),
  }));

  // ── Per-test DB ───────────────────────────────────────────────────────
  let tmpDir: string;
  let db: InstanceType<typeof Database>;

  function setupDb(dir: string) {
    const dbPath = path.join(dir, 'claudeclaw.db');
    db = new Database(dbPath);
    db.exec(`
      CREATE TABLE mission_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        assigned_agent TEXT,
        status TEXT NOT NULL DEFAULT 'queued',
        priority INTEGER NOT NULL DEFAULT 5,
        jira_issue_key TEXT,
        jira_sprint_id TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
      )
    `);
    return dbPath;
  }

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), `jira-sync-test-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    const dbPath = setupDb(tmpDir);

    // Inject the tmp DB path via the config mock
    const config = await import('./config.js');
    (config as Record<string, unknown>).STORE_DIR = tmpDir;
    // Override db path for the sync module using env
    process.env._TEST_DB_DIR = tmpDir;

    mockCreateIssue.mockClear();
    mockTransitionIssue.mockClear();
  });

  afterEach(() => {
    db?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env._TEST_DB_DIR;
  });

  import { syncTaskToJira, pushStatusToJira, bulkSyncToJira } from './jira-sync.js';

  describe('syncTaskToJira', () => {
    it('creates a Jira issue for a task that has no jira_issue_key and stores the key', async () => {
      db.prepare(`
        INSERT INTO mission_tasks (id, title, prompt, assigned_agent, status, priority)
        VALUES ('task1', 'Fix login bug', 'Please fix the auth redirect', 'ops', 'queued', 7)
      `).run();

      mockCreateIssue.mockResolvedValueOnce({ id: '10001', key: 'CC-1' });

      const key = await syncTaskToJira('task1', path.join(tmpDir, 'claudeclaw.db'));

      expect(key).toBe('CC-1');
      expect(mockCreateIssue).toHaveBeenCalledOnce();
      const [opts] = mockCreateIssue.mock.calls[0];
      expect(opts.summary).toBe('Fix login bug');
      expect(opts.projectKey).toBe('CC');

      const row = db.prepare('SELECT jira_issue_key FROM mission_tasks WHERE id = ?').get('task1') as { jira_issue_key: string };
      expect(row.jira_issue_key).toBe('CC-1');
    });

    it('transitions an existing Jira issue when status changes', async () => {
      db.prepare(`
        INSERT INTO mission_tasks (id, title, prompt, status, jira_issue_key, priority)
        VALUES ('task2', 'Existing', 'prompt', 'running', 'CC-2', 5)
      `).run();

      mockTransitionIssue.mockResolvedValueOnce(undefined);

      await syncTaskToJira('task2', path.join(tmpDir, 'claudeclaw.db'));

      expect(mockTransitionIssue).toHaveBeenCalledWith('CC-2', 'In Progress');
      expect(mockCreateIssue).not.toHaveBeenCalled();
    });

    it('returns null for unknown task id', async () => {
      const key = await syncTaskToJira('nonexistent', path.join(tmpDir, 'claudeclaw.db'));
      expect(key).toBeNull();
    });
  });

  describe('bulkSyncToJira', () => {
    it('syncs all tasks without a jira_issue_key', async () => {
      db.prepare(`INSERT INTO mission_tasks (id, title, prompt, priority) VALUES ('t1', 'Task 1', 'p', 5), ('t2', 'Task 2', 'q', 5)`).run();
      mockCreateIssue
        .mockResolvedValueOnce({ id: '1', key: 'CC-1' })
        .mockResolvedValueOnce({ id: '2', key: 'CC-2' });

      const result = await bulkSyncToJira(path.join(tmpDir, 'claudeclaw.db'));

      expect(result.synced).toBe(2);
      expect(result.errors).toHaveLength(0);
    });
  });
  ```

- [ ] **Step 2: Run failing tests**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/jira-sync.test.ts 2>&1 | tail -10
  ```
  Expected: FAIL — `Cannot find module './jira-sync.js'`

- [ ] **Step 3: Write the sync bridge**

  Create `src/jira-sync.ts`:

  ```typescript
  import path from 'path';

  import Database from 'better-sqlite3';

  import { JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, STORE_DIR } from './config.js';
  import { createJiraClient } from './jira.js';
  import { logger } from './logger.js';

  // ── Status mapping ──────────────────────────────────────────────────────
  // mission_tasks.status → Jira transition name
  const STATUS_TO_TRANSITION: Record<string, string> = {
    queued: 'To Do',
    running: 'In Progress',
    completed: 'Done',
    error: 'Done',
  };

  // mission_tasks.priority (0–10) → Jira priority name
  function priorityName(p: number): string {
    if (p >= 9) return 'Highest';
    if (p >= 7) return 'High';
    if (p >= 4) return 'Medium';
    if (p >= 2) return 'Low';
    return 'Lowest';
  }

  function getDb(dbPath?: string): InstanceType<typeof Database> {
    const resolved = dbPath ?? path.join(STORE_DIR, 'claudeclaw.db');
    return new Database(resolved);
  }

  function getClient() {
    return createJiraClient({
      host: JIRA_HOST,
      email: JIRA_EMAIL,
      apiToken: JIRA_API_TOKEN,
    });
  }

  interface MissionTask {
    id: string;
    title: string;
    prompt: string;
    assigned_agent: string | null;
    status: string;
    priority: number;
    jira_issue_key: string | null;
    jira_sprint_id: string | null;
  }

  /**
   * Sync a single mission_task to Jira.
   * - If the task has no jira_issue_key: create a Jira issue and store the key.
   * - If it already has a key: transition the Jira issue to match the current status.
   *
   * @param taskId  - SQLite mission_tasks.id
   * @param dbPath  - Optional DB path override (for tests)
   * @returns The Jira issue key (e.g. 'CC-42'), or null if task not found.
   */
  export async function syncTaskToJira(taskId: string, dbPath?: string): Promise<string | null> {
    const db = getDb(dbPath);
    let task: MissionTask | undefined;
    try {
      task = db.prepare('SELECT * FROM mission_tasks WHERE id = ?').get(taskId) as MissionTask | undefined;
    } finally {
      db.close();
    }
    if (!task) return null;

    const client = getClient();

    if (task.jira_issue_key) {
      // Transition existing issue
      const targetTransition = STATUS_TO_TRANSITION[task.status];
      if (targetTransition) {
        try {
          await client.transitionIssue(task.jira_issue_key, targetTransition);
        } catch (err) {
          logger.warn({ err, issueKey: task.jira_issue_key, status: task.status }, 'jira-sync: transition failed (non-fatal)');
        }
      }
      return task.jira_issue_key;
    }

    // Create new Jira issue
    const { key } = await client.createIssue({
      projectKey: JIRA_PROJECT_KEY,
      summary: task.title,
      description: task.prompt.slice(0, 2000),
      issueType: 'Task',
      priority: priorityName(task.priority),
      labels: task.assigned_agent ? [`agent:${task.assigned_agent}`] : [],
    });

    const db2 = getDb(dbPath);
    try {
      db2.prepare('UPDATE mission_tasks SET jira_issue_key = ? WHERE id = ?').run(key, taskId);
    } finally {
      db2.close();
    }

    logger.info({ taskId, issueKey: key }, 'jira-sync: created Jira issue');
    return key;
  }

  /**
   * Convenience alias — called when a mission_task status changes.
   */
  export async function pushStatusToJira(taskId: string, dbPath?: string): Promise<void> {
    await syncTaskToJira(taskId, dbPath);
  }

  /**
   * Bulk sync: create Jira issues for all mission_tasks that don't have one yet.
   * Skips cancelled tasks. Caps at 50 per call to avoid rate limits.
   */
  export async function bulkSyncToJira(dbPath?: string): Promise<{ synced: number; errors: string[] }> {
    const db = getDb(dbPath);
    let tasks: Array<{ id: string }>;
    try {
      tasks = db.prepare(`
        SELECT id FROM mission_tasks
        WHERE jira_issue_key IS NULL AND status NOT IN ('cancelled')
        ORDER BY created_at ASC
        LIMIT 50
      `).all() as Array<{ id: string }>;
    } finally {
      db.close();
    }

    const errors: string[] = [];
    let synced = 0;
    for (const { id } of tasks) {
      try {
        await syncTaskToJira(id, dbPath);
        synced++;
      } catch (err) {
        errors.push(`${id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { synced, errors };
  }
  ```

- [ ] **Step 4: Run tests — confirm they pass**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npx vitest run src/jira-sync.test.ts 2>&1 | tail -15
  ```
  Expected: all tests PASS.

- [ ] **Step 5: Typecheck**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npm run typecheck 2>&1 | tail -5
  ```
  Expected: zero errors.

- [ ] **Step 6: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add src/jira-sync.ts src/jira-sync.test.ts
  git commit -m "feat(jira): add jira-sync bridge — mission_tasks ↔ Jira issue sync"
  ```

---

## Task 5: Jira CLI

**Files:**
- Create: `src/jira-cli.ts`

- [ ] **Step 1: Write the CLI**

  Create `src/jira-cli.ts`:

  ```typescript
  #!/usr/bin/env node
  /**
   * ClaudeClaw Jira CLI
   *
   * Ops agent calls this to manage the Jira Scrum board.
   *
   * Usage:
   *   node dist/jira-cli.js setup                      # One-time: create project + board
   *   node dist/jira-cli.js check                      # Verify credentials
   *   node dist/jira-cli.js backlog                    # List backlog issues
   *   node dist/jira-cli.js sprint                     # Show active sprint + status
   *   node dist/jira-cli.js add "Title" [--body "..."] [--priority high] [--type Story]
   *   node dist/jira-cli.js move CC-1 "In Progress"    # Transition an issue
   *   node dist/jira-cli.js sync                       # Bulk sync mission_tasks → Jira
   *   node dist/jira-cli.js standup                    # Generate standup digest
   *   node dist/jira-cli.js retro                      # Sprint retrospective digest
   *   node dist/jira-cli.js plan                       # Sprint planning report (backlog priorities)
   *   node dist/jira-cli.js start-sprint "Sprint N" [--days 14]  # Create + start new sprint
   */

  import {
    JIRA_HOST,
    JIRA_EMAIL,
    JIRA_API_TOKEN,
    JIRA_PROJECT_KEY,
    JIRA_BOARD_ID,
  } from './config.js';
  import { createJiraClient, type JiraIssue } from './jira.js';
  import { bulkSyncToJira } from './jira-sync.js';

  function parseFlag(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
  }

  function stripFlag(args: string[], flag: string): string[] {
    const idx = args.indexOf(flag);
    if (idx === -1) return args;
    return args.filter((_, i) => i !== idx && i !== idx + 1);
  }

  function formatIssue(issue: JiraIssue): string {
    const status = issue.fields.status.name.padEnd(14);
    const priority = (issue.fields.priority?.name ?? '').padEnd(8);
    return `  ${issue.key.padEnd(10)} [${status}] [${priority}] ${issue.fields.summary}`;
  }

  function addDays(date: Date, days: number): string {
    const d = new Date(date);
    d.setDate(d.getDate() + days);
    return d.toISOString();
  }

  async function main() {
    const [, , command, ...rawArgs] = process.argv;

    if (!JIRA_HOST || !JIRA_EMAIL || !JIRA_API_TOKEN) {
      console.error('❌ Jira not configured. Set JIRA_HOST, JIRA_EMAIL, JIRA_API_TOKEN in .env');
      process.exit(1);
    }

    const client = createJiraClient({ host: JIRA_HOST, email: JIRA_EMAIL, apiToken: JIRA_API_TOKEN });

    switch (command) {
      // ── check ────────────────────────────────────────────────────────
      case 'check': {
        const me = await client.getMyself();
        console.log(`✅ Jira connected as: ${me.displayName} (${me.emailAddress})`);
        console.log(`   accountId: ${me.accountId}`);
        console.log(`   Project:   ${JIRA_PROJECT_KEY}`);
        console.log(`   Board ID:  ${JIRA_BOARD_ID}`);
        break;
      }

      // ── setup ────────────────────────────────────────────────────────
      case 'setup': {
        const me = await client.getMyself();
        console.log(`Creating project ${JIRA_PROJECT_KEY} …`);
        const project = await client.createProject({
          key: JIRA_PROJECT_KEY,
          name: 'ClaudeClaw',
          leadAccountId: me.accountId,
        });
        console.log(`✅ Project created: ${project.key} (id: ${project.id})`);

        console.log(`Creating Scrum board …`);
        const board = await client.createBoard({
          name: 'ClaudeClaw Board',
          projectKey: JIRA_PROJECT_KEY,
        });
        console.log(`✅ Board created: id=${board.id}`);
        console.log(`\nNext: add JIRA_BOARD_ID=${board.id} to your .env and restart.`);
        break;
      }

      // ── backlog ──────────────────────────────────────────────────────
      case 'backlog': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set. Run jira-cli setup first.');
          process.exit(1);
        }
        const issues = await client.getBacklogIssues(JIRA_BOARD_ID);
        if (issues.length === 0) {
          console.log('Backlog is empty.');
          break;
        }
        console.log(`Backlog (${issues.length} items):\n`);
        for (const issue of issues) console.log(formatIssue(issue));
        break;
      }

      // ── sprint ───────────────────────────────────────────────────────
      case 'sprint': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set. Run jira-cli setup first.');
          process.exit(1);
        }
        const sprint = await client.getActiveSprint(JIRA_BOARD_ID);
        if (!sprint) {
          console.log('No active sprint. Use: node dist/jira-cli.js start-sprint "Sprint N"');
          break;
        }
        console.log(`Active Sprint: ${sprint.name} (id: ${sprint.id})`);
        console.log(`  Started: ${sprint.startDate ?? 'unknown'}`);
        console.log(`  Ends:    ${sprint.endDate ?? 'unknown'}\n`);

        const issues = await client.getSprintIssues(sprint.id);
        const byStatus = new Map<string, JiraIssue[]>();
        for (const issue of issues) {
          const s = issue.fields.status.name;
          if (!byStatus.has(s)) byStatus.set(s, []);
          byStatus.get(s)!.push(issue);
        }
        for (const [status, list] of byStatus) {
          console.log(`\n${status} (${list.length}):`);
          for (const issue of list) console.log(formatIssue(issue));
        }
        break;
      }

      // ── add ──────────────────────────────────────────────────────────
      case 'add': {
        const title = parseFlag(rawArgs, '--title') ?? rawArgs.filter(a => !a.startsWith('--'))[0];
        if (!title) {
          console.error('Usage: jira-cli add "Title" [--body "..."] [--priority high] [--type Story]');
          process.exit(1);
        }
        const body = parseFlag(rawArgs, '--body');
        const priority = parseFlag(rawArgs, '--priority');
        const issueType = parseFlag(rawArgs, '--type') ?? 'Task';

        const priorityMap: Record<string, string> = {
          highest: 'Highest', high: 'High', medium: 'Medium', low: 'Low', lowest: 'Lowest',
        };
        const result = await client.createIssue({
          projectKey: JIRA_PROJECT_KEY,
          summary: title,
          description: body,
          issueType,
          priority: priority ? (priorityMap[priority.toLowerCase()] ?? 'Medium') : 'Medium',
        });
        console.log(`✅ Created: ${result.key} — ${title}`);
        break;
      }

      // ── move ─────────────────────────────────────────────────────────
      case 'move': {
        const [issueKey, ...statusParts] = rawArgs;
        const newStatus = statusParts.join(' ');
        if (!issueKey || !newStatus) {
          console.error('Usage: jira-cli move CC-1 "In Progress"');
          process.exit(1);
        }
        await client.transitionIssue(issueKey, newStatus);
        console.log(`✅ ${issueKey} → ${newStatus}`);
        break;
      }

      // ── sync ─────────────────────────────────────────────────────────
      case 'sync': {
        console.log('Syncing mission_tasks → Jira …');
        const result = await bulkSyncToJira();
        console.log(`✅ Synced: ${result.synced} tasks`);
        if (result.errors.length) {
          console.log(`⚠️  Errors (${result.errors.length}):`);
          for (const e of result.errors) console.log(`  ${e}`);
        }
        break;
      }

      // ── start-sprint ─────────────────────────────────────────────────
      case 'start-sprint': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set.');
          process.exit(1);
        }
        const sprintName = rawArgs.filter(a => !a.startsWith('--'))[0];
        if (!sprintName) {
          console.error('Usage: jira-cli start-sprint "Sprint N" [--days 14]');
          process.exit(1);
        }
        const days = parseInt(parseFlag(rawArgs, '--days') ?? '14', 10);
        const now = new Date();
        const sprint = await client.createSprint({
          boardId: JIRA_BOARD_ID,
          name: sprintName,
          startDate: now.toISOString(),
          endDate: addDays(now, days),
        });
        await client.startSprint(sprint.id, sprint.startDate!, sprint.endDate!);
        console.log(`✅ Sprint started: ${sprint.name} (id: ${sprint.id})`);
        console.log(`   Ends: ${sprint.endDate}`);
        break;
      }

      // ── standup ──────────────────────────────────────────────────────
      case 'standup': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set.');
          process.exit(1);
        }
        const sprint = await client.getActiveSprint(JIRA_BOARD_ID);
        if (!sprint) {
          console.log('No active sprint — nothing to report.');
          break;
        }
        const issues = await client.getSprintIssues(sprint.id);
        const done = issues.filter(i => i.fields.status.name === 'Done');
        const inProgress = issues.filter(i => i.fields.status.name === 'In Progress');
        const todo = issues.filter(i => i.fields.status.name === 'To Do');
        const blocked = issues.filter(i => i.fields.status.name === 'Blocked');

        const today = new Date().toLocaleDateString('en-SA', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'Asia/Riyadh' });
        console.log(`📋 Daily Standup — ${today}`);
        console.log(`   Sprint: ${sprint.name}\n`);
        if (done.length) {
          console.log(`✅ Done (${done.length}):`);
          for (const i of done) console.log(`  • ${i.key}: ${i.fields.summary}`);
        }
        if (inProgress.length) {
          console.log(`\n🔄 In Progress (${inProgress.length}):`);
          for (const i of inProgress) console.log(`  • ${i.key}: ${i.fields.summary}`);
        }
        if (todo.length) {
          console.log(`\n📌 To Do (${todo.length}):`);
          for (const i of todo) console.log(`  • ${i.key}: ${i.fields.summary}`);
        }
        if (blocked.length) {
          console.log(`\n🚫 Blocked (${blocked.length}):`);
          for (const i of blocked) console.log(`  • ${i.key}: ${i.fields.summary}`);
        }
        console.log(`\nVelocity so far: ${done.length}/${issues.length} issues done`);
        break;
      }

      // ── retro ─────────────────────────────────────────────────────────
      case 'retro': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set.');
          process.exit(1);
        }
        const sprint = await client.getActiveSprint(JIRA_BOARD_ID);
        if (!sprint) {
          // Check last closed sprint
          const sprints = await client.getBoardSprints(JIRA_BOARD_ID);
          const last = sprints.filter(s => s.state === 'closed').at(-1);
          if (!last) { console.log('No closed sprints to retro.'); break; }
          const issues = await client.getSprintIssues(last.id);
          const done = issues.filter(i => i.fields.status.name === 'Done');
          const incomplete = issues.filter(i => i.fields.status.name !== 'Done');
          console.log(`🔁 Sprint Retrospective: ${last.name}`);
          console.log(`   Completed: ${done.length}/${issues.length} issues\n`);
          if (done.length) { console.log('✅ Completed:'); for (const i of done) console.log(`  • ${i.key}: ${i.fields.summary}`); }
          if (incomplete.length) { console.log('\n⚠️  Incomplete (carried over):'); for (const i of incomplete) console.log(`  • ${i.key}: ${i.fields.summary}`); }
          break;
        }
        const issues = await client.getSprintIssues(sprint.id);
        const done = issues.filter(i => i.fields.status.name === 'Done');
        console.log(`🔁 Mid-Sprint Retro: ${sprint.name}`);
        console.log(`   ${done.length}/${issues.length} issues done — ${Math.round(done.length / Math.max(issues.length, 1) * 100)}% velocity`);
        break;
      }

      // ── plan ──────────────────────────────────────────────────────────
      case 'plan': {
        if (!JIRA_BOARD_ID) {
          console.error('❌ JIRA_BOARD_ID not set.');
          process.exit(1);
        }
        const issues = await client.getBacklogIssues(JIRA_BOARD_ID);
        if (issues.length === 0) { console.log('Backlog is empty.'); break; }

        const sorted = [...issues].sort((a, b) => {
          const pOrder = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];
          return pOrder.indexOf(a.fields.priority?.name) - pOrder.indexOf(b.fields.priority?.name);
        });

        console.log(`📅 Sprint Planning — Backlog (${issues.length} items, sorted by priority):\n`);
        let i = 0;
        for (const issue of sorted) {
          i++;
          const marker = i <= 6 ? '🎯' : '  ';
          console.log(`${marker} ${issue.key.padEnd(10)} [${(issue.fields.priority?.name ?? 'Medium').padEnd(8)}] ${issue.fields.summary}`);
        }
        console.log(`\n🎯 = suggested for next sprint (top 6 by priority)`);
        console.log(`To add to sprint: node dist/jira-cli.js add-to-sprint <sprintId> CC-1 CC-2 …`);
        break;
      }

      default:
        console.error('Commands: check | setup | backlog | sprint | add | move | sync | standup | retro | plan | start-sprint');
        process.exit(1);
    }
  }

  main().catch(err => {
    console.error('jira-cli error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
  ```

- [ ] **Step 2: Build the CLI**

  ```bash
  cd /home/ubuntu/claudeclaw-os && npm run build:server 2>&1 | tail -10
  ```
  Expected: `dist/jira-cli.js` created, zero TypeScript errors.

- [ ] **Step 3: Smoke-test the CLI (credentials must be in .env)**

  ```bash
  node /home/ubuntu/claudeclaw-os/dist/jira-cli.js check 2>&1
  ```
  Expected: `✅ Jira connected as: <your name> (<email>)`

  If this fails with `Jira API 401`: the API token is wrong. Re-generate at https://id.atlassian.com/manage-profile/security/api-tokens.

- [ ] **Step 4: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add src/jira-cli.ts
  git commit -m "feat(jira): add jira-cli — backlog, sprint, add, move, sync, ceremonies"
  ```

---

## Task 6: Board + Project Initialization

This task is manual — run it once after credentials are confirmed working.

- [ ] **Step 1: Run setup to create the Jira project and Scrum board**

  ```bash
  node /home/ubuntu/claudeclaw-os/dist/jira-cli.js setup
  ```
  Expected output:
  ```
  Creating project CC …
  ✅ Project created: CC (id: 12345)
  Creating Scrum board …
  ✅ Board created: id=1
  Next: add JIRA_BOARD_ID=1 to your .env and restart.
  ```

  If the project already exists (`Project with key 'CC' already exists`): use a different project key (e.g. `CLCL`) and update `JIRA_PROJECT_KEY` in `.env`.

- [ ] **Step 2: Update `.env` with the board ID**

  ```bash
  # Replace 0 with the actual board ID printed above
  sed -i 's/^JIRA_BOARD_ID=.*/JIRA_BOARD_ID=<board-id>/' /home/ubuntu/claudeclaw-os/.env
  ```

- [ ] **Step 3: Create the first sprint**

  ```bash
  node /home/ubuntu/claudeclaw-os/dist/jira-cli.js start-sprint "Sprint 1" --days 14
  ```
  Expected: `✅ Sprint started: Sprint 1 (id: N)`

- [ ] **Step 4: Sync existing mission_tasks into Jira**

  ```bash
  node /home/ubuntu/claudeclaw-os/dist/jira-cli.js sync
  ```
  Expected: `✅ Synced: N tasks`

- [ ] **Step 5: Verify backlog shows synced items**

  ```bash
  node /home/ubuntu/claudeclaw-os/dist/jira-cli.js backlog
  ```
  Expected: list of issues matching recent mission_tasks.

---

## Task 7: Scrum Ceremony Scheduled Tasks

Wire the three Scrum ceremonies into the ops agent's `scheduled_tasks`.

- [ ] **Step 1: Create the daily standup task (Tue–Fri 9am KSA = 6am UTC)**

  ```bash
  PROJECT_ROOT=$(git -C /home/ubuntu/claudeclaw-os rev-parse --show-toplevel)
  node "$PROJECT_ROOT/dist/schedule-cli.js" create --agent ops \
    "Daily standup digest from Jira. Run the following and send the output as a Telegram message: node $PROJECT_ROOT/dist/jira-cli.js standup" \
    "0 6 * * 2-5"
  ```
  Expected: `Task created: <id>` with `Next run: Tue ...`

- [ ] **Step 2: Create the sprint planning reminder (Monday 9am KSA = 6am UTC)**

  ```bash
  PROJECT_ROOT=$(git -C /home/ubuntu/claudeclaw-os rev-parse --show-toplevel)
  node "$PROJECT_ROOT/dist/schedule-cli.js" create --agent ops \
    "Sprint planning session. Run: node $PROJECT_ROOT/dist/jira-cli.js plan — review the report, identify which issues to pull into the sprint, and send a planning summary to Telegram." \
    "0 6 * * 1"
  ```
  Expected: `Task created: <id>` with `Next run: Mon ...`

- [ ] **Step 3: Create the sprint retrospective (Friday 4pm KSA = 1pm UTC)**

  ```bash
  PROJECT_ROOT=$(git -C /home/ubuntu/claudeclaw-os rev-parse --show-toplevel)
  node "$PROJECT_ROOT/dist/schedule-cli.js" create --agent ops \
    "Sprint retrospective. Run: node $PROJECT_ROOT/dist/jira-cli.js retro — send a retro summary to Telegram with completed items, incomplete items, and any blockers observed this week." \
    "0 13 * * 5"
  ```
  Expected: `Task created: <id>` with `Next run: Fri ...`

- [ ] **Step 4: Verify all three tasks are registered**

  ```bash
  PROJECT_ROOT=$(git -C /home/ubuntu/claudeclaw-os rev-parse --show-toplevel)
  node "$PROJECT_ROOT/dist/schedule-cli.js" list --agent ops 2>&1
  ```
  Expected: three tasks listed, all with `Schedule: 0 6 * * ...` or `0 13 * * 5`.

---

## Task 8: AGENTS.md Update

- [ ] **Step 1: Add Jira scrum master to ops agent's responsibilities**

  Open `/home/ubuntu/claudeclaw-os/AGENTS.md`. Find the `### ops` section. In `Primary responsibilities`, append to the end of the list:

  ```
  **Jira Scrum Master** — backlog management, sprint planning (Monday 9am KSA), daily standups (Tue–Fri 9am KSA), sprint retrospective (Friday 4pm KSA), issue creation/transition via `node dist/jira-cli.js`.
  ```

  In `Direct-execution tasks`, append:

  ```
  run `node dist/jira-cli.js <cmd>` for Jira board management; create issues with `add`; transition with `move`; generate standup/retro digests; sync mission_tasks to Jira with `sync`.
  ```

- [ ] **Step 2: Commit**

  ```bash
  cd /home/ubuntu/claudeclaw-os && git add AGENTS.md
  git commit -m "ops: designate ops agent as Jira scrum master with ceremony schedule"
  ```

---

## Self-Review Checklist

**Spec coverage:**
| Requirement | Task |
|---|---|
| Define project management workflows | Tasks 0, 6 (Scrum workflow in Jira) |
| Create a Jira board | Task 6 — `jira-cli setup` |
| Log new tasks | Task 5 — `jira-cli add` + Task 4 sync |
| Manage the backlog | Task 5 — `jira-cli backlog`, `plan`, `move` |
| Replace "machine control" system | Architecture: Jira is backlog source of truth; `mission_tasks` is execution-only |
| Scrum ceremonies (sprint/standup/retro) | Task 7 — three scheduled tasks |

**No placeholders:** All steps contain actual runnable commands or full code blocks.

**Type consistency:** `JiraClient` returned by `createJiraClient()` is used consistently in `jira-sync.ts` and `jira-cli.ts`. `JiraIssue`, `JiraSprint`, `JiraTransition` types defined once in `jira.ts`, imported everywhere.

---

**Plan complete and saved to `docs/plans/2026-05-14-jira-scrum-master.md`.**

Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks.

**2. Inline Execution** — Execute tasks in this session using the executing-plans skill.

Which approach?
