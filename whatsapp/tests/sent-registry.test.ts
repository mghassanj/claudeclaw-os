import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

describe("sent registry persistence", () => {
  let file: string;
  beforeEach(() => {
    file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "wa-reg-")), "ids.json");
    process.env.WA_SENT_REGISTRY_PATH = file;
    vi.resetModules();
  });

  it("remembers sent ids across a restart (module reload)", async () => {
    const a = await import("../src/sent-registry.js");
    a.markSent("true_self@lid_ABC_out");
    expect(a.wasSentByBot("true_self@lid_ABC_out")).toBe(true);
    vi.resetModules();
    const b = await import("../src/sent-registry.js");
    expect(b.wasSentByBot("true_self@lid_ABC_out")).toBe(true);
    expect(b.wasSentByBot("other")).toBe(false);
  });

  it("starts empty on a missing or corrupt file", async () => {
    fs.writeFileSync(file, "{not json");
    const a = await import("../src/sent-registry.js");
    expect(a.wasSentByBot("x")).toBe(false);
    a.markSent("x");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toContain("x");
  });

  it("caps the stored ids at 1000", async () => {
    const a = await import("../src/sent-registry.js");
    for (let i = 0; i < 1100; i++) a.markSent(`id${i}`);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).length).toBeLessThanOrEqual(1000);
    expect(a.wasSentByBot("id1099")).toBe(true);
  });
});
