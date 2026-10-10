#!/usr/bin/env node
import { callMivoTask, searchMivoCapabilities, resumeMivoTask, isUncertainSubmission } from "../asset-pipeline/mivo-client.mjs";
import { downloadRemoteFiles, many, one, parseArgs, readJson, slugify, writeJson } from "../asset-pipeline/pipeline-utils.mjs";
import { buildRequestSummary, nextIndex, requestMetadataFiles, requestPath } from "../asset-pipeline/request-metadata.mjs";

/** Run or resume one generation capability published by the company API. */
export async function runMivoCapability({ capability, payload, outputDir, outputSlug, modelVersion }) {
  const slug = slugify(outputSlug || capability);
  const requests = await requestMetadataFiles(outputDir, { slug });
  const active = requests.find((request) => isUncertainSubmission(request) || (request.data.endpoint === capability && request.data.request_id && !["completed", "failed", "cancelled", "canceled"].includes(request.data.status)));
  const metadataPath = active?.path || requestPath(outputDir, await nextIndex(outputDir, slug), slug);
  let result;
  if (active) {
    result = await resumeMivoTask(active, { metadataPath });
  } else {
    result = await callMivoTask(capability, payload, { metadataPath, modelVersion });
  }
  const downloaded = await downloadRemoteFiles(result.data, outputDir, slug);
  const summary = buildRequestSummary({ kind: "mivo", provider: capability, requestId: result.requestId, submittedAt: result.submittedAt, inputFiles: payload.images || [], outputFiles: downloaded.map((file) => file.path), downloadedFiles: downloaded, result: result.data });
  await writeJson(metadataPath, summary);
  return summary;
}

async function main() {
  const { flags } = parseArgs();
  if (flags.search !== undefined) {
    console.log(JSON.stringify(await searchMivoCapabilities(one(flags, "search", "")), null, 2));
    return;
  }
  const capability = one(flags, "capability");
  const outputDir = one(flags, "output-dir");
  if (!capability || !outputDir) throw new Error("Use --search <query>, or --capability <id> --output-dir <dir> [--payload-file <json>] [--image <path>].");
  const file = one(flags, "payload-file");
  const literal = one(flags, "payload-json");
  if (file && literal) throw new Error("Use only one payload source.");
  const payload = file ? await readJson(file) : literal ? JSON.parse(literal) : {};
  if (flags.image) payload.images = [...(payload.images || []), ...many(flags, "image")];
  if (flags.prompt) payload.prompt = one(flags, "prompt");
  console.log(JSON.stringify(await runMivoCapability({ capability, payload, outputDir, outputSlug: one(flags, "output-slug"), modelVersion: one(flags, "model-version") }), null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
