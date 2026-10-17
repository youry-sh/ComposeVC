import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * The right column listens to whatever is being typed in any chat.
 * Fresh letters fall onto one line and lift away when the draft is cleared.
 */

const H = 9;
const MIN_COLS = 16;
const TICK_MS = 70;

type Glyph = { ch: string; y: number; target: number };

type World = { w: number; glyphs: Glyph[]; blink: number };

function createWorld(w: number): World {
  return { w, glyphs: [], blink: 0 };
}

const AsciiInk: React.FC = () => {
  const fieldRef = useRef<HTMLPreElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const worldRef = useRef<World>(createWorld(MIN_COLS));
  const draftRef = useRef("");
  const [frame, setFrame] = useState("");
  const [count, setCount] = useState(0);

  const paint = () => setFrame(render(worldRef.current, draftRef.current.length > 0));

  useLayoutEffect(() => {
    const field = fieldRef.current;
    const probe = probeRef.current;
    if (!field || !probe) return;
    const fit = () => {
      const charWidth = probe.getBoundingClientRect().width / 10;
      const available = field.clientWidth;
      if (!charWidth || !available) return;
      const cols = Math.max(MIN_COLS, Math.floor(available / charWidth));
      if (cols === worldRef.current.w) return;
      worldRef.current.w = cols;
      syncGlyphs(worldRef.current, draftRef.current);
      paint();
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const onDraft = (event: Event) => {
      const text = String((event as CustomEvent<{ text?: string }>).detail?.text || "");
      draftRef.current = text;
      syncGlyphs(worldRef.current, text);
      setCount(text.length);
      paint();
    };
    window.addEventListener("composevc-draft", onDraft);
    return () => window.removeEventListener("composevc-draft", onDraft);
  }, []);

  useEffect(() => {
    let timer = 0;
    const run = () => {
      if (!document.hidden) {
        const world = worldRef.current;
        world.blink = (world.blink + 1) % 8;
        let moved = false;
        for (const glyph of world.glyphs) {
          if (glyph.y < glyph.target) {
            glyph.y += 1;
            moved = true;
          } else if (glyph.y > glyph.target) {
            glyph.y -= 1;
            moved = true;
          }
        }
        world.glyphs = world.glyphs.filter((glyph) => glyph.target >= 0 || glyph.y >= 0);
        if (moved || draftRef.current) paint();
      }
      timer = window.setTimeout(run, TICK_MS);
    };
    timer = window.setTimeout(run, TICK_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="ascii-war" aria-hidden>
      <div className="ascii-war-hud">
        <span>ink</span>
        <span className="ascii-war-vs">{String(count).padStart(3, "0")}</span>
        <span>{count ? "live" : "idle"}</span>
      </div>
      <pre className="ascii-war-field" ref={fieldRef} style={{ cursor: "default" }}>
        {frame}
      </pre>
      <span className="ascii-war-probe" ref={probeRef} aria-hidden>
        0000000000
      </span>
    </div>
  );
};

function syncGlyphs(world: World, text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  const visible = flat.slice(-Math.max(1, world.w - 2));
  const baseline = H - 2;
  if (!visible) {
    for (const glyph of world.glyphs) glyph.target = -2;
    return;
  }
  const next: Glyph[] = [];
  for (let i = 0; i < visible.length; i += 1) {
    const prev = world.glyphs[i];
    if (prev && prev.ch === visible[i] && prev.target >= 0) {
      prev.target = baseline;
      next.push(prev);
    } else {
      next.push({ ch: visible[i] === " " ? "·" : visible[i], y: 0, target: baseline });
    }
  }
  for (const leftover of world.glyphs.slice(visible.length)) {
    leftover.target = -2;
    next.push(leftover);
  }
  world.glyphs = next;
}

function render(world: World, live: boolean): string {
  const grid: string[][] = Array.from({ length: H }, () => Array<string>(world.w).fill(" "));
  const line = H - 2;
  if (line >= 0 && line < H) {
    for (let x = 0; x < world.w; x += 1) grid[line][x] = ".";
  }
  world.glyphs.forEach((glyph, index) => {
    const y = Math.max(0, Math.min(H - 1, Math.round(glyph.y)));
    const x = 1 + (index % Math.max(1, world.w - 2));
    if (grid[y][x] === " " || grid[y][x] === ".") grid[y][x] = glyph.ch;
  });
  if (live && world.blink < 4) {
    const x = Math.min(world.w - 1, 1 + world.glyphs.filter((glyph) => glyph.target >= 0).length);
    if (grid[line]) grid[line][x] = "▌";
  }
  return grid.map((row) => row.join("")).join("\n");
}

export default AsciiInk;
