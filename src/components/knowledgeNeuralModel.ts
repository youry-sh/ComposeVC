import { KnowledgeChunkSummary } from "../types";

export const WORLD_W = 1900;
export const WORLD_H = 1900;
export const LANES = 8;

const OX = 950;
const OY = 950;
const R0 = 300;
const R1 = 900;
const A0 = -Math.PI;
const A1 = Math.PI;

export const PALETTE: Array<[number, number, number]> = [
  [126, 104, 255],
  [78, 132, 255],
  [64, 188, 206],
  [118, 196, 92],
  [214, 198, 78],
  [232, 146, 64],
  [236, 112, 86],
  [228, 228, 232],
];

export interface NeuralModel {
  n: number;
  lane: Uint8Array;
  laneCount: Uint32Array;
  cloud: Float32Array;
  tip: Float32Array;
  radius: Float32Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeCount: number;
  laneEdgeStart: Uint32Array;
  laneEdgeCount: Uint32Array;
  adjOff: Uint32Array;
  adjTo: Uint32Array;
  gridOff: Uint32Array;
  gridIdx: Uint32Array;
  cols: number;
  rows: number;
}

const COLS = 56;
const ROWS = 32;
const MAX_EDGES = 2_000_000;
const MAX_DEGREE = 6;

function mix(index: number, salt: number) {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h >>> 16) ^ h;
}

function unit(index: number, salt: number) {
  return (mix(index, salt) >>> 0) / 4294967296;
}

