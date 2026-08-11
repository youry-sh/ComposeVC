import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * Idle ASCII skirmish for the shell's right column — two sides march out of
 * their bases, shoot at whatever is on their row and respawn forever. Pure
 * simulation over a character grid; nothing here talks to the app.
 *
 * The grid width is measured from the container so the battlefield always runs
 * edge to edge: a fixed column count would either clip or stop halfway.
 *
 * It is background decoration, so it stops itself whenever the window is
 * hidden and never renders more than one small string per tick.
 */

const H = 13;
const MIN_COLS = 24;
const TICK_MS = 130;
const MAX_UNITS = 9;
const SPAWN_CHANCE = 0.18;
const FIRE_CHANCE = 0.22;
const MOVE_CHANCE = 0.45;
const EXPLOSION_TICKS = 3;

const GLYPH = {
  empty: " ",
  base: "█",
  left: ">",
  right: "<",
  bullet: "·",
  boom: "*",
  dust: ",",
} as const;

type Side = "l" | "r";
type Unit = { x: number; y: number; side: Side };
type Bullet = { x: number; y: number; side: Side };
type Boom = { x: number; y: number; t: number };

type World = {
  w: number;
  units: Unit[];
  bullets: Bullet[];
  booms: Boom[];
  score: { l: number; r: number };
};

function createWorld(w: number): World {
  return { w, units: [], bullets: [], booms: [], score: { l: 0, r: 0 } };
}

function occupied(world: World, x: number, y: number): boolean {
  return world.units.some((u) => u.x === x && u.y === y);
}

/** Keep the fight going across a resize instead of restarting it. */
function resizeWorld(world: World, w: number): World {
  if (w === world.w) return world;
  const inside = (x: number) => x > 0 && x < w - 1;
  return {
    ...world,
    w,
    units: world.units.filter((u) => inside(u.x)),
    bullets: world.bullets.filter((b) => inside(b.x)),
    booms: world.booms.filter((b) => b.x >= 0 && b.x < w),
  };
}

/** One simulation step, mutating `world` in place. */
function step(world: World) {
  const W = world.w;

  // ── bullets fly first, so a unit that just fired cannot outrun its shot ──
  const survivingBullets: Bullet[] = [];
  for (const bullet of world.bullets) {
    const nextX = bullet.x + (bullet.side === "l" ? 1 : -1);
    if (nextX <= 0 || nextX >= W - 1) {
      // Reached the enemy base wall — counts as a hit on it.
      world.booms.push({ x: Math.max(0, Math.min(W - 1, nextX)), y: bullet.y, t: EXPLOSION_TICKS });
      continue;
    }
    const hitIndex = world.units.findIndex(
      (u) => u.y === bullet.y && u.x === nextX && u.side !== bullet.side
    );
    if (hitIndex >= 0) {
      world.units.splice(hitIndex, 1);
      world.booms.push({ x: nextX, y: bullet.y, t: EXPLOSION_TICKS });
      world.score[bullet.side] += 1;
      continue;
    }
    survivingBullets.push({ ...bullet, x: nextX });
  }
  world.bullets = survivingBullets;

  // ── units: shoot down their row, otherwise push forward ──
  // A unit that walks into the enemy base breaches it and is spent. Without
  // that both armies used to pile up against the far wall with nobody in
  // front of them, stop firing and freeze the whole battle after one pass.
  const breached: Unit[] = [];
  for (const unit of world.units) {
    const forward = unit.side === "l" ? 1 : -1;
    const enemyAhead = world.units.some(
      (other) =>
        other.side !== unit.side &&
        other.y === unit.y &&
        (unit.side === "l" ? other.x > unit.x : other.x < unit.x)
    );
    if (enemyAhead && Math.random() < FIRE_CHANCE) {
      // Spawn on the shooter's own cell, not in front of it: bullets step
      // before units act, so a muzzle-ahead spawn jumped straight over an
      // adjacent enemy and two units nose to nose could never hit each other.
      world.bullets.push({ x: unit.x, y: unit.y, side: unit.side });
      continue;
    }
    if (Math.random() < MOVE_CHANCE) {
      const nextX = unit.x + forward;
      if (nextX <= 0 || nextX >= W - 1) {
        world.booms.push({ x: Math.max(0, Math.min(W - 1, nextX)), y: unit.y, t: EXPLOSION_TICKS });
        world.score[unit.side] += 1;
        breached.push(unit);
        continue;
      }
      if (!occupied(world, nextX, unit.y)) unit.x = nextX;
    }
  }
  if (breached.length) world.units = world.units.filter((u) => !breached.includes(u));

  // ── explosions fade ──
  world.booms = world.booms.map((b) => ({ ...b, t: b.t - 1 })).filter((b) => b.t > 0);

  // ── reinforcements ──
  for (const side of ["l", "r"] as Side[]) {
    const count = world.units.filter((u) => u.side === side).length;
    if (count >= MAX_UNITS || Math.random() > SPAWN_CHANCE) continue;
    const x = side === "l" ? 1 : W - 2;
    const y = Math.floor(Math.random() * H);
    if (!occupied(world, x, y)) world.units.push({ x, y, side });
  }
}

function render(world: World): string {
  const W = world.w;
  const grid: string[][] = Array.from({ length: H }, () => Array<string>(W).fill(GLYPH.empty));
  for (let y = 0; y < H; y += 1) {
    grid[y][0] = GLYPH.base;
    grid[y][W - 1] = GLYPH.base;
  }
  for (const bullet of world.bullets) {
    if (bullet.y >= 0 && bullet.y < H && bullet.x > 0 && bullet.x < W - 1) {
      grid[bullet.y][bullet.x] = GLYPH.bullet;
    }
  }
  for (const unit of world.units) {
    if (unit.x >= 0 && unit.x < W) grid[unit.y][unit.x] = unit.side === "l" ? GLYPH.left : GLYPH.right;
  }
  for (const boom of world.booms) {
    if (boom.x >= 0 && boom.x < W) grid[boom.y][boom.x] = boom.t > 1 ? GLYPH.boom : GLYPH.dust;
  }
  return grid.map((row) => row.join("")).join("\n");
}

const AsciiWar: React.FC = () => {
  const fieldRef = useRef<HTMLPreElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const worldRef = useRef<World>(createWorld(MIN_COLS));
  const [frame, setFrame] = useState("");
  const [score, setScore] = useState({ l: 0, r: 0 });

  // Fit the column count to the real pixel width of one character.
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
      worldRef.current = resizeWorld(worldRef.current, cols);
      setFrame(render(worldRef.current));
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(field);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let timer = 0;
    const run = () => {
      // Decoration only: never burn a tick while the window is in the background.
      if (!document.hidden) {
        step(worldRef.current);
        setFrame(render(worldRef.current));
        setScore({ ...worldRef.current.score });
      }
      timer = window.setTimeout(run, TICK_MS);
    };
    timer = window.setTimeout(run, TICK_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div className="ascii-war" aria-hidden>
      <div className="ascii-war-hud">
        <span className="ascii-war-side">
          {"> "}
          {String(score.l).padStart(3, "0")}
        </span>
        <span className="ascii-war-vs">vs</span>
        <span className="ascii-war-side">
          {String(score.r).padStart(3, "0")}
          {" <"}
        </span>
      </div>
      <pre className="ascii-war-field" ref={fieldRef}>
        {frame}
      </pre>
      <span className="ascii-war-probe" ref={probeRef} aria-hidden>
        0000000000
      </span>
    </div>
  );
};

export default AsciiWar;
