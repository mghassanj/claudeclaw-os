import { query } from "@anthropic-ai/claude-agent-sdk";

import { logger } from "./logger.js";

/**
 * Drop-in replacement for gemini.ts's generateContent that uses the
 * Claude Code agent SDK against the user's Pro/Max subscription
 * (CLAUDE_CODE_OAUTH_TOKEN). Spawns `claude -p` under the hood, so latency
 * is similar to a `claude --print` subprocess (~2-5s per call). Use only for
 * non-voice LLM work — voice paths stay on Gemini per project policy.
 *
 * Configured to behave like a one-shot text generator:
 *   - maxTurns: 1            -> no agent loop, no tool follow-ups
 *   - allowedTools: []       -> tools fully disabled
 *   - settingSources: []     -> no CLAUDE.md / skills / MCP loading
 *   - cwd: /tmp              -> neutral working dir
 *   - includePartialMessages -> off; we read the final `result` event
 *
 * The default system prompt forces JSON-only output so the existing
 * parseJsonResponse (markdown-fence-stripping) keeps working as a parser.
 */
const JSON_SYSTEM_PROMPT =
  "You are a JSON-only responder. Return ONLY valid JSON matching the structure the user requests. No prose, no preamble, no explanation, no markdown fences. If the user asks for skip behavior, return that exact JSON shape. If they ask for an object, return one object.";

export async function generateContent(
  prompt: string,
  model = "claude-opus-4-7",
): Promise<string> {
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!oauthToken) {
    throw new Error(
      "CLAUDE_CODE_OAUTH_TOKEN is not set. Run `claude setup-token` and add the result to .env.",
    );
  }

  let resultText: string | null = null;
  try {
    for await (const event of query({
      prompt,
      options: {
        model,
        maxTurns: 1,
        allowedTools: [],
        settingSources: [],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: "/tmp",
        systemPrompt: JSON_SYSTEM_PROMPT,
        includePartialMessages: false,
        env: {
          ...process.env,
          CLAUDE_CODE_OAUTH_TOKEN: oauthToken,
        },
      },
    })) {
      const ev = event as Record<string, unknown>;
      if (ev["type"] === "result") {
        resultText = (ev["result"] as string | null | undefined) ?? null;
      }
    }
  } catch (err) {
    logger.error({ err, model }, "Claude (agent SDK) generateContent failed");
    throw err;
  }

  if (!resultText) {
    logger.warn({ model }, "Claude returned empty result");
    return "";
  }
  return resultText;
}

/**
 * Parse a JSON response from Claude. Mirrors the Gemini parser exactly:
 * strips markdown fences, returns null on parse failure (caller decides
 * fallback behavior).
 */
export function parseJsonResponse<T>(text: string): T | null {
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    return JSON.parse(cleaned) as T;
  } catch (err) {
    logger.warn({ err, text: text.slice(0, 200) }, "Failed to parse Claude JSON response");
    return null;
  }
}
