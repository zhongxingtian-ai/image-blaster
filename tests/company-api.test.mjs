import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { runNanoBananaEdit } from "../.claude/scripts/asset-pipeline/nano-banana-edit.mjs";
import { generateSingleAsset } from "../.claude/scripts/asset-pipeline/generate-single-asset.mjs";
import { runGptImage2Edit } from "../.claude/scripts/asset-pipeline/gpt-image-2-edit.mjs";
import { generateEdit } from "../.claude/scripts/image-edit/generate-edit.mjs";
import { generateSfx } from "../.claude/scripts/sfx/mivo-elevenlabs-sfx.mjs";
import { callMivoTask, getMivoTaskResult, pollMivoTask } from "../.claude/scripts/asset-pipeline/mivo-client.mjs";
import { runMivoCapability } from "../.claude/scripts/mivo/run-mivo.mjs";

const base = "https://company-api.example.test";
const token = "test-company-session";
const capabilities = {
  "image.nano-banana": {
    models: [{ modelType: "NANOBANANA", enabledVersions: ["GEMINI_3_PRO_IMAGE"] }],
    request: {
      bodyTemplate: { modelType: "NANOBANANA", messageType: "image", action: "imagine", modelFormat: { version: "GEMINI_3_PRO_IMAGE" }, payload: { n: 1, resolution: "2K" } },
      context: { chatSession: { type: "freeform" } }
    }
  },
  "model3d.tripo": {
    models: [{ modelType: "TRIPO3D", enabledVersions: ["P1", "V3.1"] }],
    request: {
      bodyTemplate: { modelType: "TRIPO3D", messageType: "model3d", action: "generate_3d_model", modelFormat: { version: "P1" }, payload: { faceCount: "auto", generateType: "PBR" } },
      context: { chatSession: { type: "model3d" } }
    }
  },
  "image.gpt": {
    models: [{ modelType: "GPT", enabledVersions: ["gpt-image-2", "gpt-image-2.5-sunburst"] }],
    request: { bodyTemplate: { modelType: "GPT", messageType: "image", action: "imagine", modelFormat: { version: "gpt-image-2" }, payload: {} }, context: { chatSession: { type: "freeform" } } }
  },
  "audio.elevenlabs-sound-effect": {
    models: [{ modelType: "ELEVENLABS", enabledVersions: ["eleven_text_to_sound_v2"] }],
    request: { bodyTemplate: { modelType: "ELEVENLABS", messageType: "audio", action: "generate_sound_effect", modelFormat: { version: "eleven_text_to_sound_v2" }, payload: {} }, context: { chatSession: { type: "audio" } } }
  }
};

let folder;
let image;
let calls;
let originalFetch;
let savedEnv;
let jobs;
let originalCwd;

