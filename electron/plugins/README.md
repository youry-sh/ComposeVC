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
    driver.py            bpy driver: scene build, materials, render, bake, export
  README.md
src/components/PluginsWorkspace.tsx   "Plugins" tab (native IDE look)
```

Persisted under Electron `userData` (never localStorage):

```
<userData>/plugins/plugins.json          versioned settings
<userData>/plugins/jobs/<jobId>/         plan.json, script.py, log.txt,
                                         preview.png, textures/, *.glb, scene.blend,
                                         result.json, job.json
<userData>/plugins/output/               default "copy artifacts" target
```

## AI tools

* `blender` — full control: `status`, `probe`, `scene`, `python`, `render`,
  `export`, `import`, `inspect`, `bake`, `jobs`, `job`, `cancel`, `delete_job`,
  `config`, `copy_artifacts`, `open_output`, `open_gui`.
* `plugin` — generic plugin manager (list, status, probe, enable/disable,
  config, jobs, cancel, artifacts).

Both are registered in `electron/tools/registry.cjs` and therefore appear in
the model's tool schemas automatically.

## Blender execution contract

```
blender --background --factory-startup --python-exit-code 3 \
        --python driver.py -- --plan plan.json --out <jobDir>
```

The driver writes `result.json` (`ok`, `warnings`, `renders`, `bakes`,
`exports`, `stats`, `blendPath`) and prints progress markers:

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
