#!/usr/bin/env node
import { callMivoTask } from "./mivo-client.mjs";
import {
  downloadRemoteFiles,
  ensureDir,
  loadDotEnv,
  many,
  one,
  parseArgs,
  writeJson
} from "./pipeline-utils.mjs";
import { buildRequestSummary, requestPath } from "./request-metadata.mjs";

const ENDPOINT = "image.nano-banana";

export async function runNanoBananaEdit(options) {
  await loadDotEnv();
  const {
    prompt,
    images,
    outputDir,
    numImages = 1,
    resolution = "1K",
    aspectRatio = "auto",
    outputFormat = "png",
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!prompt) throw new Error("Nano Banana prompt is required.");
  if (!images?.length) throw new Error("At least one input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  await ensureDir(outputDir);

  const input = {
    prompt,
    images,
    n: Number(numImages),
    imgRatio: aspectRatio,
    resolution
  };
  if (outputFormat !== "png") throw new Error("Company Nano Banana returns PNG; use --format png.");

  const result = await callMivoTask(ENDPOINT, input, {
    metadataPath: metadataPath || requestPath(outputDir, 0, "nano-banana"),
    metadata: { kind: "2d", provider: ENDPOINT, ...metadata },
    onSubmit,
    onStatus,
    modelVersion: process.env.MIVO_NANO_MODEL_VERSION
  });

  const downloaded = await downloadRemoteFiles(result.data, outputDir, "nano-banana");
  const summary = buildRequestSummary({
    kind: "2d",
    provider: ENDPOINT,
    metadata,
    requestId: result.requestId,
    submittedAt: result.submittedAt,
    prompt,
    inputFiles: images,
    outputFiles: downloaded.map((file) => file.path),
    downloadedFiles: downloaded,
    result: result.data
  });

  await writeJson(metadataPath || requestPath(outputDir, 0, "nano-banana"), summary);
  return summary;
}

async function main() {
  const { flags } = parseArgs();
  const images = [...many(flags, "image"), ...many(flags, "input-image")];
  const prompt = one(flags, "prompt");
  const outputDir = one(flags, "output-dir");

  if (!prompt || !outputDir || images.length === 0) {
    throw new Error(
      "Usage: node nano-banana-edit.mjs --image <path-or-url> --prompt <prompt> --output-dir <dir>"
    );
  }

  const summary = await runNanoBananaEdit({
    prompt,
    images,
    outputDir,
    numImages: one(flags, "num-images", 1),
    resolution: one(flags, "resolution", "1K"),
    aspectRatio: one(flags, "aspect-ratio", "auto"),
    outputFormat: one(flags, "format", "png"),
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
