import { describe, expect, it } from "vitest";
import { isValidNormalizedTopicName, MAX_TOPIC_NAME_WORDS, normalizeTopicName, topicIdOf } from "../../src/core/topics/normalize";

const idOf = (name: string) => topicIdOf(normalizeTopicName(name));

describe("topic name normalisation", () => {
  it.each(["Battery Life", "battery life", "battery-life", "BATTERY LIFE", "  Battery   Life  ", "battery_life", "Battery/Life", "battery life.", "Battery\tLife\n", "“Battery Life!”"])(
    "%j → battery life",
    (name) => {
      expect(normalizeTopicName(name)).toBe("battery life");
      expect(idOf(name)).toBe("topic:battery-life");
    },
  );

  it("normalises Unicode compatibility forms (NFKC) before lower-casing", () => {
    expect(normalizeTopicName("Ｂａｔｔｅｒｙ　Ｌｉｆｅ")).toBe("battery life");
    expect(normalizeTopicName("Café Scene")).toBe(normalizeTopicName("Café scene"));
  });

  it("removes apostrophes instead of splitting words", () => {
    expect(normalizeTopicName("Creator's honesty")).toBe("creators honesty");
    expect(normalizeTopicName("Creator’s Honesty")).toBe("creators honesty");
  });

  it("keeps digits and non-Latin letters; drops emoji and symbols", () => {
    expect(normalizeTopicName("4K video quality")).toBe("4k video quality");
    expect(normalizeTopicName("Größe & Gewicht")).toBe("größe gewicht");
    expect(normalizeTopicName("音质")).toBe("音质");
    expect(normalizeTopicName("🔥 Editing 🔥")).toBe("editing");
  });

  it("does no semantic or synonym inference", () => {
    expect(idOf("battery duration")).not.toBe(idOf("battery life"));
    expect(idOf("runtime")).not.toBe(idOf("battery life"));
    expect(idOf("batteries life")).not.toBe(idOf("battery life"));
  });

  it("is idempotent", () => {
    for (const name of ["Battery-Life!!", "Creator's  honesty", "Ｂａｔｔｅｒｙ"]) expect(normalizeTopicName(normalizeTopicName(name))).toBe(normalizeTopicName(name));
  });
});

describe("topic name validity and stable IDs", () => {
  it(`accepts 1–${MAX_TOPIC_NAME_WORDS} words and rejects empty or longer names`, () => {
    expect(isValidNormalizedTopicName("audio")).toBe(true);
    expect(isValidNormalizedTopicName("one two three four five")).toBe(true);
    expect(isValidNormalizedTopicName("one two three four five six")).toBe(false);
    expect(isValidNormalizedTopicName(normalizeTopicName(" !!! 🔥 "))).toBe(false);
  });

  it("derives the same ID every time and distinct IDs for distinct names", () => {
    expect(idOf("Sponsor segment")).toBe("topic:sponsor-segment");
    expect(idOf("Sponsor segment")).toBe(idOf("sponsor-segment"));
    expect(idOf("sponsor segments")).not.toBe(idOf("sponsor segment"));
    expect(idOf("audio quality")).not.toBe(idOf("audioquality"));
  });

  it("only derives IDs from valid, already-normalised names", () => {
    expect(() => topicIdOf("Battery Life")).toThrow(RangeError);
    expect(() => topicIdOf("")).toThrow(RangeError);
    expect(() => topicIdOf("a b c d e f")).toThrow(RangeError);
  });
});
