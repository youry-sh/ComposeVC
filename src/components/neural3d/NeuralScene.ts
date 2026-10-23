/**
 * WebGL scene for the Knowledge "Neural" view.
 *
 * Owns the full Three.js lifecycle (renderer, camera, lights, controls,
 * setpiece, GPU layers, picking, disposal). React only feeds it a graph and
 * receives hover/open callbacks — no per-frame React work, so hover and
 * animation never re-render the tree.
 *
 * Scale strategy for the ~50k budget:
 *  - strands and node-to-node edges are single batched LineSegments draws,
 *  - nodes are a single additive Points draw,
 *  - all per-frame motion (flow pulse, twinkle, orbit-follow) runs in shaders,
 *  - highlight layers rebuild only on hover change (O(degree), not O(n)).
 */

import * as THREE from "three";
import { NeuralGraph, BRAIN_RADIUS } from "./graph";
import { STRAND_VERTEX, STRAND_FRAGMENT, HIGHLIGHT_STRAND_FRAGMENT, NODE_VERTEX, NODE_FRAGMENT } from "./shaders";
import { buildMagicCircleTexture } from "./magicRing";
import { readThemeColors } from "./theme";

export interface NeuralHoverInfo {
  id: string;
  title: string;
  tags: string[];
  links: string[];
  x: number;
  y: number;
}

export interface NeuralSceneOptions {
  onOpen: (id: string) => void;
  onHover: (info: NeuralHoverInfo | null) => void;
}

const CUBE_EDGE = 108;
const SPHERE_ORBIT = 150;
const SPHERE_RADIUS = 26;
const RING_OUTER = 92;
const RING_INNER = 40;

/** Fewer strand segments at large node counts keeps geometry build + upload light. */
function strandSegments(count: number) {
  return count > 10000 ? 4 : 8;
}

const FOV = 55;
const CAMERA_NEAR = 1;
const CAMERA_FAR = 12000;
const ZOOM_MIN = 120;
const ZOOM_MAX = 5400;

function hashUnit(index: number, salt: number) {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (((h >>> 16) ^ h) >>> 0) / 4294967296;
}

function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (mesh.geometry) mesh.geometry.dispose();
    const material = (mesh as THREE.Mesh).material;
    if (Array.isArray(material)) material.forEach((m) => m.dispose());
    else if (material) material.dispose();
    const points = obj as THREE.Points;
    if (points.geometry) points.geometry.dispose();
    const line = obj as THREE.LineSegments;
    if (line.geometry) line.geometry.dispose();
    const lineMat = (line as THREE.LineSegments).material;
    if (Array.isArray(lineMat)) lineMat.forEach((m) => m.dispose());
    else if (lineMat) lineMat.dispose();
  });
}

export class NeuralScene {
  private container: HTMLElement;
  private options: NeuralSceneOptions;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;

  private graph: NeuralGraph | null = null;

  // Setpiece
  private cube: THREE.Mesh;
  private sphere: THREE.Mesh;
  private ringGroup: THREE.Group;
  private ringMesh: THREE.Mesh;
  private ringTexture: THREE.Texture;
  private starfield: THREE.Points;
  private orbitParticles: THREE.Points;

  // Graph layers
  private strandLayer: THREE.LineSegments | null = null;
  private strandMaterial: THREE.ShaderMaterial;
  private nodeLayer: THREE.Points | null = null;
  private nodeMaterial: THREE.ShaderMaterial;
  private edgeLayer: THREE.LineSegments | null = null;
  private edgeMaterial: THREE.LineBasicMaterial;

  // Highlight overlays
  private highlightNode: THREE.Mesh;
  private highlightRing: THREE.Mesh;
  private highlightStrands: THREE.LineSegments;
  private highlightStrandMaterial: THREE.ShaderMaterial;
  private highlightEdges: THREE.LineSegments;

  // Controls
  private theta = 0.4;
  private phi = 1.12;
  private radius = 1400;
  private targetTheta = 0.4;
  private targetPhi = 1.12;
  private targetRadius = 1400;
  private pan = new THREE.Vector3();
  private targetPan = new THREE.Vector3();

  private pointers = new Map<number, { x: number; y: number }>();
  private dragMode: "rotate" | "pan" | null = null;
  private downPos: { x: number; y: number } | null = null;
  private pinch: { dist: number; radius: number; panX: number; panY: number; midX: number; midY: number } | null = null;

