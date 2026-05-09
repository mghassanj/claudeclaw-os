import { franc } from "franc-min";

export function detectLang(text: string): "ar" | "en" | "unknown" {
  const t = (text ?? "").trim();
  if (t.length < 10) return "unknown";
  const code = franc(t, { minLength: 10, only: ["arb", "eng"] });
  if (code === "arb") return "ar";
  if (code === "eng") return "en";
  return "unknown";
}
