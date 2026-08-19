import { resolve } from "node:path";

import { deliverPortableArtifact } from "/Users/thibault/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/deliver_portable_artifact.mjs";
import { buildPortableArtifact } from "/Users/thibault/.codex/plugins/cache/openai-curated-remote/data-analytics/0.2.8-13ceeea1f599/skills/build-report/scripts/build_portable_artifact.mjs";

function buildWithoutViewportScrollbarOverflow(input, options) {
  const html = buildPortableArtifact(input, options);
  return html.replace(
    "</head>",
    "<style>html,body{overflow-x:hidden}</style></head>",
  );
}

const directory = resolve(import.meta.dirname);
const result = await deliverPortableArtifact(
  {
    inputPath: resolve(directory, "report-source.json"),
    outputPath: resolve(directory, "report.html"),
  },
  { build: buildWithoutViewportScrollbarOverflow },
);

process.stdout.write(`${JSON.stringify(result)}\n`);
