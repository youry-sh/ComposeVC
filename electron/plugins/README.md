# ComposeVC plugins

A plugin is a built-in capability with its own settings, job history, workspace
entry and AI tool. The first (and currently only) plugin is **Blender**.

## Layout

```
electron/plugins/
  store.cjs              JSON store (settings + per-job folders), atomic writes
  registry.cjs           plugin metadata, status, shared job/artifact helpers
  blender/
    index.cjs            detection + job runner (spawn, timeout, cancel, logs)
    driver.py            bpy driver: scene, materials/presets, animation, rig,
                         effects, bakes, quality audit, exports, add-ons
    addons.cjs           extensions.blender.org search + archive download
    assets.cjs           Poly Haven CC0 texture/HDRI/model search + vault
  README.md
src/components/PluginsWorkspace.tsx   "Plugins" tab (native IDE look)
```

Persisted under Electron `userData` (never localStorage):

```
<userData>/plugins/plugins.json          versioned settings (+ enabled add-ons)
<userData>/plugins/jobs/<jobId>/         plan.json, script.py, log.txt,
                                         preview.png, textures/, *.glb, scene.blend,
                                         result.json, job.json
<userData>/plugins/output/               default "copy artifacts" target
<userData>/plugins/addons/               downloaded add-on/extension zips
<userData>/plugins/assets/<type>/<id>/   downloaded CC0 assets + asset.json
```

## AI tools

* `blender` — full control: `status`, `probe`, `scene`, `python`, `render`,
  `export`, `import`, `inspect`, `bake`, `jobs`, `job`, `cancel`, `delete_job`,
  `config`, `copy_artifacts`, `open_output`, `open_gui`, `addons`,
  `addon_search`, `addon_install`, `addon_enable`, `addon_disable`,
  `asset_search`, `asset_download`, `asset_list`, `asset_remove`.
* `plugin` — generic plugin manager (list, status, probe, enable/disable,
  config, jobs, cancel, artifacts).

## Quality pipeline

`driver.py` returns a `quality` report (`score`, `game_ready`, per-mesh UV /
materials / textures / scale / polygon checks) and the agent is instructed to
fix issues and re-run until the asset is game-ready. `export.preset`
(`unity|unreal|godot|web|3dprint`) maps to the right format and axis options.

## Add-ons

`addon_search` queries extensions.blender.org; `addon_install` downloads the
archive and installs it with `bpy.ops.extensions.package_install_files` (or the
legacy `addon_install` fallback), then enables the module. Enabled module ids
are stored in `plugins.json` and injected into every later plan, so add-ons
persist across jobs without touching the user's Blender preferences.

## Assets

`asset_search` / `asset_download` use the public Poly Haven API (CC0) and return
ready-to-paste `material`, `world` or `import` specs pointing at local files in
the vault.

## Blender execution contract

```
blender --background --factory-startup --python-exit-code 3 \
        --python driver.py -- --plan plan.json --out <jobDir>
```

The driver writes `result.json` (`ok`, `warnings`, `renders`, `bakes`,
`exports`, `stats`, `addons`, `quality`, `blendPath`) and prints progress
markers:

```
CVJOB {"stage":"objects","percent":34}
CVRESULT {"ok":true,"renders":1,"exports":1}
```

`index.cjs` streams stdout to `log.txt`, mirrors markers into `job.json`,
serialises disk writes, enforces the timeout and kills the whole process tree
on cancel/timeout. `--probe` (same driver) reports version, engines, exporters
and addons without touching the store.

## Adding the next plugin

1. Append metadata to `PLUGINS` in `registry.cjs` (id, name, tagline, tools,
   capabilities, examples, accent).
2. Add a module that exposes `detect`, `run*`, `cancel`, `probe` and produces
   the same job records through `store.cjs`.
3. Register a tool in `electron/tools/registry.cjs`.
4. The Plugins workspace lists it automatically; no UI rewrite is required.
