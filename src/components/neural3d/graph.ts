/**
 * Neural knowledge-graph model + 3D "brain" layout.
 *
 * This is the single source of truth for node/edge data consumed by the
 * WebGL scene. It intentionally reuses the link-resolution semantics of the
 * previous 2D renderer (links may be chunk ids OR titles) so the knowledge
 * store schema and public API stay untouched.
 *
 * Why not a Web Worker? The build is O(n + edges) and cooperatively yields
 * to the main thread every 32k nodes, so the UI stays responsive even at the
 * 50k budget without the transfer/cancellation machinery a worker would add.
 * The hot path (per-frame rendering) is entirely on the GPU.
 */

import { KnowledgeChunkSummary } from "../types";

export const LANES = 8;

/** Lane accent colours (sRGB) — matches the established neural palette. */
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

/** Brain shape: average world-space radius of the node cloud. */
export const BRAIN_RADIUS = 430;

const MAX_EDGES = 2_000_000;
const MAX_DEGREE = 6;

function hashText(value: string) {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function hashUnit(index: number, salt: number) {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (((h >>> 16) ^ h) >>> 0) / 4294967296;
}

function laneOf(chunk: KnowledgeChunkSummary) {
  const key = chunk.tags?.[0] || chunk.source || chunk.id;
  return hashText(key.toLowerCase()) % LANES;
}

function yieldThread() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

export interface NeuralGraph {
  count: number;
  ids: string[];
  titles: string[];
  tags: string[][];
  /** Raw link tokens per node (kept for the hover card). */
  links: string[][];
  lane: Uint8Array;
  /** n*3 world positions. */
  positions: Float32Array;
  /** n*1 world-space node radius (used for point size + picking reach). */
  sizes: Float32Array;
  /** n*3 rgb in 0..1. */
  colors: Float32Array;
  /** edgeCount*2 node indices (a, b). */
  edges: Uint32Array;
  edgeCount: number;
  /** edgeCount*2*3 per-vertex rgb (both endpoints same lane colour). */
  edgeColors: Float32Array;
  /** Undirected adjacency (for edge/strand highlight on hover). */
  adjOff: Uint32Array;
  adjTo: Uint32Array;
}

/** Deform a unit-sphere point into a recognizable brain silhouette. */
function shapeBrain(px: number, py: number, pz: number): [number, number, number] {
  let x = px * 1.16; // left-right widest
  let y = py * 1.04; // vertical
  let z = pz * 0.8; // front-back narrowest

  // Longitudinal fissure: groove at the midline separates the hemispheres,
  // deepest toward the front (z>0).
  const mid = 1 - Math.abs(px);
  const fissure = 0.15 * (0.55 + 0.45 * Math.max(0, pz));
  x += Math.sign(px || 1) * fissure * mid * mid;

  // Cerebellum: bulge tucked under the back-bottom of the skull.
  if (pz < 0 && py < 0) {
    const w = Math.min(1, Math.abs(pz) / 0.85) * Math.min(1, Math.abs(py) / 0.85);
    z -= 0.2 * w;
    y -= 0.1 * w;
  }

  // Slightly flatten the crown and base for an organic skull profile.
  y *= 1 - 0.05 * Math.pow(Math.abs(py), 3);

  return [x, y, z];
}

export function brainLayout(
  n: number,
  positions: Float32Array,
  sizes: Float32Array,
  degree: ArrayLike<number>
) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i += 1) {
    const u = n <= 1 ? 0.5 : i / (n - 1);
    const py = 1 - u * 2;
    const pr = Math.sqrt(Math.max(0, 1 - py * py));
    const theta = golden * i + 2.7;
    const [x, y, z] = shapeBrain(Math.cos(theta) * pr, py, Math.sin(theta) * pr);
    const len = Math.hypot(x, y, z) || 1;
    const jitter = 1 + (hashUnit(i, 0x1234) - 0.5) * 0.1;
    const r = BRAIN_RADIUS * jitter;
    positions[i * 3] = (x / len) * r;
    positions[i * 3 + 1] = (y / len) * r;
    positions[i * 3 + 2] = (z / len) * r;
    sizes[i] = 2.4 + Math.min(5, degree[i] || 0) * 0.5;
  }
}

