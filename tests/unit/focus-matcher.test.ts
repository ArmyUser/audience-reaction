import { describe, expect, it } from "vitest";
import { createFocusMatcher } from "../../src/core/classification/focus-matcher";

const matches = createFocusMatcher({ name: "Acme VPN", aliases: ["Acme", "AcmeVPN"] });

describe("createFocusMatcher (explicit mentions)", () => {
  it.each([
    "Acme VPN is great",
    "acme vpn is great",
    "I tried acme-vpn yesterday",
    "acme's new pricing",
    "Acme’s app",
    "ACME again?",
    "using AcmeVPN since 2024",
    "(acme)",
  ])("matches %j", (text) => expect(matches(text)).toBe(true));

  it.each([
    "Acmetastic product",
    "the acmeologist said",
    "their app keeps crashing",
    "the sponsor was annoying",
    "",
  ])("does not match %j", (text) => expect(matches(text)).toBe(false));

  it("treats regex characters in names literally", () => {
    const m = createFocusMatcher({ name: "C++ Tools (Pro)", aliases: [] });
    expect(m("I love C++ Tools (Pro)!")).toBe(true);
    expect(m("C Tools Pro")).toBe(false);
  });

  it("never matches with an empty name and aliases", () => {
    expect(createFocusMatcher({ name: " ", aliases: [""] })("anything")).toBe(false);
  });
});
