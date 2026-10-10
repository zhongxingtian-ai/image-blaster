#!/usr/bin/env node
import {
  one,
  normalizeBoolean,
  loadDotEnv,
  parseArgs,
} from "./pipeline-utils.mjs";
import { runMivoImageTo3DProvider } from "./mivo-3d-provider.mjs";

export const HUNYUAN_3D_ENDPOINT = "model3d.hunyuan";
export const HUNYUAN_3D_PROVIDER = "hunyuan";
export const DEFAULT_HUNYUAN_FACE_COUNT = 50000;
export const DEFAULT_HUNYUAN_ENABLE_PBR = true;
export const DEFAULT_HUNYUAN_GENERATE_TYPE = "Normal";
export const DEFAULT_HUNYUAN_POLYGON_TYPE = "triangle";

const MIN_FACE_COUNT = 40000;
const MAX_FACE_COUNT = 1500000;
const GENERATE_TYPES = new Map([
  ["normal", "Normal"],
  ["lowpoly", "LowPoly"],
  ["geometry", "Geometry"]
]);
const POLYGON_TYPES = new Map([
  ["triangle", "triangle"],
  ["quadrilateral", "quadrilateral"]
]);

function normalizeFaceCount(value) {
  const faceCount = Number(value);
  if (!Number.isInteger(faceCount) || faceCount < MIN_FACE_COUNT || faceCount > MAX_FACE_COUNT) {
    throw new Error(
      `face-count must be an integer between ${MIN_FACE_COUNT} and ${MAX_FACE_COUNT}.`
    );
  }
  return faceCount;
}

function normalizeGenerateType(value) {
  const normalized = GENERATE_TYPES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    throw new Error("generate-type must be one of: Normal, LowPoly, Geometry.");
  }
  return normalized;
}

function normalizePolygonType(value) {
  const normalized = POLYGON_TYPES.get(String(value).trim().toLowerCase());
  if (!normalized) {
    throw new Error("polygon-type must be one of: triangle, quadrilateral.");
  }
  return normalized;
}

export async function runHunyuan3D(options) {
  await loadDotEnv();
  const {
    image,
    outputDir,
    assetName,
    faceCount = DEFAULT_HUNYUAN_FACE_COUNT,
    enablePbr = DEFAULT_HUNYUAN_ENABLE_PBR,
    generateType = DEFAULT_HUNYUAN_GENERATE_TYPE,
    polygonType = DEFAULT_HUNYUAN_POLYGON_TYPE,
    metadataPath,
    metadata = {},
    onSubmit,
    onStatus
  } = options;

  if (!image) throw new Error("Input image is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  const normalizedFaceCount = normalizeFaceCount(faceCount);
  const normalizedGenerateType = normalizeGenerateType(generateType);
  const normalizedEnablePbr = normalizeBoolean(enablePbr, "enable-pbr");
  const normalizedPolygonType = normalizePolygonType(polygonType);

  const input = {
    generateType: normalizedGenerateType === "LowPoly" ? "LOWPOLY" : normalizedGenerateType === "Geometry" || !normalizedEnablePbr ? "WHITE" : "PBR",
    faceCount: normalizedFaceCount
  };
  if (normalizedGenerateType === "LowPoly" && normalizedPolygonType !== "triangle") throw new Error("Company Hunyuan LOWPOLY supports triangle output only.");

  return runMivoImageTo3DProvider({
    endpoint: HUNYUAN_3D_ENDPOINT,
    providerSlug: HUNYUAN_3D_PROVIDER,
    image,
    outputDir,
    assetName,
    input,
    modelVersion: normalizedGenerateType === "LowPoly" ? "V3.0" : process.env.MIVO_HUNYUAN_MODEL_VERSION || "3.1",
    metadataPath,
    metadata,
    pollIntervalMs: 10000,
    onSubmit,
    onStatus
  });
}

async function main() {
  const { flags } = parseArgs();
  const image = one(flags, "image") || one(flags, "input-image");
  const outputDir = one(flags, "output-dir");

  if (!image || !outputDir) {
    throw new Error(
      "Usage: node hunyuan-3d.mjs --image <path-or-url> --output-dir <dir> [--asset-name <name>] [--face-count <40000-1500000>] [--generate-type Normal|LowPoly|Geometry] [--polygon-type triangle|quadrilateral] [--enable-pbr true|false]"
    );
  }

  const summary = await runHunyuan3D({
    image,
    outputDir,
    assetName: one(flags, "asset-name"),
    faceCount: one(flags, "face-count", DEFAULT_HUNYUAN_FACE_COUNT),
    enablePbr: one(flags, "enable-pbr", DEFAULT_HUNYUAN_ENABLE_PBR),
    generateType: one(flags, "generate-type", DEFAULT_HUNYUAN_GENERATE_TYPE),
    polygonType: one(flags, "polygon-type", DEFAULT_HUNYUAN_POLYGON_TYPE)
  });

  console.log(JSON.stringify(summary, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
