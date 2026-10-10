#!/usr/bin/env node
import { callMivoTask, resumeMivoTask, isUncertainSubmission } from "../asset-pipeline/mivo-client.mjs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { rename, stat, unlink } from "node:fs/promises";
import {
  downloadFile,
  ensureDir,
  one,
  parseArgs,
  pathExists,
  readJson,
  slugify,
  writeJson
} from "../asset-pipeline/pipeline-utils.mjs";
import {
  artifactPath,
  buildRequestSummary,
  nextIndex,
  requestMetadataFiles,
  requestPath
} from "../asset-pipeline/request-metadata.mjs";

const ENDPOINT = "audio.elevenlabs-sound-effect";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const SILENCE_THRESHOLD_DB = "-45dB";
const START_SILENCE_SECONDS = "0.03";
const END_SILENCE_SECONDS = "0.05";

function asBool(value, fallback = false) {
  if (value === undefined) return fallback;
  if (value === true) return true;
  if (value === false) return false;
  return !["false", "0", "no", "off"].includes(String(value).toLowerCase());
}

function asNumber(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`Expected a number, received "${value}".`);
  return number;
}

function clampCount(value) {
  const count = Math.trunc(asNumber(value, 1));
  if (count < 1 || count > 4) {
    throw new Error("count must be between 1 and 4.");
  }
  return count;
}

function extensionForOutputFormat(outputFormat) {
  if (outputFormat.startsWith("mp3_")) return ".mp3";
  if (outputFormat.startsWith("pcm_")) return ".pcm";
  if (outputFormat.startsWith("opus_")) return ".opus";
  if (outputFormat.startsWith("ulaw_")) return ".ulaw";
  if (outputFormat.startsWith("alaw_")) return ".alaw";
  return ".audio";
}

async function readJsonIfExists(filePath) {
  return (await pathExists(filePath)) ? readJson(filePath) : undefined;
}

function statusText(value) {
  return String(value || "").toLowerCase();
}

function isActiveRequest(request) {
  const status = statusText(request.data?.status);
  return (isUncertainSubmission(request) || Boolean(request.data?.request_id && request.data?.endpoint)) &&
    !["completed", "failed", "cancelled", "canceled"].includes(status);
}

async function resumeMivoRequest(request, pollIntervalMs = 3000) {
  return resumeMivoTask(request, { pollIntervalMs });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
      if (error && !options.allowFailure) {
        error.message = `${command} ${args.join(" ")} failed: ${error.message}\n${stderr}`;
        reject(error);
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: error?.code ?? 0
      });
    });
  });
}

async function assertAudioTools() {
  await runCommand("ffmpeg", ["-version"]);
  await runCommand("ffprobe", ["-version"]);
}

function parseDb(value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function roundSeconds(value) {
  if (!Number.isFinite(value)) return undefined;
  return Math.round(value * 1000) / 1000;
}

function canPostprocessExtension(extension) {
  return [".mp3", ".opus"].includes(extension);
}

async function probeDuration(filePath) {
  const { stdout } = await runCommand("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "json",
    filePath
  ]);
  const duration = Number(JSON.parse(stdout)?.format?.duration);
  return Number.isFinite(duration) ? duration : undefined;
}

async function detectSilence(filePath, durationSeconds) {
  const { stderr } = await runCommand("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-af",
    `silencedetect=noise=${SILENCE_THRESHOLD_DB}:d=${START_SILENCE_SECONDS}`,
    "-f",
    "null",
    "-"
  ]);

  const starts = [...stderr.matchAll(/silence_start:\s*([0-9.]+)/g)].map((match) => Number(match[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/g)].map(
    (match) => ({
      end: Number(match[1]),
      duration: Number(match[2])
    })
  );

  const leadingEnd = starts[0] <= 0.05 ? ends[0]?.end : undefined;
  const lastStart = starts.at(-1);
  const lastEnd = ends.at(-1);
  const trailingStart =
    durationSeconds !== undefined && lastStart !== undefined && durationSeconds - lastStart >= Number(END_SILENCE_SECONDS)
      ? lastStart
      : undefined;

  return {
    threshold_db: SILENCE_THRESHOLD_DB,
    leading_seconds: roundSeconds(leadingEnd ?? 0),
    trailing_seconds: roundSeconds(
      trailingStart !== undefined
        ? Math.max(0, durationSeconds - trailingStart)
        : lastEnd && durationSeconds !== undefined && Math.abs(durationSeconds - lastEnd.end) <= 0.05
          ? lastEnd.duration
          : 0
    ),
    regions: starts.map((start, index) => ({
      start: roundSeconds(start),
      end: roundSeconds(ends[index]?.end),
      duration: roundSeconds(ends[index]?.duration)
    }))
  };
}

