# Jisr backend code reference (`mcp__jisr-backend-codewiki__*`)

## Overview

The Jisr backend codewiki MCP gives you searchable access to the actual Ruby on Rails source that powers the Jisr HR platform (payroll, GOSI, requests, attendance, leaves, settlements, end-of-service, etc.). It is the **code-grounded source of truth** — use it whenever a question depends on Jisr's internal logic, not on UI help-doc descriptions.

The backend repo is laid out conventionally for Rails: business logic lives in `app/services/...` and `app/models/...`, shared helpers in `app/utils/...`, and behavioral proofs in `spec/...`. Codewiki indexes all of these so you can search by intent ("vacation salary calculation") and then drill into specific files.

Do not paraphrase Jisr behavior from training data or memory. Always cite real code with `path:line` so the user can verify.

## Tools

- `search_docs(query, limit?)` — hybrid semantic + keyword search across the Jisr backend repo. Returns code chunks with `path`, `startLine`, `endLine`, `content`, `score`. Start here.
- `read_file(path)` — full file when a chunk needs more context, or to read a helper that the calling code references.
- `get_structure(path?)` — directory tree; rarely needed, use only when search is failing to surface a known area.

## When to use

Call `search_docs` **before answering** any question about Jisr's internal behavior:

- "How does Jisr calculate X?" / "What does Jisr do when Y?" / "What's the actual logic of Z?"
- Payroll math, GOSI calculation, end-of-service settlement, vacation salary, deduction order.
- Request approval flow, validation rules, side effects of an API call, defaults.
- Attendance/leave rules, prorated/edge-case behavior, what config flag controls behavior.
- Auditing whether a Jisr behavior matches a customer report — search both the English name and the likely Arabic alias (e.g. `gosi_applicable` and `الاشتراك في التأمينات`).

## Triggering phrases (Arabic + English)

- "كيف يحسب جسر" / "كيف تحسب جسر" / "آلية الحساب" / "منطق" / "ما هي الطريقة المتبعة" / "ليش جسر يطلع كذا"
- "how does Jisr calculate" / "how does Jisr handle" / "what does Jisr do when" / "actual logic" / "backend behavior" / "internal rules"

## VERIFY EVERY HELPER FUNCTION — DO NOT TRUST FUNCTION NAMES

This is the **#1 failure mode** and overrides any "be efficient" temptation. When the answer depends on a chain of method calls (e.g., `vacation_salary = vacation_days * daily_rate` where `vacation_days = calculate_number_of_days_custom_for_vacation_salary(range)`), follow this recursive read mandate:

1. Find the calling code with `search_docs`. Read enough to see the FULL formula.
2. List every helper function/method the formula references — `calculate_*`, `fetch_*`, `build_*`, `*.call`, range/Array methods with custom semantics, anything from `app/utils/`, etc.
3. **For each helper, call `read_file` to read its actual body.** Do not assume what `calculate_X` does from its name. The function may have edge-case guards (skipping day 31, capping at end_of_month, returning early for specific configs) that change the result.
4. Walk through the calculation manually using the verified helper behavior. State each intermediate value with its code citation. THEN compose the final number.

**Reference incident (2026-05-14):** a bot answered 6,200 SAR instead of 6,000 SAR for a vacation-salary question because it trusted that `calculate_number_of_days_custom_for_vacation_salary` returned 31 days. The function actually caps at 30 when the range covers `end_of_month`. The bug was in `app/utils/date_helpers.rb:91` — would have been caught by reading the helper. Read every helper. Always.

## Self-check before sending the reply

List every numeric assumption you made (e.g., "I assumed `vacation_days = 30`"). For each, point at the `read_file` output that proves it. If any assumption has no proof, go back and read the relevant helper. **Never publish a number you didn't trace to code.**

A typical verified answer looks like:

1. "Caller is `app/services/v2/payroll/.../earnings.rb:6` — formula is `daily_rate * vacation_days`."
2. "`vacation_days` comes from `calculate_number_of_days_custom_for_vacation_salary` at `app/utils/date_helpers.rb:78`. I read this helper — it caps at 30 days when the range covers `end_of_month` (line 91)."
3. "`daily_rate` is `monthly_salary / 30` per `app/services/.../daily_rate.rb:14`."
4. "Therefore for this case: `200 * 30 = 6,000 SAR`."

Each numeric step has a code citation. No assumption is left unproved.

## Citation rules

- **Cite as `path:line`** in the user-facing reply (e.g., `app/services/v2/payroll/internal/monthly_days/earnings.rb:6`).
- For every helper you read, cite it too — the user trusts the answer because of the citations.
- Tests in `spec/` are GOLD for proving prorated/edge-case behavior — call them out by spec file path when they confirm the answer.

## Zendesk-vs-codewiki precedence

The Jisr Knowledge Base (Zendesk articles at `jisr.zendesk.com`, source filter `jisr-kb`) is **help-doc, not backend truth**. KB articles describe the UI and high-level behavior; they often **omit, simplify, or contradict** the actual code that runs payroll/HR calculations.

- For backend-logic questions, **skip `search_enterprise_kb` (RAG)** — it returns Zendesk help articles which are NOT reliable for backend behavior. Go straight to codewiki.
- **If jisr-kb (Zendesk) and codewiki conflict, codewiki wins** — the help article is wrong, the code is reality. State the discrepancy in your reply when relevant ("الـ KB يقول X لكن الكود يطبق Y، اعتمد على Y").

## Tool budget

Generous for verification, but stop before maxTurns:

- `search_docs`: 1-3 calls is normal. Refine queries as you discover the right files.
- `read_file`: as many as the formula needs. A typical payroll/settlement question needs 2-4 `read_file` calls (caller + 1-3 helpers). **Do NOT skip reading a helper to save a turn — wrong answer is worse than slow answer.**
- Combined codewiki tool calls per reply: target 4-6, hard max 10. Leave headroom for the final compose turn.

## When NOT to use

- Jisr **API** endpoint shapes (request bodies, headers, paths, response envelopes) → use the `jisr-api` skill / `jisr-cli` catalog (237-endpoint source of truth). Codewiki shows the backend code that implements those endpoints, but the public API contract is documented in `jisr-cli`.
- General HR / Saudi-labor-law concepts not specific to Jisr's implementation → use the relevant RAG source (`saudi-labor-law`, `gosi-social-insurance`, `qiwa-sa`, etc.).
- Anything in `alsaif-automation`, `gas-manager`, `employee-cost-system`, `nitgen-jisr-sync`, `biostar-jisr-sync` — those are our integrations on top of Jisr, not the Jisr backend itself.

## Sync note

This file is the canonical version. The 4 agent CLAUDE.mds (`claudeclaw-os/CLAUDE.md`, `comms`, `ops`, `research`) import it via `@docs/jisr-codewiki-guidance.md`. The richer source-of-truth copy lives inline as Rule 5b in `whatsapp/src/reply-composer.ts` (TypeScript template literal). When you change Rule 5b there, sync this doc — and vice versa.
