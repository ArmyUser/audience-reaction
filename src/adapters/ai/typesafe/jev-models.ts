import { DEFAULT_JEV_BASE_URL } from "./jev-classifier";

// Provider-specific preflight: list the model names the authenticated TypeSafe account reports.
// Read-only: GET /v1/models. It never runs inference and never chooses a model.

export class JevModelsError extends Error {
  override readonly name = "JevModelsError";
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface ListJevModelsOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Returns the model names reported by GET /v1/models, in the order reported. Throws JevModelsError on any failure. */
export async function listJevModels(options: ListJevModelsOptions): Promise<string[]> {
  const fetchImpl = options.fetch ?? fetch;
  const url = `${(options.baseUrl ?? DEFAULT_JEV_BASE_URL).replace(/\/+$/, "")}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);

  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: { authorization: `Bearer ${options.apiKey}` }, signal: controller.signal });
  } catch (error) {
    const reason = error instanceof Error && error.name === "AbortError" ? "timed out" : "could not connect";
    throw new JevModelsError(`Jev models request ${reason} (${url}).`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new JevModelsError(`Jev rejected the credentials (HTTP ${response.status}). Check JEV_API_KEY.`, response.status);
  }
  if (!response.ok) throw new JevModelsError(`Jev models request failed with HTTP ${response.status}.`, response.status);

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new JevModelsError("Jev models response was not JSON.");
  }
  const names = extractModelNames(payload);
  if (names === undefined) throw new JevModelsError("Jev models response has an unrecognised shape; no model names could be read.");
  return names;
}

/**
 * Reads model names from the common list shapes ({ data: [...] }, { models: [...] }, or a bare array) whose items are
 * strings or objects with `id` / `name`. Returns undefined for any other shape — names are never guessed.
 */
export function extractModelNames(payload: unknown): string[] | undefined {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === "object" && payload !== null
      ? ((payload as { data?: unknown }).data ?? (payload as { models?: unknown }).models)
      : undefined;
  if (!Array.isArray(list)) return undefined;
  const names = list.map((item) =>
    typeof item === "string"
      ? item
      : typeof item === "object" && item !== null
        ? ((item as { id?: unknown }).id ?? (item as { name?: unknown }).name)
        : undefined,
  );
  return names.every((n): n is string => typeof n === "string" && n.length > 0) ? names : undefined;
}
