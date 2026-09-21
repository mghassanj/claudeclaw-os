import { describe, it, expect, vi, beforeEach } from 'vitest';

// memory-ingest imports its fallback extractor from ./anthropic.js (the old
// ./gemini.js mock no longer intercepted anything).
vi.mock('./anthropic.js', () => ({
  generateContent: vi.fn(),
  parseJsonResponse: vi.fn(),
}));

vi.mock('./pa-intake.js', async () => {
  const actual = await vi.importActual<typeof import('./pa-intake.js')>('./pa-intake.js');
  return {
    normalizeKind: actual.normalizeKind,
    pinPreferenceMemory: vi.fn(),
    recordCommitmentFromIntake: vi.fn(() => 7),
    upsertPersonFromIntake: vi.fn(() => 3),
  };
});

// Mock the Claude SDK so the new Anthropic-Haiku ingestion path doesn't
// actually try to spawn a subprocess in tests. We force it to throw so
// the code falls back to the mocked Gemini path the existing tests
// already exercise.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(() => {
    async function* failing(): AsyncGenerator<never> {
      throw new Error('mocked: Claude SDK unavailable in test env');
    }
    return failing();
  }),
}));

vi.mock('./security.js', () => ({
  getScrubbedSdkEnv: vi.fn(() => ({})),
}));

vi.mock('./active-provider.js', () => ({
  getSelectedProviderConfig: vi.fn(() => ({ type: 'claude' })),
  defaultModelForProvider: vi.fn(() => 'claude-haiku-4-5-20251001'),
}));

vi.mock('./agent-engine/index.js', () => ({
  EngineFactory: {
    forProvider: vi.fn(() => ({
      async *invoke(): AsyncGenerator<never> {
        throw new Error('mocked: provider engine unavailable in test env');
      },
    })),
  },
}));

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({})),
}));

vi.mock('./db.js', () => ({
  saveStructuredMemoryAtomic: vi.fn(() => 1),
  getMemoriesWithEmbeddings: vi.fn(() => []),
}));

vi.mock('./embeddings.js', () => ({
  embedText: vi.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
  cosineSimilarity: vi.fn(() => 0),
}));