function hashText(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function laneOf(chunk: KnowledgeChunkSummary) {
  const key = chunk.tags?.[0] || chunk.source || chunk.id;
  return hashText(key.toLowerCase()) % LANES;
}

function cellOf(x: number, y: number) {
  const c = Math.max(0, Math.min(COLS - 1, Math.floor((x / WORLD_W) * COLS)));
  const r = Math.max(0, Math.min(ROWS - 1, Math.floor((y / WORLD_H) * ROWS)));
  return r * COLS + c;
}

function yieldThread() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

export function laneCenters(laneCount: Uint32Array) {
  const active: number[] = [];
  for (let L = 0; L < LANES; L += 1) if (laneCount[L]) active.push(L);
  const band = active.length <= 1 ? 26 : Math.min(42, 460 / active.length);
  const total = Math.max(band, active.length * band);
  const top = 470 - total / 2;
  const y = new Float32Array(LANES);
  for (let i = 0; i < active.length; i += 1) y[active[i]] = top + (i + 0.5) * (total / active.length);
  return { y, top, bottom: top + total, band, active };
}

export function contentFrame(model: NeuralModel | null) {
  let minX = OX + Math.cos(A1) * R0 - 30;
  let maxX = OX + R1 + 30;
  let minY = OY + Math.sin(A0) * R1 - 30;
  let maxY = OY + Math.sin(A1) * R1 + 30;
  if (model?.n) {
    for (let i = 0; i < model.n; i += 1) {
      const x = model.cloud[i * 2];
      const y = model.cloud[i * 2 + 1];
      const r = (model.radius[i] || 4) + 8;
      if (x - r < minX) minX = x - r;
      if (x + r > maxX) maxX = x + r;
      if (y - r < minY) minY = y - r;
      if (y + r > maxY) maxY = y + r;
    }
  }
  const spanX = Math.max(200, maxX - minX);
  const spanY = Math.max(200, maxY - minY);
  const padX = spanX * 0.06;
  const padY = spanY * 0.06;
  return { x: minX - padX, y: minY - padY, w: spanX + padX * 2, h: spanY + padY * 2 };
}

export async function buildNeuralModel(
  chunks: KnowledgeChunkSummary[],
  cancelled: () => boolean
): Promise<NeuralModel | null> {
  const n = chunks.length;
  if (!n) return null;
  const lane = new Uint8Array(n);
  const laneCount = new Uint32Array(LANES);
  const cloud = new Float32Array(n * 2);
  const tip = new Float32Array(n * 2);
  const radius = new Float32Array(n);
  const ids = new Map<string, number>();
  const titles = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    if ((i & 32767) === 0) {
      if (cancelled()) return null;
      if (i) await yieldThread();
    }
    const chunk = chunks[i];
    const L = laneOf(chunk);
    lane[i] = L;
    laneCount[L] += 1;
    ids.set(chunk.id, i);
    const title = chunk.title?.trim().toLowerCase();
    if (title && !titles.has(title)) titles.set(title, i);
    const hub = Math.min(8, chunk.links?.length || 0);
    radius[i] = hub * 0.2;
  }

  const edgeCap = Math.min(MAX_EDGES, n * MAX_DEGREE);
  const rawFrom = new Uint32Array(edgeCap);
  const rawTo = new Uint32Array(edgeCap);
  let rawCount = 0;
  const degree = new Uint16Array(n);
  for (let i = 0; i < n; i += 1) {
    if ((i & 16383) === 0) {
      if (cancelled()) return null;
      if (i) await yieldThread();
    }
    const links = chunks[i].links || [];
    for (let k = 0; k < links.length && degree[i] < MAX_DEGREE; k += 1) {
      const token = String(links[k] || "").trim();
      if (!token) continue;
      const j = ids.get(token) ?? titles.get(token.toLowerCase());
      if (j == null || j === i || degree[j] >= MAX_DEGREE) continue;
      if (rawCount >= edgeCap) break;
      rawFrom[rawCount] = i;
      rawTo[rawCount] = j;
      rawCount += 1;
      degree[i] += 1;
      degree[j] += 1;
    }
    if (rawCount >= edgeCap) break;
  }

  const laneEdgeCount = new Uint32Array(LANES);
  for (let e = 0; e < rawCount; e += 1) laneEdgeCount[lane[rawFrom[e]]] += 1;
  const laneEdgeStart = new Uint32Array(LANES);
  let edgeAcc = 0;
  for (let L = 0; L < LANES; L += 1) {
    laneEdgeStart[L] = edgeAcc;
    edgeAcc += laneEdgeCount[L];
  }
  const fill = laneEdgeStart.slice();
  const edgeFrom = new Uint32Array(rawCount);
  const edgeTo = new Uint32Array(rawCount);
  for (let e = 0; e < rawCount; e += 1) {
    const slot = fill[lane[rawFrom[e]]]++;
    edgeFrom[slot] = rawFrom[e];
    edgeTo[slot] = rawTo[e];
  }

  const adjOff = new Uint32Array(n + 1);
  for (let e = 0; e < rawCount; e += 1) {
    adjOff[edgeFrom[e] + 1] += 1;
    adjOff[edgeTo[e] + 1] += 1;
  }
  for (let i = 1; i <= n; i += 1) adjOff[i] += adjOff[i - 1];
  const adjTo = new Uint32Array(adjOff[n]);
  const adjCursor = adjOff.slice();
  for (let e = 0; e < rawCount; e += 1) {
    const a = edgeFrom[e];
    const b = edgeTo[e];
    adjTo[adjCursor[a]++] = b;
    adjTo[adjCursor[b]++] = a;
  }

  placeClusters(n, lane, laneCount, edgeFrom, edgeTo, rawCount, cloud, tip, radius);

  const cells = COLS * ROWS;
  const counts = new Uint32Array(cells);
  for (let i = 0; i < n; i += 1) counts[cellOf(cloud[i * 2], cloud[i * 2 + 1])] += 1;
  const gridOff = new Uint32Array(cells + 1);
  for (let c = 0; c < cells; c += 1) gridOff[c + 1] = gridOff[c] + counts[c];
  const gridIdx = new Uint32Array(n);
  const gridCursor = gridOff.slice();
  for (let i = 0; i < n; i += 1) {
    const cell = cellOf(cloud[i * 2], cloud[i * 2 + 1]);
    gridIdx[gridCursor[cell]++] = i;
  }

  return {
    n,
    lane,
    laneCount,
    cloud,
    tip,
    radius,
    edgeFrom,
    edgeTo,
    edgeCount: rawCount,
    laneEdgeStart,
    laneEdgeCount,
    adjOff,
    adjTo,
    gridOff,
    gridIdx,
    cols: COLS,
    rows: ROWS,
  };
}

