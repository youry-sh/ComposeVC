import React, { useEffect, useMemo, useState } from "react";
import { Cable, Check, ChevronLeft, ChevronRight, Download, ExternalLink, Search, Trash2, X } from "lucide-react";
import { McpServer } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface RegistryCard {
  name: string;
  title: string;
  description: string;
  version: string;
  repository: string;
  transport: string;
  packageName: string;
  runtime: string;
  remoteUrl: string;
  raw: unknown;
}

interface SpecField {
  name: string;
  description?: string;
  required?: boolean;
  secret?: boolean;
}

const quiet = "ide-quiet-btn inline-flex h-7 items-center justify-center gap-1.5 px-2.5 text-[11px] theme-soft disabled:opacity-40";
const primary = "ide-primary-btn inline-flex h-7 items-center justify-center gap-1.5 px-2.5 text-[11px] ui-btn-primary disabled:opacity-40";
const field = "ide-field h-8 w-full px-3 text-[12px] text-ink-950 outline-none";
const CHIPS = ["github", "filesystem", "browser", "postgres", "slack", "notion", "memory", "search"];

const McpModal: React.FC<Props> = ({ open, onClose }) => {
  const [tab, setTab] = useState<"browse" | "installed">("browse");
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [cursors, setCursors] = useState<string[]>([""]);
  const [cards, setCards] = useState<RegistryCard[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [installed, setInstalled] = useState<McpServer[]>([]);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [secrets, setSecrets] = useState<Record<string, string>>({});

  const loadInstalled = async () => {
    const list = await window.lopster?.listMcpServers?.();
    setInstalled(list || []);
  };

  useEffect(() => {
    if (!open) return;
    void loadInstalled();
    const off = window.lopster?.onMcpChanged?.(() => void loadInstalled());
    return () => off?.();
  }, [open]);

  useEffect(() => {
    if (!open || tab !== "browse") return;
    let cancelled = false;
    const run = async () => {
      setLoading(true);
      setError("");
      try {
        const result = await window.lopster?.searchMcpRegistry?.({
          query,
          cursor: cursors[page] || "",
          limit: 18,
        });
        if (cancelled) return;
        setCards(result?.servers || []);
        setNextCursor(result?.nextCursor || null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [open, tab, query, page, cursors]);

  const installedByRegistry = useMemo(() => {
    const map = new Map<string, McpServer>();
    for (const server of installed) {
      if (server.marketplace?.name) map.set(server.marketplace.name, server);
    }
    return map;
  }, [installed]);

  const selectedCard = cards.find((card) => card.name === selectedName) || null;
  const selectedInstalled = installed.find((server) => server.id === selectedName || server.marketplace?.name === selectedName) || null;

  const submitSearch = (value: string) => {
    setQuery(value.trim());
    setPage(0);
    setCursors([""]);
    setSelectedName(null);
  };

  const install = async (card: RegistryCard) => {
    setBusy(card.name);
    setError("");
    setNotice("");
    try {
      const environment: Record<string, string> = {};
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(secrets)) {
        if (!value.trim()) continue;
        if (key.startsWith("header:")) headers[key.slice(7)] = value.trim();
        else environment[key] = value.trim();
      }
      const result = await window.lopster?.installMcpRegistry?.(card.raw, { environment, headers });
      const warnings = result?.warnings?.filter(Boolean) || [];
      setNotice(result?.updated ? `Saved the key for ${card.title}` : result?.already ? `${card.title} is already installed` : `Installed ${card.title}${warnings.length ? ` · ${warnings[0]}` : ""}`);
      await loadInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (server: McpServer) => {
    setBusy(server.id);
    setError("");
    try {
      await window.lopster?.removeMcpServer?.(server.id);
      if (selectedName === server.id) setSelectedName(null);
      await loadInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const saveSecrets = async (server: McpServer) => {
    setBusy(server.id);
    setError("");
    try {
      const environment = { ...(server.environment || {}) };
      const headers = { ...(server.headers || {}) };
      for (const [key, value] of Object.entries(secrets)) {
        const text = value.trim();
        if (!text) continue;
        if (key.startsWith("header:")) {
          const name = key.slice(7);
          headers[name] = /^authorization$/i.test(name) && !/^(bearer|basic)\s+/i.test(text) ? `Bearer ${text}` : text;
        } else {
          environment[key] = text;
        }
      }
      await window.lopster?.updateMcpServer?.(server.id, { environment, headers });
      setNotice(`Saved settings for ${server.title || server.name}`);
      await loadInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-5" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="mcp-market flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden border border-ink-300" style={{ background: "var(--bg)" }}>
        <header className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-ink-200 px-4">
          <div className="flex min-w-0 items-center gap-2">
            <Cable className="h-4 w-4 shrink-0" style={{ color: "var(--accent)" }} />
            <b className="truncate text-[13px] text-ink-950">MCP Marketplace</b>
            <span className="hidden truncate text-[10px] text-ink-500 sm:inline">Official Registry · registry.modelcontextprotocol.io</span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button type="button" className={`${quiet} ${tab === "browse" ? "text-ink-950" : ""}`} onClick={() => { setTab("browse"); setSelectedName(null); }}>Browse</button>
            <button type="button" className={`${quiet} ${tab === "installed" ? "text-ink-950" : ""}`} onClick={() => { setTab("installed"); setSelectedName(null); }}>Installed {installed.length ? installed.length : ""}</button>
            <button type="button" className={quiet} onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
          </div>
        </header>

        {tab === "browse" && (
          <div className="flex shrink-0 flex-col gap-2 border-b border-ink-200 px-4 py-3">
            <form className="flex gap-2" onSubmit={(event) => { event.preventDefault(); submitSearch(draft); }}>
              <div className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-2 h-3.5 w-3.5 text-ink-500" />
                <input className={`${field} pl-8`} value={draft} placeholder="Search servers people published" onChange={(event) => setDraft(event.target.value)} />
              </div>
              <button type="submit" className={primary}>Search</button>
            </form>
            <div className="flex gap-1 overflow-x-auto">
              {CHIPS.map((chip) => (
                <button key={chip} type="button" className={quiet} onClick={() => { setDraft(chip); submitSearch(chip); }}>{chip}</button>
              ))}
            </div>
          </div>
        )}

        {(error || notice) && (
          <div className="shrink-0 border-b border-ink-200 px-4 py-1.5 text-[11px]">
            {notice && <span className="text-ink-600">{notice}</span>}
            {error && <span className="text-status-err">{error}</span>}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 overflow-y-auto p-3">
            {tab === "browse" && loading && <div className="p-8 text-center font-mono text-[10px] text-ink-500">LOADING REGISTRY…</div>}
            {tab === "browse" && !loading && !cards.length && <div className="p-8 text-center font-mono text-[10px] text-ink-500">NO SERVERS ON THIS PAGE</div>}
            {tab === "browse" && (
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
                {cards.map((card) => {
                  const owned = installedByRegistry.get(card.name);
                  const active = selectedName === card.name;
                  return (
                    <div key={`${card.name}:${card.version}`} role="button" tabIndex={0} onClick={() => { setSelectedName(card.name); setSecrets({}); }} onKeyDown={(event) => { if (event.key === "Enter") { setSelectedName(card.name); setSecrets({}); } }} className="mcp-market-card border px-3 py-2.5 text-left" style={{ borderColor: active ? "var(--accent)" : "var(--border)", background: active ? "var(--accent-muted)" : "transparent" }}>
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12px] font-medium text-ink-950">{card.title}</div>
                          <div className="truncate font-mono text-[10px] text-ink-500">{card.name}</div>
                        </div>
                        <span className="shrink-0 font-mono text-[9px] uppercase text-ink-500">{card.transport}</span>
                      </div>
                      <p className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-ink-600">{card.description || "No description"}</p>
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <span className="truncate font-mono text-[9px] text-ink-500">{card.version || card.packageName || card.remoteUrl}</span>
                        <button
                          type="button"
                          className={owned ? `${quiet} pointer-events-none` : primary}
                          disabled={Boolean(owned) || busy === card.name}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!owned) void install(card);
                          }}
                        >
                          {owned ? <><Check className="h-3 w-3" /> Installed</> : busy === card.name ? "Installing…" : <><Download className="h-3 w-3" /> Install</>}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {tab === "installed" && !installed.length && <div className="p-8 text-center font-mono text-[10px] text-ink-500">NOTHING INSTALLED YET</div>}
            {tab === "installed" && installed.map((server) => (
              <button key={server.id} type="button" onClick={() => { setSelectedName(server.id); setSecrets({}); }} className="mb-1 flex w-full items-center gap-3 border px-3 py-2.5 text-left" style={{ borderColor: selectedName === server.id ? "var(--accent)" : "var(--border)", background: selectedName === server.id ? "var(--accent-muted)" : "transparent" }}>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-ink-950">{server.title || server.name}</div>
                  <div className="truncate font-mono text-[10px] text-ink-500">{server.marketplace?.name || server.name}</div>
                </div>
                <span className="shrink-0 font-mono text-[9px] uppercase text-ink-500">{server.type}</span>
                <span className="shrink-0 text-[10px] text-ink-500">{server.tools?.length || 0} tools</span>
              </button>
            ))}
          </div>

          <aside className="flex w-[300px] shrink-0 flex-col border-l border-ink-200" style={{ background: "var(--sidebar-tint)" }}>
            {tab === "browse" && selectedCard && (
              <Detail
                title={selectedCard.title}
                subtitle={selectedCard.name}
                description={selectedCard.description}
                meta={[selectedCard.version && `v${selectedCard.version}`, selectedCard.transport, selectedCard.runtime].filter(Boolean).join(" · ")}
                repository={selectedCard.repository}
                specs={specsFromRaw(selectedCard.raw)}
                secrets={secrets}
                onSecret={(key, value) => setSecrets((prev) => ({ ...prev, [key]: value }))}
                actionLabel={installedByRegistry.has(selectedCard.name) ? "Installed" : busy === selectedCard.name ? "Installing…" : "Install"}
                actionDisabled={installedByRegistry.has(selectedCard.name) || busy === selectedCard.name}
                onAction={() => void install(selectedCard)}
              />
            )}
            {tab === "installed" && selectedInstalled && (
              <Detail
                title={selectedInstalled.title || selectedInstalled.name}
                subtitle={selectedInstalled.marketplace?.name || selectedInstalled.name}
                description={selectedInstalled.description || ""}
                meta={[selectedInstalled.marketplace?.version, selectedInstalled.type, selectedInstalled.status].filter(Boolean).join(" · ")}
                repository={selectedInstalled.marketplace?.repository || ""}
                specs={installedSpecs(selectedInstalled)}
                secrets={secrets}
                onSecret={(key, value) => setSecrets((prev) => ({ ...prev, [key]: value }))}
                actionLabel={busy === selectedInstalled.id ? "Saving…" : "Save settings"}
                actionDisabled={busy === selectedInstalled.id}
                onAction={() => void saveSecrets(selectedInstalled)}
                secondaryLabel="Remove"
                onSecondary={() => void remove(selectedInstalled)}
              />
            )}
            {!selectedCard && tab === "browse" && <EmptyDetail text="Select a server to install it into ComposeVC." />}
            {!selectedInstalled && tab === "installed" && <EmptyDetail text="Installed servers stay off until you enable them for a project in chat Connector." />}
          </aside>
        </div>

        {tab === "browse" && (
          <footer className="flex h-11 shrink-0 items-center justify-between border-t border-ink-200 px-4">
            <span className="font-mono text-[10px] text-ink-500">PAGE {page + 1}{query ? ` · ${query}` : ""}</span>
            <div className="flex gap-1">
              <button type="button" className={quiet} disabled={page === 0 || loading} onClick={() => setPage((value) => Math.max(0, value - 1))}><ChevronLeft className="h-3.5 w-3.5" /> Prev</button>
              <button type="button" className={quiet} disabled={!nextCursor || loading} onClick={() => {
                setCursors((prev) => {
                  if (prev[page + 1]) return prev;
                  return [...prev, nextCursor || ""];
                });
                setPage((value) => value + 1);
              }}>Next <ChevronRight className="h-3.5 w-3.5" /></button>
            </div>
          </footer>
        )}
      </div>
    </div>
  );
};

function installedSpecs(server: McpServer): Array<SpecField & { key: string }> {
  const specs = [
    ...(server.envSpec || []).map((item) => ({ ...item, key: item.name })),
    ...(server.headerSpec || []).map((item) => ({ ...item, key: `header:${item.name}` })),
  ];
  if (server.type === "remote" && !specs.some((item) => item.key.toLowerCase() === "header:authorization")) {
    const saved = String(server.headers?.Authorization || server.headers?.authorization || "");
    specs.unshift({
      name: "Authorization",
      key: "header:Authorization",
      required: true,
      secret: true,
      description: saved && !/your_api_key|\{[^}]+\}/i.test(saved) ? "Saved. Paste a new key to replace it" : "Bearer API key",
    });
  }
  return specs;
}

function specsFromRaw(raw: unknown): Array<SpecField & { key: string }> {
  const server = (raw as { server?: { packages?: Array<Record<string, unknown>>; remotes?: Array<Record<string, unknown>> } })?.server
    || (raw as { packages?: Array<Record<string, unknown>>; remotes?: Array<Record<string, unknown>> })
    || {};
  const packages = Array.isArray(server.packages) ? server.packages as Array<Record<string, unknown>> : [];
  const pkg = packages.find((item) => {
    const transport = item.transport as { type?: string } | undefined;
    return !transport || transport.type === "stdio";
  }) || null;
  const remote = Array.isArray(server.remotes) ? server.remotes[0] : null;
  const env = Array.isArray(pkg?.environmentVariables) ? pkg.environmentVariables as SpecField[] : [];
  const headers = Array.isArray(remote?.headers) ? remote.headers as SpecField[] : [];
  const specs = [
    ...env.filter((item) => item?.name).map((item) => ({ ...item, key: item.name })),
    ...headers.filter((item) => item?.name).map((item) => ({ ...item, key: `header:${item.name}` })),
  ];
  const remoteOnly = Array.isArray(server.remotes) && server.remotes.length > 0;
  if (remoteOnly && !specs.some((item) => item.key.toLowerCase() === "header:authorization")) {
    specs.unshift({ name: "Authorization", key: "header:Authorization", required: true, secret: true, description: "Bearer API key" });
  }
  return specs;
}

function EmptyDetail({ text }: { text: string }) {
  return <div className="flex flex-1 items-center p-6 text-[12px] leading-5 text-ink-500">{text}</div>;
}

function Detail({
  title,
  subtitle,
  description,
  meta,
  repository,
  specs,
  secrets,
  onSecret,
  actionLabel,
  actionDisabled,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  title: string;
  subtitle: string;
  description: string;
  meta: string;
  repository: string;
  specs: Array<SpecField & { key: string }>;
  secrets: Record<string, string>;
  onSecret: (key: string, value: string) => void;
  actionLabel: string;
  actionDisabled?: boolean;
  onAction: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="text-[13px] font-medium text-ink-950">{title}</div>
        <div className="mt-0.5 truncate font-mono text-[10px] text-ink-500">{subtitle}</div>
        {meta && <div className="mt-2 font-mono text-[10px] uppercase text-ink-500">{meta}</div>}
        <p className="mt-3 text-[12px] leading-5 text-ink-700">{description || "No description published."}</p>
        {repository && (
          <button type="button" className={`${quiet} mt-3`} onClick={() => void window.lopster?.openExternal?.(repository)}>
            <ExternalLink className="h-3.5 w-3.5" /> Repository
          </button>
        )}
        {specs.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">Required to connect</div>
            {specs.map((spec) => (
              <label key={spec.key} className="grid gap-1">
                <span className="font-mono text-[10px] text-ink-600">{spec.name}{spec.required ? " *" : ""}</span>
                <input className={field} type={spec.secret ? "password" : "text"} placeholder={spec.description || spec.name} value={secrets[spec.key] || ""} onChange={(event) => onSecret(spec.key, event.target.value)} />
              </label>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 gap-1 border-t border-ink-200 p-3">
        <button type="button" className={primary} disabled={actionDisabled} onClick={onAction}>
          <Download className="h-3.5 w-3.5" /> {actionLabel}
        </button>
        {secondaryLabel && onSecondary && (
          <button type="button" className={quiet} onClick={onSecondary}><Trash2 className="h-3.5 w-3.5" /> {secondaryLabel}</button>
        )}
      </div>
    </div>
  );
}

export default McpModal;
