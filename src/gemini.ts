import { GoogleGenAI } from '@google/genai';

import { GOOGLE_API_KEY } from './config.js';
import { logger } from './logger.js';
import { requireEnabled } from './kill-switches.js';

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (client) return client;
  if (!GOOGLE_API_KEY) {
    throw new Error('GOOGLE_API_KEY is not set. Add it to .env for memory extraction.');
  }
  client = new GoogleGenAI({ apiKey: GOOGLE_API_KEY });
  return client;
}

/**
 * Generate text content via Gemini.
 * Defaults to gemini-2.0-flash. The 2.5 migration is tracked separately
 * — 2.0-flash retires June 2026 and new GCP projects already see 404s,
 * so the default bump belongs in its own PR with a changelog note.
 */
export async function generateContent(
  prompt: string,
  model = 'gemini-2.0-flash',
): Promise<string> {
  // Kill-switch: refuse Gemini calls when LLM_SPAWN_ENABLED is off.
  // Memory ingestion, classifier paths, and any other generateContent
  // caller all flow through here.
  requireEnabled('LLM_SPAWN_ENABLED');

  // No key configured — silently return empty so callers degrade gracefully
  // instead of crashing. Memory, consolidation, etc. simply skip.
  if (!GOOGLE_API_KEY) return '';

  const ai = getClient();
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        responseMimeType: 'application/json',
      },
    });
    if (!response.text) {
      logger.warn({ model }, 'Gemini returned empty response');
      return '';
    }
    return response.text;
  } catch (err) {
    logger.error({ err, model }, 'Gemini generateContent failed');
    throw err;
  }
}

/**
 * Parse a JSON response from Gemini, with fallback on malformed output.
 * Returns null if parsing fails.
 */
export function parseJsonResponse<T>(text: string): T | null {
  // Try four extraction strategies in order, most permissive last:
  //   1. Bare JSON (Gemini's responseMimeType=application/json case)
  //   2. JSON inside ```json ... ``` fences (Haiku tends to wrap)
  //   3. JSON inside generic ``` ... ``` fences
  //   4. First {...} block in the text (Haiku also tends to add prose
  //      AFTER the fence, which broke the previous regex anchor).
  const candidates: string[] = [];
  const trimmed = text.trim();
  candidates.push(trimmed);
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) candidates.push(fenced[1].trim());
  const firstObj = trimmed.match(/\{[\s\S]*\}/);
  if (firstObj) candidates.push(firstObj[0]);

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // try next
    }
  }
  logger.warn({ text: text.slice(0, 200) }, 'Failed to parse JSON response');
  return null;
}