async function measureVolume(filePath) {
  const { stderr } = await runCommand("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    filePath,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-"
  ]);

  return {
    mean_db: parseDb(stderr.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/)?.[1]),
    max_db: parseDb(stderr.match(/max_volume:\s*(-?[0-9.]+)\s*dB/)?.[1])
  };
}

export async function analyzeAudio(filePath) {
  const [durationSeconds, volume, fileStat] = await Promise.all([
    probeDuration(filePath),
    measureVolume(filePath),
    stat(filePath)
  ]);
  const silence = await detectSilence(filePath, durationSeconds);

  return {
    duration_seconds: roundSeconds(durationSeconds),
    bytes: fileStat.size,
    volume,
    silence
  };
}

function scoreAudio(analysis) {
  const duration = analysis?.after?.duration_seconds ?? analysis?.before?.duration_seconds ?? 0;
  const leading = analysis?.before?.silence?.leading_seconds ?? 0;
  const trailing = analysis?.before?.silence?.trailing_seconds ?? 0;
  const maxDb = analysis?.after?.volume?.max_db;

  let score = 100;
  score -= Math.min(35, leading * 120);
  score -= Math.min(20, trailing * 50);
  if (duration > 3) score -= Math.min(20, (duration - 3) * 8);
  if (maxDb !== undefined && maxDb < -8) score -= Math.min(20, Math.abs(maxDb + 8) * 2);
  return Math.max(0, Math.round(score));
}

export async function analyzeAndPostprocessAudio(filePath, options = {}) {
  const extension = options.extension ?? ".mp3";
  const postprocess = options.postprocess !== false;
  const before = postprocess ? await analyzeAudio(filePath) : {};

  if (!postprocess || !canPostprocessExtension(extension)) {
    return {
      postprocessed: false,
      skipped_reason: postprocess ? `Unsupported audio extension ${extension}` : "Post-processing disabled",
      before,
      after: before,
      quality_score: scoreAudio({ before, after: before })
    };
  }

  const tempPath = `${filePath}.postprocess${extension}`;
  const filters = [
    `silenceremove=start_periods=1:start_duration=${START_SILENCE_SECONDS}:start_threshold=${SILENCE_THRESHOLD_DB}:stop_periods=-1:stop_duration=${END_SILENCE_SECONDS}:stop_threshold=${SILENCE_THRESHOLD_DB}`,
    "loudnorm=I=-16:TP=-1.5:LRA=11"
  ].join(",");

  try {
    await runCommand("ffmpeg", ["-y", "-hide_banner", "-nostdin", "-i", filePath, "-af", filters, tempPath]);
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }

  const after = await analyzeAudio(filePath);

  return {
    postprocessed: true,
    filters,
    before,
    after,
    trimmed_seconds: {
      leading: before.silence.leading_seconds,
      trailing: before.silence.trailing_seconds,
      total: roundSeconds((before.duration_seconds ?? 0) - (after.duration_seconds ?? 0))
    },
    quality_score: scoreAudio({ before, after })
  };
}

