import { describe, expect, it } from "vitest";
import { runAnalysis } from "../../src/core/analysis/run-analysis";
import type { ClassifiedComment } from "../../src/core/domain/types";
import { FOCUS, goldDeps, VIDEO_ID } from "../helpers";

async function classifiedById(): Promise<Map<string, ClassifiedComment>> {
  const outcome = await runAnalysis({ videoId: VIDEO_ID, focus: FOCUS }, goldDeps());
  if (outcome.status !== "completed") throw new Error("expected completed");
  return new Map(outcome.classified.map((c) => [c.comment.id, c]));
}

describe("targeted sentiment model", () => {
  it("represents sentiment toward the creator", async () => {
    expect((await classifiedById()).get("m2-c02")!.classification.targets).toEqual({ creator: "positive", content: "not_addressed", focus: "not_addressed" });
  });

  it("represents sentiment toward the content", async () => {
    expect((await classifiedById()).get("m2-c03")!.classification.targets.content).toBe("negative");
  });

  it("represents sentiment toward the focus target", async () => {
    const c = (await classifiedById()).get("m2-c06")!;
    expect(c.classification.targets.focus).toBe("negative");
    expect(c.focusMention).toBe("explicit");
  });

  it("represents comments that address no target", async () => {
    const c = (await classifiedById()).get("m2-c29")!;
    expect(Object.values(c.classification.targets).every((t) => t === "not_addressed")).toBe(true);
    expect(c.classification.sentiment).toBe("negative");
    expect(c.focusMention).toBe("none");
  });

  it("represents multiple targets with different sentiment in one comment", async () => {
    const c = (await classifiedById()).get("m2-c32")!;
    expect(c.classification.targets).toMatchObject({ creator: "positive", content: "negative" });
  });

  it("allows target sentiment to differ from overall sentiment", async () => {
    const c = (await classifiedById()).get("m2-c07")!; // overall positive, content negative (ad placement)
    expect(c.classification.sentiment).toBe("positive");
    expect(c.classification.targets.content).toBe("negative");
  });

  it("derives focus mention type deterministically: explicit, inferred, none", async () => {
    const byId = await classifiedById();
    expect(byId.get("m2-c12")!.focusMention).toBe("explicit"); // "acme's" via alias
    expect(byId.get("m2-c11")!.focusMention).toBe("inferred"); // "Their app…"
    expect(byId.get("m2-c03")!.focusMention).toBe("none");
  });

  it("keeps an explicit name match that the classifier did not treat as addressed out of the mention count", async () => {
    const c = (await classifiedById()).get("m2-c05")!; // names Acme VPN, but only complains about the ad read
    expect(c.focusMention).toBe("explicit");
    expect(c.classification.targets.focus).toBe("not_addressed");
  });
});
