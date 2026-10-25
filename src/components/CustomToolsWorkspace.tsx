import React, { useState, useEffect, useMemo } from "react";
import {
  Copy,
  Download,
  Plug,
  Puzzle,
  Search,
  Wrench,
  Save,
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
    customToolDescription: string;
    customToolDescriptionPlaceholder: string;
    customToolSaving: string;
    customToolSave: string;
    customToolDelete: string;
    customToolEnabled: string;
    customToolDisabled: string;
    customToolsSearch: string;
    customToolExport: string;
    customToolExportOne: string;
    customToolCopyOne: string;
    customToolCopied: string;
    customToolExportSaved: string;
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
      setDescription("");
      setError(null);
    }
  }, [tools, selectedId]);

  const closeSelection = () => {
    setSelectedId(null);
    setDescription("");
    setError(null);
  };

  const openTool = (tool: CustomTool) => {
    setSelectedId(tool.id);
    setDescription(tool.description || "");
    setError(null);
  };

  const selectedTool = selectedId ? tools.find((t) => t.id === selectedId) : undefined;

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

  const kindOf = (tool: CustomTool) => {
    const body = tool.body || {};
    return String((body as { kind?: string; type?: string }).kind || (body as { type?: string }).type || "folder");
  };

  return (
    <div className="ide-tools-shell flex h-full w-full flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      <div className="ide-library-header flex h-10 shrink-0 items-center justify-between gap-3 border-b border-ink-200 px-4">
        <div className="flex min-w-0 items-center gap-2.5">
          <Puzzle className="h-3.5 w-3.5 shrink-0 text-ink-600" />
          <h2 className="min-w-0 truncate text-[13px] font-medium tracking-[-0.01em] text-ink-950">
            {labels.pluginTab}
          </h2>
          <span className="tabular-nums text-[10px] text-ink-500">{tools.length}</span>
        </div>
      </div>

      {/* Status/error bar */}
      {(statusMsg || error) && (
        <div className="flex shrink-0 items-center gap-2 border-b border-ink-200 px-4 py-1.5 text-[11px]">
          {statusMsg && <span className="text-ink-600">{statusMsg}</span>}
          {error && <span className="text-status-err">{error}</span>}
        </div>
      )}

      {/* Main area: reserved IDE plugin slot on the left, custom tools panel on top */}
      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Left: IDE plugins slot (reserved — plugins will be added here later) */}
        <aside
          className="flex max-h-[30vh] w-full shrink-0 flex-col border-b border-ink-200 md:max-h-none md:w-[236px] lg:w-[268px] md:border-b-0 md:border-r"
          style={{ background: "var(--sidebar-tint)", borderColor: "var(--border)" }}
        >
          <div
            className="flex h-9 shrink-0 items-center gap-2 border-b px-3"
            style={{ borderColor: "var(--border)" }}
          >
            <Plug className="h-3.5 w-3.5 shrink-0 text-ink-500" />
            <span className="min-w-0 truncate text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
              {labels.pluginsIde}
            </span>
            <span className="ml-auto tabular-nums text-[10px] text-ink-500">0</span>
          </div>
          <div className="ide-library-list min-h-0 flex-1 overflow-y-auto px-4 py-8 text-center scrollbar-thin">
            <Puzzle className="mx-auto h-4 w-4 text-ink-400" />
            <div className="mt-2 text-[11px] text-ink-600">{labels.pluginsIdeEmpty}</div>
            <div className="mt-1 text-[10px] leading-4 text-ink-500">{labels.pluginsIdeHint}</div>
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-0">
          {/* Custom tools panel — pinned to the top of the tab */}
          <div className="flex shrink-0 flex-col border-b border-ink-200">
            <div className="flex h-9 shrink-0 items-center gap-2 px-3">
              <Wrench className="h-3.5 w-3.5 shrink-0 text-ink-600" />
              <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                {labels.customTools}
              </span>
              <span className="tabular-nums text-[10px] text-ink-500">{filteredTools.length}</span>
              <div className="relative ml-auto min-w-0 flex-1 sm:max-w-[260px]">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-ink-500" />
                <input
                  type="text"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder={labels.customToolsSearch}
                  className="ide-search-input h-7 w-full min-w-0 bg-transparent pl-7 pr-1 text-[12px] leading-7 text-ink-950 placeholder-ink-500 outline-none"
                  style={fieldStyle}
                />
              </div>
            </div>
            <div className="ide-library-list max-h-[32vh] min-h-0 overflow-y-auto px-1.5 pb-1.5 scrollbar-thin">
              {filteredTools.length === 0 ? (
                tools.length === 0 ? null : (
                  <div className="px-2 py-2 text-[11px] font-normal text-ink-500">{labels.noResults}</div>
                )
              ) : (
                filteredTools.map((tool) => {
                  const active = selectedId === tool.id;
                  const enabled = tool.enabled !== false;
                  return (
                    <div
                      key={tool.id}
                      className={`ide-library-row group flex items-center gap-2 rounded-md px-2.5 py-1.5 transition-colors ${active ? "is-active" : ""}`}
                      style={{
                        opacity: enabled ? 1 : 0.6,
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => openTool(tool)}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none"
                        title={tool.description || tool.name}
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: enabled ? "var(--ink-950)" : "var(--ink-400)" }}
                          title={enabled ? labels.customToolEnabled : labels.customToolDisabled}
                        />
                        <span className="min-w-0 shrink-0 truncate text-[12px] font-medium text-ink-950">
                          {tool.title || tool.name}
                        </span>
                        <span className="hidden min-w-0 shrink-0 truncate font-mono text-[10px] text-ink-500 sm:inline">
                          {tool.name}
                        </span>
                        <span className="hidden min-w-0 flex-1 truncate text-[10px] text-ink-500 lg:inline">
                          {tool.description || kindOf(tool)}
                        </span>
                      </button>
                      <div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
          </div>

          {selectedTool ? (
            <>
              <div className="ide-library-editor-body min-h-0 flex-1 overflow-y-auto px-5 py-4 scrollbar-thin">
                <div className="grid max-w-[560px] gap-4">
                  <label className="grid min-w-0 gap-1.5">
                    <span className={labelClass}>{labels.customToolDescription}</span>
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder={labels.customToolDescriptionPlaceholder}
                      rows={3}
                      className="ide-field w-full min-w-0 resize-y px-3 py-2 text-[12px] leading-5 text-ink-950 placeholder-ink-500 outline-none"
                      style={fieldStyle}
                    />
                  </label>
                </div>
                {error && <div className="mt-3 text-[11px] text-status-err">{error}</div>}
              </div>
              <div className="ide-library-footer flex shrink-0 items-center justify-between gap-2 border-t border-ink-200 px-4 py-2.5">
                <div className="flex min-w-0 items-center gap-1">
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
                    <span className="hidden sm:inline">{labels.customToolExportOne}</span>
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
                    <span className="hidden sm:inline">{labels.customToolCopyOne}</span>
                  </button>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={handleSave}
                    disabled={saving}
                    className={primaryBtn}
                    title={labels.customToolSave}
                  >
                    <Save className="h-3.5 w-3.5" />
                    {saving ? labels.customToolSaving : labels.customToolSave}
                  </button>
                </div>
              </div>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
};

export default CustomToolsWorkspace;
