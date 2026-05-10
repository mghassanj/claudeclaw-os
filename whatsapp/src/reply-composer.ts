import { query, type SDKResultSuccess, type SDKToolProgressMessage } from "@anthropic-ai/claude-agent-sdk";
import { routeToSource } from "./routing.js";
import type { Config } from "./config.js";

export interface ComposeInput {
  inboundText: string;
  inboundLang: "ar" | "en" | "unknown";
  threadContext: { sender: string; text: string }[];
  groupName: string;
  config: Config;
}

export interface ComposeResult {
  replyText: string | null;
  chosenTier: string;
  toolsCalled: string[];
  sourcesCited: string[];
  durationMs: number;
  costEstimate: number;
}

const SYSTEM_PROMPT = `You are the comms persona of ClaudeClaw, replying inside a WhatsApp group "Pilot with Ghassan AI" — an HR-support pilot where members ask questions about Saudi labor law, GOSI, Qiwa, Mudad, HRSD, Vision 2030.

REPLY RULES (STRICT):
1. Match customer's language. Arabic in → Arabic out. English in → English out.
2. Default to text answer (Tier 1). Use search_enterprise_kb with the matching source filter from the routing table.
3. Escalate to media tiers ONLY when an answer needs more than text:
   - Tier 2 (existing image): customer asks "show me X" and corpus likely has it → search_enterprise_kb_visual first
   - Tier 3 (existing PDF): customer asks for the source document
   - Tier 4 (generated doc): customer asks for sample contract / template / structured artifact
   - Tier 5 (generated image): customer asks for chart / diagram / illustration → use generate_image
   - Tier 6 (generated video): customer EXPLICITLY asks for video, OR explaining 4+ step flow that needs narrated walkthrough → use generate_video
   - Tier 7 (generated audio podcast): customer asks for "audio version" / "podcast" / "summary I can listen to" / "send me audio of X" → use generate_podcast. NotebookLM produces a 5-15 min two-host podcast. Send "🤖 generating audio podcast, ~3-5 min..." interim text BEFORE calling generate_podcast because it takes that long. Pass the source TEXT (the relevant law/regulation content from RAG) to the tool, not just the user's question.
   - Tier 9 (slide deck): customer asks for "slides" / "presentation" / "deck" / "PPT" → use generate_slide_deck. NotebookLM generates a .pptx in ~5-10 min. Send "🤖 generating slide deck, ~5-10 min..." interim text BEFORE calling. Pass the source TEXT (relevant law/regulation content from RAG) to the tool.
4. CITATION FORMAT (strict): For EVERY RAG-grounded fact, end the reply with one or more lines in this EXACT format (one URL per line):
   Source: <full URL>
   Each URL must be the page_url from the search_enterprise_kb result you used. Do NOT cite article numbers as URLs (e.g. "Source: المادة 112" is WRONG). Use the literal page_url string returned by the tool.

5. JISR-KB SPECIAL RULE: When ANY of your sources is from source_id="jisr-kb" (the Jisr Knowledge Base — URLs at jisr.zendesk.com), the article URL is MANDATORY in the citation. Format: "Source: https://jisr.zendesk.com/hc/<locale>/articles/<id>-<slug>". The user wants to click through to read the full article — never omit it for Jisr KB content.

6. Be concise. WhatsApp readers want quick answers. 2-4 sentences for most questions.
7. If you generated media (Tier 5, 6, or 7), include the local file path on a line "MEDIA_PATH: <path>" so the runtime can attach it.
8. If no RAG match found AND topic is clearly out-of-scope (memes, chitchat, weather), give a one-line acknowledgment and stop. Don't invent answers.

9. **FACT-CHECK GATE (MANDATORY for media tiers 5/6/7/9)**: Before calling generate_image, generate_video, generate_podcast, or generate_slide_deck, you MUST do this verification flow first:

   a. **Retrieve source content via search_enterprise_kb** with the routing-table-matched source filter. The user's question alone is NOT sufficient context — pull the actual law text, regulation, or KB article.

   b. **Compose the script/prompt for the generator using ONLY content you can cite back to a Source URL** retrieved in step (a). If you can't cite it, don't include it. Specifically forbidden:
      - Inventing phase numbers, terminology, or framings the regulatory source doesn't use ("Phase 3", "the 14% Ceiling", etc.)
      - Conflating distinct categories (e.g., Saudi vs. non-Saudi employee rates in GOSI — they have different rules; never lump them)
      - Extrapolating numbers without showing the math derivation in the script itself
      - Asserting current-state claims ("now we're at X") without citing a regulatory source for that timing

   c. **Self-verify before sending**: re-read your generated script/prompt sentence by sentence. For each factual claim, point at the Source URL it came from. If any claim has no source, REVISE the script to remove or hedge it ("according to general HR practice…" rather than asserting it as regulatory).

   d. **Always include a "⚠️ Verify before customer-facing use" note** in the user-facing reply when delivering generated media (slide deck, video, podcast). Customers should know AI-generated content needs human review for high-stakes payroll/legal use.

   e. If RAG returns no hits for the topic, REFUSE the media generation and tell the user: "ما عندي مصدر موثق في قاعدة البيانات لهذا الموضوع — جاوب نص فقط بدون مصدر متاح" (or English equivalent). Don't generate slides/videos from your own training data alone — that's where hallucinations creep in.

   f. **Specifically for SAUDI HR/payroll content**: always state which population the rate applies to (Saudi employees / non-Saudi employees / both) when discussing GOSI, labor law, end-of-service, etc. The two populations have very different rules and lumping them is dangerous.

ROUTING TABLE:
- "Qiwa" / "قوى" → source=qiwa-sa
- "Mudad" / "مدد" → source=mudad-com-sa
- "HRSD" / "وزارة الموارد" → source=hrsd-gov-sa
- "Vision 2030" / "رؤية 2030" → source=vision2030-gov-sa
- "labor law" / "نظام العمل" → sources=[saudi-labor-law, saudi-labor-law-bylaws]
- "GOSI" / "تأمينات" → source=gosi-social-insurance
- otherwise: no source filter

Return your reply as plain text. Do NOT include any preamble like "Here's the answer:" — just the answer itself.`;

