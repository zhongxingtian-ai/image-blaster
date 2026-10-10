import { callMivoTask } from "./mivo-client.mjs";
import {
  downloadRemoteFiles,
  ensureDir,
  writeJson
} from "./pipeline-utils.mjs";
import { buildRequestSummary, requestPath } from "./request-metadata.mjs";

export async function runMivoImageTo3DProvider(options) {
  const {
    endpoint,
    providerSlug,
    image,
    outputDir,
    assetName,
    input,
    modelVersion,
    metadataPath,
    metadata = {},
    pollIntervalMs = 10000,
    onSubmit,
    onStatus
  } = options;

  if (!endpoint) throw new Error("endpoint is required.");
  if (!providerSlug) throw new Error("providerSlug is required.");
  if (!image) throw new Error("Input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  await ensureDir(outputDir);

  const normalizedInput = {
    ...input,
    images: [image]
  };
  const requestMetadataPath = metadataPath || requestPath(outputDir, 0, providerSlug);

  const result = await callMivoTask(endpoint, normalizedInput, {
    metadataPath: requestMetadataPath,
    metadata: {
      kind: "3d",
      provider: endpoint,
      provider_slug: providerSlug,
      input: normalizedInput,
      ...metadata
    },
    pollIntervalMs,
    modelVersion,
    onSubmit,
    onStatus
  });

  const downloaded = await downloadRemoteFiles(result.data, outputDir, providerSlug);
  const summary = buildRequestSummary({
    kind: "3d",
    provider: endpoint,
    metadata: {
      provider_slug: providerSlug,
      ...metadata
    },
    requestId: result.requestId,
    submittedAt: result.submittedAt,
    inputFiles: [image],
    outputFiles: downloaded.map((file) => file.path),
    downloadedFiles: downloaded,
    result: result.data,
    extra: { asset_name: assetName, input: normalizedInput }
  });

  await writeJson(requestMetadataPath, summary);
  return summary;
}
