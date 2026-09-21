import { describe, it, expect } from "vitest";
import { formatForWhatsApp, splitForWhatsApp, prepareWhatsAppMessages } from "../src/tools/format.js";

const cp = (s: string) => Array.from(s).length;

describe("formatForWhatsApp", () => {
  it("converts Markdown bold, italic-underscore and strike", () => {
    expect(formatForWhatsApp("This is **important** and __subtle__ and ~~gone~~"))
      .toBe("This is *important* and _subtle_ and ~gone~");
  });

  it("leaves WhatsApp-native formatting unchanged (idempotent)", () => {
    const wa = "*bold* _italic_ ~strike~\n• item";
    expect(formatForWhatsApp(wa)).toBe(wa);
    expect(formatForWhatsApp(formatForWhatsApp("**x** # no"))).toBe(formatForWhatsApp("**x** # no"));
  });

  it("turns headings into bold lines and strips emphasis inside them", () => {
    expect(formatForWhatsApp("# Summary\ntext\n### **Next** steps ###"))
      .toBe("*Summary*\ntext\n*Next steps*");
  });

  it("converts bullets and drops horizontal rules", () => {
    expect(formatForWhatsApp("- one\n* two\n  + nested\n---\nend"))
      .toBe("• one\n• two\n  • nested\n\nend");
  });

  it("converts a Markdown table into bullet lines with a bold header", () => {
    const md = "Status:\n\n| Task | Owner | Due |\n|---|:---:|---|\n| Payroll | Sara | Sun |\n| GOSI | Ali | Mon |\n\nDone.";
    expect(formatForWhatsApp(md)).toBe(
      "Status:\n\n*Task — Owner — Due*\n• Payroll — Sara — Sun\n• GOSI — Ali — Mon\n\nDone.",
    );
  });

  it("keeps code fences (without language tag) and never rewrites their content", () => {
    const md = "Run:\n```bash\necho **not bold** | grep x\n# not a heading\n```\nthen **bold**";
    expect(formatForWhatsApp(md)).toBe(
      "Run:\n```\necho **not bold** | grep x\n# not a heading\n```\nthen *bold*",
    );
  });

  it("protects inline code spans", () => {
    expect(formatForWhatsApp("use `a**b**c` and **this**")).toBe("use `a**b**c` and *this*");
  });

  it("strips HTML tags but keeps comparisons and arrows", () => {
    expect(formatForWhatsApp("<b>Hi</b><br>line2 <span class=\"x\">ok</span> a < b, c -> d <3"))
      .toBe("Hi\nline2 ok a < b, c -> d <3");
  });

  it("rewrites Markdown links", () => {
    expect(formatForWhatsApp("See [the doc](https://x.io/a) or [https://y.io](https://y.io)"))
      .toBe("See the doc (https://x.io/a) or https://y.io");
  });

  it("collapses 3+ blank lines", () => {
    expect(formatForWhatsApp("a\n\n\n\n\nb")).toBe("a\n\nb");
  });

  it("does not damage Arabic/RTL text or emoji", () => {
    const ar = "## الملخص\n**تم** إرسال الرسالة إلى نورة ✅ 👨‍👩‍👧\n- البند الأول\n- البند الثاني";
    expect(formatForWhatsApp(ar)).toBe("*الملخص*\n*تم* إرسال الرسالة إلى نورة ✅ 👨‍👩‍👧\n• البند الأول\n• البند الثاني");
  });

  it("handles mixed Arabic table cells", () => {
    const md = "| الموظف | الحالة |\n|---|---|\n| سارة | معتمد ✅ |";
    expect(formatForWhatsApp(md)).toBe("*الموظف — الحالة*\n• سارة — معتمد ✅");
  });
});

describe("splitForWhatsApp", () => {
  it("returns short text as one message", () => {
    expect(splitForWhatsApp("hello")).toEqual(["hello"]);
    expect(splitForWhatsApp("   ")).toEqual([]);
  });

  it("splits long text at paragraph boundaries, every chunk within the limit", () => {
    const para = (n: number) => `Paragraph ${n} ` + "word ".repeat(60).trim();
    const text = Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
    const parts = splitForWhatsApp(text, 700);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(cp(p)).toBeLessThanOrEqual(700);
    // No paragraph is cut in half.
    for (const p of parts) for (const chunk of p.split("\n\n")) expect(chunk.startsWith("Paragraph ")).toBe(true);
    expect(parts.join("\n\n")).toBe(text);
  });

  it("splits a single huge paragraph by sentences/words", () => {
    const text = "This is a sentence. ".repeat(200).trim();
    const parts = splitForWhatsApp(text, 300);
    for (const p of parts) expect(cp(p)).toBeLessThanOrEqual(300);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("splits Arabic without breaking words or characters", () => {
    const sentence = "هذه جملة عربية طويلة نسبيا للتجربة؟ ";
    const text = sentence.repeat(120).trim();
    const parts = splitForWhatsApp(text, 400);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(cp(p)).toBeLessThanOrEqual(400);
      expect(p).not.toMatch(/�/);
    }
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(text);
  });

  it("never cuts an emoji ZWJ sequence or surrogate pair", () => {
    const fam = "👨‍👩‍👧";
    const text = fam.repeat(400); // no spaces, forces a hard split
    const parts = splitForWhatsApp(text, 100);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(cp(p)).toBeLessThanOrEqual(100);
      expect(p.split(fam).join("")).toBe(""); // only whole family emoji
    }
    expect(parts.join("")).toBe(text);
  });

  it("keeps a code fence intact when it fits and re-fences it when it doesn't", () => {
    const small = "intro\n\n```\nline1\n\nline2\n```\n\noutro";
    expect(splitForWhatsApp(small)).toEqual([small]);
    const bigBody = Array.from({ length: 80 }, (_, i) => `const v${i} = ${i};`).join("\n");
    const big = "Here:\n\n```\n" + bigBody + "\n```";
    const parts = splitForWhatsApp(big, 300);
    for (const p of parts) expect(cp(p)).toBeLessThanOrEqual(300);
    const codeParts = parts.filter((p) => p.includes("```"));
    expect(codeParts.length).toBeGreaterThan(1);
    for (const p of codeParts) expect(p.match(/```/g)?.length).toBe(2);
  });
});

describe("prepareWhatsAppMessages", () => {
  it("formats then splits", () => {
    const text = "# Title\n\n" + Array.from({ length: 6 }, (_, i) => `**Point ${i}** ` + "x ".repeat(150)).join("\n\n");
    const parts = prepareWhatsAppMessages(text, 500);
    expect(parts[0].startsWith("*Title*")).toBe(true);
    expect(parts.join("\n")).not.toContain("**");
    for (const p of parts) expect(cp(p)).toBeLessThanOrEqual(500);
  });
});
