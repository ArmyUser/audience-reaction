import type { CredentialStatus, SettingsView as Settings } from "../application/analysis-api";
import { SectionHeader, StateMessage } from "./primitives";

// Settings → API & models. Read-only by design: provider keys live in the local .env file on the server and are
// never entered, stored or shown in the browser. The page reports presence only (no value, no fragment, no length).

const STATUS: Record<CredentialStatus, { label: string; className: string }> = {
  configured: { label: "Configured", className: "status-ok" },
  missing: { label: "Missing", className: "status-missing" },
  check_format: { label: "Check format", className: "status-warn" },
};

export function SettingsView({ settings }: { settings: Settings }) {
  const missing = settings.credentials.filter((c) => c.status !== "configured");
  return (
    <div className="settings">
      <header className="page-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h1>API &amp; models</h1>
          <p className="page-lede">Provider keys, the models each analysis uses, and its limits.</p>
        </div>
      </header>

      <StateMessage tone="info" title={`Keys are read from the local ${settings.envFile} file`} role="note">
        <p>
          This local app reads provider keys on the server, from <code>{settings.envFile}</code> in the project folder, when <code>npm run dev</code> starts. Keys are never sent to the browser,
          logged or stored by this page, and they cannot be entered here. To change a key, edit <code>{settings.envFile}</code> and restart the dev server. Never commit that file.
        </p>
      </StateMessage>

      <section className="section" aria-labelledby="keys-title">
        <SectionHeader
          id="keys-title"
          title="Provider keys"
          description={missing.length === 0 ? "All keys are present. Connections are not tested from this page: no provider is called." : `${missing.length} of ${settings.credentials.length} keys need attention. Connections are not tested from this page.`}
        />
        <ul className="credential-list">
          {settings.credentials.map((c) => (
            <li key={c.id} className="credential">
              <div className="credential-main">
                <p className="credential-name">{c.name}</p>
                <p className="muted small">{c.usedFor}</p>
                <p className="small">
                  Needed for: {c.requiredFor.join(" · ")}
                </p>
              </div>
              <div className="credential-side">
                <code className="env-var">{c.envVar}</code>
                <span className={`status-pill ${STATUS[c.status].className}`}>
                  <span className="dot" aria-hidden="true" />
                  {STATUS[c.status].label}
                </span>
                <span className="masked" aria-label={c.status === "missing" ? "No value set" : "Value hidden"}>
                  {c.status === "missing" ? "not set" : "••••••••••••"}
                </span>
                {c.status === "check_format" && <span className="field-error">Contains spaces or quotes; check the line in {settings.envFile}.</span>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      <div className="settings-grid">
        <section className="section" aria-labelledby="models-title">
          <SectionHeader id="models-title" title="Models (real AI pipeline)" description="Used for fixture datasets and real YouTube analysis. Demo mode uses a rule-based classifier." />
          <ol className="pipeline pipeline-vertical">
            {settings.pipeline.map((p) => (
              <li key={p.role}>
                <span className="pipeline-role">{p.role}</span>
                <span className="pipeline-component">{p.component}</span>
              </li>
            ))}
          </ol>
          <p className="muted small">Set in config/real-mode.json and config/topic-providers.json. Benchmark results for this pipeline are on the Evaluation page.</p>
        </section>

        <section className="section" aria-labelledby="limits-title">
          <SectionHeader id="limits-title" title="Limits and compliance" />
          <dl className="kv">
            <div>
              <dt>AI cost cap per analysis</dt>
              <dd className="num">${settings.limits.costLimitUsd.toFixed(2)}</dd>
            </div>
            <div>
              <dt>YouTube comments per analysis</dt>
              <dd className="num">up to {settings.limits.maxYouTubeComments} (top-level, by relevance)</dd>
            </div>
            <div>
              <dt>CG-1 (real YouTube analysis)</dt>
              <dd>
                {settings.cg1.state === "internal_testing" ? (
                  <>
                    <span className="status-pill status-warn">
                      <span className="dot" aria-hidden="true" />
                      Internal testing
                    </span>{" "}
                    exception {settings.cg1.id}, expires {settings.cg1.expiresOn}
                  </>
                ) : (
                  <>
                    <span className="status-pill status-missing">
                      <span className="dot" aria-hidden="true" />
                      Blocked
                    </span>{" "}
                    {settings.cg1.reason}
                  </>
                )}
              </dd>
            </div>
            {settings.modeVariables.map((v) => (
              <div key={v.name}>
                <dt>
                  <code>{v.name}</code>
                </dt>
                <dd>{v.value}</dd>
              </div>
            ))}
          </dl>
          <p className="muted small">
            The mode variables only set the default analysis source; it can be changed on the Analyze page. CG-1 is decided by docs/compliance/cg1-internal-testing-exception.md and cannot be
            changed here.
          </p>
        </section>
      </div>
    </div>
  );
}
