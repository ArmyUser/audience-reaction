import { currentSourceSetup } from "../local/composition";
import { AnalysisWorkspace } from "../web/AnalysisWorkspace";

// The Analyze page. The server supplies only what the source selector may offer (from configuration; nothing is
// called). Analyses are started from the browser through POST /api/analyses and addressed by id (/?id=…), so loading
// or revisiting this page never runs (or re-pays for) an analysis.
export const dynamic = "force-dynamic";

// The root page shares the layout's segment, so the title template does not apply here.
export const metadata = { title: { absolute: "Analyze · Audience Reaction" } };

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // `id` only selects which existing analysis to show; it can never start or re-run one.
  const { id } = await searchParams;
  return (
    <div className="page">
      <AnalysisWorkspace setup={currentSourceSetup()} {...(typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) ? { initialId: id } : {})} />
    </div>
  );
}