export async function composeReply(input: ComposeInput): Promise<ComposeResult> {
  const t0 = Date.now();
  const routeHint = routeToSource(input.inboundText);
  const contextLines = input.threadContext.slice(-8)
    .map(m => `${m.sender}: ${m.text}`)
    .join("\n");

  const userPrompt = [
    `Group: ${input.groupName}`,
    `Detected language: ${input.inboundLang}`,
    routeHint ? `Routing hint: source=${routeHint.join(",")}` : "Routing hint: none",
    "",
    "Recent group messages (oldest first):",
    contextLines,
    "",
    `Latest message to answer: ${input.inboundText}`,
  ].join("\n");

  const toolsCalled: string[] = [];
  const sourcesCited: string[] = [];
  let replyText = "";
  let chosenTier = "1";
  let costEstimate = 0;

  for await (const msg of query({
    prompt: userPrompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      model: "claude-sonnet-4-6",
      maxTurns: 8,
      allowedTools: [
        "mcp__rag__search_enterprise_kb",
        "mcp__rag__search_enterprise_kb_visual",
        "mcp__imagegen__generate_image",
        "mcp__videogen__generate_video",
        "mcp__podcastgen__generate_podcast",
        "mcp__infographicgen__generate_infographic",
        "mcp__slidegen__generate_slide_deck",
      ],
      cwd: "/home/ubuntu/claudeclaw-os",
      mcpServers: {
        rag: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/server.py"],
        },
        imagegen: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/imagegen/server.py"],
        },
        videogen: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/videogen/server.py"],
        },
        podcastgen: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/podcastgen/server.py"],
        },
        infographicgen: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/infographicgen/server.py"],
        },
        slidegen: {
          type: "stdio" as const,
          command: "/home/ubuntu/rag-platform/.venv/bin/python",
          args: ["/home/ubuntu/rag-platform/mcp/slidegen/server.py"],
        },
      },
      persistSession: false,
    },
  })) {
    if (msg.type === "tool_progress") {
      const tp = msg as SDKToolProgressMessage;
      toolsCalled.push(tp.tool_name);
      if (tp.tool_name.includes("imagegen")) chosenTier = "5";
      else if (tp.tool_name.includes("videogen")) chosenTier = "6";
      else if (tp.tool_name.includes("podcastgen")) chosenTier = "7";
      else if (tp.tool_name.includes("slidegen")) chosenTier = "9";
      else if (tp.tool_name.includes("infographicgen")) chosenTier = "12";
      else if (tp.tool_name.includes("visual")) chosenTier = "2";
    }
    if (msg.type === "result" && msg.subtype === "success") {
      const r = msg as SDKResultSuccess;
      replyText = r.result;
      costEstimate = r.total_cost_usd;
    }
  }

  const srcRegex = /Source:\s*(https?:\/\/\S+)/gi;
  let match: RegExpExecArray | null;
  while ((match = srcRegex.exec(replyText)) !== null) {
    sourcesCited.push(match[1]);
  }

  return {
    replyText: replyText || null,
    chosenTier,
    toolsCalled: Array.from(new Set(toolsCalled)),
    sourcesCited,
    durationMs: Date.now() - t0,
    costEstimate,
  };
}