export interface NeuralView {
  zoom: number;
  ox: number;
  oy: number;
}

function screenScale(view: NeuralView, dpr: number) {
  return Math.max(0.0001, dpr * view.zoom);
}

function hairline(view: NeuralView, dpr: number) {
  return 1.15 / screenScale(view, dpr);
}

function placeDisk(members: number[], cx: number, cy: number, gap: number, cloud: Float32Array, tip: Float32Array) {
  const golden = 2.399963;
  for (let k = 0; k < members.length; k += 1) {
    const i = members[k];
    const ang = k * golden;
    const dist = members.length === 1 ? 0 : gap * Math.sqrt(k + 0.35);
    const x = cx + Math.cos(ang) * dist;
    const y = cy + Math.sin(ang) * dist * 0.86;
    cloud[i * 2] = x;
    cloud[i * 2 + 1] = y;
    tip[i * 2] = x;
    tip[i * 2 + 1] = y;
  }
}

function placeClusters(
  n: number,
  lane: Uint8Array,
  laneCount: Uint32Array,
  edgeFrom: Uint32Array,
  edgeTo: Uint32Array,
  edgeCount: number,
  cloud: Float32Array,
  tip: Float32Array,
  radius: Float32Array
) {
  const parent = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) parent[i] = i;
  const find = (a: number) => {
    let x = a;
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  for (let e = 0; e < edgeCount; e += 1) {
    const pa = find(edgeFrom[e]);
    const pb = find(edgeTo[e]);
    if (pa !== pb) parent[pa] = pb;
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const list = groups.get(root);
    if (list) list.push(i);
    else groups.set(root, [i]);
  }
  const linked: number[][] = [];
  const loose: number[][] = Array.from({ length: LANES }, () => []);
  for (const members of groups.values()) {
    if (members.length > 1) linked.push(members);
    else loose[lane[members[0]]].push(members[0]);
  }
  linked.sort((a, b) => lane[a[0]] - lane[b[0]] || b.length - a.length);
  const packs: number[][] = [];
  for (let L = 0; L < LANES; L += 1) {
    for (const members of linked) {
      if (lane[members[0]] === L) packs.push(members);
    }
    if (loose[L].length) packs.push(loose[L]);
  }

  const span = A1 - A0;
  let cursor = A0;
  const dot = n > 20000 ? 1.05 : n > 400 ? 1.45 : 2.5;
  for (const members of packs) {
    const wedge = Math.max(0.012, span * (members.length / n));
    const spokes = Math.max(1, Math.min(members.length, Math.max(1, Math.floor(wedge / 0.01))));
    const rings = Math.max(1, Math.ceil(members.length / spokes));
    const step = (R1 - R0 - 28) / rings;
    for (let k = 0; k < members.length; k += 1) {
      const i = members[k];
      const spoke = k % spokes;
      const ring = Math.floor(k / spokes);
      const ang = cursor + ((spoke + 0.5) / spokes) * wedge;
      const rad = R0 + 16 + (ring + 0.5) * step;
      const x = OX + Math.cos(ang) * rad;
      const y = OY + Math.sin(ang) * rad;
      cloud[i * 2] = x;
      cloud[i * 2 + 1] = y;
      tip[i * 2] = x;
      tip[i * 2 + 1] = y;
      radius[i] = dot + (k % 17 === 0 ? dot * 0.8 : 0);
    }
    cursor += wedge;
  }
  void laneCount;
}

