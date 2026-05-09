import { describe, it, expect } from "vitest";
import { detectLang } from "../src/lang.js";

describe("detectLang", () => {
  it("detects arabic", () => {
    expect(detectLang("هذه فقرة نصية باللغة العربية تحتوي على معلومات عن نظام العمل."))
      .toBe("ar");
  });
  it("detects english", () => {
    expect(detectLang("This is an English paragraph about Saudi labor law and provisions."))
      .toBe("en");
  });
  it("returns unknown for empty", () => {
    expect(detectLang("")).toBe("unknown");
  });
  it("returns unknown for very short", () => {
    expect(detectLang("hi")).toBe("unknown");
  });
});
