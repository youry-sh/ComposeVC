import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Check, CloudUpload, File, Loader2, Trash2, Upload, X } from "lucide-react";
import type { StorageAccount, StorageFile, StorageItem } from "../global";

const GB = 1024 ** 3;

const formatBytes = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
};

const statusText = (status: StorageItem["status"]) => ({
  queued: "В очереди", uploading: "Загружается", completed: "Отправлено", failed: "Ошибка",
}[status] || status);

type Props = { open: boolean; onClose: () => void };

const StorageModal: React.FC<Props> = ({ open, onClose }) => {
  const [accounts, setAccounts] = useState<StorageAccount[]>([]);
  const [phone, setPhone] = useState("");
  const [files, setFiles] = useState<StorageFile[]>([]);
  const [items, setItems] = useState<StorageItem[]>([]);
  const [caption, setCaption] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const account = useMemo(() => accounts.find((entry) => entry.phone === phone), [accounts, phone]);
  const limit = account?.isPremium ? 4 * GB : 2 * GB;

  const refresh = useCallback(async () => {
    const result = await window.lopster?.storageList?.();
    if (result?.ok) setItems(result.items || []);
  }, []);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError("");
    void Promise.all([window.lopster?.storageAccounts?.(), window.lopster?.storageList?.()]).then(([accountResult, listResult]) => {
      if (!active) return;
      const nextAccounts = accountResult?.accounts || [];
      setAccounts(nextAccounts);
      setPhone((current) => nextAccounts.some((entry) => entry.phone === current) ? current : nextAccounts[0]?.phone || "");
      if (listResult?.ok) setItems(listResult.items || []);
      if (accountResult && !accountResult.ok) setError(accountResult.error || "Не удалось получить Telegram-аккаунты");
    });
    const timer = window.setInterval(() => void refresh(), 900);
    return () => { active = false; window.clearInterval(timer); };
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [open, onClose]);

  const pick = async () => {
    const result = await window.lopster?.storagePick?.();
    if (result?.ok && result.files) setFiles(result.files);
  };

  const upload = async () => {
    if (!account || files.length === 0) return;
    const oversized = files.find((entry) => entry.size > limit);
    if (oversized) { setError(`${oversized.name}: превышен лимит ${account.isPremium ? "4" : "2"} ГБ`); return; }
    setLoading(true); setError("");
    try {
      for (const file of files) {
        const result = await window.lopster?.storageUpload?.({ phone: account.phone, filePath: file.path, caption, premium: account.isPremium });
        if (!result?.ok) throw new Error(result?.error || `Не удалось добавить ${file.name}`);
      }
      setFiles([]); setCaption(""); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };

  if (!open) return null;
  return (
    <div className="storage-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="storage-modal" role="dialog" aria-modal="true" aria-label="Telegram Storage">
        <header className="storage-head">
          <div><span className="storage-kicker">TELEGRAM / SAVED MESSAGES</span><h2><CloudUpload size={17} /> Storage</h2></div>
          <button className="storage-icon-btn" onClick={onClose} aria-label="Закрыть"><X size={16} /></button>
        </header>

        {accounts.length ? (
          <div className="storage-account-row">
            <select value={phone} onChange={(event) => setPhone(event.target.value)}>
              {accounts.map((entry) => <option key={entry.phone} value={entry.phone}>{entry.name || entry.username || entry.phone}</option>)}
            </select>
            <span className={account?.isPremium ? "storage-limit premium" : "storage-limit"}>{account?.isPremium ? "PREMIUM · 4 GB" : "STANDARD · 2 GB"}</span>
          </div>
        ) : <div className="storage-empty">Telegram-аккаунт не найден. Сначала авторизуйте его через AI-инструмент Telegram.</div>}

        <button className="storage-drop" onClick={pick} disabled={!account || loading}>
          <Upload size={19} /><strong>{files.length ? `Выбрано файлов: ${files.length}` : "Выбрать файлы"}</strong>
          <span>ZIP, фото, видео, документы и другие форматы Telegram</span>
        </button>
        {files.length > 0 && <div className="storage-picked">{files.map((file) => <div key={file.path}><File size={13} /><span>{file.name}</span><small>{formatBytes(file.size)}</small></div>)}</div>}
        <div className="storage-send-row">
          <input value={caption} onChange={(event) => setCaption(event.target.value)} placeholder="Подпись (необязательно)" />
          <button onClick={upload} disabled={!account || !files.length || loading}>{loading ? <Loader2 className="storage-spin" size={15} /> : <CloudUpload size={15} />} Отправить</button>
        </div>
        {error && <div className="storage-error">{error}</div>}

        <div className="storage-history-head"><span>ИСТОРИЯ</span><small>Ctrl+T · открыть</small></div>
        <div className="storage-history chat-mono-scroll">
          {!items.length && <div className="storage-empty">Загруженные файлы появятся здесь</div>}
          {items.map((item) => <div className="storage-item" key={item.id}>
            <div className="storage-file-icon">{item.status === "completed" ? <Check size={14} /> : item.status === "uploading" ? <Loader2 className="storage-spin" size={14} /> : <File size={14} />}</div>
            <div className="storage-item-body"><div><strong>{item.name}</strong><small>{formatBytes(item.size)}</small></div><div className="storage-progress"><i style={{ width: `${Math.round((item.progress || 0) * 100)}%` }} /></div><p className={item.status === "failed" ? "is-error" : ""}>{item.error || statusText(item.status)}{item.status === "uploading" ? ` · ${Math.round((item.progress || 0) * 100)}%` : ""}</p></div>
            <button className="storage-icon-btn" onClick={async () => { await window.lopster?.storageDeleteHistory?.(item.id); await refresh(); }} title="Удалить из истории"><Trash2 size={14} /></button>
          </div>)}
        </div>
      </section>
    </div>
  );
};

export default StorageModal;