function json(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

async function mockFetch(url, options = {}) {
  const target = new URL(url);
  calls.push({ url: String(url), ...options });
  if (target.origin === "https://output.example.test") {
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    return new Response("generated-content", { headers: { "Content-Type": "image/png" } });
  }
  assert.equal(target.origin, base, "generation must use the company API");
  if (target.pathname === "/api/v1/state/token") return json({ session: token });
  assert.equal(new Headers(options.headers).get("Authorization"), `Bearer ${token}`);
  const capability = target.pathname.match(/\/capabilities\/(.+)$/)?.[1];
  if (capability) return json(capabilities[capability]);
  if (target.pathname === "/api/v1/message/chat") return json({ object_id: "chat-id" });
  if (target.pathname === "/api/v1/file/") return json(["/file/image/input-file-id"], 201);
  if (target.pathname === "/api/v1/message") {
    const body = JSON.parse(options.body);
    const id = `job-${jobs.size + 1}`;
    jobs.set(id, body);
    return json({ object_id: id }, 201);
  }
  const job = target.pathname.match(/\/message\/(.+)\/result$/)?.[1];
  if (job) {
    const mediaType = jobs.get(job)?.messageType;
    return json({ status: "completed", content: mediaType === "model3d" ? { model_files: ["/file/model/output-model-id"] } : mediaType === "video" ? { videos: [{ id: "output-video-id", uri: "/file/video/output-video-id" }] } : mediaType === "audio" ? { audios: [{ id: "output-audio-id", uri: "/file/audio/output-audio-id" }] } : { images: ["/file/image/output-image-id"], model_files: null } });
  }
  const fileId = target.pathname.match(/\/file\/meta\/(.+)$/)?.[1];
  if (fileId) return json({ name: fileId.endsWith("model-id") ? "model.glb" : fileId.endsWith("audio-id") ? "sound.mp3" : fileId.endsWith("video-id") ? "video.mp4" : "image.png", contentType: fileId.endsWith("model-id") ? "model/gltf-binary" : fileId.endsWith("audio-id") ? "audio/mpeg" : fileId.endsWith("video-id") ? "video/mp4" : "image/png" });
  if (target.pathname.includes("/file/signUrl/")) return json("//output.example.test/generated");
  throw new Error(`Unexpected company API path: ${target.pathname}`);
}

beforeEach(async () => {
  folder = await mkdtemp(path.join(os.tmpdir(), "image-blaster-company-test-"));
  image = path.join(folder, "source.png");
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB", "base64"));
  calls = [];
  jobs = new Map();
  originalFetch = globalThis.fetch;
  originalCwd = process.cwd();
  savedEnv = { ...process.env };
  Object.assign(process.env, { MIVO_ENDPOINT: base, MIVO_USER_SUB: "mivo-test-key" });
  delete process.env.FAL_KEY;
  globalThis.fetch = mockFetch;
  process.chdir(folder);
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  process.chdir(originalCwd);
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await rm(folder, { recursive: true, force: true });
});

test("image editing uploads references to Mivo and downloads the generated image", async () => {
  const metadataPath = path.join(folder, "request.json");
  const result = await runNanoBananaEdit({ images: [image], prompt: "Remove the chair", outputDir: folder, metadataPath });
  const generated = [...jobs.values()][0];
  assert.equal(generated.modelType, "NANOBANANA");
  assert.equal(generated.action, "modal");
  assert.deepEqual(generated.payload.images, ["input-file-id"]);
  assert.equal(result.downloaded_files.length, 1);
  assert.ok(calls.filter((call) => new URL(call.url).pathname.endsWith("/result")).every((call) => new URL(call.url).searchParams.get("force") === "true"));
  assert.equal(await readFile(result.downloaded_files[0].path, "utf8"), "generated-content");
  const metadata = await readFile(metadataPath, "utf8");
  assert.equal(metadata.includes(token), false);
  assert.equal(metadata.includes("mivo-test-key"), false);
});

test("single-asset generation defaults to Tripo through the company API", async () => {
  const result = await generateSingleAsset({ world: "room", directImage: image, objectName: "Chair", description: "A wooden chair", imageEditPrompt: "Isolate the chair", regenerate: false });
  const modelJob = [...jobs.values()].find((job) => job.messageType === "model3d");
  assert.equal(modelJob.modelType, "TRIPO3D");
  assert.equal(modelJob.action, "generate_3d_model");
  assert.equal(result.model_provider, "tripo");
  assert.ok(result.model_files.some((file) => file.endsWith(".glb")));
});

test("GPT editing carries the mask through the company's native mask field", async () => {
  const metadataPath = path.join(folder, "gpt.json");
  await runGptImage2Edit({ images: [image], maskImage: image, prompt: "Replace the chair", outputDir: folder, metadataPath });
  const body = [...jobs.values()][0];
  assert.equal(body.modelFormat.version, "gpt-image-2.5-sunburst");
  assert.equal(body.payload.size, undefined);
  assert.equal(body.payload.background, "opaque");
  assert.ok(body.payload.maskBase64.startsWith("data:image/png;base64,"));
  assert.equal((await readFile(metadataPath, "utf8")).includes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"), false);
});

test("sound effects use the company audio task and produce indexed MP3 files", async () => {
  const result = await generateSfx({ prompt: "A wooden tap", outputDir: folder, prefix: "tap", count: 2, durationSeconds: 3, postprocess: false });
  for (const body of jobs.values()) {
    assert.equal(body.modelType, "ELEVENLABS");
    assert.equal(body.payload.prompt, "A wooden tap");
    assert.equal(body.payload.duration, 3);
    assert.equal(body.payload.n, 1);
    assert.equal(body.payload.text, undefined);
  }
  assert.equal(result.files.length, 2);
  for (const file of result.files) assert.ok(file.path.endsWith(".mp3"));
});

test("a interrupted image task resumes the saved company message instead of charging again", async () => {
  let fail = true;
  globalThis.fetch = async (url, options) => {
    if (String(url).includes("/result") && fail) { fail = false; throw new Error("temporary network outage"); }
    return mockFetch(url, options);
  };
  const options = { images: [image], prompt: "Remove the chair", outputDir: folder, outputSlug: "plate" };
  await assert.rejects(generateEdit(options), /network outage/);
  const result = await generateEdit(options);
  assert.equal(jobs.size, 1);
  assert.equal(JSON.parse(await readFile(result.request_metadata, "utf8")).request_id, "job-1");
});

test("an uncertain submission blocks automatic resubmission until the user checks it", async () => {
  globalThis.fetch = async (url, options) => {
    const result = await mockFetch(url, options);
    if (new URL(url).pathname === "/api/v1/message") throw new Error("submit response lost");
    return result;
  };
  const options = { images: [image], prompt: "Remove the chair", outputDir: folder, outputSlug: "plate" };
  await assert.rejects(generateEdit(options), /submit response lost/);
  globalThis.fetch = mockFetch;
  await assert.rejects(generateEdit(options), /no confirmed message ID/);
  assert.equal(jobs.size, 1);
});

test("legacy FAL jobs never send their IDs or credentials to the company endpoint", async () => {
  await writeFile(path.join(folder, ".0-plate-request.json"), JSON.stringify({ endpoint: "fal-ai/nano-banana-2/edit", request_id: "old-fal-job", status: "submitted" }));
  await assert.rejects(generateEdit({ images: [image], prompt: "Remove the chair", outputDir: folder, outputSlug: "plate" }), /Legacy FAL/);
  assert.equal(calls.length, 0);
});

test("a missing company key fails before any network request", async () => {
  delete process.env.MIVO_USER_SUB;
  await assert.rejects(callMivoTask("image.nano-banana", { prompt: "A chair" }), /MIVO_USER_SUB is required/);
  assert.equal(calls.length, 0);
});

test("a failed task is saved as failed and produces no downloaded files", async () => {
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith("/result") ? json({ status: "failed", error: "upstream failure" }) : mockFetch(url, options);
  const metadataPath = path.join(folder, "failed.json");
  await assert.rejects(callMivoTask("image.nano-banana", { prompt: "A chair" }, { metadataPath }), /generation failed/);
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).status, "failed");
  assert.equal(calls.some((call) => call.url.startsWith("https://output")), false);
});

