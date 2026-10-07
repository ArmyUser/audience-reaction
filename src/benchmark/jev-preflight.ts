import { parseArgs } from "node:util";
import { DEFAULT_JEV_MODEL } from "../adapters/ai/typesafe/jev-classifier";
import { JevModelsError, listJevModels } from "../adapters/ai/typesafe/jev-models";

// Manual preflight (never part of `npm test`): lists the models the authenticated TypeSafe account reports and checks
// whether the model the benchmark would use is among them. No inference, no benchmark results, no model switching.
// Usage: npm run jev:models [-- --jev-model jev-preview]

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { "jev-model": { type: "string", default: DEFAULT_JEV_MODEL } } });
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    console.error("JEV_API_KEY is not set. Add it to a local .env file (never commit it) and re-run.");
    process.exit(1);
  }

  const models = await listJevModels({ apiKey });
  console.log(`Models reported by the TypeSafe account (${models.length}):`);
  for (const name of models) console.log(`- ${name}`);

  const wanted = values["jev-model"];
  if (models.includes(wanted)) {
    console.log(`\nOK: "${wanted}" is available. The benchmark will use it as configured.`);
  } else {
    console.error(`\nNOT REPORTED: "${wanted}" is not in the list above. The benchmark would fail or use an unexpected model.`);
    console.error("Choose one of the reported names explicitly with --jev-model; nothing was changed automatically.");
    process.exit(2);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof JevModelsError ? error.message : error instanceof Error ? `${error.name}: ${error.message}` : "Preflight failed");
  process.exit(1);
});
