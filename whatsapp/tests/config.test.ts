import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig } from "../src/config.js";

describe("config", () => {
  beforeEach(() => {
    delete process.env.WHATSAPP_ENABLED;
    delete process.env.WHATSAPP_ALLOWED_GROUPS;
    delete process.env.WHATSAPP_TIERS_ENABLED;
    delete process.env.WHATSAPP_QR_PORT;
  });

  it("defaults: disabled, no groups, all tiers", () => {
    const c = loadConfig();
    expect(c.enabled).toBe(false);
    expect(c.allowedGroups).toEqual([]);
    expect(c.tiersEnabled).toEqual(new Set(["1","2","3","4","5","6","7","8"]));
    expect(c.qrPort).toBe(9334);
  });

  it("parses single group", () => {
    process.env.WHATSAPP_ENABLED = "true";
    process.env.WHATSAPP_ALLOWED_GROUPS = "Pilot with Ghassan AI";
    expect(loadConfig().allowedGroups).toEqual(["Pilot with Ghassan AI"]);
  });

  it("parses multiple groups, trims spaces", () => {
    process.env.WHATSAPP_ALLOWED_GROUPS = "A, B ,C";
    expect(loadConfig().allowedGroups).toEqual(["A","B","C"]);
  });

  it("parses tier subset", () => {
    process.env.WHATSAPP_TIERS_ENABLED = "1,2,3";
    expect(loadConfig().tiersEnabled).toEqual(new Set(["1","2","3"]));
  });

  it("isGroupAllowed handles exact match", () => {
    process.env.WHATSAPP_ALLOWED_GROUPS = "Pilot with Ghassan AI";
    const c = loadConfig();
    expect(c.isGroupAllowed("Pilot with Ghassan AI")).toBe(true);
    expect(c.isGroupAllowed("Other Group")).toBe(false);
  });

  it("isTierEnabled", () => {
    process.env.WHATSAPP_TIERS_ENABLED = "1,2,3";
    const c = loadConfig();
    expect(c.isTierEnabled("1")).toBe(true);
    expect(c.isTierEnabled("5")).toBe(false);
  });
});