test("a polling timeout keeps the message ID for later recovery", async () => {
  globalThis.fetch = (url, options) => new URL(url).pathname.endsWith("/result") ? json({ status: "processing" }) : mockFetch(url, options);
  const metadataPath = path.join(folder, "timeout.json");
  await assert.rejects(pollMivoTask("image.nano-banana", "job-existing", { metadataPath, timeoutMs: 10, pollIntervalMs: 0 }), /still running/);
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).request_id, "job-existing");
  assert.equal(jobs.size, 0);
});

test("a rejected submit is recorded as failed rather than an unknown paid task", async () => {
  globalThis.fetch = (url, options) => new URL(url).pathname === "/api/v1/message" ? json({ detail: "invalid options" }, 422) : mockFetch(url, options);
  const metadataPath = path.join(folder, "rejected.json");
  await assert.rejects(callMivoTask("image.nano-banana", { prompt: "A chair" }, { metadataPath }), /422/);
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).status, "failed");
});

test("a submit server error is not automatically retried", async () => {
  let submits = 0;
  globalThis.fetch = (url, options) => {
    if (new URL(url).pathname === "/api/v1/message") { submits += 1; return json({}, 503); }
    return mockFetch(url, options);
  };
  const metadataPath = path.join(folder, "unknown.json");
  await assert.rejects(callMivoTask("image.nano-banana", { prompt: "A chair" }, { metadataPath }), /503/);
  assert.equal(submits, 1);
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).status, "submission_unknown");
});

test("a completed image whose download fails resumes without another paid submission", async () => {
  let fail = true;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("https://output") && fail) { fail = false; return new Response("download unavailable", { status: 502 }); }
    return mockFetch(url, options);
  };
  const options = { images: [image], prompt: "Remove the chair", outputDir: folder, outputSlug: "plate" };
  await assert.rejects(generateEdit(options), /Download failed/);
  await generateEdit(options);
  assert.equal(jobs.size, 1);
});

