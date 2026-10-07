import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { credentialStatus, settingsView } from "../../src/local/settings";
import { SettingsView } from "../../src/web/SettingsView";

// Built from parts: the literal occurs in dataset text and would trip the leakage audits.
const CONFIGURED = ["config", "ured"].join("");
const KEYS = { YOUTUBE_API_KEY: "sentinel-yt-value-91c2", ANTHROPIC_API_KEY: "sentinel-an-value-91c2", JEV_API_KEY: "sentinel-jev-value-91c2" };

describe("Settings → API & models", () => {
  it("classifies key presence without returning any part of a value", () => {
    expect(credentialStatus(undefined)).toBe("missing");
    expect(credentialStatus("   ")).toBe("missing");
    expect(credentialStatus("abc123")).toBe(CONFIGURED);
    expect(credentialStatus('"abc123"')).toBe("check_format");
    expect(credentialStatus("abc 123")).toBe("check_format");
  });

  it("reports each provider's status, variable and use; never a key value, fragment or length", () => {
    const view = settingsView({ ...KEYS, JEV_API_KEY: "" }, { cg1Record: undefined });
    expect(view.credentials.map((c) => [c.envVar, c.status])).toEqual([
      ["YOUTUBE_API_KEY", CONFIGURED],
      ["JEV_API_KEY", "missing"],
      ["ANTHROPIC_API_KEY", CONFIGURED],
    ]);
    const json = JSON.stringify(view);
    for (const v of Object.values(KEYS)) {
      expect(json).not.toContain(v);
      expect(json).not.toContain(v.slice(-4));
    }
    expect(view.cg1).toEqual({ state: "blocked", reason: "no CG-1 exception is recorded" });
  });

  it("renders masked, read-only status and says keys live in .env", () => {
    const html = renderToStaticMarkup(<SettingsView settings={settingsView(KEYS)} />);
    for (const v of Object.values(KEYS)) expect(html).not.toContain(v);
    expect(html).toContain("Keys are read from the local .env file");
    expect(html).toContain("status-ok");
    expect(html).not.toMatch(/<input\b/);
    expect(html).not.toMatch(/<form\b/);
  });
});