  private hovered = -1;
  private pendingPick: { x: number; y: number } | null = null;
  private needsPick = false;
  private hoverClearTimer: number | null = null;
  private hoverHold = false;
  private multiTouch = false;
  private gestureMoved = false;

  private time = 0;
  private lastFrame = 0;
  private motion = 1;
  private showLinks = false;
  private fitted = false;
  private fitRadius = 0;
  private disposed = false;

  private resizeObserver: ResizeObserver | null = null;
  private themeCleanup: () => void;
  private mediaCleanup: () => void;
  private reducedQuery: MediaQueryList;

  private tmpVec = new THREE.Vector3();
  private tmpVec2 = new THREE.Vector3();
  private raycaster = new THREE.Raycaster();

  constructor(container: HTMLElement, options: NeuralSceneOptions) {
    this.container = container;
    this.options = options;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    const canvas = this.renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.touchAction = "none";
    container.appendChild(canvas);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, CAMERA_NEAR, CAMERA_FAR);
    this.camera.position.set(0, 0, this.radius);

    const colors = readThemeColors();
    const bg = new THREE.Color(colors.bg);
    this.scene.background = bg;
    this.scene.fog = new THREE.Fog(bg, 800, 5200);

    // ── Lights (for the lit cube + gold sphere) ──
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 1.7);
    key.position.set(700, 900, 1300);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc6ff, 0.55);
    rim.position.set(-900, -400, -1100);
    this.scene.add(rim);

    // ── Setpiece ──
    this.cube = new THREE.Mesh(
      new THREE.BoxGeometry(CUBE_EDGE, CUBE_EDGE, CUBE_EDGE),
      new THREE.MeshStandardMaterial({
        color: 0xf8f8f8,
        roughness: 0.28,
        metalness: 0.05,
        emissive: 0x202020,
        emissiveIntensity: 0.6,
      })
    );
    const cubeEdges = new THREE.LineSegments(
      new THREE.EdgesGeometry(this.cube.geometry),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })
    );
    this.cube.add(cubeEdges);
    this.scene.add(this.cube);

    this.sphere = new THREE.Mesh(
      new THREE.SphereGeometry(SPHERE_RADIUS, 32, 24),
      new THREE.MeshStandardMaterial({
        color: 0xf7c04a,
        roughness: 0.16,
        metalness: 0.75,
        emissive: 0x8a5a12,
        emissiveIntensity: 0.7,
      })
    );
    this.scene.add(this.sphere);

    this.ringGroup = new THREE.Group();
    this.ringTexture = buildMagicCircleTexture();
    this.ringMesh = new THREE.Mesh(
      new THREE.RingGeometry(RING_INNER, RING_OUTER, 96, 1),
      new THREE.MeshBasicMaterial({
        map: this.ringTexture,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        opacity: 0.95,
      })
    );
    this.ringGroup.add(this.ringMesh);
    this.scene.add(this.ringGroup);

    // Orbit spark particles around the sphere.
    {
      const count = 220;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        const a = hashUnit(i, 0x9a1) * Math.PI * 2;
        const r = SPHERE_RADIUS * (1.6 + hashUnit(i, 0x9b2) * 1.4);
        pos[i * 3] = Math.cos(a) * r;
        pos[i * 3 + 1] = Math.sin(a) * r * 0.55;
        pos[i * 3 + 2] = Math.sin(a * 0.7) * r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      this.orbitParticles = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: 0xffd98a,
          size: 2.4,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.7,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        })
      );
      this.scene.add(this.orbitParticles);
    }

    // Faint starfield for depth/atmosphere.
    {
      const count = 1800;
      const pos = new Float32Array(count * 3);
      for (let i = 0; i < count; i += 1) {
        const r = 2600 + hashUnit(i, 0x7a1) * 3200;
        const u = hashUnit(i, 0x7b2) * 2 - 1;
        const t = hashUnit(i, 0x7c3) * Math.PI * 2;
        const s = Math.sqrt(Math.max(0, 1 - u * u));
        pos[i * 3] = Math.cos(t) * s * r;
        pos[i * 3 + 1] = u * r;
        pos[i * 3 + 2] = Math.sin(t) * s * r;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      this.starfield = new THREE.Points(
        geo,
        new THREE.PointsMaterial({
          color: new THREE.Color(colors.accent),
          size: 1.7,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0.35,
          depthWrite: false,
          fog: false,
          blending: THREE.AdditiveBlending,
        })
      );
      this.scene.add(this.starfield);
    }

    // ── Shared materials (uniforms updated per frame) ──
    this.strandMaterial = new THREE.ShaderMaterial({
      vertexShader: STRAND_VERTEX,
      fragmentShader: STRAND_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSphere: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uDetail: { value: 1 },
        uFogColor: { value: bg.clone() },
        uFogNear: { value: 800 },
        uFogFar: { value: 5200 },
        uDim: { value: 0 },
      },
    });

    this.nodeMaterial = new THREE.ShaderMaterial({
      vertexShader: NODE_VERTEX,
      fragmentShader: NODE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uPixelRatio: { value: this.renderer.getPixelRatio() },
        uScale: { value: 1 },
        uTime: { value: 0 },
        uFlow: { value: 1 },
        uDetail: { value: 1 },
        uFogColor: { value: bg.clone() },
        uFogNear: { value: 800 },
        uFogFar: { value: 5200 },
        uDim: { value: 0 },
      },
    });

    this.edgeMaterial = new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    // ── Highlight overlays ──
    this.highlightNode = new THREE.Mesh(
      new THREE.SphereGeometry(1, 18, 14),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95 })
    );
    this.highlightNode.visible = false;
    this.scene.add(this.highlightNode);

    this.highlightRing = new THREE.Mesh(
      new THREE.RingGeometry(0.82, 1, 40, 1),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.8,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      })
    );
    this.highlightRing.visible = false;
    this.scene.add(this.highlightRing);

    this.highlightStrandMaterial = new THREE.ShaderMaterial({
      vertexShader: STRAND_VERTEX,
      fragmentShader: HIGHLIGHT_STRAND_FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uSphere: { value: new THREE.Vector3() },
        uFogColor: { value: bg.clone() },
        uFogNear: { value: 800 },
        uFogFar: { value: 5200 },
      },
    });

    this.highlightStrands = new THREE.LineSegments(new THREE.BufferGeometry(), this.highlightStrandMaterial);
    this.highlightStrands.visible = false;
    this.scene.add(this.highlightStrands);

    this.highlightEdges = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      })
    );
    this.highlightEdges.visible = false;
    this.scene.add(this.highlightEdges);

    // ── Events ──
    this.reducedQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    this.motion = this.reducedQuery.matches ? 0 : 1;

    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("pointerleave", this.onPointerLeave);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("dblclick", this.onDoubleClick);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    const onTheme = () => this.applyTheme();
    window.addEventListener("lopster-theme-change", onTheme);
    this.themeCleanup = () => window.removeEventListener("lopster-theme-change", onTheme);

    const onMotion = () => {
      this.motion = this.reducedQuery.matches ? 0 : 1;
      this.strandMaterial.uniforms.uFlow.value = this.motion;
      this.nodeMaterial.uniforms.uFlow.value = this.motion;
    };
    if (typeof this.reducedQuery.addEventListener === "function") {
      this.reducedQuery.addEventListener("change", onMotion);
      this.mediaCleanup = () => this.reducedQuery.removeEventListener("change", onMotion);
    } else {
      this.mediaCleanup = () => {};
    }

    this.lastFrame = performance.now();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ── Graph ──
  setGraph(graph: NeuralGraph | null) {
    this.cancelHoverClear();
    this.hoverHold = false;
    this.clearGraphLayers();
    this.graph = graph;
    this.hovered = -1;
    this.needsPick = false;
    this.pendingPick = null;
    this.setHighlight(null);
    this.options.onHover(null);

    if (!graph || !graph.count) return;

    this.strandLayer = new THREE.LineSegments(buildStrandGeometry(graph), this.strandMaterial);
    this.scene.add(this.strandLayer);

    this.nodeLayer = new THREE.Points(buildNodeGeometry(graph), this.nodeMaterial);
    this.scene.add(this.nodeLayer);

    if (this.showLinks) this.buildEdgeLayer();
    this.applyEdgeVisibility();

    if (!this.fitted) this.fit();
  }

  setShowLinks(value: boolean) {
    this.showLinks = value;
    if (value && this.graph && this.graph.count && !this.edgeLayer) this.buildEdgeLayer();
    this.applyEdgeVisibility();
  }

  private buildEdgeLayer() {
    if (!this.graph || !this.graph.count || this.edgeLayer) return;
    this.edgeLayer = new THREE.LineSegments(buildEdgeGeometry(this.graph), this.edgeMaterial);
    this.scene.add(this.edgeLayer);
  }

  private applyEdgeVisibility() {
    const on = this.showLinks && !!this.edgeLayer;
    if (this.edgeLayer) this.edgeLayer.visible = on;
    this.edgeMaterial.opacity = this.showLinks ? (this.hovered >= 0 ? 0.08 : 0.24) : 0;
  }

  fit() {
    const radius = (BRAIN_RADIUS * 1.1 + 80) * 3.0;
    this.targetRadius = radius;
    this.targetTheta = 0.4;
    this.targetPhi = 1.12;
    this.targetPan.set(0, 0, 0);
    this.radius = radius;
    this.theta = 0.4;
    this.phi = 1.12;
    this.pan.set(0, 0, 0);
    this.fitRadius = radius;
    this.fitted = true;
  }

  // ── Rendering loop ──
  private frame() {
    if (this.disposed) return;
    const now = performance.now();
    let dt = (now - this.lastFrame) / 1000;
    this.lastFrame = now;
    if (!(dt > 0) || dt > 0.1) dt = 0.016;
    this.time += dt * this.motion;

    this.updateCamera(dt);
    this.updateSetpiece();
    this.updateUniforms();

    if (this.needsPick && this.pendingPick) {
      this.performPick(this.pendingPick.x, this.pendingPick.y);
      this.needsPick = false;
    }

    this.renderer.render(this.scene, this.camera);
  }

  private updateSetpiece() {
    const t = this.time;

    // White cube: slow meditative spin.
    this.cube.rotation.x = t * 0.22;
    this.cube.rotation.y = t * 0.14;

    // Gold sphere: tilted orbital loop.
    this.sphere.position.set(
      Math.cos(t * 0.55) * SPHERE_ORBIT,
      Math.sin(t * 0.4675) * SPHERE_ORBIT * 0.34,
      Math.sin(t * 0.55) * SPHERE_ORBIT * 0.62
    );
    this.sphere.rotation.y = t * 0.9;

    // Spell ring follows the sphere and billboards to the camera.
    this.ringGroup.position.copy(this.sphere.position);
    this.ringGroup.quaternion.copy(this.camera.quaternion);
    this.ringMesh.rotation.z = t * 0.18;

    this.orbitParticles.position.copy(this.sphere.position);
    this.orbitParticles.rotation.y = t * 0.25;
    this.starfield.rotation.y = t * 0.03;

    if (this.highlightRing.visible) {
      this.highlightRing.quaternion.copy(this.camera.quaternion);
      this.highlightRing.scale.setScalar(1 + Math.sin(t * 3.5) * 0.25);
    }
  }

  private updateUniforms() {
    const detail = this.computeDetail();
    this.strandMaterial.uniforms.uTime.value = this.time;
    this.strandMaterial.uniforms.uFlow.value = this.motion;
    this.strandMaterial.uniforms.uDetail.value = detail;
    this.strandMaterial.uniforms.uSphere.value.copy(this.sphere.position);
    this.nodeMaterial.uniforms.uTime.value = this.time;
    this.nodeMaterial.uniforms.uFlow.value = this.motion;
    this.nodeMaterial.uniforms.uDetail.value = detail;
    this.highlightStrandMaterial.uniforms.uSphere.value.copy(this.sphere.position);
  }

  private computeDetail() {
    const t = clamp((this.radius - this.fitRadius) / (ZOOM_MAX - this.fitRadius), 0, 1);
    return 1 - t * 0.85;
  }

  private updateCamera(dt: number) {
    const k = 1 - Math.exp(-dt * (this.motion ? 9 : 14));
    this.theta += (this.targetTheta - this.theta) * k;
    this.phi += (this.targetPhi - this.phi) * k;
    this.radius += (this.targetRadius - this.radius) * k;
    this.pan.lerp(this.targetPan, k);

    const sinPhi = Math.sin(this.phi);
    this.camera.position.set(
      this.pan.x + this.radius * sinPhi * Math.sin(this.theta),
      this.pan.y + this.radius * Math.cos(this.phi),
      this.pan.z + this.radius * sinPhi * Math.cos(this.theta)
    );
    this.camera.lookAt(this.pan);
  }

  // ── Picking ──
  private performPick(clientX: number, clientY: number) {
    if (!this.graph || !this.graph.count) {
      this.setHover(-1);
      return;
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -(((clientY - rect.top) / rect.height) * 2 - 1)
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const ray = this.raycaster.ray;
    const pos = this.graph.positions;
    const sizes = this.graph.sizes;
    const worldPerPx = (2 * Math.tan((FOV * Math.PI) / 360)) / rect.height;

    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < this.graph.count; i += 1) {
      const x = pos[i * 3];
      const y = pos[i * 3 + 1];
      const z = pos[i * 3 + 2];
      const ox = x - ray.origin.x;
      const oy = y - ray.origin.y;
      const oz = z - ray.origin.z;
      const t = ox * ray.direction.x + oy * ray.direction.y + oz * ray.direction.z;
      if (t < 0) continue;
      const cx = ray.origin.x + ray.direction.x * t - x;
      const cy = ray.origin.y + ray.direction.y * t - y;
      const cz = ray.origin.z + ray.direction.z * t - z;
      const d2 = cx * cx + cy * cy + cz * cz;
      const reach = sizes[i] * 1.8 + 18 * worldPerPx * t;
      if (d2 < reach * reach && d2 < bestD) {
        bestD = d2;
        best = i;
      }
    }
    if (best >= 0) {
      this.cancelHoverClear();
      this.setHover(best);
    } else if (this.hovered >= 0) {
      this.scheduleHoverClear();
    } else {
      this.setHover(-1);
    }
  }

  private setHover(index: number) {
    if (index === this.hovered) return;
    this.hovered = index;
    this.applyHighlight();
    this.emitHover();
  }

  private scheduleHoverClear() {
    if (this.hoverClearTimer != null || this.hoverHold) return;
    this.hoverClearTimer = window.setTimeout(() => {
      this.hoverClearTimer = null;
      if (this.hoverHold) return;
      this.setHover(-1);
    }, 250);
  }

  private cancelHoverClear() {
    if (this.hoverClearTimer != null) {
      window.clearTimeout(this.hoverClearTimer);
      this.hoverClearTimer = null;
    }
  }

  /** Card tells the scene the pointer is over it, so hover must not be cleared. */
  setHoverHold(value: boolean) {
    this.hoverHold = value;
    if (value) {
      this.cancelHoverClear();
    } else if (this.hovered >= 0) {
      this.scheduleHoverClear();
    }
  }

  private applyHighlight() {
    const on = this.hovered >= 0 && !!this.graph;
    this.strandMaterial.uniforms.uDim.value = on ? 0.62 : 0;
    this.nodeMaterial.uniforms.uDim.value = on ? 0.62 : 0;
    this.edgeMaterial.opacity = this.showLinks ? (on ? 0.08 : 0.24) : 0;
    this.setHighlight(on ? this.hovered : null);
  }

  private setHighlight(index: number | null) {
    const graph = this.graph;
    if (index == null || !graph || index < 0 || index >= graph.count) {
      this.highlightNode.visible = false;
      this.highlightRing.visible = false;
      this.highlightStrands.visible = false;
      this.highlightEdges.visible = false;
      return;
    }

    const px = graph.positions[index * 3];
    const py = graph.positions[index * 3 + 1];
    const pz = graph.positions[index * 3 + 2];
    const r = graph.sizes[index] * 2.4;

    this.highlightNode.position.set(px, py, pz);
    this.highlightNode.scale.setScalar(r);
    this.highlightNode.visible = true;

    this.highlightRing.position.set(px, py, pz);
    this.highlightRing.scale.setScalar(r * 1.9);
    this.highlightRing.quaternion.copy(this.camera.quaternion);
    this.highlightRing.visible = true;

    // Bright strand (sphere -> node) for the hovered node, sharing the main
    // strand's near-end orbit-follow via uSphere.
    this.highlightStrands.geometry.dispose();
    this.highlightStrands.geometry = buildSingleStrandGeometry(graph, index);
    this.highlightStrands.visible = true;

    // Bright node-to-node edges touching the hovered node.
    const edgeCount = graph.adjOff[index + 1] - graph.adjOff[index];
    const edgePos = new Float32Array(edgeCount * 2 * 3);
    for (let e = 0; e < edgeCount; e += 1) {
      const j = graph.adjTo[graph.adjOff[index] + e];
      edgePos[e * 6] = px;
      edgePos[e * 6 + 1] = py;
      edgePos[e * 6 + 2] = pz;
      edgePos[e * 6 + 3] = graph.positions[j * 3];
      edgePos[e * 6 + 4] = graph.positions[j * 3 + 1];
      edgePos[e * 6 + 5] = graph.positions[j * 3 + 2];
    }
    this.highlightEdges.geometry.dispose();
    this.highlightEdges.geometry = new THREE.BufferGeometry();
    this.highlightEdges.geometry.setAttribute("position", new THREE.BufferAttribute(edgePos, 3));
    this.highlightEdges.visible = edgeCount > 0;
  }

  private emitHover() {
    const graph = this.graph;
    if (this.hovered < 0 || !graph) {
      this.options.onHover(null);
      return;
    }
    const i = this.hovered;
    const x = graph.positions[i * 3];
    const y = graph.positions[i * 3 + 1];
    const z = graph.positions[i * 3 + 2];
    this.tmpVec.set(x, y, z).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.options.onHover({
      id: graph.ids[i],
      title: graph.titles[i],
      tags: graph.tags[i],
      links: graph.links[i],
      x: (this.tmpVec.x * 0.5 + 0.5) * rect.width,
      y: (-this.tmpVec.y * 0.5 + 0.5) * rect.height,
    });
  }

  // ── Pointer / wheel handlers ──
  private onPointerDown = (event: PointerEvent) => {
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.downPos = { x: event.clientX, y: event.clientY };

    if (this.pointers.size === 2) {
      const pts = [...this.pointers.values()];
      this.pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
        radius: this.targetRadius,
        panX: this.targetPan.x,
        panY: this.targetPan.y,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
      };
      this.dragMode = null;
    } else if (event.button === 0) {
      this.dragMode = "rotate";
    } else if (event.button === 1 || event.button === 2) {
      this.dragMode = "pan";
    }
    if (this.pointers.size <= 2) {
      try {
        (this.renderer.domElement as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        /* ignore */
      }
    }
  };

  private onPointerMove = (event: PointerEvent) => {
    if (this.pointers.has(event.pointerId)) {
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    }

    if (this.pinch && this.pointers.size >= 2) {
      const pts = [...this.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      this.targetRadius = clamp(this.pinch.radius * (this.pinch.dist / dist), ZOOM_MIN, ZOOM_MAX);
      const midX = (pts[0].x + pts[1].x) / 2;
      const midY = (pts[0].y + pts[1].y) / 2;
      this.targetPan.set(
        this.pinch.panX - (midX - this.pinch.midX) * this.panScale(),
        this.pinch.panY + (midY - this.pinch.midY) * this.panScale(),
        this.targetPan.z
      );
      this.clampPan();
      return;
    }

    if (this.dragMode === "rotate") {
      const dx = event.movementX || 0;
      const dy = event.movementY || 0;
      this.targetTheta -= dx * 0.0058;
      this.targetPhi = clamp(this.targetPhi - dy * 0.0058, 0.08, Math.PI - 0.08);
      return;
    }
    if (this.dragMode === "pan") {
      const dx = event.movementX || 0;
      const dy = event.movementY || 0;
      this.tmpVec.setFromMatrixColumn(this.camera.matrix, 0);
      this.tmpVec2.setFromMatrixColumn(this.camera.matrix, 1);
      const s = this.panScale();
      this.targetPan.addScaledVector(this.tmpVec, -dx * s);
      this.targetPan.addScaledVector(this.tmpVec2, dy * s);
      this.clampPan();
      return;
    }

    // Not dragging: queue hover picking (throttled to one per frame).
    this.pendingPick = { x: event.clientX, y: event.clientY };
    this.needsPick = true;
  };

  private onPointerUp = (event: PointerEvent) => {
    if (this.downPos) {
      const moved = Math.hypot(event.clientX - this.downPos.x, event.clientY - this.downPos.y);
      if (moved < 5 && event.button === 0 && this.graph && this.graph.count) {
        this.performPick(event.clientX, event.clientY);
        if (this.hovered >= 0) {
          this.options.onOpen(this.graph.ids[this.hovered]);
        }
      }
      this.downPos = null;
    }
    this.pointers.delete(event.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) this.dragMode = null;
    if (this.dragMode === null) {
      this.pendingPick = { x: event.clientX, y: event.clientY };
      this.needsPick = true;
    }
    // Re-anchor the hover card after a drag ended (camera has moved).
    if (this.hovered >= 0) this.emitHover();
  };

  private onPointerLeave = () => {
    if (this.dragMode) return;
    this.pendingPick = null;
    this.needsPick = false;
    this.setHover(-1);
  };

  private onWheel = (event: WheelEvent) => {
    event.preventDefault();
    this.targetRadius = clamp(this.targetRadius * Math.exp(event.deltaY * 0.0011), ZOOM_MIN, ZOOM_MAX);
  };

  private onContextMenu = (event: MouseEvent) => {
    event.preventDefault();
  };

  private onDoubleClick = () => {
    this.fit();
  };

  private panScale() {
    return (2 * this.radius * Math.tan((FOV * Math.PI) / 360)) / Math.max(1, this.container.clientHeight);
  }

  private clampPan() {
    const max = BRAIN_RADIUS * 3.4;
    if (this.targetPan.length() > max) {
      this.targetPan.setLength(max);
    }
  }

  // ── Theme / resize ──
  private applyTheme() {
    const colors = readThemeColors();
    const bg = new THREE.Color(colors.bg);
    this.scene.background = bg;
    (this.scene.fog as THREE.Fog).color.copy(bg);
    this.strandMaterial.uniforms.uFogColor.value.copy(bg);
    (this.starfield.material as THREE.PointsMaterial).color.set(colors.accent);
  }

  private resize() {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.nodeMaterial.uniforms.uScale.value = h / 2 / Math.tan((FOV * Math.PI) / 360);
    this.nodeMaterial.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
  }

  // ── Disposal ──
  private clearGraphLayers() {
    // Shared materials are owned by the scene and reused across setGraph calls,
    // so only the per-graph geometry is disposed here (the materials live until
    // the scene itself is disposed).
    for (const layer of [this.strandLayer, this.nodeLayer, this.edgeLayer]) {
      if (!layer) continue;
      this.scene.remove(layer);
      layer.geometry.dispose();
    }
    this.strandLayer = null;
    this.nodeLayer = null;
    this.edgeLayer = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.clearGraphLayers();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("pointerleave", this.onPointerLeave);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("dblclick", this.onDoubleClick);

    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.themeCleanup();
    this.mediaCleanup();

    // Free the setpiece + highlight resources.
    for (const obj of [this.cube, this.sphere, this.ringGroup, this.orbitParticles, this.starfield, this.highlightNode, this.highlightRing, this.highlightStrands, this.highlightEdges]) {
      this.scene.remove(obj);
      disposeObject(obj);
    }
    this.ringTexture.dispose();
    this.strandMaterial.dispose();
    this.nodeMaterial.dispose();
    this.edgeMaterial.dispose();

    this.renderer.dispose();
    try {
      this.renderer.forceContextLoss();
    } catch {
      /* ignore */
    }
    canvas.remove();
    this.container = null as unknown as HTMLElement;
  }
}

