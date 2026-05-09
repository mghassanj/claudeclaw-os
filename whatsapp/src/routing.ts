type Rule = { keywords: RegExp; sources: string[] };

const RULES: Rule[] = [
  { keywords: /\b(qiwa)\b|قوى/i,                                 sources: ["qiwa-sa"] },
  { keywords: /\b(mudad)\b|مدد/i,                                sources: ["mudad-com-sa"] },
  { keywords: /\b(hrsd)\b|وزارة\s+الموارد/i,                     sources: ["hrsd-gov-sa"] },
  { keywords: /\b(vision\s*2030)\b|رؤية\s*2030/i,                sources: ["vision2030-gov-sa"] },
  { keywords: /\b(labor\s*law|labour\s*law)\b|نظام\s+العمل/i,    sources: ["saudi-labor-law", "saudi-labor-law-bylaws"] },
  { keywords: /\b(gosi)\b|التأمينات\s+الاجتماعية|تأمينات/i,     sources: ["gosi-social-insurance"] },
];

export function routeToSource(message: string): string[] | null {
  for (const r of RULES) {
    if (r.keywords.test(message)) return r.sources;
  }
  return null;
}
