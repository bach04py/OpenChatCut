# NOTES-M0: Driving OpenChatCut headlessly (investigation only, no code changed)

Branch `videoauto`, commit `f96502a1`, investigated 2026-11-16. Paths are relative to the repo root.
"Unsure" marks anything I did not run end to end.

## TL;DR

- **You do not need the MCP edit session to export.** There are two supported non-MCP paths:
  1. **CLI `occ render`**: `cli/commands/render.ts:184` `runRenderCommand()`. It renders the *saved* project with the server's own export pipeline: no app, no browser and no HTTP. Run it as `npx tsx cli/main.ts render <project> --out cut.mp4` (or `npm run occ -- render ...`).
  2. **HTTP `POST /export/job`** (async, returns `{renderId}`) or **`POST /export`** (sync, returns the file bytes) on the local server (`:5199`). Both are mounted from `server/plugins/export.ts:62-63`. They take the JSON body `ExportRequest` (`server/plugins/export-plan.ts:19`). They are guarded by a CSRF "request-shape" gate, not by the MCP token (details in §3.2).
- The whole pipeline (create project → import folder → build timeline → render) can run with **no app open at all** through `occ`:
  `occ project new` → `occ tools call import_folder --apply` / `occ edit --ops ... --apply` → `occ render`.
- Over MCP, export *is* possible but only as a "real-project" tool (`submit_render_job`). It needs an edit session, the **browser editor connected**, and `approvalMode:"auto"`. Otherwise it waits for a human click. It is not available in offline (headless) MCP sessions.

---

## 1. MCP server (`/api/external-mcp/mcp`, port 5199)

| What | Where |
|---|---|
| Port 5199 (desktop embedded server; canonical port, with fallback) | `desktop/embedded-port.ts:7`, `desktop/embedded-server.ts:110-115`; dev: `config/vite.config.ts:154` |
| Route mount + Bearer-token check | `server/plugins/external-agent.ts:139-148` |
| Token = `OPENCHATCUT_MCP_TOKEN` env, else the file `~/.openchatcut/mcp-token` | `server/editor-auth.ts:35-48`, `server/mcp-token.ts:25-27` |
| Transport (Streamable HTTP, sessions, 2 MiB body limit, 1 h idle, max 64 sessions) | `server/external-agent/mcp.ts:408` `handleMcpRequest`, `:333` `startMcpSession` |
| Dispatch: control tools → offline runtime → browser broker | `server/external-agent/mcp.ts:116` `callTool` |
| Tool list assembly | `server/external-agent/mcp-tool-catalog.ts:23` `fullMcpTools` |

**How the tool list is built (it is dynamic):**
- Five **control tools** are always present (`server/external-agent/mcp-controls.ts:72-126`).
- If a **browser editor is connected** (or the session is bound to one), the server lists the tools the browser *registered* through the broker (`broker.ts:245` `registeredTools()`). The browser builds that list from `src/agent/external-tool-schemas.ts:28` `externalToolSchemas()`: global reads + session tools + draft tools + "real" tools.
- If **no browser is connected**, the server falls back to the **offline** catalogue: `server/external-agent/offline-tools.ts:65` `offlineExternalToolSchemas()`. That is the four session tools plus the server-direct subset.
- Every editor tool also gets an `editorProjectId` property (`mcp-tool-catalog.ts:31-41`).
- **Exposure mode:** `full` is the default. With the header `x-openchatcut-tool-exposure: progressive` or `?toolExposure=progressive`, only 9 boot tools are shown until `ToolSearch` / `load_skill` activates more (`server/external-agent/mcp-tool-exposure.ts:167-187`).

I generated the full list by importing those same catalogue functions with tsx (read-only script, not committed). Counts: 5 control + **130 browser-mode tools**, of which **39 are also offline/CLI-capable**. The table is in the **Appendix**. It shows each tool's name, policy class, and argument signature (name, required or optional, type or enum). For full JSON schemas (descriptions, nested objects), regenerate them as described at the end.

Legend for "Policy" (from `src/agent/external-tool-policy.ts`):
- `global-read`: no session needed.
- `session-control`: the edit-session lifecycle tools.
- `draft-read` / `draft-edit`: run against the isolated draft; need `editSessionId`.
- `REAL (live project)`: acts on the live project and needs a one-shot confirmation unless the session is `auto` (§3.3).

"Offline/CLI = yes" means the tool also works with no browser (offline MCP and `occ`).

---

## 2. Edit sessions

- **Session tool schemas** (`list_edit_sessions`, `recover_edit_session`, `begin_edit_session`, `get_edit_session`, `review_edit_session`, `discard_edit_session`): `src/agent/external-tool-shape.ts:24-97`.
- **The allow/deny lists are all in one file: `src/agent/external-tool-policy.ts`.**
  - `GLOBAL_READ_TOOL_NAMES` (`:1-4`): `load_skill` and `ToolSearch`. No session needed.
  - `READ_ONLY_TOOL_NAMES` (`:6-12`): draft reads.
  - `DRAFT_EDIT_TOOL_NAMES` (`:14-26`): the tools **allowed inside a session**. This includes `import_asset`, `import_assets` and `import_folder`.
  - `isExternalRealTool` (`:147-153`): **everything else is excluded from the draft** and treated as "real". This covers generation, **export (`submit_render_job`, `track_export`, `read_export_history`)**, transcription, uploads, and so on. Real tools run against the live project, gated per call.
  - `SERVER_DIRECT_READ_TOOL_NAMES` / `SERVER_DIRECT_EDIT_TOOL_NAMES` (`:28-87`): the subset that runs **without a browser**. This is used by offline MCP sessions (`offline-tools.ts:54-62`) and by the CLI (`cli/tool-catalog.ts:22`). `edit_captions` preset/bilingual actions still need the browser (`:89-96`, `:130-140`).
- **Browser-mode dispatch:** `src/agent/external-bridge-runtime.ts`.
  - `review_edit_session` → `review()` (line 151).
  - Real tools → `runRealTool()` (lines 154-192).
  - Draft tools → `runEditorTool()`.
- **Offline-mode runtime:** `server/external-agent/offline-runtime.ts`. `begin_edit_session` **requires `approvalMode:"auto"`** (`:207-210`), and `review_edit_session` commits the draft atomically.
- **Ownership caveat (unsure of exact behaviour):** an offline session claims project ownership and is refused while the editor has that project open. See the comment at `cli/store.ts:6-9` and `server/external-agent/project-edit-ownership.ts`. For a fully headless run, keep the app closed or on a different project.

## 3. Export: how it is triggered

### 3.1 CLI entry point (no app, no HTTP): the recommended path
- Entry points:
  - `cli/main.ts:64` `run(argv)` → `cli/router.ts` → `cli/commands/render.ts:184` `runRenderCommand(commandLine, json)`.
  - Usage text is at `cli/main.ts:18`: `occ render [<project>] --out <file> [--resolution 1080p] [--fps 30] [--codec h264] [--from <frame|4s>] [--to <frame|4s>] [--dry-run] [--quiet]`. Other flags: `--timeline <id>`, `--format video|audio`, `--bitrate <bps>`, `--json`, `--data-dir <path>`.
- How it runs: `readProjectDoc` → `acceptExportSubmission({state, project, timelineId, format, ...})` (`server/plugins/export-submission.ts:17`) → `renderTimeline({...})` (`server/plugins/export-rendering.ts` → `remotion/render.mjs:227`). It writes to a `.partial-<uuid>.<ext>` file and then renames it.
- How to invoke: `cli-dist/` **does not exist** in this checkout, so the `bin` entry `occ` → `./cli-dist/occ.mjs` is not built. Use `npx tsx cli/main.ts ...`, or `npm run occ -- ...`, or `npm run build:cli`.
- **Data-dir caveat:**
  - The default library root is `~/.openchatcut`. That root holds the project store and the MCP token.
  - However, the default **uploads dir is `<cwd>/public/media/uploads`** (`server/runtime-profile.ts:143-152`).
  - The packaged desktop app `chdir`s into Electron `userData` first (`desktop/chdir-first.ts:8-11`). So an `occ` run from the repo root may not find media the packaged app imported.
  - Fix: set `OPENCHATCUT_DATA_DIR` (or `--data-dir`) so both use `<dataDir>/media/uploads`, or run `occ` from the same cwd. `occ where --json` prints the resolved paths.