function clamp(value: number, min: number, max: number) {
  return value < min ? min : value > max ? max : value;
}

/** Quadratic bezier from origin O to node P, bowed perpendicular by a stable hash. */
function strandControl(i: number, px: number, py: number, pz: number): [number, number, number] {
  const len = Math.hypot(px, py, pz) || 1;
  const ax = Math.sin(i * 12.9898) * 43758.5453;
  const ay = Math.cos(i * 78.233) * 12543.765;
  const az = Math.sin(i * 37.719) * 39773.51;
  // Perpendicular direction to P.
  let cx = py * az - pz * ay;
  let cy = pz * ax - px * az;
  let cz = px * ay - py * ax;
  const cl = Math.hypot(cx, cy, cz);
  if (cl < 1e-4) {
    cx = 1;
    cy = 0;
    cz = 0;
  } else {
    cx /= cl;
    cy /= cl;
    cz /= cl;
  }
  const bend = len * (0.16 + hashUnit(i, 0xbeef) * 0.24);
  return [px * 0.5 + cx * bend, py * 0.5 + cy * bend, pz * 0.5 + cz * bend];
}

function quad(o: [number, number, number], c: [number, number, number], p: [number, number, number], t: number): [number, number, number] {
  const mt = 1 - t;
  const a = mt * mt;
  const b = 2 * mt * t;
  const d = t * t;
  return [a * o[0] + b * c[0] + d * p[0], a * o[1] + b * c[1] + d * p[1], a * o[2] + b * c[2] + d * p[2]];
}

