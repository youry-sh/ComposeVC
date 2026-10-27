import React, { useState, useEffect, useMemo } from "react";
import {
  Copy,
  Download,
  FolderOpen,
  Link2,
  Power,
  Save,
  Search,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { CustomTool } from "../types";

interface CustomToolsWorkspaceProps {
  tools: CustomTool[];
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
    pluginTab: string;
    pluginsIde: string;
    pluginsIdeEmpty: string;
    pluginsIdeHint: string;
    customTools: string;
    customToolsHint: string;
    customToolsEmpty: string;
    customToolDescription: string;
    customToolDescriptionPlaceholder: string;
    customToolSaving: string;
    customToolSave: string;
    customToolDelete: string;
    customToolEnabled: string;
    customToolDisabled: string;
    customToolsSearch: string;
    customToolExport: string;
    customToolExportAll: string;
    customToolExportOne: string;
    customToolCopyOne: string;
    customToolCopyPack: string;
    customToolCopied: string;
    customToolExportSaved: string;
    customToolRuntime: string;
    customToolTags: string;
    customToolDependencies: string;
    customToolDependenciesEmpty: string;
    customToolImportCancel: string;
    noResults: string;
  };
}

const quietBtn =
  "ide-quiet-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 theme-soft";
const primaryBtn =
  "ide-primary-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ui-btn-primary";
const fieldStyle: React.CSSProperties = {
  caretColor: "var(--accent)",
};
const labelClass = "ide-field-label text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500";

const DEFAULT_ENTRY: Record<string, string> = {
  node: "main.js",
  python: "main.py",
  powershell: "main.ps1",
  bash: "main.sh",
};

const bodyText = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

const runtimeOf = (tool: CustomTool): string => {
  const body = tool.body || {};
  const explicit = bodyText(body.runtime).toLowerCase();
  if (explicit) return explicit;
  const entry = bodyText(body.entry).toLowerCase();
  if (entry.endsWith(".py")) return "python";
  if (entry.endsWith(".ps1")) return "powershell";
  if (entry.endsWith(".sh")) return "bash";
  return "node";
};

const entryOf = (tool: CustomTool): string => {
  const entry = bodyText((tool.body || {}).entry);
  return entry || DEFAULT_ENTRY[runtimeOf(tool)] || "main.js";
};

const timeoutOf = (tool: CustomTool): number | null => {
  const value = Number((tool.body || {}).timeout_ms);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
};

const toolDirOf = (tool: CustomTool): string => bodyText((tool.body || {}).toolDir);

const formatStamp = (value?: number): string => {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
};

