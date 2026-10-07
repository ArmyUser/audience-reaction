import { getAnalysis, listAnalyses, startAnalysis } from "../../../../local/composition";

// /api/analyses — the analysis API of the local app, in one route module so one in-memory registry serves it all.
// - POST /api/analyses           { source, url? } → starts an analysis, or returns the identical one already running
//                                  or completed ({ analysis, reused }). Only `source` (an allowlisted option id) and
//                                  `url` (real YouTube only) are read; everything else in the body is ignored.
// - GET  /api/analyses           → recent analyses, without results.
// - GET  /api/analyses/<id>      → one analysis with its status, stage and, once finished, its result.
// Reading never starts or repeats an analysis. A paid analysis must not be triggerable from another site: POST must
// be JSON (a cross-site page cannot send that without a CORS preflight, which is never approved), and the Host must be
// a loopback name whose origin matches any Origin header sent (this also defeats DNS rebinding). This app is
// local-only.
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const NO_STORE = { "cache-control": "no-store" };
const ID = /^[0-9a-f-]{36}$/;

type Context = { params: Promise<{ id?: string[] }> };

function sameOrigin(request: Request): boolean {
  const host = request.headers.get("host");
  if (host === null) return false;
  try {
    if (!LOOPBACK_HOSTNAMES.has(new URL(`http://${host}`).hostname)) return false;
    const origin = request.headers.get("origin");
    return origin === null || new URL(origin).host === host;
  } catch {
    return false;
  }
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

export async function GET(request: Request, context: Context): Promise<Response> {
  if (!sameOrigin(request)) return json({ error: "Cross-origin requests are not accepted." }, 403);
  const segments = (await context.params).id ?? [];
  if (segments.length === 0) return json({ analyses: listAnalyses() });
  const id = segments[0]!;
  const analysis = segments.length === 1 && ID.test(id) ? getAnalysis(id) : undefined;
  if (!analysis) return json({ error: "This analysis is no longer available. Results are kept in memory for a limited time only." }, 404);
  return json({ analysis });
}

export async function POST(request: Request, context: Context): Promise<Response> {
  if ((await context.params).id?.length) return json({ error: "Not found." }, 404);
  if (!(request.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return json({ error: "Send the request as JSON." }, 415);
  if (!sameOrigin(request)) return json({ error: "Cross-origin requests are not accepted." }, 403);

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) return json({ error: "Request too large." }, 413);
    body = JSON.parse(text);
  } catch {
    return json({ error: "The request body is not valid JSON." }, 400);
  }
  if (typeof body !== "object" || body === null) return json({ error: "The request body is not valid JSON." }, 400);
  const { url, source } = body as Record<string, unknown>;
  const started = startAnalysis({ url, source });
  if (!started.ok) return json({ error: started.message, ...(started.field ? { field: started.field } : {}) }, 400);
  return json(started.response, started.response.reused ? 200 : 202);
}
