import type { ClassifierEvaluation, DatasetInfo, DatasetRole, EvaluationView as Evaluation, Spread, TopicEvaluation, TopicMetric } from "../application/evaluation-view";
import { SectionHeader, StateMessage } from "./primitives";

// Internal evaluation view: benchmark metrics of the effective pipeline, kept apart from the customer report. Every
// dataset carries its role, so development results are never read as hold-out evidence.

const ROLE_LABEL: Record<DatasetRole, string> = { development: "Development", validation: "Validation", "held-out": "Held-out" };

export function RoleBadge({ role }: { role: DatasetRole }) {
  return <span className={`role-badge role-${role}`}>{ROLE_LABEL[role]}</span>;
}

function fmt(value: number, unit: TopicMetric["unit"]): string {
  switch (unit) {
    case "rate":
      return `${(value * 100).toFixed(1)}%`;
    case "usd":
      return `$${value.toFixed(3)}`;
    case "ms":
      return value >= 1000 ? `${(value / 1000).toFixed(1)} s` : `${Math.round(value)} ms`;
    case "pp":
      return `${value.toFixed(1)} pp`;
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}

function SpreadCell({ spread, unit }: { spread: Spread; unit: TopicMetric["unit"] }) {
  return (
    <>
      <span className="num">{fmt(spread.mean, unit)}</span>
      {spread.n > 1 && spread.min !== spread.max && (
        <span className="muted small num">
          {" "}
          ({fmt(spread.min, unit)} – {fmt(spread.max, unit)})
        </span>
      )}
    </>
  );
}

export function EvaluationView({ view }: { view: Evaluation }) {
  return (
    <div className="report">
      <header className="page-header">
        <div>
        <p className="eyebrow">Internal · not customer-facing</p>
        <h1>Pipeline evaluation</h1>
        <p className="page-lede">
          Benchmark results of the pipeline the app runs in real mode, from saved result files. Development results show what the pipeline was tuned on; validation and held-out
          results are the honest estimate. Averages are plain means over repeats, not significance-tested scores.
        </p>
        </div>
      </header>

      {view.problems.length > 0 && (
        <StateMessage tone="error" title="Some result files could not be read">
          <ul className="plain-list">
            {view.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </StateMessage>
      )}

      <section className="section" aria-labelledby="pipeline">
        <SectionHeader id="pipeline" eyebrow="Configuration" title="Effective pipeline" description="As configured in config/real-mode.json and config/topic-providers.json." />
        <ol className="pipeline">
          {view.pipeline.map((p) => (
            <li key={p.role}>
              <span className="pipeline-role">{p.role}</span>
              <span className="pipeline-component">{p.component}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className="section" aria-labelledby="datasets">
        <SectionHeader id="datasets" eyebrow="Data" title="Datasets and their roles" description="Only development sets may be used to tune the analysis; the web app's fixture mode accepts m2-synthetic and t1-topics-v1 only." />
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Dataset</th>
                <th scope="col">Role</th>
                <th scope="col">Used for</th>
                <th scope="col">Note</th>
              </tr>
            </thead>
            <tbody>
              {view.datasets.map((d) => (
                <tr key={d.id}>
                  <th scope="row">
                    <code>{d.id}</code>
                  </th>
                  <td>
                    <RoleBadge role={d.role} />
                  </td>
                  <td>{d.kind === "classifier" ? "Classifier" : "Topics"}</td>
                  <td className="small muted">{d.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="section" aria-labelledby="topic-eval">
        <SectionHeader id="topic-eval" eyebrow="Topics" title="Topic pipeline benchmark" description="Discovery → consolidation → assignment, scored against gold taxonomies and dispositions. Mean over repeats (min – max)." />
        <TopicTable evaluations={view.topics} />
      </section>

      <section className="section" aria-labelledby="classifier-eval">
        <SectionHeader id="classifier-eval" eyebrow="Classifier" title="Classifier benchmark" description="Per task accuracy and macro F1; per-class precision / recall / F1 averaged over repeats." />
        {view.classifier.map((c) => (
          <ClassifierBlock key={c.file} evaluation={c} />
        ))}
      </section>
    </div>
  );
}

function DatasetHead({ dataset }: { dataset: DatasetInfo }) {
  return (
    <span className="dataset-head">
      <code>{dataset.id}</code> <RoleBadge role={dataset.role} />
    </span>
  );
}

function TopicTable({ evaluations }: { evaluations: TopicEvaluation[] }) {
  if (evaluations.length === 0) return <p className="muted">No topic results are listed in the manifest.</p>;
  const keys = evaluations[0]!.metrics.map((m) => m.key);
  return (
    <>
      <div className="table-wrap">
        <table className="metric-table">
          <thead>
            <tr>
              <th scope="col">Metric</th>
              {evaluations.map((e) => (
                <th scope="col" key={e.dataset.id} className="num">
                  <DatasetHead dataset={e.dataset} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const first = evaluations[0]!.metrics.find((m) => m.key === key)!;
              return (
                <tr key={key}>
                  <th scope="row">
                    {first.label}
                    {first.lowerIsBetter && <span className="muted small"> · lower is better</span>}
                  </th>
                  {evaluations.map((e) => {
                    const m = e.metrics.find((x) => x.key === key);
                    return (
                      <td key={e.dataset.id} className="num">
                        {m ? <SpreadCell spread={m.spread} unit={m.unit} /> : "—"}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            <tr>
              <th scope="row">Repeats</th>
              {evaluations.map((e) => (
                <td key={e.dataset.id} className="num">
                  {e.files.length}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <ul className="plain-list small muted">
        {evaluations.map((e) => (
          <li key={e.dataset.id}>
            <code>{e.dataset.id}</code>: {e.configuration} — {e.matchesCurrent ? "matches the current pipeline" : "does NOT match the current pipeline"}
          </li>
        ))}
      </ul>
    </>
  );
}

function ClassifierBlock({ evaluation: c }: { evaluation: ClassifierEvaluation }) {
  return (
    <div className="eval-block">
      <h3 className="subhead">
        <DatasetHead dataset={c.dataset} />
      </h3>
      <p className="small muted">
        {c.model}
        {c.modelVersions.length > 0 && ` (served ${c.modelVersions.join(", ")})`} · {c.questionSet} · guideline {c.guidelineVersion} · {c.repeats} repeats ·{" "}
        {c.matchesCurrent ? "matches the current classifier" : "does NOT match the current classifier"}
        {c.costPerRunUsd !== null && ` · $${c.costPerRunUsd.toFixed(4)} per run`}
        {c.requestLatencyP50Ms !== null && ` · p50 request ${c.requestLatencyP50Ms} ms`}
        {c.wallClockMs && ` · ${(c.wallClockMs.mean / 1000).toFixed(1)} s per run`}
      </p>
      <div className="table-wrap">
        <table className="metric-table">
          <thead>
            <tr>
              <th scope="col">Task</th>
              <th scope="col" className="num">
                Accuracy
              </th>
              <th scope="col" className="num">
                Macro F1
              </th>
              <th scope="col">Per class: precision / recall / F1 (support)</th>
            </tr>
          </thead>
          <tbody>
            {c.tasks.map((t) => (
              <tr key={t.task}>
                <th scope="row">
                  <code>{t.task}</code> <span className="muted small">n={t.n}</span>
                </th>
                <td className="num">
                  <SpreadCell spread={t.accuracy} unit="rate" />
                </td>
                <td className="num">
                  <SpreadCell spread={t.macroF1} unit="rate" />
                </td>
                <td className="small">
                  {t.perClass.map((p) => (
                    <span key={p.label} className="class-metric">
                      {p.label}: {(p.precision * 100).toFixed(0)} / {(p.recall * 100).toFixed(0)} / {(p.f1 * 100).toFixed(0)} <span className="muted">({p.support})</span>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
