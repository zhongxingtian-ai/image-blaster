#!/usr/bin/env node
import { callMivoTask } from "./mivo-client.mjs";
import {
  downloadRemoteFiles,
  ensureDir,
  loadDotEnv,
  many,
  one,
  parseArgs,
  toModelInputUrl,
  writeJson
} from "./pipeline-utils.mjs";
import { buildRequestSummary, requestPath } from "./request-metadata.mjs";

const ENDPOINT = "image.gpt";

export async function runGptImage2Edit(options) {
  await loadDotEnv();
  const {
    prompt,
    images,
    outputDir,
    numImages = 1,
    imageSize = "auto",
    quality = "medium",
    outputFormat = "png",
    maskImage,
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!prompt) throw new Error("GPT Image 2 prompt is required.");
  if (!images?.length) throw new Error("At least one input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  await ensureDir(outputDir);

  const input = {
    prompt,
    images,
    quality,
    n: Number(numImages),
    output_format: outputFormat
  };
  if (imageSize !== "auto") {
    if (!/^\d+x\d+$/.test(imageSize)) throw new Error("Company GPT image size must be auto or widthxheight.");
    input.size = imageSize;
  }

  if (maskImage) {
    input.maskBase64 = await toModelInputUrl(maskImage);
  }

  const result = await callMivoTask(ENDPOINT, input, {
    metadataPath: metadataPath || requestPath(outputDir, 0, "gpt-image-2"),
    metadata: { kind: "2d", provider: ENDPOINT, ...metadata },
    onSubmit,
    onStatus,
    modelVersion: process.env.MIVO_GPT_MODEL_VERSION || (maskImage ? "gpt-image-2.5-sunburst" : "gpt-image-2")
  });

  const downloaded = await downloadRemoteFiles(result.data, outputDir, "gpt-image-2");
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

  await writeJson(metadataPath || requestPath(outputDir, 0, "gpt-image-2"), summary);
  return summary;
}

async function main() {
  const { flags } = parseArgs();
  const images = [...many(flags, "image"), ...many(flags, "input-image")];
  const prompt = one(flags, "prompt");
  const outputDir = one(flags, "output-dir");

  if (!prompt || !outputDir || images.length === 0) {
    throw new Error(
      "Usage: node gpt-image-2-edit.mjs --image <path-or-url> --prompt <prompt> --output-dir <dir>"
    );
  }

  const summary = await runGptImage2Edit({
    prompt,
    images,
    outputDir,
    numImages: one(flags, "num-images", 1),
    imageSize: one(flags, "image-size", "auto"),
    quality: one(flags, "quality", "medium"),
    outputFormat: one(flags, "format", "png"),
    maskImage: one(flags, "mask-image")
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