const CustomToolsWorkspace: React.FC<CustomToolsWorkspaceProps> = ({
  tools,
  onUpdate,
  onRemove,
  labels,
}) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyShare, setBusyShare] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const enabledCount = useMemo(
    () => tools.filter((tool) => tool.enabled !== false).length,
    [tools]
  );

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
    if (selectedId && tools.some((t) => t.id === selectedId)) return;
    const next = tools[0];
    if (!next) {
      setSelectedId(null);
      setDescription("");
      setConfirmDeleteId(null);
      setError(null);
      return;
    }
    setSelectedId(next.id);
    setDescription(next.description || "");
  }, [tools, selectedId]);

  const closeSelection = () => {
    setSelectedId(null);
    setDescription("");
    setConfirmDeleteId(null);
    setError(null);
  };

  const openTool = (tool: CustomTool) => {
    setSelectedId(tool.id);
    setDescription(tool.description || "");
    setConfirmDeleteId(null);
    setError(null);
  };

  const selectedTool = selectedId ? tools.find((t) => t.id === selectedId) : undefined;
  const selectedEnabled = selectedTool ? selectedTool.enabled !== false : false;
  const dirty = !!selectedTool && description !== (selectedTool.description || "");

  const handleSave = async () => {
    if (!selectedTool) return;
    setSaving(true);
    setError(null);
    setStatusMsg(null);
    try {
      // Catalog-only edit: entry code, runtime, title, tags and connections stay
      // untouched on disk (the agent owns the tool folder).
      await onUpdate(selectedTool.id, {
        name: selectedTool.name,
        description: description.trim() || undefined,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save custom tool");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (toolId: string) => {
    setConfirmDeleteId(null);
    try {
      await onRemove(toolId);
      if (selectedId === toolId) closeSelection();
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

  return (
    <div className="ide-tools-shell flex h-full w-full flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      <div className="ide-library-header flex min-h-11 shrink-0 flex-wrap items-center gap-3 border-b border-ink-200 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Wrench className="h-3.5 w-3.5 shrink-0 text-ink-600" />
          <h2 className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-ink-950">
            {labels.customTools}
          </h2>
          <span
            className="shrink-0 rounded border px-1.5 py-[1px] text-[10px] tabular-nums text-ink-500"
            style={{ borderColor: "var(--border)" }}
          >
            {tools.length}
          </span>
          <span
            className="hidden shrink-0 items-center gap-1.5 text-[10px] text-ink-500 sm:flex"
            title={labels.customToolEnabled}
          >
            <span className="h-1 w-1 rounded-full" style={{ background: "var(--ok)" }} />
            {enabledCount}/{tools.length}
          </span>
        </div>
        <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-1.5">
          <div className="relative min-w-0 flex-1 sm:max-w-[280px]">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={labels.customToolsSearch}
              aria-label={labels.customToolsSearch}
              className="ide-search-input h-7 w-full min-w-0 bg-transparent pl-7 pr-7 text-[12px] leading-7 text-ink-950 placeholder-ink-500 outline-none"
              style={fieldStyle}
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear"
                title="Clear"
                className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-ink-500 outline-none transition-colors hover:text-ink-950"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
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
            <span className="hidden md:inline">{labels.customToolCopyPack}</span>
          </button>
        </div>
      </div>

      {/* Status/error bar */}
      {(statusMsg || error) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-200 px-4 py-1.5 text-[11px]">
          {statusMsg && <span className="min-w-0 truncate text-ink-600">{statusMsg}</span>}
          {error && <span className="min-w-0 truncate text-status-err">{error}</span>}
          <button
            type="button"
            onClick={() => {
              setStatusMsg(null);
              setError(null);
            }}
            className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center text-ink-500 outline-none transition-colors hover:text-ink-950"
            title={labels.customToolImportCancel}
            aria-label={labels.customToolImportCancel}
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <aside
          className="flex w-[268px] shrink-0 flex-col border-r border-ink-200 lg:w-[320px]"
          style={{ background: "var(--sidebar-tint)", borderColor: "var(--border)" }}
        >
          <div
            className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
            style={{ borderColor: "var(--border)" }}
          >
            <Terminal className="h-3.5 w-3.5 shrink-0 text-ink-500" />
            <span className="min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
              {labels.customTools}
            </span>
            <span className="ml-auto shrink-0 tabular-nums text-[10px] text-ink-500">
              {filteredTools.length}
              {search ? ` / ${tools.length}` : ""}
            </span>
          </div>
          <div className="ide-library-list min-h-0 flex-1 overflow-y-auto p-1.5 scrollbar-thin">
            {filteredTools.length === 0 ? (
              <div className="flex flex-col items-center justify-center px-4 py-10 text-center">
                <FolderOpen className="h-4 w-4 text-ink-400" />
                {search ? (
                  <div className="mt-2 text-[11px] text-ink-600">{labels.noResults}</div>
                ) : null}
              </div>
            ) : (
              filteredTools.map((tool) => {
                const active = selectedId === tool.id;
                const enabled = tool.enabled !== false;
                return (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => openTool(tool)}
                    className={`ide-library-row group flex w-full min-w-0 items-start gap-2.5 px-2.5 py-2 text-left outline-none transition-colors ${active ? "is-active" : ""}`}
                    style={{ opacity: enabled ? 1 : 0.62 }}
                    title={tool.description || tool.name}
                  >
                    <span
                      className="mt-[3px] flex h-6 w-6 shrink-0 items-center justify-center rounded-[2px] border"
                      style={{
                        borderColor: "var(--border)",
                        background: active ? "var(--bg)" : "var(--input-bg)",
                      }}
                    >
                      <Terminal className="h-3.5 w-3.5 text-ink-600" />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="min-w-0 truncate text-[12px] font-medium text-ink-950">
                          {tool.title || tool.name}
                        </span>
                        {enabled ? null : (
                          <span className="shrink-0 text-[9px] uppercase tracking-[0.08em] text-ink-500">
                            {labels.customToolDisabled}
                          </span>
                        )}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[10px] text-ink-500">{tool.name}</span>
                      {tool.description ? (
                        <span className="mt-0.5 min-w-0 truncate text-[10px] leading-4 text-ink-500">
                          {tool.description}
                        </span>
                      ) : null}
                    </span>
                    <span
                      className="mt-[3px] shrink-0 rounded-[2px] border px-1.5 py-[1px] font-mono text-[9px] uppercase tracking-[0.04em] text-ink-500"
                      style={{ borderColor: "var(--border)" }}
                    >
                      {runtimeOf(tool)}
                    </span>
                  </button>
                );
              })
            )}
          </div>
          <div
            className="flex h-8 shrink-0 items-center justify-between gap-2 border-t px-3 text-[10px] text-ink-500"
            style={{ borderColor: "var(--border)" }}
          >
            <span className="min-w-0 truncate font-mono">userData/custom-tools</span>
            <span className="shrink-0 tabular-nums" title={labels.customToolEnabled}>
              {enabledCount}/{tools.length}
            </span>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col" style={{ background: "var(--bg)" }}>
          {selectedTool ? (
            <>
              <div
                className="flex shrink-0 flex-wrap items-start gap-3 border-b px-5 py-4 lg:px-7"
                style={{ borderColor: "var(--border)", background: "var(--panel-header-bg)" }}
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <h3 className="min-w-0 truncate text-[14px] font-semibold tracking-[-0.01em] text-ink-950">
                      {selectedTool.title || selectedTool.name}
                    </h3>
                    <span
                      className="inline-flex shrink-0 items-center gap-1 rounded-[2px] border px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-[0.08em]"
                      style={{
                        borderColor: "var(--border)",
                        color: selectedEnabled ? "var(--ink-700)" : "var(--ink-500)",
                      }}
                    >
                      <span
                        className="h-1 w-1 rounded-full"
                        style={{ background: selectedEnabled ? "var(--ok)" : "var(--ink-400)" }}
                      />
                      {selectedEnabled ? labels.customToolEnabled : labels.customToolDisabled}
                    </span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-ink-500">
                    <span className="min-w-0 truncate font-mono">{selectedTool.name}</span>
                    <span aria-hidden>·</span>
                    <span className="whitespace-nowrap">
                      {labels.customToolRuntime}{" "}
                      <span className="font-mono lowercase text-ink-600">{runtimeOf(selectedTool)}</span>
                    </span>
                    <span aria-hidden>·</span>
                    <span className="min-w-0 truncate font-mono">{entryOf(selectedTool)}</span>
                    {selectedTool.updatedAt ? (
                      <>
                        <span aria-hidden>·</span>
                        <span className="whitespace-nowrap">{formatStamp(selectedTool.updatedAt)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => void handleToggle(selectedTool)}
                    className={quietBtn}
                    title={selectedEnabled ? labels.customToolDisabled : labels.customToolEnabled}
                  >
                    <Power className="h-3.5 w-3.5" />
                    <span className="hidden xl:inline">
                      {selectedEnabled ? labels.customToolDisabled : labels.customToolEnabled}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleExport({
                        ids: [selectedTool.id],
                        names: [selectedTool.name],
                      })
                    }
                    disabled={busyShare}
                    className={quietBtn}
                    title={labels.customToolExportOne}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span className="hidden xl:inline">{labels.customToolExportOne}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void handleCopyPack({
                        ids: [selectedTool.id],
                        names: [selectedTool.name],
                      })
                    }
                    disabled={busyShare}
                    className={quietBtn}
                    title={labels.customToolCopyOne}
                  >
                    <Copy className="h-3.5 w-3.5" />
                    <span className="hidden xl:inline">{labels.customToolCopyOne}</span>
                  </button>
                  {confirmDeleteId === selectedTool.id ? (
                    <span className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => void handleDelete(selectedTool.id)}
                        className="ui-btn-danger h-7 px-2 text-[10px]"
                      >
                        {labels.customToolDelete}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className={quietBtn}
                        title={labels.customToolImportCancel}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(selectedTool.id)}
                      className={quietBtn}
                      title={labels.customToolDelete}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving || !dirty}
                    className={primaryBtn}
                    title={labels.customToolSave}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? labels.customToolSaving : labels.customToolSave}
                  </button>
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 lg:px-7 scrollbar-thin">
                <div className="mx-auto grid w-full max-w-[1120px] gap-6 xl:grid-cols-[minmax(0,1fr)_288px]">
                  <div className="flex min-w-0 flex-col gap-5">
                    <label className="grid min-w-0 gap-1.5">
                      <span className={labelClass}>{labels.customToolDescription}</span>
                      <textarea
                        value={description}
                        onChange={(e) => setDescription(e.target.value)}
                        placeholder={labels.customToolDescriptionPlaceholder}
                        rows={4}
                        className="ide-field w-full min-w-0 resize-y px-3 py-2 text-[12px] leading-5 text-ink-950 placeholder-ink-500 outline-none"
                        style={fieldStyle}
                      />
                    </label>

                    <div className="grid min-w-0 gap-1.5">
                      <span className={labelClass}>{labels.customToolTags}</span>
                      <div className="flex min-h-[26px] min-w-0 flex-wrap items-center gap-1.5">
                        {(selectedTool.tags || []).length ? (
                          (selectedTool.tags || []).map((tag, index) => (
                            <span
                              key={`${tag}-${index}`}
                              className="rounded-[2px] border px-1.5 py-[1px] font-mono text-[10px] text-ink-600"
                              style={{ borderColor: "var(--border)", background: "var(--input-bg)" }}
                            >
                              {tag}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] text-ink-500">—</span>
                        )}
                      </div>
                    </div>

                    <div className="grid min-w-0 gap-1.5">
                      <span className={labelClass}>{labels.customToolDependencies}</span>
                      <div className="flex min-h-[26px] min-w-0 flex-wrap items-center gap-1.5">
                        {(selectedTool.dependencies || []).length ? (
                          (selectedTool.dependencies || []).map((dependency, index) => (
                            <span
                              key={`${dependency}-${index}`}
                              className="inline-flex items-center gap-1 rounded-[2px] border px-1.5 py-[1px] font-mono text-[10px] text-ink-600"
                              style={{ borderColor: "var(--border)", background: "var(--input-bg)" }}
                            >
                              <Link2 className="h-3 w-3 shrink-0 text-ink-500" />
                              {dependency}
                            </span>
                          ))
                        ) : (
                          <span className="text-[11px] leading-4 text-ink-500">
                            {labels.customToolDependenciesEmpty}
                          </span>
                        )}
                      </div>
                    </div>

                    <div className="grid min-w-0 gap-1.5">
                      <span className="min-w-0 truncate font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                        inputSchema
                      </span>
                      <pre className="ide-code-editor max-h-[240px] min-w-0 overflow-auto px-3 py-2 font-mono text-[10.5px] leading-4 text-ink-700 scrollbar-thin">
                        {JSON.stringify(
                          selectedTool.inputSchema || { type: "object", properties: {} },
                          null,
                          2
                        )}
                      </pre>
                    </div>
                  </div>

                  <aside className="flex min-w-0 flex-col gap-3">
                    <div
                      className="overflow-hidden rounded-[2px] border"
                      style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                    >
                      <div
                        className="border-b px-3 py-2 font-mono text-[10px] uppercase tracking-[0.1em] text-ink-500"
                        style={{ borderColor: "var(--border)" }}
                      >
                        tool.json
                      </div>
                      <div className="grid grid-cols-[74px_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-2.5">
                        <span className="font-mono text-[10px] text-ink-500">runtime</span>
                        <span className="min-w-0 break-all font-mono text-[11px] text-ink-950">
                          {runtimeOf(selectedTool)}
                        </span>
                        <span className="font-mono text-[10px] text-ink-500">entry</span>
                        <span className="min-w-0 break-all font-mono text-[11px] text-ink-950">
                          {entryOf(selectedTool)}
                        </span>
                        <span className="font-mono text-[10px] text-ink-500">timeout_ms</span>
                        <span className="min-w-0 break-all font-mono text-[11px] text-ink-950">
                          {timeoutOf(selectedTool) ? `${timeoutOf(selectedTool)} ms` : "—"}
                        </span>
                        <span className="font-mono text-[10px] text-ink-500">updatedAt</span>
                        <span className="min-w-0 break-all font-mono text-[11px] text-ink-950">
                          {formatStamp(selectedTool.updatedAt) || "—"}
                        </span>
                        <span className="font-mono text-[10px] text-ink-500">toolDir</span>
                        <span className="min-w-0 break-all font-mono text-[10px] leading-4 text-ink-600">
                          {toolDirOf(selectedTool) || "—"}
                        </span>
                      </div>
                    </div>
                  </aside>
                </div>
              </div>
            </>
          ) : (
            <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 py-10 scrollbar-thin">
              <div className="w-full max-w-[620px]">
                <div className="flex items-start gap-3">
                  <span
                    className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[2px] border"
                    style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                  >
                    <Wrench className="h-4 w-4 text-ink-500" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="text-[14px] font-medium text-ink-950">{labels.customTools}</h3>
                    <p className="mt-1 text-[11px] leading-5 text-ink-500">{labels.customToolsEmpty}</p>
                  </div>
                </div>
                <div
                  className="mt-5 overflow-hidden rounded-[2px] border"
                  style={{ borderColor: "var(--border)", background: "var(--surface)" }}
                >
                  <div
                    className="flex flex-wrap items-center gap-2 border-b px-3 py-2 font-mono text-[10px] text-ink-500"
                    style={{ borderColor: "var(--border)" }}
                  >
                    <span>userData/custom-tools/&lt;name&gt;/</span>
                    <span aria-hidden>·</span>
                    <span>stdin JSON → stdout JSON</span>
                  </div>
                  <p className="px-3 py-3 text-[11px] leading-5 text-ink-600">{labels.customToolsHint}</p>
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default CustomToolsWorkspace;
