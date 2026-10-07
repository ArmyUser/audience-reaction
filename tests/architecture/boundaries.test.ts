import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Enforces the layering described in the README ("Architecture"):
// browser → src/app → src/application → src/core ← src/adapters, with src/local as composition root.

const ROOT = resolve(__dirname, "../..");
const SRC = join(ROOT, "src");

type Layer = "core" | "application" | "adapters" | "local" | "app" | "web" | "benchmark";

interface SourceFile {
  path: string;
  layer: Layer;
  text: string;
  imports: string[];
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? listFiles(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const IMPORT_PATTERNS = [
  /\bimport\s+(?:type\s+)?[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bexport\s+[^'"]*?\bfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
];

function importsOf(text: string): string[] {
  return IMPORT_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((m) => m[1]!));
}

const files: SourceFile[] = listFiles(SRC).map((path) => {
  const layer = relative(SRC, path).split(sep)[0] as Layer;
  const text = readFileSync(path, "utf8");
  return { path, layer, text, imports: importsOf(text) };
});

/** Target of an import: a src layer, or "external:<package>". */
function targetOf(file: SourceFile, specifier: string): string {
  if (specifier.startsWith(".")) {
    const abs = resolve(dirname(file.path), specifier);
    const rel = relative(SRC, abs);
    return rel.startsWith("..") ? `outside:${relative(ROOT, abs)}` : `src:${rel.split(sep)[0]}`;
  }
  const pkg = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!;
  return `external:${pkg}`;
}

const ALLOWED_SRC: Record<Layer, Layer[]> = {
  core: ["core"],
  application: ["application", "core"],
  adapters: ["adapters", "core"],
  local: ["local", "application", "adapters", "core"],
  app: ["app", "application", "local", "web"],
  web: ["web", "application"],
  // The topic benchmark runs the production topic use case (analyzeTopics + TwoPhaseTopicDiscoverer) end to end.
  benchmark: ["benchmark", "application", "core", "adapters"],
};

const ALLOWED_EXTERNAL: Record<Layer, string[]> = {
  core: ["zod"],
  application: [],
  adapters: ["@anthropic-ai/sdk", "@google/genai", "zod"],
  // The composition root may read committed benchmark result files for the internal evaluation view.
  local: ["server-only", "node:fs", "node:path"],
  app: ["react", "next"],
  web: ["react"],
  benchmark: ["node:crypto", "node:fs", "node:path", "node:util"],
};

describe("architecture boundaries", () => {
  it("finds source files in every layer", () => {
    const layers = new Set(files.map((f) => f.layer));
    for (const layer of ["core", "application", "adapters", "local", "app", "web", "benchmark"]) expect(layers).toContain(layer);
  });

  for (const file of files) {
    const name = relative(ROOT, file.path);

    it(`${name} only imports allowed layers and packages`, () => {
      for (const specifier of file.imports) {
        const target = targetOf(file, specifier);
        if (target.startsWith("src:")) {
          expect(ALLOWED_SRC[file.layer], `${name} → ${specifier}`).toContain(target.slice(4));
        } else if (target.startsWith("outside:")) {
          // Only adapters may read synthetic fixtures from outside src/; only the composition root may read config/.
          const allowed = (file.layer === "adapters" && target.startsWith("outside:fixtures/")) || (file.layer === "local" && /^outside:config\/[\w/-]+\.json$/.test(target));
          expect(allowed, `${name} → ${specifier}`).toBe(true);
        } else {
          expect(ALLOWED_EXTERNAL[file.layer], `${name} → ${specifier}`).toContain(target.slice(9));
        }
      }
    });
  }

  it("core, application and adapters use no environment variables, filesystem or Node-specific modules", () => {
    for (const file of files.filter((f) => ["core", "application", "adapters"].includes(f.layer))) {
      expect(file.text, relative(ROOT, file.path)).not.toMatch(/process\.env|\bnode:|from\s*['"](fs|path|sqlite3|better-sqlite3)['"]/);
    }
  });
});

describe("provider isolation", () => {
  it("only the Anthropic adapter imports the Anthropic SDK", () => {
    const importers = files.filter((f) => f.imports.some((i) => i.startsWith("@anthropic-ai/"))).map((f) => relative(SRC, f.path));
    expect(importers.length).toBeGreaterThan(0);
    for (const path of importers) expect(path.startsWith(join("adapters", "ai", "anthropic") + sep)).toBe(true);
  });

  it("only the Google adapter imports the Google GenAI SDK", () => {
    const importers = files.filter((f) => f.imports.some((i) => i.startsWith("@google/"))).map((f) => relative(SRC, f.path));
    expect(importers.length).toBeGreaterThan(0);
    for (const path of importers) expect(path.startsWith(join("adapters", "ai", "google") + sep)).toBe(true);
  });

  it("no source file mentions a vendor in the core, application, or web layers", () => {
    for (const file of files.filter((f) => ["core", "application", "web", "app"].includes(f.layer))) {
      expect(file.text, relative(ROOT, file.path)).not.toMatch(/anthropic|claude|\bjev\b|typesafe|gemini|google/i);
    }
  });

  it("only composition roots read environment variables", () => {
    for (const file of files.filter((f) => f.text.includes("process.env"))) {
      expect(["local", "benchmark"], relative(ROOT, file.path)).toContain(file.layer);
    }
  });
});

describe("server/client separation", () => {
  it("the composition root is guarded by server-only", () => {
    const composition = files.find((f) => f.path.endsWith(join("local", "composition.ts")))!;
    expect(composition.imports).toContain("server-only");
  });

  it("web components import application code for types only", () => {
    for (const file of files.filter((f) => f.layer === "web")) {
      const valueImports = [...file.text.matchAll(/^import\s+(?!type\b)[^;]*?from\s*['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
      for (const specifier of valueImports) {
        expect(targetOf(file, specifier), `${relative(ROOT, file.path)} value-imports ${specifier}`).not.toBe("src:application");
      }
    }
  });

  it("client components never import server-side layers", () => {
    for (const file of files.filter((f) => /^\s*['"]use client['"]/.test(f.text))) {
      for (const specifier of file.imports) {
        const target = targetOf(file, specifier);
        expect(["src:local", "src:adapters", "src:core", "external:server-only"], `${relative(ROOT, file.path)} → ${specifier}`).not.toContain(target);
      }
    }
  });

  it("browser-reachable code (app, web, client components) never names an API key variable", () => {
    for (const file of files.filter((f) => ["app", "web"].includes(f.layer) || /^\s*['"]use client['"]/.test(f.text))) {
      expect(file.text, relative(ROOT, file.path)).not.toMatch(/\b(YOUTUBE|ANTHROPIC|JEV|GEMINI|GOOGLE)_API_KEY\b/);
    }
  });

  it("the YouTube adapter gets its key from the composition root only", () => {
    const adapter = files.find((f) => f.path.endsWith(join("adapters", "youtube", "youtube-comment-source.ts")))!;
    expect(adapter.text).not.toMatch(/process\.env|YOUTUBE_API_KEY/);
  });

  it("no source file reads NEXT_PUBLIC_ variables", () => {
    for (const file of files) expect(file.text, relative(ROOT, file.path)).not.toContain("NEXT_PUBLIC_");
  });
});