vi.mock('./logger.js', () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { ingestConversationTurn } from './memory-ingest.js';
import { generateContent, parseJsonResponse } from './anthropic.js';
import { pinPreferenceMemory, recordCommitmentFromIntake, upsertPersonFromIntake } from './pa-intake.js';
import { saveStructuredMemoryAtomic } from './db.js';

const mockGenerateContent = vi.mocked(generateContent);
const mockParseJson = vi.mocked(parseJsonResponse);
const mockSave = vi.mocked(saveStructuredMemoryAtomic);

describe('ingestConversationTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Hard filters (skip before hitting Gemini) ────────────────────

  it('skips messages <= 15 characters', async () => {
    const result = await ingestConversationTurn('chat1', 'short msg', 'ok');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('skips messages exactly 15 characters', async () => {
    const result = await ingestConversationTurn('chat1', '123456789012345', 'ok');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  it('processes messages of 16 characters', async () => {
    mockGenerateContent.mockResolvedValue('{}');
    mockParseJson.mockReturnValue({ skip: true });
    const result = await ingestConversationTurn('chat1', '1234567890123456', 'ok');
    // Should have called Gemini even though it was skipped by LLM
    expect(mockGenerateContent).toHaveBeenCalled();
    expect(result).toBe(false);
  });

  it('skips messages starting with /', async () => {
    const result = await ingestConversationTurn('chat1', '/chatid some long command text here', 'Your ID is 12345');
    expect(result).toBe(false);
    expect(mockGenerateContent).not.toHaveBeenCalled();
  });

  // ── Gemini decides to skip ────────────────────────────────────────

  it('returns false when Gemini says skip', async () => {
    mockGenerateContent.mockResolvedValue('{"skip": true}');
    mockParseJson.mockReturnValue({ skip: true });
    const result = await ingestConversationTurn('chat1', 'ok sounds good thanks for doing that', 'No problem.');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('returns false when Gemini returns null (parse failure)', async () => {
    mockGenerateContent.mockResolvedValue('garbage');
    mockParseJson.mockReturnValue(null);
    const result = await ingestConversationTurn('chat1', 'some message that is long enough', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Gemini extracts a memory ──────────────────────────────────────

  it('saves a structured memory on valid extraction', async () => {
    const extraction = {
      skip: false,
      summary: 'User prefers dark mode in all applications',
      entities: ['dark mode', 'UI'],
      topics: ['preferences', 'UI'],
      importance: 0.8,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn(
      'chat1',
      'I always want dark mode enabled in everything',
      'Got it, I will remember your dark mode preference.',
    );

    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      'I always want dark mode enabled in everything',
      'User prefers dark mode in all applications',
      ['dark mode', 'UI'],
      ['preferences', 'UI'],
      0.8,
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  // ── Importance filtering ──────────────────────────────────────────

  it('skips extraction with importance < 0.3', async () => {
    const extraction = {
      skip: false,
      summary: 'Trivial fact',
      entities: [],
      topics: [],
      importance: 0.25,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some trivial message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips extraction with importance exactly 0.2 (below 0.3 floor)', async () => {
    const extraction = {
      skip: false,
      summary: 'Low importance fact',
      entities: [],
      topics: [],
      importance: 0.2,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some borderline message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips extraction with importance exactly 0.3 (below 0.5 floor)', async () => {
    const extraction = {
      skip: false,
      summary: 'Borderline fact',
      entities: [],
      topics: [],
      importance: 0.3,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some borderline message longer than fifteen', 'ok');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('saves extraction with importance exactly 0.5', async () => {
    const extraction = {
      skip: false,
      summary: 'Useful fact',
      entities: [],
      topics: [],
      importance: 0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'some useful message longer than fifteen', 'ok');
    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalled();
  });

  // ── Importance clamping ───────────────────────────────────────────

  it('clamps importance above 1.0 to 1.0', async () => {
    const extraction = {
      skip: false,
      summary: 'Very important',
      entities: [],
      topics: [],
      importance: 1.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    await ingestConversationTurn('chat1', 'extremely important message for testing', 'noted');
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      expect.any(String),
      'Very important',
      [],
      [],
      1.0,  // clamped
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  it('clamps negative importance to 0', async () => {
    const extraction = {
      skip: false,
      summary: 'Negative importance',
      entities: [],
      topics: [],
      importance: -0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    // importance -0.5 < 0.2 threshold, so it should be skipped
    const result = await ingestConversationTurn('chat1', 'message with negative importance test', 'response');
    expect(result).toBe(false);
  });

  // ── Validation of required fields ─────────────────────────────────

  it('skips when summary is missing', async () => {
    const extraction = {
      skip: false,
      summary: '',
      entities: [],
      topics: [],
      importance: 0.7,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message with no summary extracted from it', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('skips when importance is not a number', async () => {
    const extraction = {
      skip: false,
      summary: 'Valid summary',
      entities: [],
      topics: [],
      importance: 'high' as unknown as number,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message where importance is a string', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Missing optional fields ───────────────────────────────────────

  it('handles missing entities and topics gracefully', async () => {
    const extraction = {
      skip: false,
      summary: 'No entities or topics',
      importance: 0.5,
    };
    mockGenerateContent.mockResolvedValue(JSON.stringify(extraction));
    mockParseJson.mockReturnValue(extraction);

    const result = await ingestConversationTurn('chat1', 'message with no entities or topics at all', 'response');
    expect(result).toBe(true);
    expect(mockSave).toHaveBeenCalledWith(
      'chat1',
      expect.any(String),
      'No entities or topics',
      [],  // defaults to empty
      [],  // defaults to empty
      0.5,
      expect.any(Array),
      'conversation',
      'main',
    );
  });

  // ── Error handling ────────────────────────────────────────────────

  it('returns false when Gemini API throws', async () => {
    mockGenerateContent.mockRejectedValue(new Error('API rate limited'));

    const result = await ingestConversationTurn('chat1', 'this message should not crash the bot', 'response');
    expect(result).toBe(false);
    expect(mockSave).not.toHaveBeenCalled();
  });

  // ── Message truncation ────────────────────────────────────────────

  it('truncates long messages to 2000 chars in prompt', async () => {
    mockGenerateContent.mockResolvedValue('{"skip": true}');
    mockParseJson.mockReturnValue({ skip: true });

    const longMsg = 'x'.repeat(5000);
    await ingestConversationTurn('chat1', longMsg, 'response');

    const promptArg = mockGenerateContent.mock.calls[0][0];
    // The prompt should contain the truncated message, not the full 5000 chars
    expect(promptArg).not.toContain('x'.repeat(3000));
    expect(promptArg).toContain('x'.repeat(2000));
  });
});

describe('typed intake', () => {
  const mockPin = vi.mocked(pinPreferenceMemory);
  const mockCommit = vi.mocked(recordCommitmentFromIntake);
  const mockPerson = vi.mocked(upsertPersonFromIntake);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function extract(obj: Record<string, unknown>): void {
    mockGenerateContent.mockResolvedValue(JSON.stringify(obj));
    mockParseJson.mockReturnValue(obj);
  }

  it('prompt asks for a kind', async () => {
    extract({ skip: true });
    await ingestConversationTurn('chat1', 'a message long enough to process', 'ok');
    const prompt = mockGenerateContent.mock.calls[0][0] as string;
    expect(prompt).toContain('"kind": "fact" | "preference" | "person" | "commitment"');
    expect(prompt).toContain('COMMITMENTS');
  });

  it('no kind = fact: saved exactly as before, no side effects', async () => {
    extract({ skip: false, summary: 'Standing rule X', entities: [], topics: [], importance: 0.7 });
    expect(await ingestConversationTurn('chat1', 'from now on always do X please', 'ok')).toBe(true);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockPin).not.toHaveBeenCalled();
    expect(mockCommit).not.toHaveBeenCalled();
    expect(mockPerson).not.toHaveBeenCalled();
  });

  it('preference is saved and pinned', async () => {
    extract({ kind: 'preference', summary: 'Reply in Najdi Arabic', entities: [], topics: [], importance: 0.9 });
    expect(await ingestConversationTurn('chat1', 'always answer me in Najdi when I write Arabic', 'ok')).toBe(true);
    expect(mockSave).toHaveBeenCalledTimes(1);
    expect(mockPin).toHaveBeenCalledWith(1);
  });

  it('person upserts a contact and still saves the memory row', async () => {
    const person = { name: 'Nora', relationship: 'client HR lead', language_pref: 'ar-najdi' };
    extract({ kind: 'person', summary: 'Nora is the client HR lead', entities: ['Nora'], topics: [], importance: 0.7, person });
    expect(await ingestConversationTurn('chat1', 'Nora is the HR lead at the client, talk to her in Najdi', 'noted')).toBe(true);
    expect(mockPerson).toHaveBeenCalledWith(person);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('commitment becomes an unconfirmed open loop, not a memory row (even below 0.5)', async () => {
    const commitment = { summary: 'Follow up with Nora on Thursday', due: '1d', contact_name: 'Nora' };
    extract({ kind: 'commitment', summary: 'Follow up with Nora', entities: [], topics: [], importance: 0.3, commitment });
    expect(await ingestConversationTurn('chat1', 'remind me to follow up with Nora tomorrow', 'will do')).toBe(true);
    expect(mockCommit).toHaveBeenCalledWith(commitment, 'Follow up with Nora', 'main');
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('no contact/loop side effects for scheduled, mission or loop-fired turns, or other agents', async () => {
    extract({ kind: 'commitment', summary: 'x', entities: [], topics: [], importance: 0.8, commitment: { summary: 'x' } });
    expect(await ingestConversationTurn('chat1', '[Scheduled task]: remind Mohamed about rent', 'ok')).toBe(false);
    expect(await ingestConversationTurn('chat1', '[Open loop #4 fired] new message from Nora', 'ok')).toBe(false);
    expect(await ingestConversationTurn('chat1', 'I will follow up with the vendor tomorrow', 'ok', 'comms')).toBe(false);
    expect(mockCommit).not.toHaveBeenCalled();

    extract({ kind: 'person', summary: 'Omar is a vendor', entities: [], topics: [], importance: 0.6, person: { name: 'Omar' } });
    await ingestConversationTurn('chat1', 'Omar is our vendor contact for printing', 'ok', 'comms');
    expect(mockPerson).not.toHaveBeenCalled();
    expect(mockSave).toHaveBeenCalledTimes(1);
  });

  it('a side-effect failure never loses the memory row', async () => {
    mockPin.mockImplementationOnce(() => { throw new Error('db locked'); });
    extract({ kind: 'preference', summary: 'Short answers', entities: [], topics: [], importance: 0.8 });
    expect(await ingestConversationTurn('chat1', 'keep your answers short from now on', 'ok')).toBe(true);
    expect(mockSave).toHaveBeenCalledTimes(1);
  });
});
