import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { KnowledgeChunkSummary } from "../types";
import {
  NeuralModel,
  NeuralView,
  buildNeuralModel,
  contentFrame,
  drawNeural,
  hitTest,
  restartFlower,
} from "./knowledgeNeuralModel";

interface Props {
  chunks: KnowledgeChunkSummary[];
  onBack: () => void;
  onOpen: (id: string) => void;
}

const KnowledgeNeural: React.FC<Props> = ({ chunks, onBack, onOpen }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef<NeuralModel | null>(null);
  const viewRef = useRef<NeuralView>({ zoom: 1, ox: 0, oy: 0 });
  const hoverRef = useRef(-1);
  const fitted = useRef(false);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const chunksRef = useRef(chunks);
  const onOpenRef = useRef(onOpen);
  const [showLinks, setShowLinks] = useState(false);
  const showLinksRef = useRef(false);
  showLinksRef.current = showLinks;
  chunksRef.current = chunks;
  onOpenRef.current = onOpen;

  useEffect(() => {
    restartFlower();
  }, []);

  useEffect(() => {
    const face = new FontFace("Caveat", "url(./fonts/Caveat.ttf)", { weight: "600" });
    face.load().then((loaded) => document.fonts.add(loaded)).catch(() => {});
  }, []);

  useEffect(() => {
    const token = { cancelled: false };
    modelRef.current = null;
    fitted.current = false;
    void buildNeuralModel(chunks, () => token.cancelled).then((model) => {
      if (token.cancelled) return;
      modelRef.current = model;
      fitted.current = false;
    });
    return () => {
      token.cancelled = true;
    };
  }, [chunks]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    let frame = 0;

    const resize = () => {
      const rect = wrap.getBoundingClientRect();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      if (!fitted.current && rect.width > 0 && rect.height > 0) {
        const frame = contentFrame(modelRef.current);
        const zoom = Math.min(1.15, Math.max(0.28, Math.min((rect.width - 72) / frame.w, (rect.height - 72) / frame.h)));
        viewRef.current = {
          zoom,
          ox: (rect.width - frame.w * zoom) / 2 - frame.x * zoom,
          oy: (rect.height - frame.h * zoom) / 2 - frame.y * zoom,
        };
        fitted.current = Boolean(modelRef.current) || chunksRef.current.length === 0;
      }
    };

    const paint = () => {
      resize();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      drawNeural(ctx, modelRef.current, viewRef.current, canvas.width, canvas.height, dpr, hoverRef.current, showLinksRef.current);
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);

    const worldPoint = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      return { x, y, wx: (x - view.ox) / view.zoom, wy: (y - view.oy) / view.zoom };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const view = viewRef.current;
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const wx = (x - view.ox) / view.zoom;
      const wy = (y - view.oy) / view.zoom;
      const next = Math.min(32, Math.max(0.35, view.zoom * Math.exp(-event.deltaY * 0.00115)));
      view.zoom = next;
      view.ox = x - wx * next;
      view.oy = y - wy * next;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const point = worldPoint(event);
      drag.current = { x: point.x, y: point.y, ox: viewRef.current.ox, oy: viewRef.current.oy };
      canvas.classList.add("is-panning");
      canvas.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const point = worldPoint(event);
      if (drag.current) {
        viewRef.current.ox = drag.current.ox + (point.x - drag.current.x);
        viewRef.current.oy = drag.current.oy + (point.y - drag.current.y);
        return;
      }
      const model = modelRef.current;
      hoverRef.current = model ? hitTest(model, point.wx, point.wy, viewRef.current.zoom) : -1;
      canvas.style.cursor = hoverRef.current >= 0 && !drag.current ? "pointer" : drag.current ? "grabbing" : "grab";
    };

    const onPointerUp = (event: PointerEvent) => {
      const point = worldPoint(event);
      const moved = drag.current ? Math.hypot(point.x - drag.current.x, point.y - drag.current.y) : 0;
      drag.current = null;
      canvas.classList.remove("is-panning");
      if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
      if (moved > 5) return;
      const model = modelRef.current;
      if (!model) return;
      const hit = hitTest(model, point.wx, point.wy, viewRef.current.zoom);
      const chunk = hit >= 0 ? chunksRef.current[hit] : null;
      if (chunk) onOpenRef.current(chunk.id);
    };

    const onDoubleClick = () => {
      fitted.current = false;
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("dblclick", onDoubleClick);
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("dblclick", onDoubleClick);
    };
  }, []);

  return (
    <div className="knowledge-neural" ref={wrapRef}>
      <canvas ref={canvasRef} />
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
          Все связи
        </button>
      </div>
    </div>
  );
};

export default KnowledgeNeural;
