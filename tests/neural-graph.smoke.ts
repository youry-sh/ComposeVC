/**
 * Smoke test for the neural graph model + brain layout.
 *
 * Runs the REAL graph.ts (no re-implementation) so regressions in link
 * resolution, undirected dedupe, brain placement or finite coordinates fail
 * here. Run with:  node tests/neural-graph.smoke.ts
 * (Node >= 23 runs .ts directly via type stripping; graph.ts uses only
 * erasable syntax.)
 */
import { buildNeuralGraph, brainLayout, BRAIN_RADIUS } from "../src/components/neural3d/graph.ts";

interface Chunk {
  id: string;
  title: string;
  tags: string[];
  links: string[];
}

function mk(id: string, title: string, tags: string[], links: string[]): Chunk {
  return {
    id,
    title,
    tags,
    links,
    file: "",
    source: "s",
    hash: "h",
    charCount: 0,
    createdAt: 0,
    updatedAt: 0,
  } as unknown as Chunk;
}

let failures = 0;
function assert(cond: boolean, message: string) {
  if (!cond) {
    failures += 1;
    console.error("FAIL:", message);
  }
}

async function main() {
  const A = mk("a", "Alpha", ["x"], ["b"]);
  const B = mk("b", "Beta", ["x"], ["a", "c"]);
  const C = mk("c", "Gamma", ["y"], ["Beta"]);
  const D = mk("d", "Delta", [], []);

  const graph = await buildNeuralGraph([A, B, C, D] as never, () => false);

  assert(graph !== null, "graph built");
  if (!graph) return;
  assert(graph.count === 4, `count=4 got ${graph.count}`);
  // A-B (reciprocal, deduped to 1) + B-C (via title "Beta") = 2.
  assert(graph.edgeCount === 2, `edgeCount=2 got ${graph.edgeCount}`);
  assert(graph.positions.length === 12, "positions length");
  for (let i = 0; i < graph.positions.length; i += 1) {
    assert(Number.isFinite(graph.positions[i]), `finite pos[${i}]`);
  }
  let maxR = 0;
  for (let i = 0; i < graph.count; i += 1) {
    maxR = Math.max(maxR, Math.hypot(graph.positions[i * 3], graph.positions[i * 3 + 1], graph.positions[i * 3 + 2]));
  }
  assert(maxR > 300 && maxR < BRAIN_RADIUS * 1.3, `brain radius plausible (${maxR.toFixed(0)})`);
  assert(graph.adjOff[4] === 4, `adjacency degree total (${graph.adjOff[4]})`);

  // Scale check: 20k-node chain builds, dedupes to N-1 edges, stays finite.
  const N = 20000;
  const big: Chunk[] = [];
  for (let i = 0; i < N; i += 1) {
    const next = i + 1 < N ? ["n" + (i + 1)] : [];
    big.push(mk("n" + i, "Node" + i, [], next));
  }
  const bg = await buildNeuralGraph(big as never, () => false);
  assert(bg !== null, "big graph built");
  if (bg) {
    assert(bg.count === N, `big count ${bg.count}`);
    assert(bg.edgeCount === N - 1, `big edges ${bg.edgeCount}`);
    for (let i = 0; i < bg.positions.length; i += 97) {
      assert(Number.isFinite(bg.positions[i]), `big pos finite @${i}`);
    }
    // Layout stays finite on the raw helper too.
    const p = new Float32Array(8 * 3);
    const s = new Float32Array(8);
    const deg = [0, 1, 2, 3, 4, 5, 6, 7];
    brainLayout(8, p, s, deg);
    for (let i = 0; i < p.length; i += 1) assert(Number.isFinite(p[i]), `layout finite @${i}`);
    assert(s.every((v) => v > 0), "sizes positive");
  }

  if (failures) {
    console.error(`${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log("SMOKE_OK");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
