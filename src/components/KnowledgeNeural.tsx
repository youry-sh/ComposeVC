import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Link2, Loader2 } from "lucide-react";
import { KnowledgeChunkSummary } from "../types";
import { NeuralScene, NeuralHoverInfo } from "./neural3d/NeuralScene";
import { buildNeuralGraph, NeuralGraph } from "./neural3d/graph";

interface Props {
  chunks: KnowledgeChunkSummary[];
  onBack: () => void;
  onOpen: (id: string) => void;
}

function clamp(value: number, min: number, max: number) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return value < lo ? lo : value > hi ? hi : value;
}

const KnowledgeNeural: React.FC<Props> = ({ chunks, onBack, onOpen }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<NeuralScene | null>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  const [showLinks, setShowLinks] = useState(true);
  const [hover, setHover] = useState<NeuralHoverInfo | null>(null);
  const [status, setStatus] = useState<"idle" | "building" | "ready" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Mount the WebGL scene exactly once; it owns its full lifecycle.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    let scene: NeuralScene | null = null;
    try {
      scene = new NeuralScene(wrap, {
        onOpen: (id) => onOpenRef.current(id),
        onHover: (info) => setHover(info),
      });
      sceneRef.current = scene;
    } catch (cause) {
      setStatus("error");
      setErrorMessage(cause instanceof Error ? cause.message : String(cause));
    }

    return () => {
      sceneRef.current = null;
      scene?.dispose();
    };
  }, []);

  // Build the graph cooperatively and hand it to the scene. A cancellation
  // token guards against a stale build landing after a newer one.
  useEffect(() => {
    const token = { cancelled: false };
    if (!chunks.length) {
      sceneRef.current?.setGraph(null);
      setStatus("idle");
      setHover(null);
      return;
    }
    setStatus("building");
    void buildNeuralGraph(chunks, () => token.cancelled).then((graph: NeuralGraph | null) => {
      if (token.cancelled) return;
      sceneRef.current?.setGraph(graph);
      setStatus(graph ? "ready" : "idle");
    });
    return () => {
      token.cancelled = true;
    };
  }, [chunks]);

  useEffect(() => {
    sceneRef.current?.setShowLinks(showLinks);
  }, [showLinks]);

  const openHovered = useCallback(() => {
    if (hover) onOpenRef.current(hover.id);
  }, [hover]);

  const card = hover
    ? {
        left: clamp(hover.x, 140, (wrapRef.current?.clientWidth ?? 0) - 140),
        top: clamp(hover.y, 150, wrapRef.current?.clientHeight ?? 0),
      }
    : null;

  return (
    <div className="knowledge-neural" ref={wrapRef} role="application" aria-label="Neural knowledge graph">
      <div className="knowledge-neural-tools">
        <button type="button" className="knowledge-neural-back" onClick={onBack}>
          <ArrowLeft className="h-3.5 w-3.5" />
          Library
        </button>
        <button
          type="button"
          className={`knowledge-neural-back ${showLinks ? "is-on" : ""}`}
          onClick={() => setShowLinks((value) => !value)}
        >
          <Link2 className="h-3.5 w-3.5" />
          Все связи
        </button>
      </div>

      <div className="knowledge-neural-hint">
        <span>ЛКМ — вращение</span>
        <span>ПКМ / колесо — зум</span>
        <span>двойной клик — сброс</span>
      </div>

      {status === "building" && (
        <div className="knowledge-neural-status">
          <Loader2 className="h-4 w-4 knowledge-neural-spin" />
          <span>Построение нейросети…</span>
        </div>
      )}

      {status === "error" && (
        <div className="knowledge-neural-status is-error">
          <span>Не удалось запустить WebGL</span>
          <small>{errorMessage}</small>
        </div>
      )}

      {status !== "building" && status !== "error" && !chunks.length && (
        <div className="knowledge-neural-status">
          <span>Пока нет знаний — добавьте чанк в библиотеке</span>
        </div>
      )}

      {hover && status !== "error" && (
        <div
          className="knowledge-neural-card"
          style={{ left: card?.left, top: card?.top }}
          onClick={openHovered}
          onPointerEnter={() => sceneRef.current?.setHoverHold(true)}
          onPointerLeave={() => sceneRef.current?.setHoverHold(false)}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              openHovered();
            }
          }}
        >
          <div className="knowledge-neural-card-title">{hover.title || "Без названия"}</div>
          {hover.tags.length > 0 && (
            <div className="knowledge-neural-card-tags">
              {hover.tags.slice(0, 6).map((tag) => (
                <span key={tag} className="knowledge-neural-card-tag">
                  {tag}
                </span>
              ))}
            </div>
          )}
          <div className="knowledge-neural-card-meta">
            <span>{hover.links.length} связей</span>
            <span className="knowledge-neural-card-open">открыть →</span>
          </div>
        </div>
      )}
    </div>
  );
};

export default KnowledgeNeural;
