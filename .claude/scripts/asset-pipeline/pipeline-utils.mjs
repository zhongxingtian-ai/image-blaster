#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

let envLoaded = false;

export async function loadDotEnv(envPath = ".env") {
  if (envLoaded) return;
  envLoaded = true;

  let contents;
  try {
    contents = await readFile(envPath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = line.slice(0, equalsIndex).trim();
    let value = line.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export async function requireEnv(name) {
  await loadDotEnv();
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set. Add it to .env before running this script.`);
  }
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positionals = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    const key = token.slice(2);
    const next = argv[index + 1];
    const value = next === undefined || next.startsWith("--") ? true : next;
    if (value !== true) index += 1;

    if (flags[key] === undefined) {
      flags[key] = value;
    } else if (Array.isArray(flags[key])) {
      flags[key].push(value);
    } else {
      flags[key] = [flags[key], value];
    }
  }

  return { flags, positionals };
}

export function one(flags, key, fallback = undefined) {
  const value = flags[key];
  if (Array.isArray(value)) return value.at(-1);
  return value ?? fallback;
}

export function many(flags, key) {
  const value = flags[key];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

export async function ensureDir(dirPath) {
  await mkdir(dirPath, { recursive: true });
}

export async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  const value = JSON.parse(await readFile(filePath, "utf8"));
  return isRequestMetadataPath(filePath) ? stripBase64(value) : value;
}

function isRequestMetadataPath(filePath) {
  return /-request\.json$/i.test(path.basename(filePath || ""));
}

export async function writeJson(filePath, value) {
  await ensureDir(path.dirname(filePath));
  const output = isRequestMetadataPath(filePath) ? stripBase64(value) : value;
  await writeFile(filePath, `${JSON.stringify(output, null, 2)}\n`);
}

export function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function isUrl(value) {
  return /^https?:\/\//i.test(value);
}

export function isDataUri(value) {
  return /^data:/i.test(value);
}

export function inferMime(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  const mimes = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".heic": "image/heic",
    ".heif": "image/heif",
    ".glb": "model/gltf-binary",
    ".obj": "model/obj",
    ".mtl": "model/mtl",
    ".fbx": "application/octet-stream",
    ".usdz": "model/vnd.usdz+zip"
  };
  return mimes[extension] ?? "application/octet-stream";
}

export async function fileToDataUri(filePath) {
  const data = await readFile(filePath);
  return `data:${inferMime(filePath)};base64,${data.toString("base64")}`;
}

export async function toModelInputUrl(value) {
  if (isUrl(value) || isDataUri(value)) return value;
  if (!(await pathExists(value))) {
    throw new Error(`Input file does not exist: ${value}`);
  }
  return fileToDataUri(value);
}

export async function downloadFile(url, outputPath) {
  await ensureDir(path.dirname(outputPath));

  if (isDataUri(url)) {
    const match = url.match(/^data:([^;,]+)?(;base64)?,(.*)$/);
    if (!match) throw new Error("Invalid data URI");
    const body = decodeURIComponent(match[3]);
    const buffer = match[2] ? Buffer.from(body, "base64") : Buffer.from(body);
    await writeFile(outputPath, buffer);
    return outputPath;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed (${response.status}) from ${new URL(url).origin}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  await writeFile(outputPath, buffer);
  return outputPath;
}

export function extensionForFile(file, fallback = ".bin") {
  if (file.file_name) {
    const extension = path.extname(file.file_name);
    if (extension) return extension;
  }

  const mime = file.content_type;
  const extensions = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "model/gltf-binary": ".glb",
    "model/obj": ".obj",
    "model/mtl": ".mtl"
  };
  return extensions[mime] ?? fallback;
}

export function safeFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

export function collectRemoteFiles(value, label = "file", collected = [], seen = new Set()) {
  if (!value) return collected;

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectRemoteFiles(item, `${label}-${index + 1}`, collected, seen));
    return collected;
  }

  if (typeof value === "object") {
    if (typeof value.url === "string" && !seen.has(value.url)) {
      seen.add(value.url);
      collected.push({ label, file: value });
      return collected;
    }

    for (const [key, child] of Object.entries(value)) {
      collectRemoteFiles(child, key, collected, seen);
    }
  }

  return collected;
}

export async function downloadRemoteFiles(result, outputDir, prefix = "file") {
  const downloaded = [];
  const remoteFiles = collectRemoteFiles(result);

  for (const { label, file } of remoteFiles) {
    const fallbackName = `${prefix}-${safeFileName(label)}${extensionForFile(file)}`;
    const fileName = safeFileName(file.file_name || fallbackName);
    const outputPath = path.join(outputDir, fileName);
    await downloadFile(file.url, outputPath);
    downloaded.push({
      label,
      path: outputPath,
      source: file
    });
  }

  return downloaded;
}

function isBase64Field(key) {
  return /base64|b64/i.test(String(key || ""));
}

export function stripBase64(value, key = "") {
  if (["authorization", "apikey", "mivousersub", "usersub", "session", "accesstoken", "refreshtoken", "password"].includes(String(key).replace(/[_-]/g, "").toLowerCase())) return "[redacted]";
  if (typeof value === "string") {
    if (isDataUri(value) || isBase64Field(key)) return "[stripped]";
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripBase64(item, key));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, child]) => [
        childKey,
        stripBase64(child, childKey)
      ])
    );
  }

  return value;
}

export const sanitizeForMetadata = stripBase64;

export function normalizeBoolean(value, fieldName = "boolean") {
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${fieldName} must be true or false.`);
}

export async function updateMetadata(metadataPath, patch) {
  if (!metadataPath) return;
  const previous = (await pathExists(metadataPath)) ? await readJson(metadataPath) : {};
  await writeJson(metadataPath, sanitizeForMetadata({
    schema_version: 1,
    ...previous,
    ...patch,
    updated_at: new Date().toISOString()
  }));
}
