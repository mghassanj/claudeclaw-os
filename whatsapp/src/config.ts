export interface Config {
  enabled: boolean;
  allowedGroups: string[];
  tiersEnabled: Set<string>;
  qrPort: number;
  isGroupAllowed: (groupName: string) => boolean;
  isTierEnabled: (tier: string) => boolean;
}

export function loadConfig(): Config {
  const enabled = (process.env.WHATSAPP_ENABLED ?? "false").toLowerCase() === "true";
  const allowedGroups = (process.env.WHATSAPP_ALLOWED_GROUPS ?? "")
    .split(",").map(s => s.trim()).filter(Boolean);
  const tiersEnabled = new Set(
    (process.env.WHATSAPP_TIERS_ENABLED ?? "1,2,3,4,5,6,7,8")
      .split(",").map(s => s.trim()).filter(Boolean)
  );
  const qrPort = parseInt(process.env.WHATSAPP_QR_PORT ?? "9334", 10);
  return {
    enabled, allowedGroups, tiersEnabled, qrPort,
    isGroupAllowed: (g) => allowedGroups.includes(g),
    isTierEnabled: (t) => tiersEnabled.has(t),
  };
}

let _current: Config = loadConfig();
export function currentConfig(): Config { return _current; }
export function reloadConfig(): Config { _current = loadConfig(); return _current; }
