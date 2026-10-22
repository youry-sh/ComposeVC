import React, { useState, useEffect, useMemo } from "react";
import {
  Copy,
  Download,
  Search,
  Upload,
  Wrench,
  X,
  Save,
  Cable,
} from "lucide-react";
import { CustomTool } from "../types";
import McpModal from "./McpModal";

interface CustomToolsWorkspaceProps {
  tools: CustomTool[];
  onAdd: (input: {
    name: string;
    title?: string;
    description?: string;
    code?: string;
    runtime?: string;
    entry?: string;
    tags?: string[];
    inputSchema?: Record<string, unknown>;
    dependencies?: string[];
  }) => Promise<void>;
  onUpdate: (
    toolId: string,
    patch: {
      name?: string;
      title?: string;
      description?: string;
      code?: string;
      runtime?: string;
      entry?: string;
      enabled?: boolean;
      tags?: string[];
      inputSchema?: Record<string, unknown>;
      dependencies?: string[];
    }
  ) => Promise<void>;
  onRemove: (toolId: string) => Promise<void>;
  labels: {
    customTools: string;
    customToolsHint: string;
    customToolsEmpty: string;
    customToolTitle: string;
    customToolTitlePlaceholder: string;
    customToolDescription: string;
    customToolDescriptionPlaceholder: string;
    customToolBody: string;
    customToolBodyPlaceholder: string;
    customToolRuntime: string;
    customToolSaving: string;
    customToolDependencies: string;
    customToolDependenciesEmpty: string;
    customToolDependenciesHint: string;
    customToolSave: string;
    customToolDelete: string;
    customToolEnabled: string;
    customToolDisabled: string;
    customToolsSearch: string;
    customToolTags: string;
    customToolTagsPlaceholder: string;
    customToolInvalidJson: string;
    customToolExport: string;
    customToolExportAll: string;
    customToolExportOne: string;
    customToolImport: string;
    customToolImportAll: string;
    customToolImportOne: string;
    customToolImportPick: string;
    customToolImportPickHint: string;
    customToolImportSelected: string;
    customToolImportCancel: string;
    customToolCopyPack: string;
    customToolCopyOne: string;
    customToolCopied: string;
    customToolExportSaved: string;
    customToolImportDone: string;
    customToolImportMode: string;
    customToolImportSkip: string;
    customToolImportOverwrite: string;
    customToolImportRename: string;
    noResults: string;
  };
}

const DEFAULT_CODE = `const fs = require("fs");

async function main(args, ctx) {
  // args — call args; ctx — { toolDir, rootPath, userDataPath, toolsRoot }
  return { ok: true, result: args };
}

async function run() {
  const raw = fs.readFileSync(0, "utf8");
  let payload = {};
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch (err) {
    process.stderr.write(String(err && err.message ? err.message : err));
    process.exit(2);
  }
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const ctx = payload.ctx && typeof payload.ctx === "object" ? payload.ctx : {};
  try {
    const result = await main(args, ctx);
    process.stdout.write(JSON.stringify(result == null ? null : result));
  } catch (err) {
    process.stderr.write(String(err && err.stack ? err.stack : err));
    process.exit(1);
  }
}

run();
`;

const RUNTIME_ENTRY: Record<string, string> = {
  node: "main.js",
  python: "main.py",
  powershell: "main.ps1",
};

/** Mirror of the backend `normalizeToolName`: derives a folder-safe slug from a title. */
const slugifyName = (raw: string) =>
  String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);

type PanelMode = "create" | "edit";
type ImportMode = "skip" | "overwrite" | "rename";

interface ImportPreviewTool {
  index?: number;
  id?: string;
  name?: string;
  title?: string;
  description?: string;
  kind?: string;
  enabled?: boolean;
  tags?: string[];
  valid?: boolean;
  error?: string | null;
}

interface ImportPickState {
  path?: string | null;
  text: string;
  format?: "zip" | "json" | string | null;
  tools: ImportPreviewTool[];
  selected: number[];
}

const quietBtn =
  "ide-quiet-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 theme-soft";
const primaryBtn =
  "ide-primary-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ui-btn-primary";
const fieldClass =
  "ide-field h-8 w-full min-w-0 px-3 text-[12px] leading-none text-ink-950 placeholder-ink-500 outline-none";
