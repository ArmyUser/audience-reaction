import Anthropic from "@anthropic-ai/sdk";
import type { PriceTable } from "../../src/core/cost/usage";
import { FIXTURE } from "../helpers";

// Mock transport for the real Anthropic SDK client: no network, but the SDK's own request building, retries,
// timeouts and error classes are exercised.

export const TEST_API_KEY = "sk-ant-test-DO-NOT-LEAK-0000";
export const PRICES: PriceTable = { "claude-haiku-4-5": { inputPerMTok: 1, outputPerMTok: 5, source: "test" } };

export interface CapturedRequest {
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export type Responder = (request: CapturedRequest, callIndex: number) => Response | Promise<Response>;

export function mockClient(responder: Responder, options: { maxRetries?: number; timeout?: number } = {}) {
  const calls: CapturedRequest[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const request = { body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers };
    calls.push(request);
    const signal = init?.signal;
    const response = responder(request, calls.length - 1);
    if (!signal) return response;
    return Promise.race([
      response,
      new Promise<Response>((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    ]);
  };
  const client = new Anthropic({ apiKey: TEST_API_KEY, fetch: fetch as never, maxRetries: options.maxRetries ?? 0, timeout: options.timeout ?? 5_000 });
  return { client, calls };
}

export function messageResponse(
  text: string,
  options: { stopReason?: string; inputTokens?: number; outputTokens?: number; status?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      id: "msg_test",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text }],
      stop_reason: options.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: { input_tokens: options.inputTokens ?? 1000, output_tokens: options.outputTokens ?? 400 },
    }),
    { status: options.status ?? 200, headers: { "content-type": "application/json" } },
  );
}

export function errorResponse(status: number, type: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message: `${type} (test)` } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Comment ids and texts sent in the request's data block. */
export function requestComments(request: CapturedRequest): { commentId: string; text: string }[] {
  const messages = request.body.messages as { content: string }[];
  const content = messages[0]!.content;
  const json = content.slice(content.indexOf("<comment_data>") + "<comment_data>".length, content.indexOf("</comment_data>"));
  return (JSON.parse(json) as { comments: { commentId: string; text: string }[] }).comments;
}

/** A well-behaved model: returns the fixture gold labels for exactly the requested comments. */
export function goldResponder(focus: boolean): Responder {
  const byId = new Map(FIXTURE.comments.map((c) => [c.id, c.gold]));
  return (request) => {
    const results = requestComments(request).map(({ commentId }) => {
      const g = byId.get(commentId)!;
      const { focus: focusLabel, ...targets } = g.targets;
      return { commentId, type: g.type, isQuestion: g.isQuestion, isRequest: g.isRequest, sentiment: g.sentiment, targets: focus ? { ...targets, focus: focusLabel } : targets };
    });
    return messageResponse(JSON.stringify({ results }));
  };
}
