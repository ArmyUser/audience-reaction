import type { TopicAssigner, TopicAssignmentRequest, TopicTaxonomyGenerator, TopicTaxonomyRequest } from "../../core/ports";
import type { FixtureDecision } from "./fixture-topic-discoverer";

// Test-only fakes for the two topic phases. Scripted per call (call n uses step n; the last step repeats), they record
// every request and never read comment text or call anything external. An Error step is thrown as a provider failure.

/** Replays scripted taxonomy proposals (raw, untrusted; may be invalid on purpose). */
export class FixtureTopicTaxonomyGenerator implements TopicTaxonomyGenerator {
  readonly label = "Fake taxonomy generator (fixture)";
  readonly requests: TopicTaxonomyRequest[] = [];

  constructor(private readonly steps: readonly unknown[]) {
    if (steps.length === 0) throw new RangeError("At least one taxonomy step is required");
  }

  async proposeTaxonomy(request: TopicTaxonomyRequest): Promise<unknown> {
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)];
    this.requests.push(structuredClone(request));
    if (step instanceof Error) throw step;
    return structuredClone(step);
  }
}

export type FixtureAssignerStep =
  | {
      /** Comment ID → its one disposition (same shape as the single-phase fixture). */
      decisions: Record<string, FixtureDecision>;
      /** Requested comments not in `decisions`: an explicit `no_specific_topic`, or nothing (a missing assignment). */
      unlisted: "no_specific_topic" | "omit";
      /** Appended verbatim, e.g. a second entry for a comment or a malformed entry. */
      extraEntries?: unknown[];
    }
  | Error;

/** Replays scripted dispositions for the requested comments only (so affected-only retries are observable). */
export class FixtureTopicAssigner implements TopicAssigner {
  readonly label = "Fake topic assigner (fixture)";
  readonly requests: TopicAssignmentRequest[] = [];

  constructor(private readonly steps: readonly FixtureAssignerStep[]) {
    if (steps.length === 0) throw new RangeError("At least one assignment step is required");
  }

  async assignTopics(request: TopicAssignmentRequest): Promise<unknown[]> {
    const step = this.steps[Math.min(this.requests.length, this.steps.length - 1)]!;
    this.requests.push(structuredClone(request));
    if (step instanceof Error) throw step;
    const entries = request.comments.flatMap((c) => {
      if (Object.hasOwn(step.decisions, c.id)) return [{ commentId: c.id, ...step.decisions[c.id]! }];
      return step.unlisted === "no_specific_topic" ? [{ commentId: c.id, disposition: "no_specific_topic" }] : [];
    });
    return [...entries, ...structuredClone(step.extraEntries ?? [])];
  }
}
