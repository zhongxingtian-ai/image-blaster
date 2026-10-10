import { readFile } from "node:fs/promises";
import path from "node:path";
import { inferMime, loadDotEnv, sanitizeForMetadata, safeFileName, updateMetadata } from "./pipeline-utils.mjs";

const sessions = new Map();
let auth;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function configuration() {
  await loadDotEnv();
  const endpoint = new URL(process.env.MIVO_ENDPOINT || "https://aigc.xindong.com");
  if (endpoint.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) {
    throw new Error("MIVO_ENDPOINT must use HTTPS (HTTP is allowed only on localhost).");
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("Invalid MIVO_ENDPOINT.");
  const key = process.env.MIVO_USER_SUB?.trim();
  if (!key) throw new Error("MIVO_USER_SUB is required. Configure your company Mivo API key in .env.");
  return { endpoint: endpoint.href.replace(/\/$/, ""), key };
}

async function getToken(config, force = false) {
  if (!force && auth?.endpoint === config.endpoint && auth.key === config.key && auth.expires > Date.now()) return auth.token;
  const response = await fetch(`${config.endpoint}/api/v1/state/token`, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(30000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "", sub: config.key, name: "" })
  });
  if (!response.ok) throw new Error(`Mivo authentication failed (${response.status}).`);
  const data = await response.json();
  if (!data.session) throw new Error("Mivo authentication returned no session.");
  auth = { ...config, token: data.session, expires: Date.now() + 24 * 60 * 60 * 1000 };
  return auth.token;
}

