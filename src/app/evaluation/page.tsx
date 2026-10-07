import { loadEvaluation } from "../../local/evaluation";
import { EvaluationView } from "../../web/EvaluationView";

// Internal evaluation page: saved benchmark results of the effective pipeline. Reads committed result files only;
// makes no provider call. Kept apart from the customer report.
export const dynamic = "force-dynamic";

export const metadata = { title: "Pipeline evaluation (internal)" };

export default function EvaluationPage() {
  const view = loadEvaluation();
  return (
    <div className="page">
      <EvaluationView view={view} />
    </div>
  );
}