export async function buildNeuralGraph(
  chunks: KnowledgeChunkSummary[],
  cancelled: () => boolean
): Promise<NeuralGraph | null> {
  const n = chunks.length;
  if (!n) return null;

  const lane = new Uint8Array(n);
  const ids = new Array<string>(n);
  const titles = new Array<string>(n);
  const tags = new Array<string[]>(n);
  const links = new Array<string[]>(n);
  const idMap = new Map<string, number>();
  const titleMap = new Map<string, number>();
  const degree = new Uint16Array(n);

  for (let i = 0; i < n; i += 1) {
    if ((i & 32767) === 0) {
      if (cancelled()) return null;
      if (i) await yieldThread();
    }
    const chunk = chunks[i];
    lane[i] = laneOf(chunk);
    ids[i] = chunk.id;
    titles[i] = chunk.title || "";
    tags[i] = chunk.tags || [];
    links[i] = chunk.links || [];
    idMap.set(chunk.id, i);
    const title = chunk.title?.trim().toLowerCase();
    if (title && !titleMap.has(title)) titleMap.set(title, i);
  }

  const cap = Math.min(MAX_EDGES, n * MAX_DEGREE);
  const rawFrom = new Uint32Array(cap);
  const rawTo = new Uint32Array(cap);
  let edgeCount = 0;

  for (let i = 0; i < n; i += 1) {
    if ((i & 16383) === 0) {
      if (cancelled()) return null;
      if (i) await yieldThread();
    }
    const lks = links[i];
    for (let k = 0; k < lks.length && degree[i] < MAX_DEGREE; k += 1) {
      const token = String(lks[k] || "").trim();
      if (!token) continue;
      const j = idMap.get(token) ?? titleMap.get(token.toLowerCase());
      if (j == null || j === i || degree[j] >= MAX_DEGREE) continue;
      if (edgeCount >= cap) break;
      rawFrom[edgeCount] = i;
      rawTo[edgeCount] = j;
      edgeCount += 1;
      degree[i] += 1;
      degree[j] += 1;
    }
    if (edgeCount >= cap) break;
  }

  const adjOff = new Uint32Array(n + 1);
  for (let e = 0; e < edgeCount; e += 1) {
    adjOff[rawFrom[e] + 1] += 1;
    adjOff[rawTo[e] + 1] += 1;
  }
  for (let i = 1; i <= n; i += 1) adjOff[i] += adjOff[i - 1];
  const adjTo = new Uint32Array(adjOff[n]);
  const cursor = adjOff.slice();
  for (let e = 0; e < edgeCount; e += 1) {
    const a = rawFrom[e];
    const b = rawTo[e];
    adjTo[cursor[a]++] = b;
    adjTo[cursor[b]++] = a;
  }

  const positions = new Float32Array(n * 3);
  const sizes = new Float32Array(n);
  brainLayout(n, positions, sizes, degree);

  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i += 1) {
    const [r, g, b] = PALETTE[lane[i] % LANES];
    colors[i * 3] = r / 255;
    colors[i * 3 + 1] = g / 255;
    colors[i * 3 + 2] = b / 255;
  }

  const edgeColors = new Float32Array(edgeCount * 2 * 3);
  for (let e = 0; e < edgeCount; e += 1) {
    const a = rawFrom[e];
    const [r, g, b] = PALETTE[lane[a] % LANES];
    edgeColors[e * 6] = r / 255;
    edgeColors[e * 6 + 1] = g / 255;
    edgeColors[e * 6 + 2] = b / 255;
    edgeColors[e * 6 + 3] = r / 255;
    edgeColors[e * 6 + 4] = g / 255;
    edgeColors[e * 6 + 5] = b / 255;
  }

  const edges = new Uint32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e += 1) {
    edges[e * 2] = rawFrom[e];
    edges[e * 2 + 1] = rawTo[e];
  }

  return {
    count: n,
    ids,
    titles,
    tags,
    links,
    lane,
    positions,
    sizes,
    colors,
    edges,
    edgeCount,
    edgeColors,
    adjOff,
    adjTo,
  };
}