async function apiRequest(apiPath, options = {}) {
  const config = await configuration();
  const method = options.method || "GET";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const token = await getToken(config);
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${config.endpoint}/api/v1${apiPath}`, {
      ...options, headers, redirect: "error", signal: AbortSignal.timeout(60000)
    });
    if (response.status === 401 && attempt === 0) {
      await getToken(config, true);
      continue;
    }
    if ((response.status === 429 || (method === "GET" && response.status >= 500)) && attempt < 3) {
      const seconds = Number(response.headers.get("Retry-After"));
      await delay(Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 60) * 1000 : 3500 * (attempt + 1));
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(`Mivo ${method} ${apiPath.split("?")[0]} failed (${response.status}).`), { status: response.status });
    return response;
  }
  throw new Error("Mivo request retry limit exceeded.");
}

async function apiJson(apiPath, body) {
  const options = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return (await apiRequest(apiPath, options)).json();
}

function objectId(value) {
  if (typeof value === "string") return normalizeFileId(value);
  return value?.object_id || value?._id || value?.id;
}

function normalizeFileId(value) {
  if (typeof value !== "string" || !value) throw new Error("Mivo returned an invalid file reference.");
  return value.split(/[?#]/)[0].replace(/\/$/, "").split("/").at(-1);
}

export async function getMivoCapability(id) {
  if (!/^(image|model3d|audio|video|event)\.[a-z0-9.-]+$/.test(id)) {
    throw new Error("This request is not a company Mivo capability. Legacy FAL tasks cannot be resumed here.");
  }
  const response = await apiJson(`/capabilities/${encodeURIComponent(id)}`);
  const capability = response.capability || response;
  if (!capability.request?.bodyTemplate?.modelType || !capability.request.bodyTemplate.messageType) throw new Error(`Mivo capability ${id} is not a message generation capability.`);
  return capability;
}

export async function searchMivoCapabilities(query = "") {
  return apiJson(`/capabilities/search?query=${encodeURIComponent(query)}&limit=100`);
}

async function chatSession(type) {
  const config = await configuration();
  const cacheKey = `${config.endpoint}\n${config.key}\n${type}`;
  if (!sessions.has(cacheKey)) {
    const id = objectId(await apiJson("/message/chat", { type }));
    if (!id) throw new Error("Mivo returned no chat session ID.");
    sessions.set(cacheKey, id);
  }
  return sessions.get(cacheKey);
}

async function inputFile(value) {
  if (typeof value !== "string" || !value) throw new Error("Input image must be a path, URL or data URI.");
  if (value.startsWith("data:")) {
    const match = value.match(/^data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match) throw new Error("Expected a base64 image data URI.");
    return { bytes: Buffer.from(match[2], "base64"), mime: match[1], name: "reference.png" };
  }
  if (/^https?:\/\//.test(value)) {
    const response = await fetch(value, { signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error(`Reference image download failed (${response.status}).`);
    return { bytes: Buffer.from(await response.arrayBuffer()), mime: response.headers.get("Content-Type")?.split(";")[0] || inferMime(value), name: path.basename(new URL(value).pathname) || "reference.png" };
  }
  return { bytes: await readFile(value), mime: inferMime(value), name: path.basename(value) };
}

export async function uploadMivoImage(value) {
  if (/^mivo:\/\/image\/[\w-]+$/.test(value)) return value.slice("mivo://image/".length);
  if (typeof value === "string" && /^[a-f0-9]{24}$/i.test(value)) return value;
  const file = await inputFile(value);
  if (!file.mime.startsWith("image/") || file.bytes.length > 20 * 1024 * 1024) throw new Error("Reference images must be images of at most 20 MB.");
  const form = new FormData();
  form.append("file", new Blob([file.bytes], { type: file.mime }), safeFileName(file.name));
  const response = await (await apiRequest("/file/", { method: "POST", body: form })).json();
  const id = objectId(Array.isArray(response) ? response[0] : response);
  if (!id) throw new Error("Mivo upload returned no file ID.");
  return id;
}

export async function submitMivoTask(id, input, options = {}) {
  const capability = await getMivoCapability(id);
  const body = structuredClone(capability.request.bodyTemplate);
  // Vendor-specific defaults may be invalid for another enabled version.
  // The server validates and fills defaults for the explicitly submitted inputs.
  const payload = { ...input };
  if (payload.images) payload.images = await Promise.all(payload.images.map((image) => image === null ? null : uploadMivoImage(image)));
  if (options.modelVersion) {
    const versions = capability.models?.flatMap((model) => model.enabledVersions || []) || [];
    if (!versions.includes(options.modelVersion)) throw new Error(`Mivo capability ${id} does not support version ${options.modelVersion}.`);
    body.modelFormat = { ...body.modelFormat, version: options.modelVersion };
  }
  body.payload = payload;
  if (body.messageType === "image" && payload.images?.length) body.action = "modal";
  body.chatSessionId = await chatSession(capability.request.context?.chatSession?.type || "freeform");
  const submittedAt = new Date().toISOString();
  const metadata = { ...options.metadata, endpoint: id, api_provider: "mivo", status: "submitting", submitted_at: submittedAt };
  await updateMetadata(options.metadataPath, { ...metadata, input: sanitizeForMetadata(body.payload) });
  let response;
  try {
    response = await apiJson("/message", body);
  } catch (error) {
    await updateMetadata(options.metadataPath, { status: error.status >= 400 && error.status < 500 ? "failed" : "submission_unknown" });
    throw error;
  }
  const requestId = objectId(response);
  if (!requestId) throw new Error("Mivo submit returned no message ID. Check the company console before retrying.");
  const submitted = { ...metadata, request_id: requestId, status: "submitted" };
  await updateMetadata(options.metadataPath, submitted);
  if (options.onSubmit) await options.onSubmit(submitted);
  return submitted;
}

function assertTask(id, requestId) {
  if (!/^(image|model3d|audio|video|event)\.[a-z0-9.-]+$/.test(id)) throw new Error("Legacy FAL tasks cannot be resumed through Mivo. Use local outputs or explicitly regenerate.");
  if (!requestId) throw new Error("Submission has no confirmed message ID. Check the company console before regenerating.");
}

export function isUncertainSubmission(request) {
  return ["submitting", "submission_unknown"].includes(request?.data?.status) && !request.data.request_id;
}

function readTaskResult(requestId) {
  // force reads the worker result instead of a potentially stale message projection.
  return apiJson(`/message/${encodeURIComponent(requestId)}/result?force=true`);
}

export async function pollMivoTask(id, requestId, options = {}) {
  assertTask(id, requestId);
  const deadline = Date.now() + (options.timeoutMs ?? 30 * 60 * 1000);
  while (Date.now() < deadline) {
    const result = await readTaskResult(requestId);
    const state = String(result.status || result.content?.status || "unknown").toLowerCase();
    const done = ["completed", "success", "succeeded"].includes(state);
    const patch = { endpoint: id, request_id: requestId, api_provider: "mivo", status: done ? "downloading" : state, upstream_status: state, checked_at: new Date().toISOString() };
    await updateMetadata(options.metadataPath, patch);
    if (options.onStatus) await options.onStatus(patch);
    if (done) return { endpoint: id, request_id: requestId, status: result };
    if (["failed", "failure", "error", "cancelled", "canceled", "revoked"].includes(state)) throw new Error(`Mivo generation ${state}. Check the company console for task details.`);
    if (!["pending", "submitted", "processing", "running", "queued", "in_progress"].includes(state)) throw new Error(`Unexpected Mivo task status: ${state}.`);
    await delay(options.pollIntervalMs ?? 3000);
  }
  throw new Error("Mivo task is still running. Its message ID has been saved; run again to resume without resubmitting.");
}

async function outputFile(id) {
  const meta = await apiJson(`/file/meta/${encodeURIComponent(id)}`);
  const signed = await apiJson(`/file/signUrl/${encodeURIComponent(id)}`);
  const rawUrl = typeof signed === "string" ? signed : signed.url;
  const url = rawUrl?.startsWith("//") ? `https:${rawUrl}` : rawUrl;
  if (!url || !/^https?:\/\//.test(url)) throw new Error("Mivo returned an invalid download URL.");
  const extension = path.extname(meta.name || "") || ".bin";
  return { file_id: id, url, content_type: meta.contentType, file_name: `${safeFileName(id)}-${safeFileName(path.basename(meta.name || "output", extension)).slice(0, 60)}${extension}` };
}

export async function getMivoTaskResult(id, requestId, options = {}) {
  assertTask(id, requestId);
  const result = options.taskResult || await readTaskResult(requestId);
  const state = String(result.status || result.content?.status || "unknown").toLowerCase();
  if (!["completed", "success", "succeeded"].includes(state)) throw new Error("Mivo result is not completed.");
  const content = result.content || {};
  const fileIds = [...(content.images || []), ...(content.model_files || []), ...(content.audios || []).map((audio) => audio.id), ...(content.videos || []).map((video) => video.id)].map(normalizeFileId);
  if (!fileIds.length) throw new Error("Mivo completed without output files.");
  const data = { files: await Promise.all([...new Set(fileIds)].map(outputFile)) };
  await updateMetadata(options.metadataPath, { status: "downloading", upstream_status: "completed", api_provider: "mivo", result: data });
  return { requestId, data };
}

export async function callMivoTask(id, input, options = {}) {
  const submitted = await submitMivoTask(id, input, options);
  return resumeMivoTask(submitted, options);
}

export async function resumeMivoTask(request, options = {}) {
  const data = request.data || request;
  const settings = { ...options, metadataPath: options.metadataPath || request.path };
  const status = await pollMivoTask(data.endpoint, data.request_id, settings);
  const result = await getMivoTaskResult(data.endpoint, data.request_id, { ...settings, taskResult: status.status });
  return { ...result, submittedAt: data.submitted_at, queueStatus: status.status };
}
