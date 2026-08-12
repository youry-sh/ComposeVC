import React, { useCallback, useEffect, useState } from "react";
import { Check, Play, Plus, Trash2, X, Youtube } from "lucide-react";
import ChatMonoScroll from "./ChatMonoScroll";
import type { YoutubeVideo } from "../global";

const YoutubeWorkspace: React.FC = () => {
  const [videos, setVideos] = useState<YoutubeVideo[]>([]);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState<YoutubeVideo | null>(null);
  const refresh = useCallback(async () => { const res = await window.lopster?.youtubeList?.(); if (res?.ok) setVideos(res.videos || []); }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const add = async () => {
    if (!url.trim()) return; setError("");
    const res = await window.lopster?.youtubeAdd?.({ url: url.trim(), title: title.trim() });
    if (!res?.ok) { setError(res?.error || "Не удалось добавить видео"); return; }
    setUrl(""); setTitle(""); void refresh();
  };
  const watched = async (video: YoutubeVideo) => { await window.lopster?.youtubeUpdate?.(video.id, { watched: !video.watched }); void refresh(); };
  const remove = async (video: YoutubeVideo) => { await window.lopster?.youtubeDelete?.(video.id); if (playing?.id === video.id) setPlaying(null); void refresh(); };
  return (
    <div className="youtube-shell">
      <header className="youtube-head">
        <div><Youtube /><span><strong>YOUTUBE</strong><small>видео и трансляции</small></span></div>
        <div className="youtube-add">
          <input value={url} onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="Вставьте ссылку YouTube…" />
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void add(); }} placeholder="Название (необязательно)" />
          <button onClick={() => void add()}><Plus /> ДОБАВИТЬ</button>
        </div>
      </header>
      {error && <div className="youtube-error">{error}</div>}
      <ChatMonoScroll className="youtube-scroll">
        {!videos.length ? <div className="youtube-empty"><Youtube /><strong>Видео пока нет</strong><span>Добавьте обычное видео, Shorts или прямую трансляцию.</span></div> : <div className="youtube-grid">
          {videos.map((video) => <article key={video.id} className={`youtube-card${video.watched ? " is-watched" : ""}`}>
            <button className="youtube-thumb" onClick={() => setPlaying(video)}>
              <img src={`https://i.ytimg.com/vi/${video.videoId}/hqdefault.jpg`} alt="" loading="lazy" />
              <span><Play /></span>{video.watched && <i><Check /> ПРОСМОТРЕНО</i>}
            </button>
            <div className="youtube-card-copy"><strong title={video.title}>{video.title}</strong><span>{video.videoId}</span></div>
            <footer><button onClick={() => setPlaying(video)}><Play /> СМОТРЕТЬ</button><button className={video.watched ? "is-active" : ""} onClick={() => void watched(video)}><Check /> {video.watched ? "ПРОСМОТРЕНО" : "ОТМЕТИТЬ"}</button><button onClick={() => void remove(video)} title="Удалить"><Trash2 /></button></footer>
          </article>)}
        </div>}
      </ChatMonoScroll>
      {playing && <div className="youtube-player-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) setPlaying(null); }}><div className="youtube-player"><header><div><Youtube /><span>{playing.title}</span></div><button onClick={() => setPlaying(null)}><X /></button></header>{React.createElement("webview", { className: "youtube-webview", src: `${playing.url}&autoplay=1`, partition: "persist:composevc-youtube", webpreferences: "contextIsolation=yes,sandbox=yes", title: playing.title })}</div></div>}
    </div>
  );
};
export default YoutubeWorkspace;