const fieldStyle: React.CSSProperties = {
  caretColor: "var(--accent)",
};
const labelClass = "ide-field-label text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500";

const CustomToolsWorkspace: React.FC<CustomToolsWorkspaceProps> = ({
  tools,
  onAdd,
  onUpdate,
  onRemove,
  labels,
}) => {
  const [panelMode, setPanelMode] = useState<PanelMode>("create");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [runtime, setRuntime] = useState("node");
  const [codeText, setCodeText] = useState(DEFAULT_CODE);
  const [tagsText, setTagsText] = useState("");
  const [dependencies, setDependencies] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [busyShare, setBusyShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [importMode, setImportMode] = useState<ImportMode>("skip");
  const [importPick, setImportPick] = useState<ImportPickState | null>(null);
  const [mcpOpen, setMcpOpen] = useState(false);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.title || "").toLowerCase().includes(q) ||
        (t.description || "").toLowerCase().includes(q) ||
        (t.tags || []).some((tag) => tag.toLowerCase().includes(q)) ||
        JSON.stringify(t.body || {}).toLowerCase().includes(q)
    );
  }, [tools, search]);

  useEffect(() => {
    if (selectedId && !tools.some((t) => t.id === selectedId)) {
      setSelectedId(null);
      setPanelMode("create");
      setTitle("");
      setDescription("");
      setRuntime("node");
      setCodeText(DEFAULT_CODE);
      setTagsText("");
      setDependencies([]);
      setError(null);
    }
  }, [tools, selectedId]);

  const resetCreateForm = () => {
    setTitle("");
    setDescription("");
    setRuntime("node");
    setCodeText(DEFAULT_CODE);
    setTagsText("");
    setDependencies([]);
    setError(null);
  };

  const openCreate = () => {
    setPanelMode("create");
    setSelectedId(null);
    resetCreateForm();
  };

  const openEdit = async (tool: CustomTool) => {
    setPanelMode("edit");
    setSelectedId(tool.id);
    setTitle(tool.title || "");
    setDescription(tool.description || "");
    const rt =
      (tool.body as { runtime?: string } | undefined)?.runtime ||
      (tool as { runtime?: string }).runtime ||
      "node";
    setRuntime(rt);
    setTagsText((tool.tags || []).join(", "));
    setDependencies(tool.dependencies || []);
    setError(null);
    try {
      const file = await window.lopster?.readCustomToolFile?.(tool.id);
      if (file?.content) {
        setCodeText(file.content);
      } else {
        setCodeText(DEFAULT_CODE);
      }
    } catch {
      setCodeText(DEFAULT_CODE);
    }
  };

  const parseTags = (raw: string) =>
    raw
      .split(/[,;\n]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 20);

  const canSave = Boolean(name.trim() && codeText.trim());

  const handleSave = async () => {
    const trimmedName = name.trim();
    const trimmedTitle = title.trim();
    const trimmedDescription = description.trim();
    const trimmedCode = codeText;
    if (!trimmedName || !trimmedCode.trim()) {
      setError(labels.customToolInvalidJson);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const tags = parseTags(tagsText);
      const entry = RUNTIME_ENTRY[runtime] || "main.js";
      if (panelMode === "edit" && selectedId) {
        await onUpdate(selectedId, {
          name: trimmedName,
          title: trimmedTitle || undefined,
          description: trimmedDescription || undefined,
          code: trimmedCode,
          runtime,
          entry,
          tags,
          dependencies,
        });
      } else {
        await onAdd({
          name: trimmedName,
          title: trimmedTitle || undefined,
          description: trimmedDescription || undefined,
          code: trimmedCode,
          runtime,
          entry,
          tags,
          dependencies,
        });
        resetCreateForm();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save custom tool");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (toolId: string) => {
    try {
      await onRemove(toolId);
      if (selectedId === toolId) openCreate();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete custom tool");
    }
  };

  const handleToggle = async (tool: CustomTool) => {
    try {
      await onUpdate(tool.id, { enabled: tool.enabled === false });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to toggle custom tool");
    }
  };

  const handleExport = async (opts?: { ids?: string[]; names?: string[] }) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.lopster?.exportCustomTools?.({
        ...(opts || {}),
        saveToFile: true,
        dialog: true,
        format: "zip",
      });
      if (result?.saved && result.path) {
        setStatusMsg(`${labels.customToolExportSaved}: ${result.path} (${result.count || 0})`);
      } else if (result?.text) {
        try {
          await navigator.clipboard.writeText(result.text);
          setStatusMsg(`${labels.customToolCopied} · ${result.count || 0}`);
        } catch {
          setStatusMsg(`${labels.customToolExport}: ${result.count || 0}`);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusyShare(false);
    }
  };

  const handleCopyPack = async (opts?: { ids?: string[]; names?: string[] }) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const result = await window.lopster?.exportCustomTools?.({
        ...(opts || {}),
        format: "json",
      });
      const text = result?.text || "";
      if (!text) throw new Error("Empty export pack");
      await navigator.clipboard.writeText(text);
      setStatusMsg(`${labels.customToolCopied} · ${result?.count || 0}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy pack failed");
    } finally {
      setBusyShare(false);
    }
  };

  const applyImportResult = (result: {
    imported?: unknown[];
    updated?: unknown[];
    skipped?: unknown[];
    errors?: Array<{ index?: number; name?: string; error?: string }>;
  } | null | undefined) => {
    const imported = result?.imported?.length || 0;
    const updated = result?.updated?.length || 0;
    const skipped = result?.skipped?.length || 0;
    const errors = result?.errors?.length || 0;
    setStatusMsg(
      `${labels.customToolImportDone}: +${imported}, ~${updated}, skip ${skipped}` +
        (errors ? `, err ${errors}` : "")
    );
    if (errors && result?.errors?.[0]?.error) {
      setError(String(result.errors[0].error));
    }
  };

  const runImportWithFilter = async (
    source: string | null | undefined,
    filter?: { indices?: number[]; names?: string[]; onlyOne?: boolean },
    fromPath?: string | null,
    format?: string | null
  ) => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const isZip =
        format === "zip" ||
        (typeof fromPath === "string" && /\.zip$/i.test(fromPath));
      const result = await window.lopster?.importCustomTools?.({
        source: isZip ? undefined : source || undefined,
        path: fromPath || undefined,
        mode: importMode,
        indices: isZip ? undefined : filter?.indices,
        names: filter?.names,
        onlyOne: filter?.onlyOne === true,
        format: isZip ? "zip" : format === "json" ? "json" : undefined,
      });
      if (result?.canceled) return;
      applyImportResult(result);
      setImportPick(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusyShare(false);
    }
  };

  const handleImport = async () => {
    setBusyShare(true);
    setError(null);
    setStatusMsg(null);
    try {
      const preview = await window.lopster?.previewCustomToolsImport?.({
        dialog: true,
      });
      if (preview?.canceled) return;
      const packTools = Array.isArray(preview?.tools) ? preview.tools : [];
      const format =
        preview?.format === "zip" ||
        (typeof preview?.path === "string" && /\.zip$/i.test(preview.path))
          ? "zip"
          : "json";
      const text = preview?.text || "";
      if (packTools.length === 0) {
        throw new Error("Import pack is empty");
      }
      if (format === "json" && !text) {
        throw new Error("Import pack is empty");
      }
      if (format === "zip" && !preview?.path) {
        throw new Error("ZIP import requires a file path");
      }
      if (packTools.length === 1) {
        const only = packTools[0];
        setBusyShare(false);
        await runImportWithFilter(
          format === "zip" ? null : text,
          format === "zip"
            ? {
                names: only.name ? [String(only.name)] : undefined,
                onlyOne: true,
              }
            : {
                indices: only.index != null ? [only.index] : [0],
                onlyOne: true,
              },
          preview?.path,
          format
        );
        return;
      }
      setImportPick({
        path: preview?.path || null,
        text,
        format,
        tools: packTools,
        selected: packTools.length ? [Number(packTools[0].index ?? 0)] : [],
      });
      setStatusMsg(
        `${labels.customToolImportPick}: ${packTools.length} · ${preview?.path || ""}`.trim()
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusyShare(false);
    }
  };

  const toggleImportPickIndex = (index: number) => {
    setImportPick((prev) => {
      if (!prev) return prev;
      const has = prev.selected.includes(index);
      return {
        ...prev,
        selected: has ? prev.selected.filter((x) => x !== index) : [...prev.selected, index],
      };
    });
  };

  const handleImportSelected = async () => {
    if (!importPick) return;
    const indices = importPick.selected.slice().sort((a, b) => a - b);
    if (!indices.length) {
      setError(labels.customToolImportPick);
      return;
    }
    const fmt = importPick.format || "json";
    if (fmt === "zip") {
      const names = importPick.tools
        .filter((t) => indices.includes(Number(t.index ?? -1)))
        .map((t) => String(t.name || ""))
        .filter(Boolean);
      await runImportWithFilter(null, { names }, importPick.path, "zip");
      return;
    }
    await runImportWithFilter(importPick.text, { indices }, importPick.path, "json");
  };

  const handleImportAllFromPick = async () => {
    if (!importPick) return;
    await runImportWithFilter(
      importPick.format === "zip" ? null : importPick.text,
      undefined,
      importPick.path,
      importPick.format || "json"
    );
  };

  const kindOf = (tool: CustomTool) => {
    const body = tool.body || {};
    return String((body as { kind?: string; type?: string }).kind || (body as { type?: string }).type || "folder");
  };

  return (
    <div className="ide-tools-shell flex h-full w-full flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      <div className="ide-library-header flex h-10 shrink-0 items-center justify-between gap-3 border-b border-ink-200 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-ink-600" />
          <h2 className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-ink-950">
            {labels.customTools}
          </h2>
          <span className="tabular-nums text-[10px] text-ink-500">{tools.length}</span>
          <span className="hidden min-w-0 truncate text-[11px] text-ink-500 xl:inline">
            {labels.customToolsHint}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button type="button" onClick={() => setMcpOpen(true)} className={primaryBtn} title="Model Context Protocol servers">
            <Cable className="h-3.5 w-3.5" />
            MCP
          </button>
          <select
            value={importMode}
            onChange={(e) => setImportMode(e.target.value as ImportMode)}
            className="ide-compact-select h-7 max-w-[120px] bg-transparent px-1.5 text-[11px] text-ink-700 outline-none"
            style={{ borderBottom: "1px solid var(--border)" }}
            title={labels.customToolImportMode}
            disabled={busyShare}
          >
            <option value="skip">{labels.customToolImportSkip}</option>
            <option value="overwrite">{labels.customToolImportOverwrite}</option>
            <option value="rename">{labels.customToolImportRename}</option>
          </select>
          <button
            type="button"
            onClick={() => void handleImport()}
            disabled={busyShare}
            className={quietBtn}
            title={labels.customToolImport}
          >
            <Upload className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{labels.customToolImport}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleExport()}
            disabled={busyShare || tools.length === 0}
            className={quietBtn}
            title={labels.customToolExportAll}
          >
            <Download className="h-3.5 w-3.5" />
            <span className="hidden md:inline">{labels.customToolExportAll}</span>
          </button>
          <button
            type="button"
            onClick={() => void handleCopyPack()}
            disabled={busyShare || tools.length === 0}
            className={quietBtn}
            title={labels.customToolCopyPack}
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Status/error bar */}
      {(statusMsg || error) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-200 px-4 py-1.5 text-[11px]">
          {statusMsg && <span className="text-ink-600">{statusMsg}</span>}
          {error && <span className="text-status-err">{error}</span>}
        </div>
      )}

      {/* Import picker */}
      {importPick && (
        <div className="shrink-0 border-b border-ink-200 px-4 py-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12px] font-medium tracking-[-0.01em] text-ink-950">
                {labels.customToolImportPick}
              </div>
              <div className="mt-0.5 text-[11px] text-ink-500">{labels.customToolImportPickHint}</div>
              {importPick.path ? (
                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500">{importPick.path}</div>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <button
                type="button"
                onClick={() => setImportPick(null)}
                disabled={busyShare}
                className={quietBtn}
              >
                {labels.customToolImportCancel}
              </button>
              <button
                type="button"
                onClick={() => void handleImportAllFromPick()}
                disabled={busyShare}
                className={quietBtn}
              >
                {labels.customToolImportAll}
              </button>
              <button
                type="button"
                onClick={() => void handleImportSelected()}
                disabled={busyShare || importPick.selected.length === 0}
                className={primaryBtn}
              >
                {labels.customToolImportSelected}
                {importPick.selected.length ? ` (${importPick.selected.length})` : ""}
              </button>
            </div>
          </div>
          <div className="mt-2 max-h-[140px] space-y-0.5 overflow-y-auto scrollbar-thin">
            {importPick.tools.map((tool) => {
              const idx = Number(tool.index ?? 0);
              const checked = importPick.selected.includes(idx);
              const label = tool.title || tool.name || `#${idx}`;
              return (
                <label
                  key={`${idx}-${tool.name || "tool"}`}
                  className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 transition-colors"
                  style={{
                    background: checked ? "var(--accent-muted)" : "transparent",
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggleImportPickIndex(idx)}
                    className="mt-0.5"
                    disabled={busyShare}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[12px] font-medium text-ink-950">{label}</span>
                    <span className="block truncate font-mono text-[10px] text-ink-500">
                      {tool.name || "—"}
                      {tool.kind ? ` · ${tool.kind}` : ""}
                    </span>
                    {tool.description ? (
                      <span className="block truncate text-[10px] text-ink-500">{tool.description}</span>
                    ) : null}
                    {tool.error ? (
                      <span className="block truncate text-[10px] text-status-err">{tool.error}</span>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </div>
        </div>
      )}

      {/* Main area: side panel + editor */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Tool list sidebar */}
        <aside
          className="flex w-full max-h-[38vh] shrink-0 flex-col border-b border-ink-200 md:max-h-none md:w-[280px] lg:w-[300px] md:border-b-0 md:border-r"
          style={{ background: "var(--sidebar-tint)", borderColor: "var(--border)" }}
        >
          <div className="shrink-0 px-3 pt-2.5 pb-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
              <input
                type="text"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={labels.customToolsSearch}
                className="ide-search-input h-8 w-full min-w-0 bg-transparent pl-6 pr-0 text-[12px] text-ink-950 placeholder-ink-500 outline-none"
                style={fieldStyle}
              />
            </div>
          </div>
          <div className="ide-library-list min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-2 scrollbar-thin">
            {filteredTools.length === 0 ? (
              <div className="px-2 py-8 text-center text-[11px] text-ink-500">
                {tools.length === 0 ? labels.customToolsEmpty : labels.noResults}
              </div>
            ) : (
              filteredTools.map((tool) => {
                const active = selectedId === tool.id;
                const enabled = tool.enabled !== false;
                return (
                  <div
                    key={tool.id}
                    className={`ide-library-row group rounded-md px-2.5 py-2 transition-colors ${active ? "is-active" : ""}`}
                    style={{
                      opacity: enabled ? 1 : 0.6,
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => openEdit(tool)}
                      className="w-full min-w-0 text-left outline-none"
                    >
                      <div className="flex items-start gap-2">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[12px] font-medium text-ink-950">
                            {tool.title || tool.name}
                          </span>
                          <span className="block truncate font-mono text-[10px] text-ink-500">{tool.name}</span>
                          <span className="mt-0.5 block truncate text-[10px] text-ink-500">
                            {kindOf(tool)}
                            {tool.description ? ` · ${tool.description}` : ""}
                          </span>
                        </span>
                        <span
                          className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: enabled ? "var(--ink-950)" : "var(--ink-400)" }}
                          title={enabled ? labels.customToolEnabled : labels.customToolDisabled}
                        />
                      </div>
                    </button>
                    <div className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => void handleToggle(tool)}
                        className={quietBtn}
                      >
                        {enabled ? labels.customToolEnabled : labels.customToolDisabled}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void handleExport({
                            ids: [tool.id],
                            names: [tool.name],
                          })
                        }
                        className={quietBtn}
                        title={labels.customToolExportOne}
                      >
                        {labels.customToolExport}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleDelete(tool.id)}
                        className="ui-btn-danger h-7 px-2 text-[10px]"
                      >
                        {labels.customToolDelete}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </aside>

        <section className="ide-library-editor flex min-h-0 min-w-0 flex-1 flex-col bg-ink-0">
          <div className="ide-library-editor-body min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 scrollbar-thin">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="grid min-w-0 gap-1.5">
                <span className={labelClass}>{labels.customToolName}</span>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={labels.customToolNamePlaceholder}
                  className={fieldClass}
                  style={fieldStyle}
                />
              </label>
              <label className="grid min-w-0 gap-1.5">
                <span className={labelClass}>{labels.customToolTitle}</span>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={labels.customToolTitlePlaceholder}
                  className={fieldClass}
                  style={fieldStyle}
                />
              </label>
            </div>
            <label className="grid min-w-0 gap-1.5">
              <span className={labelClass}>{labels.customToolDescription}</span>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={labels.customToolDescriptionPlaceholder}
                className={fieldClass}
                style={fieldStyle}
              />
            </label>
            <label className="grid min-w-0 gap-1.5">
              <span className={labelClass}>{labels.customToolTags}</span>
              <input
                type="text"
                value={tagsText}
                onChange={(e) => setTagsText(e.target.value)}
                placeholder={labels.customToolTagsPlaceholder}
                className={fieldClass}
                style={fieldStyle}
              />
            </label>
            <label className="grid min-w-0 gap-1.5">
              <span className={labelClass}>Runtime</span>
              <select
                value={runtime}
                onChange={(e) => {
                  const rt = e.target.value;
                  setRuntime(rt);
                }}
                className="ide-field h-8 w-full min-w-0 px-3 text-[12px] leading-none text-ink-950 outline-none"
                style={fieldStyle}
              >
                <option value="node">node (main.js)</option>
                <option value="python">python (main.py)</option>
                <option value="powershell">powershell (main.ps1)</option>
              </select>
            </label>
            <div className="grid min-w-0 gap-1.5">
              <span className={labelClass}>Подключённые инструменты</span>
              <div className="grid max-h-36 grid-cols-1 gap-1 overflow-y-auto border border-ink-200 bg-ink-50 p-2 sm:grid-cols-2 scrollbar-thin">
                {tools.filter((tool) => tool.id !== selectedId && tool.name !== name.trim()).length ? (
                  tools.filter((tool) => tool.id !== selectedId && tool.name !== name.trim()).map((tool) => (
                    <label key={tool.id} className="flex min-w-0 cursor-pointer items-center gap-2 px-1 py-1 text-[11px] text-ink-700 hover:bg-ink-100">
                      <input
                        type="checkbox"
                        checked={dependencies.includes(tool.name)}
                        onChange={() => setDependencies((current) => current.includes(tool.name) ? current.filter((name) => name !== tool.name) : [...current, tool.name])}
                      />
                      <span className="truncate font-mono">{tool.name}</span>
                    </label>
                  ))
                ) : (
                  <span className="px-1 py-2 text-[10px] text-ink-500">Создай другие инструменты — их можно будет подключить сюда.</span>
                )}
              </div>
              <span className="text-[10px] text-ink-500">Код получает ctx.callTool. Подключать можно только отмеченные инструменты; циклы блокируются.</span>
            </div>
            <label className="grid min-w-0 gap-1.5">
              <span className={labelClass}>{labels.customToolBody}</span>
              <textarea
                value={codeText}
                onChange={(e) => setCodeText(e.target.value)}
                placeholder={labels.customToolBodyPlaceholder}
                spellCheck={false}
                className="ide-code-editor min-h-[280px] w-full resize-y bg-transparent px-3 py-2 font-mono text-[11.5px] leading-5 text-ink-950 placeholder-ink-500 outline-none"
                style={{ caretColor: "var(--accent)" }}
              />
            </label>
            {error && <div className="text-[11px] text-status-err">{error}</div>}
          </div>
          <div className="ide-library-footer flex shrink-0 items-center justify-between gap-2 border-t border-ink-200 px-4 py-2.5">
            <div className="flex min-w-0 items-center gap-1">
              {panelMode === "edit" && selectedId ? (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      void handleExport({
                        ids: [selectedId],
                        names: name.trim() ? [name.trim()] : undefined,
                      })
                    }
                    disabled={busyShare}
                    className={quietBtn}
                    title={labels.customToolExportOne}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{labels.customToolExportOne}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopyPack({
                        ids: [selectedId],
                        names: name.trim() ? [name.trim()] : undefined,
                      })
                    }
                    disabled={busyShare}
                    className={quietBtn}
                    title={labels.customToolCopyOne}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{labels.customToolCopyOne}</span>
                  </button>
                </>
              ) : null}
            </div>
            {panelMode === "edit" ? (
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={handleSave}
                  disabled={saving || !canSave}
                  className={primaryBtn}
                >
                  <Save className="h-3.5 w-3.5" />
                  {saving ? "Saving…" : labels.customToolSave}
                </button>
              </div>
            ) : null}
          </div>
        </section>
      </div>
      <McpModal open={mcpOpen} onClose={() => setMcpOpen(false)} />
    </div>
  );
};

export default CustomToolsWorkspace;
