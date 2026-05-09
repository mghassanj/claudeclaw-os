import { describe, it, expect } from "vitest";
import { routeToSource } from "../src/routing.js";

describe("routeToSource", () => {
  it.each([
    ["What is the GOSI subscription rate?", ["gosi-social-insurance"]],
    ["نسبة اشتراك التأمينات الاجتماعية", ["gosi-social-insurance"]],
    ["How do I add a worker on Qiwa?", ["qiwa-sa"]],
    ["كيف أضيف عاملاً جديداً في قوى؟", ["qiwa-sa"]],
    ["متطلبات حماية الأجور في مدد", ["mudad-com-sa"]],
    ["Mudad wage protection requirements", ["mudad-com-sa"]],
    ["HRSD ministerial decision", ["hrsd-gov-sa"]],
    ["وزارة الموارد البشرية", ["hrsd-gov-sa"]],
    ["Vision 2030 labor goals", ["vision2030-gov-sa"]],
    ["رؤية 2030", ["vision2030-gov-sa"]],
    ["What does the labor law say about annual leave", ["saudi-labor-law", "saudi-labor-law-bylaws"]],
    ["نظام العمل المادة 50", ["saudi-labor-law", "saudi-labor-law-bylaws"]],
    ["What is the weather today", null],
  ])("routes %j", (msg, expected) => {
    expect(routeToSource(msg as string)).toEqual(expected);
  });
});