function buildStrandPositions(graph: NeuralGraph, index: number): Float32Array {
  const px = graph.positions[index * 3];
  const py = graph.positions[index * 3 + 1];
  const pz = graph.positions[index * 3 + 2];
  const c = strandControl(index, px, py, pz);
  const out = new Float32Array(STRAND_SEGMENTS * 2 * 3);
  const o: [number, number, number] = [0, 0, 0];
  const p: [number, number, number] = [px, py, pz];
  for (let s = 0; s < STRAND_SEGMENTS; s += 1) {
    const t0 = s / STRAND_SEGMENTS;
    const t1 = (s + 1) / STRAND_SEGMENTS;
    const a = quad(o, c, p, t0);
    const b = quad(o, c, p, t1);
    out[s * 6] = a[0];
    out[s * 6 + 1] = a[1];
    out[s * 6 + 2] = a[2];
    out[s * 6 + 3] = b[0];
    out[s * 6 + 4] = b[1];
    out[s * 6 + 5] = b[2];
  }
  return out;
}

function buildStrandGeometry(graph: NeuralGraph): THREE.BufferGeometry {
  const n = graph.count;
  const vCount = n * STRAND_SEGMENTS * 2;
  const position = new Float32Array(vCount * 3);
  const aT = new Float32Array(vCount);
  const aSeed = new Float32Array(vCount);
  const aColor = new Float32Array(vCount * 3);

  for (let i = 0; i < n; i += 1) {
    const px = graph.positions[i * 3];
    const py = graph.positions[i * 3 + 1];
    const pz = graph.positions[i * 3 + 2];
    const c = strandControl(i, px, py, pz);
    const seed = hashUnit(i, 0x5eed);
    const cr = graph.colors[i * 3];
    const cg = graph.colors[i * 3 + 1];
    const cb = graph.colors[i * 3 + 2];
    const o: [number, number, number] = [0, 0, 0];
    const p: [number, number, number] = [px, py, pz];
    const base = i * STRAND_SEGMENTS * 2;
    for (let s = 0; s < STRAND_SEGMENTS; s += 1) {
      const t0 = s / STRAND_SEGMENTS;
      const t1 = (s + 1) / STRAND_SEGMENTS;
      const a = quad(o, c, p, t0);
      const b = quad(o, c, p, t1);
      const v = (base + s * 2) * 3;
      position[v] = a[0];
      position[v + 1] = a[1];
      position[v + 2] = a[2];
      position[v + 3] = b[0];
      position[v + 4] = b[1];
      position[v + 5] = b[2];
      aT[base + s * 2] = t0;
      aT[base + s * 2 + 1] = t1;
      aSeed[base + s * 2] = seed;
      aSeed[base + s * 2 + 1] = seed;
      const w = (base + s * 2) * 3;
      aColor[w] = cr;
      aColor[w + 1] = cg;
      aColor[w + 2] = cb;
      aColor[w + 3] = cr;
      aColor[w + 4] = cg;
      aColor[w + 5] = cb;
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("aT", new THREE.BufferAttribute(aT, 1));
  geo.setAttribute("aSeed", new THREE.BufferAttribute(aSeed, 1));
  geo.setAttribute("aColor", new THREE.BufferAttribute(aColor, 3));
  return geo;
}

function buildNodeGeometry(graph: NeuralGraph): THREE.BufferGeometry {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(graph.positions, 3));
  geo.setAttribute("aColor", new THREE.BufferAttribute(graph.colors, 3));
  geo.setAttribute("aSize", new THREE.BufferAttribute(graph.sizes, 1));
  return geo;
}

function buildEdgeGeometry(graph: NeuralGraph): THREE.BufferGeometry {
  const vCount = graph.edgeCount * 2;
  const position = new Float32Array(vCount * 3);
  for (let e = 0; e < graph.edgeCount; e += 1) {
    const a = graph.edges[e * 2];
    const b = graph.edges[e * 2 + 1];
    position[e * 6] = graph.positions[a * 3];
    position[e * 6 + 1] = graph.positions[a * 3 + 1];
    position[e * 6 + 2] = graph.positions[a * 3 + 2];
    position[e * 6 + 3] = graph.positions[b * 3];
    position[e * 6 + 4] = graph.positions[b * 3 + 1];
    position[e * 6 + 5] = graph.positions[b * 3 + 2];
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(graph.edgeColors, 3));
  return geo;
}
