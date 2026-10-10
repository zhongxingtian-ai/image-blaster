#!/usr/bin/env node
import { loadDotEnv, normalizeBoolean, one, parseArgs } from "./pipeline-utils.mjs";
import { runMivoImageTo3DProvider } from "./mivo-3d-provider.mjs";

export const TRIPO_3D_PROVIDER = "tripo";
export const DEFAULT_TRIPO_FACE_COUNT = 50000;

/** Generate one Tripo model through the company's model3d capability. */
export async function runTripo3D(options) {
  await loadDotEnv();
  const modelVersion = options.modelVersion || process.env.MIVO_TRIPO_MODEL_VERSION || "V3.1";
  const requestedCount = options.targetPolycount ?? options.faceCount ?? DEFAULT_TRIPO_FACE_COUNT;
  const count = requestedCount === "auto" ? "auto" : Number(requestedCount);
  if (count !== "auto" && (!Number.isInteger(count) || count < 48 || count > 2000000)) throw new Error("Tripo face count must be auto or an integer between 48 and 2000000.");
  if (modelVersion === "V3.1" && count !== "auto" && count < 19999) throw new Error("Company Tripo V3.1 triangle models require at least 19999 faces; use --target-polycount auto or 50000.");
  if (modelVersion === "P1" && count !== "auto" && count > 20000) throw new Error("Company Tripo P1 supports 48-20000 faces or auto.");
  if (modelVersion === "P2-preview" && (count === "auto" || count > 50000)) throw new Error("Company Tripo P2 supports 48-50000 faces.");
  const texture = normalizeBoolean(options.enablePbr ?? true, "enable-pbr");
  return runMivoImageTo3DProvider({
    ...options,
    endpoint: "model3d.tripo",
    providerSlug: TRIPO_3D_PROVIDER,
    modelVersion,
    input: { generateType: texture ? "PBR" : "WHITE", faceCount: count },
    pollIntervalMs: 5000
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { flags } = parseArgs();
  runTripo3D({ image: one(flags, "image"), outputDir: one(flags, "output-dir"), targetPolycount: one(flags, "target-polycount", DEFAULT_TRIPO_FACE_COUNT), modelVersion: one(flags, "model-version") })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
