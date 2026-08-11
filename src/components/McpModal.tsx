import React, { useEffect, useMemo, useState } from "react";
import { Cable, Circle, Plug, PlugZap, Plus, RefreshCw, Search, Server, Trash2, X } from "lucide-react";
import { McpServer } from "../types";

interface Props { open: boolean; onClose: () => void; }
const field = "ide-field h-8 w-full px-3 font-mono text-[11px] text-ink-950 outline-none";
const quiet = "ide-quiet-btn inline-flex h-8 items-center justify-center gap-1.5 px-3 text-[11px] theme-soft disabled:opacity-40";
const primary = "ide-primary-btn inline-flex h-8 items-center justify-center gap-1.5 px-3 text-[11px] ui-btn-primary disabled:opacity-40";
interface McpForm { name: string; title: string; description: string; type: "local" | "remote"; command: string; args: string; cwd: string; environment: string; url: string; headers: string; startup: string; request: string; enabled: boolean; }
const blank: McpForm = { name: "", title: "", description: "", type: "local", command: "", args: "[]", cwd: "", environment: "{}", url: "", headers: "{}", startup: "30000", request: "300000", enabled: true };

const McpModal: React.FC<Props> = ({ open, onClose }) => {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState(blank);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>(["$ mcp registry ready"]);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);

  const load = async () => { const list = await window.lopster?.listMcpServers?.(); setServers(list || []); };
  useEffect(() => { if (!open) return; void load(); const off = window.lopster?.onMcpChanged?.(() => void load()); return () => off?.(); }, [open]);
  const filtered = useMemo(() => servers.filter(s => !query || `${s.name} ${s.title} ${s.description || ""} ${(s.tools || []).map(t => t.name).join(" ")}`.toLowerCase().includes(query.toLowerCase())), [servers, query]);
  const append = (line: string) => setLog(prev => [...prev.slice(-7), `${new Date().toLocaleTimeString()} ${line}`]);
  const select = (s: McpServer) => { setSelected(s.id); setError(""); setForm({ name: s.name, title: s.title || "", description: s.description || "", type: s.type, command: s.command || "", args: JSON.stringify(s.args || [], null, 2), cwd: s.cwd || "", environment: JSON.stringify(s.environment || {}, null, 2), url: s.url || "", headers: JSON.stringify(s.headers || {}, null, 2), startup: String(s.timeout?.startup || 30000), request: String(s.timeout?.request || 300000), enabled: s.enabled !== false }); };
  const reset = () => { setSelected(null); setForm(blank); setError(""); };
  const parseObject = (text: string, label: string) => { try { const value = JSON.parse(text || "{}"); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error(); return value; } catch { throw new Error(`${label}: invalid JSON object`); } };
  const parseArray = (text: string) => { try { const value = JSON.parse(text || "[]"); if (!Array.isArray(value)) throw new Error(); return value.map(String); } catch { throw new Error("Arguments: invalid JSON array"); } };
  const payload = () => ({ name: form.name, title: form.title, description: form.description, type: form.type, enabled: form.enabled, command: form.command, args: parseArray(form.args), cwd: form.cwd || undefined, environment: parseObject(form.environment, "Environment"), url: form.url, headers: parseObject(form.headers, "Headers"), timeout: { startup: Number(form.startup), request: Number(form.request) } });
  const save = async () => { setBusy("save"); setError(""); try { const p = payload(); if (selected) await window.lopster?.updateMcpServer?.(selected, p); else await window.lopster?.addMcpServer?.(p); append(`saved ${p.name}`); await load(); reset(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } };
  const act = async (kind: "connect" | "disconnect" | "refresh" | "remove", s: McpServer) => { setBusy(`${kind}:${s.id}`); setError(""); try { if (kind === "connect") await window.lopster?.connectMcpServer?.(s.id); if (kind === "disconnect") await window.lopster?.disconnectMcpServer?.(s.id); if (kind === "refresh") await window.lopster?.refreshMcpServer?.(s.id); if (kind === "remove") await window.lopster?.removeMcpServer?.(s.id); append(`${kind} ${s.name}`); await load(); if (kind === "remove" && selected === s.id) reset(); } catch (e) { const msg = e instanceof Error ? e.message : String(e); setError(msg); append(`error ${msg}`); } finally { setBusy(null); } };
  const importConfig = async () => { setBusy("import"); setError(""); try { const result = await window.lopster?.importMcpConfig?.(importText, { overwrite: true }); append(`imported ${result?.imported || 0} server(s)`); setImportText(""); setShowImport(false); await load(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); } };
  if (!open) return null;

  return <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-5" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="flex h-[min(820px,94vh)] w-[min(1180px,96vw)] flex-col overflow-hidden border border-ink-300 shadow-2xl" style={{ background: "var(--bg)", boxShadow: "0 28px 90px rgba(0,0,0,.55), 0 0 0 1px var(--accent-muted)" }}>
      <header className="flex h-11 shrink-0 items-center justify-between border-b border-ink-200 px-4">
        <div className="flex items-center gap-2 font-mono"><Cable className="h-4 w-4" style={{ color: "var(--accent)" }}/><b className="text-[13px] text-ink-950">MCP CONTROL DECK</b><span className="text-[10px] text-ink-500">// MODEL CONTEXT PROTOCOL</span></div>
        <div className="flex gap-1"><button className={quiet} onClick={() => setShowImport(v => !v)}>IMPORT JSON</button><button className={quiet} onClick={onClose}><X className="h-4 w-4"/></button></div>
      </header>
      {showImport && <div className="flex shrink-0 gap-2 border-b border-ink-200 p-3"><textarea value={importText} onChange={e => setImportText(e.target.value)} placeholder={'{"mcpServers":{"filesystem":{"command":"npx","args":["-y","@modelcontextprotocol/server-filesystem","/workspace"]}}}'} className="ide-code-editor h-24 flex-1 resize-none bg-transparent p-2 font-mono text-[10px] text-ink-950 outline-none"/><button className={primary} disabled={!importText.trim() || busy === "import"} onClick={() => void importConfig()}>IMPORT</button></div>}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] shrink-0 flex-col border-r border-ink-200" style={{ background: "var(--sidebar-tint)" }}>
          <div className="flex gap-2 border-b border-ink-200 p-3"><div className="relative flex-1"><Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-ink-500"/><input className={`${field} pl-8`} placeholder="search servers / tools" value={query} onChange={e => setQuery(e.target.value)}/></div><button className={primary} onClick={reset}><Plus className="h-3.5 w-3.5"/></button></div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">{filtered.map(s => <button key={s.id} onClick={() => select(s)} className="mb-1 w-full border px-3 py-2.5 text-left transition-colors" style={{ borderColor: selected === s.id ? "var(--accent)" : "var(--border)", background: selected === s.id ? "var(--accent-muted)" : "transparent" }}>
            <div className="flex items-center gap-2"><Circle className="h-2.5 w-2.5" fill={s.status === "connected" ? "#4ade80" : s.enabled === false ? "#64748b" : "#f59e0b"} stroke="none"/><span className="flex-1 truncate font-mono text-[12px] font-semibold text-ink-950">{s.name}</span><span className="text-[9px] uppercase text-ink-500">{s.type}</span></div>
            <div className="mt-1 truncate text-[10px] text-ink-500">{s.type === "local" ? `${s.command} ${(s.args || []).join(" ")}` : s.url}</div><div className="mt-1 text-[9px] text-ink-500">{s.tools?.length || 0} TOOLS · {s.status}</div>
          </button>)}{!filtered.length && <div className="p-8 text-center font-mono text-[10px] text-ink-500">NO MCP SERVERS</div>}</div>
        </aside>
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="mb-5 flex items-center gap-2"><Server className="h-4 w-4 text-ink-600"/><span className="font-mono text-[12px] text-ink-950">{selected ? `EDIT :: ${form.name}` : "NEW SERVER"}</span></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-[10px] uppercase text-ink-500">Name<input className={field} value={form.name} onChange={e => setForm({...form,name:e.target.value})}/></label>
              <label className="grid gap-1 text-[10px] uppercase text-ink-500">Title<input className={field} value={form.title} onChange={e => setForm({...form,title:e.target.value})}/></label>
              <label className="col-span-2 grid gap-1 text-[10px] uppercase text-ink-500">Description<input className={field} value={form.description} onChange={e => setForm({...form,description:e.target.value})}/></label>
              <label className="grid gap-1 text-[10px] uppercase text-ink-500">Transport<select className={field} value={form.type} onChange={e => setForm({...form,type:e.target.value as "local"|"remote"})}><option value="local">LOCAL / STDIO</option><option value="remote">REMOTE / STREAMABLE HTTP</option></select></label>
              <label className="flex items-end gap-2 pb-1 text-[10px] uppercase text-ink-500"><input type="checkbox" checked={form.enabled} onChange={e => setForm({...form,enabled:e.target.checked})}/> Auto-connect & expose tools</label>
              {form.type === "local" ? <><label className="grid gap-1 text-[10px] uppercase text-ink-500">Command<input className={field} placeholder="npx" value={form.command} onChange={e => setForm({...form,command:e.target.value})}/></label><label className="grid gap-1 text-[10px] uppercase text-ink-500">Working directory<input className={field} value={form.cwd} onChange={e => setForm({...form,cwd:e.target.value})}/></label><label className="col-span-2 grid gap-1 text-[10px] uppercase text-ink-500">Arguments JSON<textarea className={`${field} h-20 py-2`} value={form.args} onChange={e => setForm({...form,args:e.target.value})}/></label><label className="col-span-2 grid gap-1 text-[10px] uppercase text-ink-500">Environment JSON · supports {"{env:NAME}"}<textarea className={`${field} h-20 py-2`} value={form.environment} onChange={e => setForm({...form,environment:e.target.value})}/></label></> : <><label className="col-span-2 grid gap-1 text-[10px] uppercase text-ink-500">Streamable HTTP URL<input className={field} placeholder="https://host.example/mcp" value={form.url} onChange={e => setForm({...form,url:e.target.value})}/></label><label className="col-span-2 grid gap-1 text-[10px] uppercase text-ink-500">Headers JSON · supports {"{env:NAME}"}<textarea className={`${field} h-24 py-2`} value={form.headers} onChange={e => setForm({...form,headers:e.target.value})}/></label></>}
              <label className="grid gap-1 text-[10px] uppercase text-ink-500">Startup timeout ms<input className={field} type="number" value={form.startup} onChange={e => setForm({...form,startup:e.target.value})}/></label><label className="grid gap-1 text-[10px] uppercase text-ink-500">Request timeout ms<input className={field} type="number" value={form.request} onChange={e => setForm({...form,request:e.target.value})}/></label>
            </div>{error && <div className="mt-3 border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-[10px] text-status-err">ERR :: {error}</div>}
            {selected && (() => { const s=servers.find(x=>x.id===selected); return s ? <div className="mt-5"><div className="mb-2 font-mono text-[10px] text-ink-500">DISCOVERED TOOLS [{s.tools?.length || 0}]</div><div className="grid grid-cols-2 gap-1">{(s.tools || []).map(t=><div key={t.publicName} className="border border-ink-200 px-2 py-1.5"><div className="truncate font-mono text-[10px] text-ink-950">{t.publicName}</div><div className="truncate text-[9px] text-ink-500">{t.description}</div></div>)}</div></div> : null; })()}
          </div>
          <div className="shrink-0 border-t border-ink-200 bg-black/20 p-3"><div className="mb-2 h-[76px] overflow-hidden font-mono text-[9px] leading-4 text-ink-500">{log.map((l,i)=><div key={i}><span style={{color:"var(--accent)"}}>&gt;</span> {l}</div>)}</div><div className="flex justify-between"><div className="flex gap-1">{selected && <><button className={quiet} onClick={() => void act("connect", servers.find(s=>s.id===selected)!)}><PlugZap className="h-3.5 w-3.5"/>CONNECT</button><button className={quiet} onClick={() => void act("disconnect", servers.find(s=>s.id===selected)!)}><Plug className="h-3.5 w-3.5"/>STOP</button><button className={quiet} onClick={() => void act("refresh", servers.find(s=>s.id===selected)!)}><RefreshCw className="h-3.5 w-3.5"/>REFRESH</button><button className={quiet} onClick={() => void act("remove", servers.find(s=>s.id===selected)!)}><Trash2 className="h-3.5 w-3.5"/></button></>}</div><button className={primary} disabled={!form.name.trim() || busy === "save"} onClick={() => void save()}>{busy === "save" ? "SAVING…" : selected ? "SAVE SERVER" : "ADD SERVER"}</button></div></div>
        </main>
      </div>
    </div>
  </div>;
};
export default McpModal;
