---
name: image-blast-wildcard
description: Discover and run one generation capability from the company Mivo API when no narrower Image Blast skill fits.
argument-hint: [company capability or natural request] [inputs and output directory]
allowed-tools: Read Write Glob Bash(ls *) Bash(node .claude/scripts/mivo/run-mivo.mjs *) Bash(node .claude/scripts/project/ensure-local-assets.mjs *)
---

## Instructions

Discover company capabilities with `node .claude/scripts/mivo/run-mivo.mjs --search "<query>"`.
Use the returned capability ID and its live request body template. The company catalog describes Mivo message payloads, not the vendor API payloads.

Before starting a new generation, confirm the exact capability and inputs unless the user has already authorized that operation in the current conversation. A confirmed background request starts with `CONFIRMED_MIVO_CAPABILITY: <id>`. The execution agent must use that capability and must not select another model or contact FAL.

Run a confirmed message generation:

```bash
node .claude/scripts/mivo/run-mivo.mjs \
  --capability "<company capability id>" \
  --payload-file "<JSON containing the capability payload>" \
  --output-dir "<output directory>" \
  --output-slug "<artifact slug>"
```

Use `--image <path>` for reference files, which the client uploads to Mivo. Optional `--model-version` must be enabled in the company catalog. Configure `MIVO_USER_SUB` locally; do not paste or log the key. The endpoint defaults to `https://aigc.xindong.com`.

The runner saves company message IDs and can resume interrupted tasks. If a submit response was lost before its ID was confirmed, check the company console before explicitly regenerating. Report generated local files and request metadata. File exports and other non-message capabilities require their documented interfaces and are not supported by this runner.