test("the generic capability runner resumes a completed task after download failure", async () => {
  let fail = true;
  globalThis.fetch = (url, options) => {
    if (String(url).startsWith("https://output") && fail) { fail = false; return new Response("download unavailable", { status: 502 }); }
    return mockFetch(url, options);
  };
  const options = { capability: "model3d.tripo", payload: { images: [image] }, outputDir: folder };
  await assert.rejects(runMivoCapability(options), /Download failed/);
  const result = await runMivoCapability(options);
  assert.equal(jobs.size, 1);
  assert.ok(result.output_files[0].endsWith(".glb"));
});

test("a partial audio batch reuses completed items before resuming the remaining task", async () => {
  let fail = true;
  globalThis.fetch = (url, options) => {
    if (new URL(url).pathname.endsWith("/message/job-2/result") && fail) { fail = false; throw new Error("audio polling interrupted"); }
    return mockFetch(url, options);
  };
  const options = { prompt: "A wooden tap", outputDir: folder, prefix: "tap", count: 2, postprocess: false };
  await assert.rejects(generateSfx(options), /polling interrupted/);
  const saved = JSON.parse(await readFile(path.join(folder, ".0-tap-1-request.json"), "utf8"));
  await writeFile(saved.output_files[0], "already-processed-audio");
  const result = await generateSfx(options);
  assert.equal(jobs.size, 2);
  assert.equal(result.files.length, 2);
  assert.equal(await readFile(saved.output_files[0], "utf8"), "already-processed-audio");
  assert.equal(calls.filter((call) => call.url.startsWith("https://output")).length, 2);
});

test("completed video task outputs are resolved using company file metadata", async () => {
  jobs.set("video-job", { messageType: "video" });
  const result = await getMivoTaskResult("video.example", "video-job");
  assert.equal(result.data.files[0].content_type, "video/mp4");
  assert.equal(result.data.files[0].url, "https://output.example.test/generated");
});

test("a direct Tripo CLI loads its model override from the local env file", async () => {
  await writeFile(path.join(folder, ".env"), "MIVO_TRIPO_MODEL_VERSION=V3.1\n");
  const code = `
    import assert from 'node:assert/strict';
    import { runTripo3D } from ${JSON.stringify("file://" + path.join(originalCwd, ".claude/scripts/asset-pipeline/tripo-3d.mjs"))};
    const base = ${JSON.stringify(base)}, token = ${JSON.stringify(token)};
    const capabilities = ${JSON.stringify(capabilities)};
    const calls = [], jobs = new Map();
    ${json.toString()}
    ${mockFetch.toString()}
    globalThis.fetch = mockFetch;
    await runTripo3D({ image: ${JSON.stringify(image)}, outputDir: ${JSON.stringify(folder)} });
    console.log([...jobs.values()][0].modelFormat.version);
  `;
  const env = { ...process.env };
  delete env.MIVO_TRIPO_MODEL_VERSION;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8", cwd: folder });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), "V3.1");
});

test("Tripo sends only caller parameters instead of incompatible catalog defaults", async () => {
  const template = capabilities["model3d.tripo"].request.bodyTemplate;
  const previous = template.payload;
  template.payload = { ...previous, geometry_quality: "standard", quad: false, pbr: true };
  try {
    await runMivoCapability({ capability: "model3d.tripo", payload: { images: [image] }, outputDir: folder });
    const job = [...jobs.values()][0];
    assert.equal(job.payload.pbr, undefined);
    assert.equal(job.payload.geometry_quality, undefined);
  } finally {
    template.payload = previous;
  }
});

test("resumed metadata redacts credentials even if the upstream response echoes them", async () => {
  let fail = true;
  globalThis.fetch = async (url, options) => {
    if (new URL(url).pathname.endsWith("/result") && fail) { fail = false; throw new Error("polling interrupted"); }
    const response = await mockFetch(url, options);
    if (new URL(url).pathname.endsWith("/result")) return json({ ...await response.json(), userSub: "mivo-test-key", authorization: `Bearer ${token}` });
    return response;
  };
  const options = { images: [image], prompt: "Remove the chair", outputDir: folder, outputSlug: "plate" };
  await assert.rejects(generateEdit(options), /polling interrupted/);
  const result = await generateEdit(options);
  const metadata = await readFile(result.request_metadata, "utf8");
  assert.equal(metadata.includes("mivo-test-key"), false);
  assert.equal(metadata.includes(token), false);
});
