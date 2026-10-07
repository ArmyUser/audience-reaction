import { COMMENT_TYPES } from "../domain/types";
import type { ClassificationSchema } from "./schema";

/**
 * Provider-neutral JSON Schema for classifier output, for providers that support schema-constrained output.
 * Uses only widely supported keywords (no length/number constraints; additionalProperties: false everywhere).
 * Comment ids are not enumerated so the schema stays identical across batches; ids, counts and combination rules
 * are enforced afterwards by validation.ts, which is the source of truth.
 */
export function classificationJsonSchema(schema: ClassificationSchema): Record<string, unknown> {
  const targetLabels = ["not_addressed", ...schema.sentimentLabels];
  const targetProperties = Object.fromEntries(schema.targets.map((t) => [t, { type: "string", enum: targetLabels }]));
  return {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["commentId", "type", "isQuestion", "isRequest", "sentiment", "targets"],
          properties: {
            commentId: { type: "string" },
            type: { type: "string", enum: [...COMMENT_TYPES] },
            isQuestion: { type: "boolean" },
            isRequest: { type: "boolean" },
            sentiment: { type: "string", enum: [...schema.sentimentLabels] },
            targets: {
              type: "object",
              additionalProperties: false,
              required: [...schema.targets],
              properties: targetProperties,
            },
          },
        },
      },
    },
  };
}