function drawFan(ctx: CanvasRenderingContext2D, lw: number) {
  ctx.lineWidth = Math.max(lw * 0.55, 0.55);
  ctx.strokeStyle = "rgba(255,255,255,0.2)";
  const rays = 140;
  for (let i = 0; i < rays; i += 1) {
    const ang = (Math.PI * 2 * i) / rays;
    ctx.beginPath();
    ctx.moveTo(OX + Math.cos(ang) * (R0 + 2), OY + Math.sin(ang) * (R0 + 2));
    ctx.lineTo(OX + Math.cos(ang) * R1, OY + Math.sin(ang) * R1);
    ctx.stroke();
  }
  const rings = 34;
  for (let i = 1; i <= rings; i += 1) {
    const rad = R0 + ((R1 - R0) * i) / rings;
    ctx.beginPath();
    ctx.arc(OX, OY, rad, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = Math.max(lw * 3.1, 2.8);
  ctx.beginPath();
  ctx.arc(OX, OY, R0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = Math.max(lw * 1.2, 1.15);
  ctx.beginPath();
  ctx.arc(OX, OY, R0 - 18, 0, Math.PI * 2);
  ctx.stroke();
}

function drawFlower(ctx: CanvasRenderingContext2D, lw: number) {
  if (!flowerAt) flowerAt = performance.now();
  const grow = Math.min(1, (performance.now() - flowerAt) / 2400);
  const ease = 1 - (1 - grow) ** 3;
  const full = R0 * 0.46;
  const s = full * Math.max(0.04, ease);
  ctx.save();
  ctx.translate(OX, OY - full * 0.16);
  ctx.strokeStyle = "rgba(244,244,244,0.94)";
  ctx.fillStyle = "rgba(244,244,244,0.95)";
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(lw * 1.25, 1.15);
  ctx.beginPath();
  ctx.moveTo(0, s * 0.08);
  ctx.quadraticCurveTo(s * 0.04, s * 0.55, 0, s * 1.05);
  ctx.stroke();
  const petals = 14;
  for (let i = 0; i < petals; i += 1) {
    const open = Math.min(1, Math.max(0, ease * 1.25 - i * 0.03));
    if (open <= 0) continue;
    const a = -Math.PI * 0.95 + (i / (petals - 1)) * Math.PI * 1.15;
    const len = s * (0.62 + (i % 3) * 0.08) * open;
    const curl = (i % 2 === 0 ? 1 : -1) * len * 0.22;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(Math.cos(a) * len * 0.45 + curl, Math.sin(a) * len * 0.45, Math.cos(a) * len, Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(1.6, s * 0.045), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

let flowerAt = 0;
export function restartFlower() {
  flowerAt = performance.now();
}

function drawStrands(
  ctx: CanvasRenderingContext2D,
  model: NeuralModel,
  lw: number,
  view: NeuralView,
  width: number,
  height: number,
  dpr: number,
  showLinks = false
) {
  drawFan(ctx, lw);
  if (showLinks && model.edgeCount) {
    ctx.strokeStyle = "rgba(244,244,244,0.55)";
    ctx.lineWidth = Math.max(lw * 0.9, 0.8);
    ctx.beginPath();
    for (let e = 0; e < model.edgeCount; e += 1) {
      const a = model.edgeFrom[e];
      const b = model.edgeTo[e];
      ctx.moveTo(model.tip[a * 2], model.tip[a * 2 + 1]);
      ctx.lineTo(model.tip[b * 2], model.tip[b * 2 + 1]);
    }
    ctx.stroke();
  }
  const zoomed = view.zoom > fitZoom(width / dpr, height / dpr) * 1.7;

  const viewLeft = -view.ox / view.zoom - 30;
  const viewTop = -view.oy / view.zoom - 30;
  const viewRight = viewLeft + width / (dpr * view.zoom) + 60;
  const viewBottom = viewTop + height / (dpr * view.zoom) + 60;
  const dotBudget = model.n <= 80 ? model.n : zoomed ? 6000 : 2800;
  let dots = 0;
  const c0 = Math.max(0, Math.floor((viewLeft / WORLD_W) * model.cols));
  const c1 = Math.min(model.cols - 1, Math.floor((viewRight / WORLD_W) * model.cols));
  const r0 = Math.max(0, Math.floor((viewTop / WORLD_H) * model.rows));
  const r1 = Math.min(model.rows - 1, Math.floor((viewBottom / WORLD_H) * model.rows));
  for (let r = r0; r <= r1 && dots < dotBudget; r += 1) {
    for (let c = c0; c <= c1 && dots < dotBudget; c += 1) {
      const cell = r * model.cols + c;
      const start = model.gridOff[cell];
      const end = model.gridOff[cell + 1];
      const span = end - start;
      if (!span) continue;
      const stride = model.n <= 80 ? 1 : Math.max(1, Math.ceil(span / 40));
      for (let p = start; p < end && dots < dotBudget; p += stride) {
        const i = model.gridIdx[p];
        ctx.fillStyle = "rgba(244,244,244,0.94)";
        ctx.beginPath();
        ctx.arc(model.cloud[i * 2], model.cloud[i * 2 + 1], model.radius[i], 0, Math.PI * 2);
        ctx.fill();
        dots += 1;
      }
    }
  }
}

function rgba(lane: number, alpha: number) {
  const [r, g, b] = PALETTE[lane % PALETTE.length];
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawCurve(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  bend: number
) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2 + bend;
  ctx.moveTo(x0, y0);
  ctx.quadraticCurveTo(mx, my, x1, y1);
}

export function drawNeural(
  ctx: CanvasRenderingContext2D,
  model: NeuralModel | null,
  view: NeuralView,
  width: number,
  height: number,
  dpr: number,
  hover: number,
  showLinks = false
) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = "#070707";
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(dpr * view.zoom, 0, 0, dpr * view.zoom, view.ox * dpr, view.oy * dpr);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const lw = hairline(view, dpr);
  ctx.lineWidth = lw;

  if (!model || !model.n) {
    drawFan(ctx, lw);
    drawFlower(ctx, lw);
    return;
  }

  drawStrands(ctx, model, lw, view, width, height, dpr, showLinks);
  if (!showLinks) drawFlower(ctx, lw);

  if (hover >= 0 && hover < model.n) {
    const start = model.adjOff[hover];
    const end = model.adjOff[hover + 1];
    ctx.strokeStyle = "rgba(244,244,244,0.95)";
    ctx.lineWidth = lw * 1.8;
    ctx.beginPath();
    const hx = model.tip[hover * 2];
    const hy = model.tip[hover * 2 + 1];
    for (let p = start; p < end; p += 1) {
      const j = model.adjTo[p];
      ctx.moveTo(hx, hy);
      ctx.lineTo(model.tip[j * 2], model.tip[j * 2 + 1]);
    }
    ctx.stroke();
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(model.cloud[hover * 2], model.cloud[hover * 2 + 1], model.radius[hover] + lw, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function fitZoom(width: number, height: number) {
  const pad = 28;
  return Math.max(0.2, Math.min((width - pad) / WORLD_W, (height - pad) / WORLD_H));
}

export function hitTest(model: NeuralModel, wx: number, wy: number, zoom: number) {
  const reach = 14 / Math.max(zoom, 0.2);
  const reach2 = reach * reach;
  let best = -1;
  let bestD = reach2;
  const c0 = Math.max(0, Math.floor((wx / WORLD_W) * model.cols) - 1);
  const c1 = Math.min(model.cols - 1, Math.floor((wx / WORLD_W) * model.cols) + 1);
  const r0 = Math.max(0, Math.floor((wy / WORLD_H) * model.rows) - 1);
  const r1 = Math.min(model.rows - 1, Math.floor((wy / WORLD_H) * model.rows) + 1);
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      const cell = r * model.cols + c;
      const start = model.gridOff[cell];
      const end = model.gridOff[cell + 1];
      const stride = Math.max(1, Math.floor((end - start) / 80));
      for (let p = start; p < end; p += stride) {
        const i = model.gridIdx[p];
        const dx = model.cloud[i * 2] - wx;
        const dy = model.cloud[i * 2 + 1] - wy;
        const d = dx * dx + dy * dy;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
  }
  const tipReach2 = (10 / Math.max(zoom, 0.2)) ** 2;
  const stride = Math.max(1, Math.floor(model.n / 2500));
  for (let i = 0; i < model.n; i += stride) {
    const dx = model.tip[i * 2] - wx;
    const dy = model.tip[i * 2 + 1] - wy;
    const d = dx * dx + dy * dy;
    if (d < tipReach2 && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}