export async function generateSfx(options) {
  const {
    prompt,
    outputDir,
    prefix = "sfx",
    count = 1,
    loop = false,
    durationSeconds,
    promptInfluence = 0.3,
    outputFormat = DEFAULT_OUTPUT_FORMAT,
    kind = "sfx",
    postprocess = true
  } = options;

  if (!prompt) throw new Error("prompt is required.");
  if (!outputDir) throw new Error("outputDir is required.");

  const requestedCount = clampCount(count);
  const duration = asNumber(durationSeconds, undefined);
  if (duration !== undefined && (duration < 0.5 || duration > 30)) {
    throw new Error("durationSeconds must be between 0.5 and 30 for the company ElevenLabs capability.");
  }
  if (outputFormat !== DEFAULT_OUTPUT_FORMAT) throw new Error("Company ElevenLabs returns MP3; use the default output format.");

  const influence = asNumber(promptInfluence, 0.3);
  if (influence < 0 || influence > 1) {
    throw new Error("promptInfluence must be between 0 and 1.");
  }

  await ensureDir(outputDir);
  const extension = extensionForOutputFormat(outputFormat);
  const shouldPostprocess = asBool(postprocess, true) && !loop;
  if (shouldPostprocess) {
    await assertAudioTools();
    if (!canPostprocessExtension(extension)) {
      throw new Error(`Audio post-processing is only supported for mp3 and opus outputs, received ${outputFormat}.`);
    }
  }
  const files = [];
  const requests = [];
  const batchPath = path.join(outputDir, `.${slugify(prefix)}-sfx-batch.json`);
  const previousBatch = await readJsonIfExists(batchPath);
  const settings = { prompt, count: requestedCount, loop: Boolean(loop), duration: duration ?? null, influence, outputFormat, kind };
  const recovering = previousBatch?.status === "running" && JSON.stringify(previousBatch.settings) === JSON.stringify(settings);
  const batchId = recovering ? previousBatch.id : randomUUID();
  await writeJson(batchPath, { id: batchId, status: "running", settings });

  for (let index = 0; index < requestedCount; index += 1) {
    const input = {
      prompt,
      taskType: "generate_sound_effect",
      n: 1,
      smartPrompt: false,
      loop: Boolean(loop),
      promptInfluence: influence
    };
    if (duration !== undefined) input.duration = duration;

    const audioPrefix = requestedCount > 1 ? `${prefix}-${index + 1}` : prefix;
    const activeRequest = (await requestMetadataFiles(outputDir, { slug: audioPrefix })).find((request) => request.data.batch_id === batchId && (isActiveRequest(request) || request.data.status === "completed"));
    const requestIndex = activeRequest?.index ?? await nextIndex(outputDir, audioPrefix);
    const metadataPath = activeRequest?.path ?? requestPath(outputDir, requestIndex, audioPrefix);
    const completedLocal = activeRequest?.data.status === "completed" && activeRequest.data.output_files?.length && await pathExists(activeRequest.data.output_files[0]);
    const result = activeRequest
      ? completedLocal
        ? { requestId: activeRequest.data.request_id, submittedAt: activeRequest.data.submitted_at, data: activeRequest.data.result }
        : await resumeMivoRequest(activeRequest)
      : await callMivoTask(ENDPOINT, input, {
          metadataPath,
          metadata: {
            kind: "sfx",
            sfx_kind: kind,
            provider: ENDPOINT,
            index: requestIndex,
            batch_id: batchId
          },
          pollIntervalMs: 3000
        });
    const audio = result.data?.files?.find((file) => file.content_type?.startsWith("audio/") || /\.(mp3|wav|opus)$/i.test(file.file_name));
    const audioUrl = audio?.url;
    if (!audioUrl) {
      throw new Error("Mivo SFX result did not include an audio file.");
    }

    const audioPath = artifactPath(outputDir, requestIndex, audioPrefix, extension);
    if (!completedLocal) await downloadFile(audioUrl, audioPath);
    const audioAnalysis = completedLocal && activeRequest.data.audio_analysis
      ? activeRequest.data.audio_analysis
      : await analyzeAndPostprocessAudio(audioPath, {
      extension,
      postprocess: shouldPostprocess
    });

    const file = {
      path: audioPath,
      url: audioUrl,
      source: audio,
      output_format: outputFormat,
      loop: Boolean(loop),
      duration_seconds: audioAnalysis.after.duration_seconds ?? duration,
      audio_analysis: audioAnalysis
    };
    files.push(file);
    requests.push({
      index: requestIndex,
      kind: "sfx",
      request_id: result.requestId,
      generated_at: new Date().toISOString(),
      endpoint: ENDPOINT,
      metadata_path: metadataPath,
      file: audioPath
    });

    const metadata = (await readJsonIfExists(metadataPath)) || {};
    const summary = buildRequestSummary({
      kind: "sfx",
      provider: ENDPOINT,
      metadata: {
        index: requestIndex,
        sfx_kind: kind,
        batch_id: batchId
      },
      requestId: result.requestId,
      submittedAt: result.submittedAt,
      prompt,
      inputFiles: [],
      outputFiles: [audioPath],
      downloadedFiles: [{
        label: "audio",
        path: audioPath,
        source: audio
      }],
      result: result.data,
      extra: {
        audio_analysis: audioAnalysis
      }
    });

    await writeJson(metadataPath, {
      ...metadata,
      ...summary
    });
  }

  const run = {
    id: new Date().toISOString(),
    kind,
    prompt,
    loop: Boolean(loop),
    count: requestedCount,
    files,
    requests
  };
  await writeJson(batchPath, { id: batchId, status: "completed", settings });

  return {
    ...run,
    provider: ENDPOINT,
    endpoint: ENDPOINT
  };
}

async function main() {
  const { flags, positionals } = parseArgs();
  const prompt = one(flags, "prompt") || positionals.join(" ");
  const outputDir = one(flags, "output-dir");

  if (!prompt || !outputDir) {
    throw new Error(
      "Usage: node mivo-elevenlabs-sfx.mjs --prompt <description> --output-dir <dir> [--count 1-4] [--loop] [--duration-seconds <0.5-22>]"
    );
  }

  const result = await generateSfx({
    prompt,
    outputDir,
    prefix: one(flags, "prefix", slugify(prompt).slice(0, 40) || "sfx"),
    count: one(flags, "count", 1),
    loop: asBool(one(flags, "loop"), false),
    durationSeconds: one(flags, "duration-seconds"),
    promptInfluence: one(flags, "prompt-influence", 0.3),
    outputFormat: one(flags, "output-format", DEFAULT_OUTPUT_FORMAT),
    kind: one(flags, "kind", "sfx"),
    postprocess: asBool(one(flags, "postprocess"), true)
  });

  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
