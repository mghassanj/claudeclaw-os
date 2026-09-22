# Contributing to ClaudeClaw

## Adding a migration

Use the `add-migration` skill from within Claude Code:

```
/add-migration
```

or write a prompt like `add a new migration`.

The skill will walk you through picking a version bump (current / patch / minor / major),
naming the migration, and will create the migration file, update `migrations/version.json`,
sync `package.json`, and add an entry to `CHANGELOG.md`.

After the skill finishes, open the generated file and implement the `run()` function.

## Running tests

Tests use [Vitest](https://vitest.dev). Install dependencies first (the
`whatsapp/` service is a separate package):

```bash
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
cd whatsapp && PUPPETEER_SKIP_DOWNLOAD=1 npm ci --legacy-peer-deps && cd ..
```

`--legacy-peer-deps` is needed because `openai@4` declares an optional peer
`zod@^3` while `@anthropic-ai/claude-agent-sdk` needs `zod@^4`. Bumping to
`openai@6` resolves it, but that also makes npm install the agent SDK's
peers (`zod@4`, `@modelcontextprotocol/sdk`) that the deployed WhatsApp
service currently runs without, so it is left for a deliberate follow-up.

### Test safety guard

`src/test-guard.ts` runs before every root and `whatsapp/` test run
(vitest `globalSetup` + `setupFiles`). It:

- **Refuses to run** (throws, exit 1) when `NODE_ENV=production`; when
  `DATABASE_URL` points at a non-local host and `TEST_DATABASE_URL` is not
  set; when a real `.env` exists at the repo root (or `whatsapp/.env`); or
  when the hostname looks like the production EC2 host (`ip-172-31-*`).
- **Sandboxes** `CLAUDECLAW_CONFIG` and `STORE_DIR` to fresh temp dirs and
  sets `CLAUDECLAW_IGNORE_DOTENV=1`, so no test can read real secrets or
  write to a live store or agent config.

Opt-in environment variables:

| Variable | Effect |
| --- | --- |
| `ALLOW_TESTS_WITH_DOTENV=1` | Run on a dev machine that has a `.env` (it is still never read). |
| `ALLOW_TESTS_ON_HOST=1` | Run on an `ip-172-31-*` host. Never use this on production. |
| `TEST_DATABASE_URL` | Disposable Postgres for `whatsapp/tests/audit.test.ts` (skipped otherwise). It replaces `DATABASE_URL` for the run. |
| `RUN_TELEGRAM_INTEGRATION=1` + `TELEGRAM_TEST_BOT_TOKEN` + `TELEGRAM_TEST_CHAT_ID` | Run the real Telegram tests in `src/file-send.integration.test.ts` (they send actual messages). |

The SPA-shell checks for `/` and `/warroom` in `src/dashboard.contract.test.ts`
need the web build (`npm run build`); they skip locally without it and always
run in CI.

CI (`.github/workflows/ci.yml`) runs typecheck, build, and both test suites
on Node 20 and 22 for every pull request and push to `main`. It needs no
secrets.

Run the full test suite once:

```bash
npm test                          # root suite
cd whatsapp && npx vitest run     # whatsapp suite
```

Run in watch mode during development:

```bash
npm run test:watch
```

Run with coverage report:

```bash
npm run test:coverage
```

Run a specific test file:

```bash
npx vitest run src/migrations.test.ts
```

## Test layout

Tests live next to the source files they cover:

```
src/
  migrations.ts
  migrations.test.ts
  db.ts
  db.test.ts
  ...
```

Integration tests that hit external APIs (Telegram, etc.) are in files ending with `.integration.test.ts`. They are included in the normal test run but skip unless explicitly opted in (see the table above); they never read credentials from `.env`.

## Writing tests

- Use `describe` / `it` blocks. Nest `describe` blocks to group related cases.
- Use `beforeEach` / `afterEach` for setup and teardown; clean up any temp files or mocks.
- Mock `process.exit` with `vi.spyOn` when testing guard functions — do not let tests actually exit the process.
- Test files that touch the file system should create a temp directory via `fs.mkdtempSync` and remove it in `afterEach`.
- Match the style of existing tests: short, focused assertions, no commented-out code.