### 3.2 HTTP routes on the local server
- Code: `server/plugins/export-job-routes.ts`, mounted by `exportPlugin()` (`server/plugins/export.ts:33,62-63`). That plugin is part of `serverPlugins()`, which the desktop embedded server loads (`desktop/embedded-server.ts:100`).
- Routes:
  - `POST /export/job` (`:57`, `:102-213`): body is `ExportRequest`; response is `{ renderId }`. The job runs async.
  - `GET /export/job/<id>` (`:92-100`): returns a snapshot with status/progress. On completion, `result.path` = `/media/uploads/<file>` inside the uploads dir.
  - `DELETE /export/job/<id>` cancels or cleans up; `POST /export/job/<id>/promote` also exists (`:63`, `:77`).
  - `POST /export` (`:228-330`): synchronous; returns the encoded bytes in the response.
  - `GET /export/capabilities`.
- Body type `ExportRequest` (`server/plugins/export-plan.ts:19-34`):
  `{ state: TimelineState, project?: ProjectDoc, timelineId?: string, format?: 'video'|'audio', codec?: 'h264'|'vp8'|'prores'|'mp3'|'wav', name?, startFrame?, endFrameExclusive?, startSeconds?, endSeconds?, resolution?: '480p'|'720p'|'1080p'|'4k', fps?: 24|25|30|50|60, videoBitrate? }`.
  The browser's `submit_render_job` sends `{state: <active timeline>, project: <ProjectDoc>, timelineId, format, ...}` (`src/agent/tools/export-tools.ts:186-212`). Mirror that with the stored doc.
- **Auth for these routes:** they are not covered by the MCP Bearer token. A global gate applies: `server/plugins/request-shape-gate.ts:12-23` → `server/project-store-http-auth.ts:74`. For POST it requires:
  - a loopback socket,
  - a loopback `Host`,
  - an `Origin` whose host equals `Host`,
  - `Sec-Fetch-Site: same-origin` or `none`.

  This is CSRF protection under a "local device is trusted" model (comment at `:5-25`). A non-browser client can satisfy it by sending those headers. **Unsure** whether the maintainers consider that a supported API. The CLI path avoids the question.
- You also need the project JSON for the body. Read it from the SQLite store (§4), or call the MCP `read_project` tool.

### 3.3 MCP path (inside an edit session)
- The tools are `submit_render_job` and `track_export` (schemas at `src/agent/tools/schemas/export-tools.ts:7,31`; handler at `src/agent/tools/export-tools.ts:186` `submitRenderJob(args, ctx)`).
- They are "real" tools:
  - They are **only registered when a browser editor is connected**. They are not in the offline list.
  - Each call needs `editSessionId` and a `drafting` session (`external-bridge-runtime.ts:166-171`).
- In a `manual` session, the call returns `{needs_confirmation:true, confirmationId}` and waits for a click in the editor (`:194-225`).
- **In an `approvalMode:"auto"` session, the confirmation is skipped** (`:179-183`). The code comment says "auto (YOLO) sessions skip the confirmation card entirely".
  - This **contradicts** the schema text at `external-tool-shape.ts:54` ("never bypasses real-tool confirmation"). The code wins; the doc string is stale.
- `ctx.getDoc()` in the handler reads the **live** project (real tools use the live context, `:186`). So apply the draft first (`review_edit_session`), then call `submit_render_job` from a fresh `auto` session. **Unsure:** I did not run this end to end.
- MCP clamps `track_export action=wait` to 45 s per call (`mcp.ts:161-164`). Poll in a loop.

## 4. On-disk project format, and the Remotion CLI directly

- **Storage:**
  - SQLite at `<root>/project-store-v1.sqlite3`, with one table `kv(k TEXT, v TEXT)` (`server/storage/sqlite-store.ts:26-29,46`).
  - The project document is under key `project:<projectId>` (`cli/store.ts:74`). Its value is **JSON** (`encode = JSON.stringify`, `sqlite-store.ts:111`).
  - `<root>` = `OPENCHATCUT_DATA_DIR`, else the settings pointer file, else `~/.openchatcut` (`server/runtime-profile.ts:109-152`).
  - Older layouts (`project-store-v1.json`, `project-store-v1/`) are migrated (`runtime-profile.ts:48-58`, `server/storage/sqlite-migration*.ts`).
- **Schema:** `ProjectDoc` is in `src/editor/projectTypes.ts:8`. Timeline types are in `src/editor/types.ts`. Stored docs must go through `runProjectMigrations` (`src/persist/migrations/index.ts`) before use, as the CLI does at `cli/store.ts:76`.
- **Remotion composition:** entry `remotion/index.ts`, composition id `"timeline"` (`remotion/Root.tsx`). Input props are `{ state, project?, timelineId?, transparent? }`.
- **Direct `npx remotion render remotion/index.ts timeline --props=...` is possible in principle but not plug-and-play** (unsure; not tried). The app's bundle step (`remotion/serve-bundle.mjs:47-76`) does extra work:
  - It adds a webpack override (`.js`→`.ts/.tsx` extension alias, `.frag` as `asset/source`).
  - It copies `assets/` over the serve root (fonts, LUTs, thumbs).
  - It symlinks `<serveUrl>/media/uploads` to the live uploads dir.

  Media must also be "materialized" to local paths: `remotion/render-contract.mjs:162` `assertMaterializedRenderSnapshot`, handled by `materializeServerExportMedia` in `export-media-plan.ts`. Rendering also sets the Chromium GL backend (`angle` on Windows, `render.mjs:33-39`), which GL effects need.
- **Recommendation:** don't bypass the app's pipeline. `occ render` already *is* "render the on-disk project headlessly with Remotion", reusing all of the above.

## 5. Effects, transitions and template catalogue

| Catalogue | Registry / source | Notes |
|---|---|---|
| Per-clip GL effects (built-in shaders) | `src/gl/fx/shaderEffects.ts:51` `FX_EFFECTS`, `:449` `FX_ORDER`, `:485` `FX_IDS` | ids `builtin:fx-*`; GLSL in `src/gl/fx/*.frag.ts` |
| LUT looks | `src/gl/fx/lutEffects.ts:25` `LUT_EFFECTS`, `:201`, `:220` | `.cube` files in `assets/luts/` |
| Combined effect registry | `src/gl/fx/effects.ts:18` `ALL_FX`; runtime custom/plugin fx `:27` `CUSTOM_FX`, `registerCustomFx :50` | `FxDef` type: `src/gl/fx/uniforms.ts:30` (`id,name,desc,frag,props[],passes?,pipeline?,cube?`). `pipeline` is a function, so drop it for JSON (see `serializableDefsFor :34`) |
| Effect tool (what MCP `manage_effects` uses) | `src/agent/tools/effect-tools.ts:4-6` | `manage_effects action=list` returns ids |
| GLSL transitions | `src/gl/transitions.ts:30` `GLSL_TRANSITIONS`; type list `src/editor/transitionTypes.ts:13-40` | custom shader transitions: `src/gl/customTransitions.ts:32` |
| Motion-graphic templates | `src/editor/initial.ts:12` `TEMPLATES` = `assets/templates/openchatcut-templates.json` + `social-shorts-templates.json` + `koubo-scenes-templates.json` | already JSON; `Tpl` type `src/types.ts:15` |
| Plugin-pack templates | `src/library/pluginTemplateCatalog.ts` via `server/external-agent/offline-catalogs.ts:13-60` (reads installed packs) | |
| Library (transitions/zooms/etc. as library items) | `src/agent/tools/library-catalog.ts:24,84` `buildLibraryItems(templates)` | |
| Built-in audio | `src/audio/library.ts:15` `AUDIO_ASSETS` | |

**Dumping to JSON later:**
- The fx defs are plain TS modules; the shaders are `.frag.ts` string exports, not `?raw`. So `npx tsx` can import `src/gl/fx/effects.ts` and `JSON.stringify` the entries, minus `pipeline`.
- Quick alternative with no new code: `occ tools call list_templates`, `browse_library`, or `manage_effects` with `--args '{"action":"list"}' --json`. All are headless-capable. **Unsure** whether `manage_effects list` needs a `targetItemId`.
- Minor: the comment at `external-tool-policy.ts:65-69` mentions `cli/raw-hooks.mjs`, which does not exist in `cli/`. The comment looks stale, since `src/gl` no longer uses `?raw`.

