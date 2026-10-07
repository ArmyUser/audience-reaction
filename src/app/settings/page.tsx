import { currentSettings } from "../../local/composition";
import { SettingsView } from "../../web/SettingsView";

// Settings → API & models: key presence (never values), models, limits and CG-1 status. Read-only; calls nothing.
export const dynamic = "force-dynamic";

export const metadata = { title: "Settings · API & models" };

export default function SettingsPage() {
  return (
    <div className="page page-narrow">
      <SettingsView settings={currentSettings()} />
    </div>
  );
}
