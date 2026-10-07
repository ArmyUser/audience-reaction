import type { PriceTable } from "../../src/core/cost/usage";
import { FIXTURE } from "../helpers";

// Mock transport for the Jev adapter (injected fetch). No network.

export const TEST_JEV_KEY = "jev-test-key-DO-NOT-LEAK-0000";
export const JEV_PRICES: PriceTable = {
  "jev-latest": { inputPerMTok: 0.042, outputPerMTok: 0, source: "test" },
  "jev-preview": { inputPerMTok: 0.042, outputPerMTok: 0, source: "test" },
};

export interface JevCall {
  url: string;
  headers: Record<string, string>;
  body: { model: string; state: { comment: string; focus_target: unknown }; questions: Record<string, { type: string; criteria?: Record<string, string> }> };
}

export type JevResponder = (call: JevCall, index: number) => Response | Promise<Response>;

export function mockJevFetch(responder: JevResponder) {
  const calls: JevCall[] = [];
  const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: JevCall = {
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)) as JevCall["body"],
    };
    calls.push(call);
    const result = responder(call, calls.length - 1);
    const signal = init?.signal;
    if (!signal) return result;
    return Promise.race([
      result,
      new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    ]);
  };
  return { fetch: fetchImpl as unknown as typeof fetch, calls };
}

export function jevResponse(answers: Record<string, unknown>, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 900, output_tokens: 60 } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function choice(key: string, options: string[] = [key]) {
  return { type: "choice", choice: key, probabilities: Object.fromEntries(options.map((o) => [o, o === key ? 0.9 : 0.1 / Math.max(1, options.length - 1)])), confidence: 0.85 };
}

export function noul(p: number) {
  return { type: "noul", noul: p };
}

/**
 * Answers matching the fixture gold labels for the comment in the request's state, for whichever question set the
 * request uses (jev-q1: one Choice per target; jev-q2: addressed Noul + sentiment Choice per target).
 */
export function goldJevResponder(): JevResponder {
  const byText = new Map(FIXTURE.comments.map((c) => [c.text, c.gold]));
  return (call) => {
    const g = byText.get(call.body.state.comment);
    if (!g) return jevResponse({});
    const answers: Record<string, unknown> = {
      type: choice(g.type),
      sentiment: choice(g.sentiment),
      is_question: noul(g.isQuestion ? 0.93 : 0.04),
      is_request: noul(g.isRequest ? 0.91 : 0.06),
    };
    for (const target of ["creator", "content", "focus"] as const) {
      const label = g.targets[target];
      if (`target_${target}` in call.body.questions) answers[`target_${target}`] = choice(label);
      if (`${target}_addressed` in call.body.questions) {
        answers[`${target}_addressed`] = noul(label === "not_addressed" ? 0.07 : 0.92);
        // A gated-off target still needs a valid sentiment answer; "neutral" is what a model would plausibly give.
        answers[`${target}_sentiment`] = choice(label === "not_addressed" ? "neutral" : label);
      }
    }
    return jevResponse(answers);
  };
}