## 6. Suggested Python pipeline (based on the above; untested)

```
occ project new "Auto" --size 1920x1080 --fps 30 --json        -> projectId
occ tools call import_folder --project <id> --args '{"path":"C:/media/in"}' --apply --json
occ edit --project <id> --ops '[{"tool":"...","args":{...}}, ...]' --apply --json   # build timeline
occ render <id> --out C:/out/final.mp4 --resolution 1080p --json
```
Things to watch:
- Use the same `OPENCHATCUT_DATA_DIR` for every call (§3.1 caveat).
- `AGENT_IMPORT_ROOTS` (keystore key, `server/local-path-import.ts:23-54`) optionally restricts the folders that can be imported.
- Keep the editor off the project during offline commits (§2).

---

## Appendix: full MCP tool list (browser-connected mode)

| # | Tool | Policy | Offline/CLI | Arguments (besides editSessionId / editorProjectId) |
|---|---|---|---|---|
| C1 | `openchatcut_status` | control (server-side) | yes |  |
| C2 | `list_projects` | control (server-side) | yes | includeDeleted?: boolean, editorBaseUrl?: string |
| C3 | `create_project` | control (server-side) | yes | name?: string, description?: string, compositionWidth?: number, compositionHeight?: number, fps?: number, editorBaseUrl?: string |
| C4 | `target_project` | control (server-side) | yes | projectId: string, editorBaseUrl?: string |
| C5 | `get_editor_url` | control (server-side) | yes | projectId?: string, editorBaseUrl?: string |
| 1 | `load_skill` | global-read (no session) | — | name: string, file?: string, files?: string[], offset?: integer, limit?: integer |
| 2 | `ToolSearch` | global-read (no session) | — | query: string, limit?: number |
| 3 | `list_edit_sessions` | session-control (no session) | — |  |
| 4 | `recover_edit_session` | session-control | — | action: resume|discard |
| 5 | `begin_edit_session` | session-control (no session) | yes | clientName?: string, approvalMode?: manual|auto, reuseExisting?: boolean |
| 6 | `get_edit_session` | session-control | yes |  |
| 7 | `review_edit_session` | session-control | yes | summary?: string |
| 8 | `discard_edit_session` | session-control | yes |  |
| 9 | `export_jianying_draft` | draft-edit | yes | draftName?: string, draftsDir?: string |
| 10 | `read_timeline` | draft-read | yes |  |
| 11 | `list_templates` | draft-read | yes | category?: string |
| 12 | `search_templates` | draft-read | yes | query: string |
| 13 | `add_motion_graphic` | draft-edit | yes | templateName: string, track?: string, startFrame?: number, ripple?: boolean |
| 14 | `update_item_props` | draft-edit | yes | itemId: string, props: object |
| 15 | `move_item` | draft-edit | yes | itemId: string, track?: string, startFrame?: number |
| 16 | `set_item_timing` | draft-edit | yes | itemId: string, startFrame?: number, durationInFrames?: number, fadeInSeconds?: number, fadeOutSeconds?: number, ripple?: boolean |
| 17 | `duplicate_item` | draft-edit | yes | itemId: string |
| 18 | `remove_item` | draft-edit | yes | itemId: string, ripple?: boolean |
| 19 | `split_item` | draft-edit | yes | itemId: string, atFrame: number |
| 20 | `list_audio` | draft-read | yes |  |
| 21 | `add_audio` | draft-edit | yes | audioName: string, track?: string, startFrame?: number, ripple?: boolean |
| 22 | `clear_timeline` | draft-edit | yes |  |
| 23 | `set_aspect_ratio` | draft-edit | yes | ratio: 16:9|9:16|1:1|4:3|3:4, fit?: contain|cover |
| 24 | `read_agent_artifact` | draft-read | yes | artifactId: string, pointer?: string, offset?: integer, limit?: integer |
| 25 | `read_transcript` | draft-read | yes | itemId?: string, track?: string, silenceThresholdSeconds?: number, maxWordsPerPhrase?: integer, offset?: integer, limit?: integer |
| 26 | `search_media` | draft-read | — | query: string, modalities?: string[], limit?: integer |
| 27 | `find_transcript` | draft-read | yes | query: string, asset?: string, track?: string, fuzzy?: boolean, includeWordTimestamps?: boolean, limit?: integer |
| 28 | `manage_timelines` | draft-edit | yes | action: list|create|duplicate|switch|update|delete|insert, timelineId?: string, timelineIds?: string[], name?: string, ratio?: 16:9|9:16|1:1|4:3|3:4, width?: integer, height?: integer, fit?: contain|cover, hidden?: boolean, activate?: boolean, timelines?: object[], track?: string, startFrame?: integer, sourceStartFrame?: integer, sourceDurationInFrames?: integer, playbackRate?: number |
| 29 | `edit_track` | draft-edit | yes | action: list|create|update|delete|tighten|reorder_items, json?: string, trackId?: string, trackIds?: string[] |
| 30 | `read_script` | draft-read | yes | track?: string, showSilence?: boolean |
| 31 | `apply_script` | draft-edit | yes | timelineMd: string, preview?: boolean, track?: string |
| 32 | `view_timeline_frames` | draft-read | — | frames?: number[], seconds?: number[], count?: number, fromSeconds?: number, toSeconds?: number, timelineId?: string |
| 33 | `view_asset_frames` | draft-read | — | assetId?: string, itemId?: string, timelineId?: string, sourceTimesMs?: number[], frames?: number[], seconds?: number[], count?: number, fromSeconds?: number, toSeconds?: number |
| 34 | `browse_library` | draft-read | yes | category?: motion-graphics|luts|zoom|fx|audio-fx|sound-effects|transitions, group?: string, query?: string, id?: string, limit?: number, offset?: number |
| 35 | `edit_item` | draft-edit | yes | adds?: object[], updates?: object[], deletes?: object[], ripple?: boolean, validateOnly?: boolean, projectId?: string |
| 36 | `manage_effects` | draft-edit | yes | action: list|add|update|remove, targetItemId?: string, effectId?: string, assetId?: string, propertyOverrides?: object |
| 37 | `manage_design_style` | draft-edit | — | action: list|get|apply|update|clear|save|delete, presetId?: string, designSpec?: string, patch?: string, applyToProject?: boolean, name?: string, rename?: string, scenarios?: string[], scenario?: string, thumbnailUrl?: string, clearThumbnail?: boolean |
| 38 | `search_stock_media` | draft-read | — | query: string, category?: string, kind?: any|video|audio|music|image, orientation?: horizontal|square|vertical|landscape|portrait|squarish, platforms?: string, limitPerPlatform?: integer |
| 39 | `read_captions` | draft-read | yes | captionTrackId?: string, list?: boolean |
| 40 | `edit_captions` | draft-edit | yes | action: enable|disable|hide_overlay|show_overlay|display_text|template|style|animation|layout|layout_policy|positions|preset_apply|preset_delete|preset_list|preset_rename|preset_save|bilingual|language_mode|source_add|source_list|source_remove|source_set|source_update|track, json?: string, templatePreset?: string, preset?: string, motionPreset?: none|fade-up|pop|word-pop|karaoke-pulse, trackId?: string, trackOrder?: union, list?: boolean, captionTrackId?: string, captionsItemId?: string |
| 41 | `apply_caption_avoidance` | draft-edit | — |  |
| 42 | `place_graphics_in_safe_zone` | draft-edit | — | itemId?: string |
| 43 | `auto_reframe` | draft-edit | — | itemId: string, intervalFrames?: number, sensitivity?: number, smooth?: number, maxSamples?: number |
| 44 | `update_watermark` | draft-edit | yes | enabled?: boolean, text?: string, position?: tl|tr|bl|br, opacity?: number |
| 45 | `manage_markers` | draft-edit | yes | action: list|create|update|delete, timelineId?: string, fromFrame?: number, durationFrames?: number, note?: string, color?: blue|cyan|fuchsia|green|pink|purple|red|yellow, scope?: project|item, itemId?: string, markerId?: string, transcriptSegments?: string, transcriptTrack?: string, notePrefix?: string, markers?: object[], updates?: object[] |
| 46 | `search_fonts` | draft-read | — | query: string, projectId?: string |
| 47 | `read_project` | draft-read | yes | view?: timeline|assets, timelineId?: string, track?: string, fromFrame?: number, toFrame?: number, itemId?: string, assetId?: string, code?: boolean, projectId?: string |
| 48 | `analyze_music` | draft-read | — | itemId?: string, assetId?: string, force?: boolean, optional?: boolean |
| 49 | `inspect_music` | draft-read | — | itemId?: string, assetId?: string, fromMs?: number, toMs?: number |
| 50 | `music_edit_plan` | draft-read | — | itemId: string, timing: auto|beat|downbeat|section, density: sparse|medium|dense, fromFrame?: number, toFrame?: number, targetItemIds?: string[] |
| 51 | `music_image_plan` | draft-read | — | itemId: string, timing: auto|beat|downbeat|section, density: sparse|medium|dense, fromFrame?: number, toFrame?: number, imageAssetIds?: string[], track?: string |
| 52 | `browse_local_media` | draft-read | yes | path?: string, query?: string, kind?: video|audio|image|gif|svg, recursive?: boolean, offset?: integer, limit?: integer |
| 53 | `import_assets` | draft-edit | yes | paths: string[] |
| 54 | `import_asset` | draft-edit | yes | path: string |
| 55 | `import_folder` | draft-edit | yes | path: string |
| 56 | `import_timeline` | draft-edit | yes | format: fcpxml|edl, content: string, name?: string, activate?: boolean, fps?: number, startTimecode?: string |
| 57 | `submit_motion_graphic` | REAL (live project) | — | prompt?: string, description?: string, name: string, durationSeconds?: number, durationInFrames?: number, width?: number, height?: number |
| 58 | `create_motion_graphic` | REAL (live project) | — | description?: string, prompt?: string, name: string, durationSeconds?: number, durationInFrames?: number, width?: number, height?: number |
| 59 | `transcribe_track` | REAL (live project) | — | track?: string, provider?: assemblyai|local|openai|mistral|deepgram|groq|elevenlabs|cartesia |
| 60 | `clean_script` | REAL (live project) | — | track?: string, itemId?: string, only?: string, silence?: string, longSilence?: number, maxPauseSeconds?: number, removeFillers?: boolean, cutPadMs?: number |
| 61 | `edit_gap` | REAL (live project) | — | action: list|delete|cap|restore, track?: string, itemId?: string, afterWordIndex?: number, afterText?: string, gapIndex?: number, maxSeconds?: number, minGapSeconds?: number |
| 62 | `delete_text` | REAL (live project) | — | track?: string, query: string |
| 63 | `manage_transcript` | REAL (live project) | — | action: fix|clear_edits|set_play_order|retry_transcription|translation_create|translation_ensure|translation_list|translation_read, itemId?: string, track?: string, provider?: assemblyai|local|openai|mistral|deepgram|groq|elevenlabs|cartesia, wordIndex?: number, find?: string, text?: string, from?: string, to?: string, playOrder?: integer[], clearPlayOrder?: boolean, lang?: string, targetLanguage?: string |
| 64 | `manage_media_pool` | REAL (live project) | — | action: list|create_folder|rename_folder|delete_empty_folder|move_assets|rename_asset|favorite_assets|unfavorite_assets|delete_assets|relink_asset, assetIds?: string, folderPath?: string, name?: string, newName?: string, parentPath?: string, targetPath?: string, src?: string, durationInFrames?: number, width?: number, height?: number, sourceFilename?: string, confirm?: boolean |
| 65 | `detect_scenes` | REAL (live project) | — | itemId?: string, assetId?: string, threshold?: number, minSceneSeconds?: number, maxScenes?: number, apply?: report|markers|split |
| 66 | `submit_image` | REAL (live project) | — | model?: gpt-image-2|nano-banana|image-01|wavespeed|byteplus|grok-imagine|agnes-image|fal, falModel?: nano-banana-2|nano-banana-pro|gpt-image-2|flux-2|flux-2-pro|seedream-5-pro|ideogram-4|qwen-image-3|recraft-v3, prompt: string, name: string, addToTimeline?: boolean, aspectRatio?: 1:1|16:9|9:16|4:3|3:4|3:2|2:3|4:5|5:4|21:9|auto|4:1|1:4|8:1|1:8, imageSize?: 512px|1K|2K|4K|0.5K, width?: integer, height?: integer, quality?: low|medium|high|auto, referenceAssetIds?: string[], maskAssetId?: string, count?: integer, background?: transparent|opaque|auto, moderation?: low|auto, inputFidelity?: low|high, outputFormat?: png|jpeg|webp, outputCompression?: integer, seed?: integer, promptOptimizer?: boolean |
| 67 | `submit_voice` | REAL (live project) | — | provider: elevenlabs|doubao|minimax|inworld|fishaudio|speechify|openai|gemini|mistral|cartesia, text: string, voiceId?: string, modelId?: string, stability?: number, speed?: number, similarityBoost?: number, style?: number, useSpeakerBoost?: boolean, languageCode?: string, seed?: integer, outputFormat?: string, instructions?: string, optimizeStreamingLatency?: integer, enableLogging?: boolean, applyTextNormalization?: auto|on|off, applyLanguageTextNormalization?: boolean, pronunciationDictionaryLocators?: object[], previousText?: string, nextText?: string, previousRequestIds?: string[], nextRequestIds?: string[], speedRatio?: number, emotion?: string, loudnessRatio?: number, pitch?: number, volume?: number, sampleRate?: integer, bitrate?: integer, audioFormat?: mp3|pcm|flac|wav|pcmu_raw|pcmu_wav|opus, channel?: integer, forceCbr?: boolean, stream?: boolean, excludeAggregatedAudio?: boolean, languageBoost?: Chinese|Chinese,Yue|English|Arabic|Russian|Spanish|French|Portuguese|German|Turkish|Dutch|Ukrainian|Vietnamese|Indonesian|Japanese|Italian|Korean|Thai|Polish|Romanian|Greek|Czech|Finnish|Hindi|Bulgarian|Danish|Hebrew|Malay|Persian|Slovak|Swedish|Croatian|Filipino|Hungarian|Norwegian|Slovenian|Catalan|Nynorsk|Tamil|Afrikaans|auto, textNormalization?: boolean, latexRead?: boolean, pronunciations?: string[], timbreWeights?: object[], voiceModify?: object, subtitleEnable?: boolean, subtitleType?: sentence|word|word_streaming, name?: string |
| 68 | `submit_sound` | REAL (live project) | — | provider?: elevenlabs|sonilo, prompt?: string, durationSeconds?: number, promptInfluence?: number, loop?: boolean, outputFormat?: string, sourceAssetId?: string, name?: string |
| 69 | `submit_music` | REAL (live project) | — | prompt?: string, provider?: mureka|minimax|atlas|sonilo, mode?: instrumental|song|prompt-song|soundtrack|track|t2m|cover|v2m, lyrics?: string, isInstrumental?: boolean, lyricsOptimizer?: boolean, sampleRate?: integer, bitrate?: integer, audioFormat?: mp3|wav|pcm|flac, referenceAssetId?: string, coverFeatureId?: string, count?: integer, stream?: boolean, styles?: string[], gender?: female|male, referenceId?: string, instrumentalId?: string, vocalId?: string, melodyId?: string, sourceAssetId?: string, audioStartMs?: integer, audioEndMs?: integer, songId?: string, trackType?: Vocals|Instrumental|Drums|Bass|Guitar|Keyboard|Percussion|Strings|Synth|FX|Brass|Woodwinds, generateStartMs?: integer, generateEndMs?: integer, vocalGender?: female|male, name?: string |
| 70 | `submit_video` | REAL (live project) | — | model: seedance2|kling|hailuo|byteplus|grok-imagine-video|ofox|agnes-video|fal|gemini-omni, falModel?: seedance-2.5|seedance-2.0|kling-v3-standard|kling-v3-pro|kling-o3-standard|kling-o3-pro|veo-3.1|veo-3.1-fast|wan-3.0|minimax-h3-max|pixverse-v6, prompt?: string, name?: string, durationSeconds?: union, ratio?: string, resolution?: 360p|480p|512p|720p|1080p|4k|768p|540p, mode?: std|pro, firstFrame?: string, lastFrame?: string, refImages?: string[], refVideos?: string[], refAudios?: string[], refVideoMode?: feature|base, promptOptimizer?: boolean, fastPretreatment?: boolean, generateAudio?: boolean, seed?: integer, cameraFixed?: boolean, watermark?: boolean, returnLastFrame?: boolean, executionExpiresAfter?: integer, priority?: integer, multiPrompts?: object[], shotType?: customize|intelligence |
| 71 | `track_progress` | REAL (live project) | — | action: params|status|wait|resume, target?: generation|transcription|upload|visual-analysis, jobIds?: string, assetIds?: string, timeoutSeconds?: number |
| 72 | `rerun_generation` | REAL (live project) | — | jobId: string |
| 73 | `submit_export` | REAL (live project) | — | format?: video|audio|subtitles|xml, codec?: h264|vp8|mp3|wav, subtitleFormat?: srt|txt, captionTrackId?: string, nleFormat?: fcp_xml|fcp_xml_resolve, name?: string, fps?: number, resolution?: 480p|720p|1080p, videoBitrate?: integer, timelineId?: string, startFrame?: integer, endFrameExclusive?: integer, startSeconds?: number, endSeconds?: number, confirmFontFallback?: boolean, motionGraphicRenderKeys?: string[] |
| 74 | `download_media` | REAL (live project) | — | url: union, name?: string, type?: audio|gif|image|svg|video, projectId?: string |
| 75 | `push_asset` | REAL (live project) | — | filePath: object, name?: string, type?: audio|effect|gif|image|motion-graphic|svg|transition|video, duration?: number, durationInFrames?: number, width?: number, height?: number, properties?: any[], projectId?: string |
| 76 | `import_url_asset` | REAL (live project) | — | url: string, name?: string, kind?: video|image|audio |
| 77 | `submit_shader` | REAL (live project) | — | type: effect|transition, prompt: string, name?: string, referenceAssetIds?: string[], properties?: object[] |
| 78 | `find_highlights` | REAL (live project) | — | count?: integer, ratio?: 9:16|16:9|1:1|4:3|3:4, topic?: string, instruction?: string, itemId?: string, minSeconds?: number, maxSeconds?: number |
| 79 | `submit_render_job` | REAL (live project) | — | format?: video|audio, codec?: h264|vp8|mp3|wav, resolution?: 480p|720p|1080p, fps?: integer, videoBitrate?: integer, name?: string, startFrame?: integer, endFrameExclusive?: integer, startSeconds?: number, endSeconds?: number, saveToMediaPool?: boolean |
| 80 | `track_export` | REAL (live project) | — | action: status|wait, renderIds?: string, latest?: boolean, onlyActive?: boolean, timelineId?: string, timeoutSeconds?: number |
| 81 | `read_export_history` | REAL (live project) | — | limit?: integer |
| 82 | `verify_export` | REAL (live project) | — | renderId?: string, src?: string, maxCuts?: integer |
| 83 | `publish_to_social` | REAL (live project) | — | source: string, platforms: string[], title: string, description?: string, youtubePrivacy?: private|unlisted|public, tiktokPrivacy?: PUBLIC_TO_EVERYONE|MUTUAL_FOLLOW_FRIENDS|FOLLOWER_OF_CREATOR|SELF_ONLY, pinterestBoardId?: string, aiGenerated?: boolean, confirm?: boolean, previewId?: string |
| 84 | `track_social_publish` | REAL (live project) | — | requestId: string, action?: status|wait, timeoutSeconds?: number |
| 85 | `manage_template` | REAL (live project) | — | action: get|list_assets|apply|copy_assets|save, templateId?: string, placement?: union, omitAssetIds?: string[], name?: string |
| 86 | `normalize_loudness` | REAL (live project) | — | target?: number, itemId?: string |
| 87 | `isolate_voice` | REAL (live project) | — | itemId: string, action?: apply|attach|clear, sourceAssetId?: string, denoisedAssetId?: string, strength?: number, force?: boolean |
| 88 | `manage_skill` | REAL (live project) | — | action: list|get|current|activate|create|update|delete, skillId?: string, name?: string, body?: string, summary?: string, scenarios?: string[] |
| 89 | `convert_motion_graphic_to_video` | REAL (live project) | — | itemId?: string, assetId?: string, replace?: boolean, opaque?: boolean |
| 90 | `register_converted_video` | REAL (live project) | — | mgAssetId: string, renderId?: string, outputUrl?: string, name?: string, durationInFrames?: number |
| 91 | `export_motion_graphic_prores` | REAL (live project) | — | itemId?: string, itemIds?: string[], assetId?: string, assetIds?: string[], filenameMode?: asset|xml, name?: string, preferTimelineInstance?: boolean, timelineId?: string |
| 92 | `edit_asset` | REAL (live project) | — | action: update|delete, assetId: string, name?: string, code?: string, props?: object, favorite?: boolean, sourceTimecode?: object, captureClock?: object, clearSourceTimecode?: boolean, clearCaptureClock?: boolean, confirm?: boolean |
| 93 | `web_browser` | REAL (live project) | — | provider?: parallel|firecrawl, url: string, formats?: string[], onlyMainContent?: boolean, fullPage?: boolean, waitFor?: number, timeout?: number, country?: string, query?: string, schema?: object, actions?: any[], execJs?: string |
| 94 | `web_search` | REAL (live project) | — | provider?: parallel|firecrawl, query: string, limit?: number, country?: string, lang?: string, tbs?: string, scrapeMarkdown?: boolean |
| 95 | `web_map` | REAL (live project) | — | url: string, search?: string, limit?: number, includeSubdomains?: boolean, ignoreQueryParameters?: boolean, sitemap?: skip|include|only |
| 96 | `web_crawl` | REAL (live project) | — | url: string, limit?: number, maxDiscoveryDepth?: number, maxDepth?: number, includePaths?: string[], excludePaths?: string[], allowSubdomains?: boolean, crawlEntireDomain?: boolean, maxWaitMs?: number |
| 97 | `web_batch_scrape` | REAL (live project) | — | urls: string[], formats?: string[], onlyMainContent?: boolean, maxWaitMs?: number |
| 98 | `search_content` | REAL (live project) | — | query: string, projectId?: string, limit?: number |
| 99 | `ask_followup_questions` | REAL (live project) | — | fields: object[], prompt?: string, title?: string, submitLabel?: string, messagePrefix?: string |
| 100 | `list_projects` | REAL (live project) | — | editorBaseUrl?: string, includeDeleted?: boolean |
| 101 | `create_project` | REAL (live project) | — | name?: string, description?: string, compositionWidth?: number, compositionHeight?: number, fps?: number, editorBaseUrl?: string |
| 102 | `delete_project` | REAL (live project) | — | projectId: string |
| 103 | `restore_project` | REAL (live project) | — | projectId: string, editorBaseUrl?: string |
| 104 | `duplicate_project` | REAL (live project) | — | projectId?: string, name?: string, activate?: boolean, editorBaseUrl?: string |
| 105 | `edit_project` | REAL (live project) | — | action: update|speaker-create|speaker-update|speaker-delete, id?: string, from?: string, to?: string, json?: string, projectId?: string |
| 106 | `target_project` | REAL (live project) | — | projectId: string, editorBaseUrl?: string |
| 107 | `get_editor_url` | REAL (live project) | — | projectId?: string, editorBaseUrl?: string, openPricing?: boolean, pricingSource?: string |
| 108 | `import_media` | REAL (live project) | — | action: create_session, assetId?: string, assetType: audio|gif|image|svg|video, filename: string, contentType: string, size: integer, projectId?: string |
| 109 | `finalize_uploaded_asset` | REAL (live project) | — | receipt: string, assetType: audio|gif|image|svg|video, durationInSeconds?: number, width?: number, height?: number, fps?: number, hasAudioTrack?: boolean, projectId?: string |
| 110 | `request_asset_download` | REAL (live project) | — | assetId: string, variant?: string, projectId?: string |
| 111 | `report_user_friction` | REAL (live project) | — | category: complaint|env_unstable|confused|blocked|agent_self_detected|other, summary: string, projectId?: string |
| 112 | `create_motion_graphic_from_code` | REAL (live project) | — | code: string, name: string, width: number, height: number, durationInFrames?: number, durationInSeconds?: number, description?: string, properties?: any[], projectId?: string |
| 113 | `install_skill` | REAL (live project) | — | repo: string, slug?: string |
| 114 | `run_skill_script` | REAL (live project) | — | skill: string, command: string, timeout?: number |
| 115 | `run_code` | REAL (live project) | — | command: string, files?: object[], outputs?: string[] |
| 116 | `probe_media` | REAL (live project) | — | source: string |
| 117 | `multicam_sync` | REAL (live project) | — | itemIds: string[], referenceItemId?: string, groupId?: string, masterItemId?: string |
| 118 | `change_cam` | REAL (live project) | — | groupId?: string, targetAngleId?: string, itemIds?: string[], targetItemId?: string, fromSeconds: number, toSeconds?: number |
| 119 | `manage_link_group` | REAL (live project) | — | action: link|sync_lock|unlink, itemIds: string[], anchorItemId?: string |
| 120 | `undo_last_change` | REAL (live project) | — |  |
| 121 | `redo_last_change` | REAL (live project) | — |  |
| 122 | `manage_versions` | REAL (live project) | — | action: list|save|restore|delete, name?: string, versionId?: string, confirm?: boolean |
| 123 | `apply_layout` | REAL (live project) | — | layout: full|2up-horizontal|2up-vertical|3up-horizontal|grid-4|pip, assignments: object[], mode?: cover|fit, anchorX?: number, anchorY?: number, insetCorner?: top-left|top-right|bottom-left|bottom-right, insetSize?: number, insetMargin?: number |
| 124 | `remove_silence` | REAL (live project) | — | itemId?: string, thresholdDb?: number, minSilenceMs?: number, padMs?: number, dryRun?: boolean |
| 125 | `inspect_color` | REAL (live project) | — | frame?: number, seconds?: number, assetId?: string, sourceSeconds?: number, referenceFrame?: number, referenceSeconds?: number, referenceAssetId?: string, referenceSourceSeconds?: number |
| 126 | `auto_grade` | REAL (live project) | — | action: analyze|apply, itemIds?: string |
| 127 | `detect_beats` | REAL (live project) | — | assetId?: string, itemId?: string, markers?: none|beats|downbeats, markerLimit?: number |
| 128 | `sync_cuts_to_music` | REAL (live project) | — | itemId: string, timing: auto|beat|downbeat|section, density: sparse|medium|dense, fromFrame?: number, toFrame?: number, targetItemIds?: string[], analysisRef: string |
| 129 | `sync_images_to_music` | REAL (live project) | — | itemId: string, timing: auto|beat|downbeat|section, density: sparse|medium|dense, fromFrame?: number, toFrame?: number, imageAssetIds?: string[], track?: string, analysisRef: string |
| 130 | `review_scene_plan` | REAL (live project) | — | scenes: object[] |

