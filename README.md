<img width="960" height="540" alt="image-blaster-1" src="https://github.com/user-attachments/assets/d294e420-eb48-4f00-b6a8-13005442d1a8" />

## `image-blaster`
Creates 3D environments, SFX, and meshes from a single image using Claude skills, World Labs, and the company's Mivo API.

This fork uses `https://aigc.xindong.com` for image editing, Tripo/Hunyuan models, and ElevenLabs sound effects. Tripo is the default object generator. The company API does not currently expose World Labs worlds, so environment generation still needs a separate World Labs key. A FAL account or key is no longer needed.

Can take you from an image to a fully meshed 3D environment in < 5 minutes, great for jumpstarting 3D work. Go full blast.


## Quickstart

1. Open a Terminal, enter `git clone https://github.com/zhongxingtian-ai/image-blaster`
2. Enter the directory with `cd image-blaster`
3. Run `claude` (install with `curl -fsSL https://claude.ai/install.sh | bash`)
4. Copy `.env.example` to `.env`. Configure `MIVO_USER_SUB` with your company [Mivo](https://aigc.xindong.com/) key, and `WORLD_LABS_API_KEY` for environment generation. Keep keys in `.env`, not in chat or source code.
5. Put an image into `input/` directory and ask Claude to `blast it and confirm each step with me`.

### Description

By default `image-blaster` will use your input image to create:

1. 3D models (`.glb`, `.obj`) of all *dynamic* objects
2. Gaussian splat (`.spz`) of the *static* environment,
3. Ambient looping sound and object specific physics SFX (`.mp3`)

### Extensions

You can embed `image-blaster` under the assets of *any game engine, DCC software, or web app*.

1. Unity, Unreal, or Godot game engine
2. Blender, 3DS Max, or Maya or other DCC software
3. Three.js web app or Electron app

## Advanced

IMAGE-BLASTER uses a few generation models:

- `marble-1.1` - World Labs Marble model creates the explorable environment.
- `nano-banana` - default image edit preference for source cleanup, clean plates, and object reference images.
- `gpt-image-2` - alternate image edit provider when the edit skill is asked to prefer it.
- `tripo` - default 3D object generation through the company `model3d.tripo` capability.
- `hunyuan-3d` - optional 3D object generation through the company `model3d.hunyuan` capability.
- `elevenlabs-sfx` - ElevenLabs sound effects model creates ambient and object-specific sounds.

3D model creation supports these Hunyuan parameters:

- `--face-count <40000-1500000>`: target face count for Hunyuan. IMAGE-BLASTER defaults to `50000`.
- `--enable-pbr true|false`: enable PBR material generation. Defaults to `true`.
- `--generate-type Normal|LowPoly|Geometry`: `Normal` creates a textured model, `LowPoly` applies polygon reduction, and `Geometry` creates a white geometry-only model. Defaults to `Normal`.
- `--polygon-type triangle`: the company Hunyuan LowPoly route supports triangle output. LowPoly uses V3.0; the other modes use 3.1.

Tripo defaults to company version `V3.1` and `--target-polycount 50000`. `MIVO_TRIPO_MODEL_VERSION` can select another company-enabled version (`P1` or `P2-preview`); use a face count allowed by that version. Model availability and message routing come from the live company capability catalog; the server fills defaults for submitted inputs.

### Company API tasks

Images upload to Mivo before generation. Tasks save their company message ID before polling; interrupted commands resume that ID. An uncertain submission requires checking the company console before explicitly regenerating, so a lost response cannot silently create a second paid task. Existing FAL outputs remain usable locally; unfinished FAL tasks cannot be resumed through Mivo.

Search the company catalog, or run a confirmed generation capability:

```bash
node .claude/scripts/mivo/run-mivo.mjs --search tripo
node .claude/scripts/mivo/run-mivo.mjs --capability model3d.tripo --image input/chair.png --output-dir worlds/room/output/chair
```

ElevenLabs now uses the company's MP3 output. Audio post-processing needs `ffmpeg` and `ffprobe`; use `--postprocess false` to download the original audio without those tools.

### Validation

Node.js 20 or newer is required. Company integration tests mock authentication, uploads, message tasks, recovery, and signed downloads without real API calls:

```bash
npm run test:api
npm run --workspace=app test
npm run --workspace=app build
```

### Examples

- Video game level concepts? `IMAGE-BLAST` it.
- Your childhood bedroom? `IMAGE-BLAST` it.
- Need an environment for a robot? `IMAGE-BLAST` it.
- A film location scout? `IMAGE-BLAST` it.
- An architectural rendering? `IMAGE-BLAST` it.

### Development

- remove `/app` from the `.claudeignore` file to give Claude the ability to change the React viewer.
