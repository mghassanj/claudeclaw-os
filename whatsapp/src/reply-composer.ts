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
4. CITATION FORMAT (strict): For EVERY RAG-grounded fact, end the reply with one or more lines in this EXACT format (one URL per line):
   Source: <full URL>
   Each URL must be the page_url from the search_enterprise_kb result you used. Do NOT cite article numbers as URLs (e.g. "Source: المادة 112" is WRONG). Use the literal page_url string returned by the tool.

5. JISR-KB SPECIAL RULE: When ANY of your sources is from source_id="jisr-kb" (the Jisr Knowledge Base — URLs at jisr.zendesk.com), the article URL is MANDATORY in the citation. Format: "Source: https://jisr.zendesk.com/hc/<locale>/articles/<id>-<slug>". The user wants to click through to read the full article — never omit it for Jisr KB content.

6. Be concise. WhatsApp readers want quick answers. 2-4 sentences for most questions.
7. If you generated media (Tier 5 or 6), include the local file path on a line "MEDIA_PATH: <path>" so the runtime can attach it.
8. If no RAG match found AND topic is clearly out-of-scope (memes, chitchat, weather), give a one-line acknowledgment and stop. Don't invent answers.

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
      ],
      cwd: "/home/ubuntu/claudeclaw-os",
      // Explicitly pass MCP servers — settingSources discovery does not reliably
      // pick up servers added after first load (imagegen/videogen were missing).
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
      },
      // Don't persist ephemeral reply sessions to disk
      persistSession: false,
    },
  })) {
    // tool_progress events carry the tool name for every tool invocation
    if (msg.type === "tool_progress") {
      const tp = msg as SDKToolProgressMessage;
      toolsCalled.push(tp.tool_name);
      if (tp.tool_name.includes("imagegen")) chosenTier = "5";
      else if (tp.tool_name.includes("videogen")) chosenTier = "6";
      else if (tp.tool_name.includes("visual")) chosenTier = "2";
    }
    // result message carries the final text and cost
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