Regenerate: write a tsx script that imports `externalToolSchemas` (`src/agent/external-tool-schemas.ts`), `offlineExternalToolSchemas` (`server/external-agent/offline-tools.ts`) and `MCP_CONTROL_TOOLS` (`server/external-agent/mcp-controls.ts`), then `JSON.stringify` them. The live list can also include tools from plugins the user installed, and it shrinks in progressive exposure mode.


---

# M0 follow-ups (2026-11-16): export proof, headless feasibility, catalogue

Everything below was **run**, not just read. The desktop app was **not running**: the `openchatcut` MCP server was unreachable (ECONNREFUSED) for the whole session. No existing source file was modified. Two files were added: `scripts/dump-catalogue.mts` and `catalogue.json`.

## F1. `occ render` end to end: works

**Environment**
- Windows 11, Node v24.22.1.
- No hardware H.264 encoder was found (nvenc/qsv/amf probed), so the export used libx264 software encoding.
- Data dir (isolated, throwaway):
  `OPENCHATCUT_DATA_DIR=C:/Users/LAPTOP/AppData/Local/Temp/claude/e548d33e00b0b41a/2ed843a5-e567-458f-9d1d-c1cc823eaa33/scratchpad/m0/data`
  - `occ where --json` confirmed `rootDir` = that dir and `mediaDir` = `<dir>/media/uploads`.
  - Caveat: `keystorePath` still resolved to `<cwd>/.env.local` (the repo's), because the keystore is cwd-relative even with a data dir set.

**Test media**
- Two synthetic 4 s clips (640×360, 30 fps, H.264 + AAC sine tone): `clip_a.mp4` (colour bars + moving box) and `clip_b.mp4` (different palette).
- No system ffmpeg is installed. Remotion's bundled `node_modules/@remotion/compositor-win32-x64-msvc/ffmpeg.exe` is a minimal build (no `testsrc`, `drawtext`, `rawvideo`, `select` or `hstack`). I generated BMP frames in Python and piped them through `-f image2pipe -c:v bmp`.

**Exact commands** (bash, repo root, with `OPENCHATCUT_DATA_DIR` exported as above):
```
npx tsx cli/main.ts project new "M0 proof" --size 1280x720 --fps 30 --json
#   -> id 6fe5c8a1-d19a-48e8-9588-7813f679ccfb                       (3.6 s)
npx tsx cli/main.ts tools call import_folder --project 6fe5c8a1 \
  --args '{"path":"<scratchpad>/m0/media"}' --apply --json
#   -> 2 assets imported, session "applied"                          (3.5 s)
npx tsx cli/main.ts tools call edit_item --project 6fe5c8a1 \
  --args '{"adds":[{"type":"video","assetId":"7b3fd4ff-90be-4c0f-baf2-a9c5fe486251","track":"V1","fromFrame":0}]}' --apply --json
#   -> item_ce81c18c… on track_v1, frames 0-120
npx tsx cli/main.ts render 6fe5c8a1 --out <scratchpad>/m0/out/single.mp4 --json
```

**Result (single clip)**
- Exit code 0.
- Wall time: **13.5 s** for a timed repeat run (`single2.mp4`, byte-identical to the first). That includes the per-process webpack bundle, which is rebuilt on every `occ` invocation.
- Output: **292,345 bytes**. ffprobe: h264 **1280×720**, 30 fps, **120 frames**, AAC audio, container duration **4.011 s**.
- The CLI's JSON reported `frames:120, durationSeconds:4`.
- A frame extracted at 2 s shows clip A's bars and box scaled up to 1280×720, so the output is real content, not a black frame.
- **No failures.** The only stderr noise was the media-acceleration notice, plus (in F2's render) Remotion warnings that the template loaded the Inter font with ~126 network requests. **Rendering motion-graphics templates needs network access to Google Fonts**, or the fonts must be pre-cached. I did not test an offline machine.

## F2. Headless feasibility: the 39 offline tools can build a real timeline

All six operations were executed with `occ tools call … --apply` (one offline auto session per command). The stored `ProjectDoc` was then re-read, and the timeline was rendered (`full.mp4`) and inspected frame by frame.

| # | Operation | Offline? | Tool + args actually used | Verified by |
|---|---|---|---|---|
| 1 | Import media | **Yes** | `import_folder {path}` (also `import_asset`, `import_assets`) | 2 pool assets returned; files copied into `<dataDir>/media/uploads` |
| 2 | Add clip to a track | **Yes** | `edit_item {adds:[{type:"video",assetId,track:"V1",fromFrame}]}` | item placed; in render |
| 3 | Trim in/out | **Yes** | `edit_item {updates:[{type:"video",itemId,srcInFrame:15,durationInFrames:90}]}`, then `edit_track {action:"tighten",trackId:"V1"}` to close the gap. (`set_item_timing`, `split_item` and `edit_item` `operation:"slip"` also exist offline.) | doc has `srcInFrame:15, durationInFrames:90`; rendered frame at 1.5 s matches source frame 60 (bar phase), so the in-point is honoured |
| 4 | Visual effect with parameters | **Yes** | `manage_effects {action:"add",targetItemId,assetId:"builtin:fx-glitch",propertyOverrides:{intensity:1.2,blockSize:40}}` (or `edit_item adds:[{type:"effect",…}]`) | doc `effects[0].overrides = {intensity:1.2, blockSize:40}`; glitch visible on clip B |
| 5 | Transition at a cut | **Yes** | `edit_item {adds:[{type:"transition",assetId:"builtin:tr-cross-dissolve",outgoingItemId:A,incomingItemId:B,durationInFrames:20}]}` | `timeline.transitions[0]` stored; frame 3.1 s shows the A/B blend |
| 6 | Motion-graphics template with text fields | **Yes** | `edit_track {action:"create",json:"{\"trackType\":\"video\"}"}` → V2; `edit_item {adds:[{type:"motion-graphic",assetId:"library:motion-graphic:b820ad1e-…",track:"V2",startFrame:30}]}` (or `add_motion_graphic {templateName}`); `update_item_props {itemId,props:{nameText,titleText,introText,accentColor}}` | rendered lower third reads "Headless Export / M0 proof / Rendered by occ, no clicks" in the custom red accent |

**Missing tool for each gap: none.** All six are covered offline. The ids needed came from offline reads: `browse_library` (category/group/query/id), `list_templates`, `search_templates`. The final render was 7.0 s, 210 frames, 1,573,275 bytes, **20.7 s** wall time.

**Problems found while doing it (the first is a renderer behaviour, not an offline gap)**
1. **GL transitions hide upper-track overlays.** The lower third on V2 vanishes for the whole transition window (about frames 79–100) and returns afterwards. Cause: `src/editor/TimelineComposition.tsx:367`, where GLSL transition windows are "painted over both clips, beneath captions", i.e. above every track item. So titles or overlays that span a cut disappear during a GL transition. Workaround: keep overlays clear of transition windows, or use captions. **Unsure** whether upstream considers this intended.
2. Inside the transition window the glitch effect also appears on the *outgoing* clip's pixels (frame 2.8 s). It looks like the incoming clip's effect stack is applied to the transition composite. Observed only; I did not trace the cause.
3. Large tool results are **archived** to an agent artifact (`manage_effects action=list` returned `{archived:true, artifactId}`, 16 kB). `occ` discards the session after a read-only call, so the artifact can't be read back in a later `occ` run. Use `browse_library` (paged) or `catalogue.json` instead. This answers the M0 "unsure": `list` needs no `targetItemId`.
4. Each `occ` call is a separate process and a separate offline edit session (about 3.5 s overhead each), and each `render` re-bundles. For many operations, batch them into one `occ edit --ops '[…]' --apply` call (atomic, one session).
5. `AGENT_IMPORT_ROOTS` was unset and the import still worked (desktop/CLI default = allowed). That confirms M0 §6.

**What the 91 browser-only tools add** (not needed for the six operations above). These need the editor open and go through MCP:
- **Visual QA:** `view_timeline_frames`, `view_asset_frames`.
- **Speech/transcript:** `transcribe_track`, `manage_transcript`, `clean_script`, `delete_text`, `remove_silence`.
- **AI generation:** `submit_image`, `submit_video`, `submit_voice`, `submit_music`, `submit_sound`, `submit_shader`, `create_motion_graphic*`.
- **Analysis/sync:** `detect_scenes`, `detect_beats`, `sync_cuts_to_music`, `analyze_music`, `auto_grade`, `auto_reframe`, `multicam_sync`.
- **Media-pool management:** `manage_media_pool`, `import_url_asset`, `probe_media`.
- **Undo/versions:** `undo_last_change`, `manage_versions`. (`occ` commits do snapshot a pre-edit version.)
- **Export via MCP:** `submit_render_job`, `track_export`.
- Everything else in the browser-only set is in the M0 appendix table, where the "Offline/CLI" column is "—".

## F3. Catalogue dump

- Script: **`scripts/dump-catalogue.mts`** (new file). Run with `npx tsx scripts/dump-catalogue.mts [out]`; it takes about 1.4 s. It type-checks cleanly under `--strict` with bundler resolution.
- What it imports: `ALL_FX`, `FX_EFFECTS`/`FX_ORDER`, `LUT_EFFECTS`/`LUT_ORDER` (`src/gl/fx/effects.ts`), `GLSL_TRANSITIONS` (`src/gl/transitions.ts`), `TRANSITION_LABELS` (`src/editor/transitionTypes.ts:59`), and the three template JSONs in `assets/templates/`.
- Output: **`catalogue.json`** (repo root, 766 kB): `{generatedAt, sources, counts, items[]}`.
  - Each item has `id`, `assetId` (the exact string `edit_item`, `manage_effects` or `add_motion_graphic` accept), `name`, `kind` (`effect | lut | custom-effect | transition | template`), `description`, and `params[]` = `{key, label, type, default, min, max, step, editable, options?, uniform?, note?}`.
  - Templates also carry `category`, `width`/`height`/`fps`/`durationInFrames` and `tags`.
- Counts: **33 effects (115 params), 16 LUTs (46 params, each `intensity` 0..1), 16 transitions, 235 templates (2,195 params), 300 items in total**, with no duplicate assetIds. These match what `browse_library` reported live (fx 33, luts 16, transitions 16, motion-graphics 235). `ALL_FX` = 49 = FX + LUT; no runtime custom fx were registered in a fresh process.
- Things to know when consuming it:
  - **Effect params**: numbers have real `default/min/max/step` from the defs. Colour params are `type:"color-rgb01"`, with the default an RGB array and each channel 0..1.
  - **Transitions have no per-item tunable shader parameters.** Their uniforms are hard-coded per type in `src/gl/transitions.ts`. They are emitted with `editable:false` and `min/max:null`; the ranges in code comments ("Ai default [0, 1]") are not enforced. The only per-item knobs are `durationInFrames` (min 1, no default in the type) and `direction` (`left|right|up|down`, default `left`).
  - **Template params**: `default` = `defaultValue` from `propSchema`. `min/max` exist only where the template declares them (124 of 2,195 params; mostly `number`). Other types are `text` 1,014, `color` 700 (hex strings), `number` 197, `font` 161, `boolean` 92, `image` 19, `select` 7 (with `options`), `string` 3, `asset` 2.
  - Effect and transition **display names are mostly Chinese** (e.g. `builtin:fx-glitch` = "故障闪烁"); template names are English.
  - Plugin-pack templates and runtime custom fx (`submit_shader`) are **not** included. They live in the user's pack store / session and are not part of the bundled registries.
- **Git note:** `.gitignore:89` ignores `/scripts/*` except allowlisted files, so `scripts/dump-catalogue.mts` does **not** show in `git status`. To keep it, either `git add -f scripts/dump-catalogue.mts` or add `!/scripts/dump-catalogue.mts` to `.gitignore`. I left `.gitignore` untouched.


---

# M2 (2026-11-16): Vietnamese diacritics and offline fonts

Test string: **"Đức Ủy Ở Hoàng Gia Nguyễn"**, typed into every `text`/`string` prop of a template. Everything was rendered with the app's own Remotion serve bundle at full template resolution. No existing source file was changed. Added: `scripts/vi-font-check.mts` and `vi-font-review.json`. `scripts/dump-catalogue.mts` now merges the review.

## V1. Do the diacritics render? Spot checks (title-cards + social-shorts)

From the full run below, looked at frame by frame:

| Template | Group | Result |
|---|---|---|
| Breaking News Title Card | title-cards | correct (Inter caps, every accent intact) |
| Location Title Card | title-cards | correct (mono face) |
| News Broadcast Title Card | title-cards | correct (serif) |
| Name Tag Title Card | title-cards | glyphs correct; headline truncated "ĐỨC ỦY Ở HOÀNG …" (length) |
| Event Opener Screen | title-cards | **fail**: tight line-height makes accents collide with the line above ("GIẠ", "NGỤYỄN") |
| Dial Chapter Card | title-cards | correct (references Georgia, but the face actually used covers Vietnamese) |
| 竖屏 social-shorts #211, #217, #219, #222 | social-shorts | correct (all 15 social-shorts pass) |

- **No tofu boxes anywhere. No accents stripped anywhere:** the Vietnamese render differed from the accent-free render in every rendered template, measured programmatically.
- The real failure modes are:
  - (a) **accent collision / clipping** in tight-leading display layouts,
  - (b) **glyph fallback**, where the template's font lacks Vietnamese and Chromium substitutes another font for ứ Ủ Ở ễ,
  - (c) plain **length overflow**.

## V2. Where the Google Fonts request happens, and how to vendor Inter

**Request path during render:**
1. `src/editor/TimelineReadinessGate.tsx:51` calls `loadTimelineFonts(state)` (`src/fonts/projectFonts.ts:100`).
2. That collects families from motion-graphic props and code (`projectFonts.ts:6-42`; a regex on `fontFamily:` in template code).
3. It then calls `ensureFont(family)` (`src/fonts/googleFonts.ts:66`). That goes to local fonts first (`:70`, `findLocalFont` → `ensureLocalFont`), otherwise `loadGoogleFace` (`:77`).
4. For Inter: `src/fonts/googleFonts.ts:38` → `(await import('@remotion/google-fonts/Inter')).loadFont()`.
   - With **no arguments**, this loads every weight (100–900) × normal/italic × every subset. That produces the 63/126 `fonts.gstatic.com` requests seen in render logs.
   - The log's `src/captions/segmenterData.ts:56` location is a source-map artefact; that file contains no font code.
   - The URLs are hard-coded in `node_modules/@remotion/google-fonts/dist/esm/Inter.mjs` (`getInfo().fonts[style][weight][subset]`).

**Can Inter be vendored? Yes, and there is an exact in-repo precedent: Noto Sans SC**, done in commit `1e6c7b05`. The change would involve:
1. **Font files:** add `assets/fonts/inter/`.
   - Copy the `@fontsource-variable/inter` 5.x (OFL-1.1) variable WOFF2 shards into `files/`, plus an `inter.css` with one `@font-face` per shard (`font-weight: 100 900`, `unicode-range` per subset, both `normal` and `italic`).
   - Also add the OFL license text and `SHA256SUMS`, and a row in `assets/fonts/LICENSES.md`.
   - The package is ~1.9 MB unpacked across all subsets. Shipping only latin, latin-ext and vietnamese would be roughly 10% of that (estimate, not measured).
2. **Registry:** in `src/fonts/localFonts.ts` (`LOCAL_CJK_FONTS`, `:38-72`), add `{ family: 'Inter', importName: 'Inter', aliasZh: [], stylesheet: '/fonts/inter/inter.css', weightRange: [100, 900] }`.
   - Because `ensureFont` checks `findLocalFont` before Google (`googleFonts.ts:70`), every Inter load then goes to disk.
   - The `/fonts/...` URL already works in both the Vite app and the Remotion serve bundle: `remotion/serve-bundle.mjs` copies `assets/` to the serve root.
3. **Catalogue:** remove Inter from `GOOGLE_FONT_CATALOG` (`src/fonts/googleFontCatalog.ts:29`), so `FONT_CATALOG` doesn't list it twice. Bundled fonts get `source:'bundled'` automatically (`:51-59`).
   - Remove the dead `case 'Inter'` at `googleFonts.ts:38`.
   - Optionally rename `LOCAL_CJK_FONTS`, since it would no longer be CJK-only.
4. **Test:** add a verify modelled on `src/fonts/notoSansOffline.verify.ts`. It serves `assets/fonts/inter/` from a local HTTP server, opens Remotion's headless Chrome with network access to Google blocked, renders "Đức Ủy Ở Hoàng Gia Nguyễn" in Inter, and asserts the face loaded. Register it in a `verify:*` script.

**Limits:**
- Inter alone does not make *all* template renders offline. Templates also pull Playfair Display (28), Montserrat (9), Roboto (8), DM Sans (5), Oswald (4), Anton, Space Mono (3 each), Caveat (2), Fredoka, Nunito and Special Elite (1 each) from Google. Fully offline rendering means vendoring those 11 families the same way. Inter covers 69 of the 235 templates.
- Vendoring does not fix Vietnamese for **DM Sans, Caveat, Fredoka and Special Elite**: Google ships no Vietnamese subset for them. Those templates need a substitute family, e.g. a Vietnamese-capable alternative chosen per template.

## V3. All 235 templates

- **Method.** `npx tsx scripts/vi-font-check.mts --out <dir> --concurrency 3`; the full run took **401 s**.
  - Per template, one transparent full-resolution frame is rendered with text set to a zero-width space (`ZW`), the Vietnamese string, and the accent-free string. The frame is chosen at 60%/45%/80%/30%/95% of duration until text is visible.
  - Programmatic metrics:
    - text pixels: Vietnamese vs ZW,
    - accent presence: Vietnamese vs accent-free,
    - text bbox touching the frame edge (overflow), for both strings,
    - a static font check: families referenced vs Vietnamese coverage. Coverage was verified with `@remotion/google-fonts` `getInfo().subsets` and the cmap of `C:\Windows\Fonts\*.ttf`: Georgia, Impact and Comic Sans lack ứ Ủ Ở ễ; Arial, Times and Segoe UI have them.
  - Then **every rendered template was reviewed visually** from contact sheets of the text-band crops (31 sheets). Ambiguous cases were re-checked on full frames or zoomed crops.
  - Programmatic flags I overruled: 8 edge flags were false positives (text-sized background art), and the bbox-top "accent clip" heuristic was dropped as unreliable.
- **Output.**
  - `vi-font-review.json` (repo root): per template `id`, `vi_ok`, `vi_status`, `vi_issues[{issue, note}]`, `vi_warnings`, metrics and fonts.
  - `scripts/dump-catalogue.mts` merges `vi_ok` / `vi_status` / `vi_issues` / `vi_warnings` into every template in `catalogue.json`. All 235 have them; `counts.templateViOk = 136`.

### Result: **136 of 235 templates are usable with Vietnamese text** (`vi_ok: true`)

| Outcome | Count | Meaning |
|---|---|---|
| ok | **136** | text renders correctly, fits, accents intact |
| fail_vietnamese | **24** | a Vietnamese-specific defect (would not happen in English) |
| fail_length | **35** | glyphs fine, but the 25-character string is too long for the field (truncated, "…", clipped, overlapping, off-frame); shorter Vietnamese text would likely work |
| no_text_field | **30** | the template has no editable text prop; text is hard-coded in its code |
| text_props_ignored | **10** | declares text props, but the code ignores them (default and Vietnamese renders are pixel-identical): Checklist Tick Animation, Fruit Shopping Tips, Shopping Tips Animation, Search Interface Simulator, Golden Chapter Card, Neon Title Card, Red Passion Chapter Card, Skewed Chapter Label, Data visualization animation, Pie chart animation |

- Glyphs render correctly (ignoring length) in **171 of the 195** templates where text is visible.

**Vietnamese-specific failures (24):**

| Issue | Templates | Count |
|---|---|---|
| `accent_collision` (line-height too tight, accents land in the line above) | Event Opener Screen; Bold Typography (HQ); Bold Typography Impact; Colorful Inspiration; eCommerce Business; Minimal Gradient Chapter Title / Company Introduction / Data Chart; Retro Decode; Tech Trends Chapter Title; Timeline Company Milestones | 11 |
| `glyph_fallback` (font lacks Vietnamese, mixed glyphs) | Hand-Drawn List Overlay and Steps for Studying (Caveat); Cartoon Style (Fredoka); Digital Revolution (Special Elite); MindSpace Kinetic Title Reveal (Impact); MindSpace Number Counter and Quote Card (DM Sans); Vibe Effects Title Card | 8 |
| `accent_clipped` (stacked tilde or hook above cut by a mask or container) | Bar Chart Weekly Growth Rate, Line Chart Sales Trend ("Nguyễn" → "Nguyên"); Editorial Lower Third Card; Tech Trends Company Introduction (Ở→Ơ, NGUYỄN→NGUYÊN) | 4 |
| `text_overflow_vi_only` | Black Friday | 1 |

Some templates carry more than one issue: 5 of the Vietnamese failures also overflow.

**Per group (vi_ok / total):**
- social-shorts 15/15 and koubo-scenes 9/9: every Chinese-market template passes. Their system serif fallback, Times New Roman on Windows, covers Vietnamese.
- quote-cards 5/5
- data-visualization 19/35, infographics 6/12, lower-thirds 5/10, social-media 2/3, social-ui 0/1, talking-head-overlays 4/8, text-effects 2/8, title-cards 11/27, uncategorized 58/102.

**Caveats:**
- **One frame per template.** An animation that clips accents only at other times would be missed. Typewriter and word-reveal templates were judged on their partial state.
- **The length failures depend on my test string.** I put the same 25-character string into every text field, including short labels such as chart legends.
- **Platform-specific.** Results are for a **Windows** render machine. Templates that rely on system fonts (`Georgia`, `Impact`, `Lora`, `system-ui`, generic `serif`) will render differently on Linux or macOS.
- **The pass/fail calls come from my visual review, and some are judgement calls.** Subtle Georgia/DM Sans substitutions that looked consistent are recorded as `vi_warnings`, not failures.
