/**
 * GLSL shaders for the neural scene.
 *
 * Everything here is GPU-driven so the render loop does zero per-node CPU
 * work per frame: strand flow, twinkle and near-end orbit-follow all advance
 * via a single `uTime` uniform. `uFlow` (0..1) freezes autonomous motion
 * under prefers-reduced-motion without removing the scene.
 */

export const STRAND_VERTEX = /* glsl */ `
attribute float aT;
attribute float aSeed;
attribute vec3 aColor;
uniform vec3 uSphere;
varying float vT;
varying float vSeed;
varying vec3 vColor;
varying float vDepth;
void main() {
  // Pull the near end of the strand toward the orbiting gold sphere so every
  // connection appears to radiate from it; the far end stays pinned to the node.
  float influence = 1.0 - smoothstep(0.0, 0.22, aT);
  vec3 p = mix(position, uSphere, influence);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  vT = aT;
  vSeed = aSeed;
  vColor = aColor;
  gl_Position = projectionMatrix * mv;
}
`;

export const STRAND_FRAGMENT = /* glsl */ `
precision highp float;
varying float vT;
varying float vSeed;
varying vec3 vColor;
varying float vDepth;
uniform float uTime;
uniform float uFlow;
uniform float uDetail;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uDim;
void main() {
  // Distance LOD: keep a deterministic fraction of strands as the camera zooms out.
  if (fract(vSeed * 13.73) > uDetail) discard;

  // Energy pulse travelling sphere -> node.
  float pulse = fract(vSeed + vT - uTime * 0.55 * uFlow);
  float glow = pow(1.0 - abs(pulse * 2.0 - 1.0), 3.0);

  // Gold at the source, fading into the node's lane colour.
  vec3 gold = vec3(1.0, 0.80, 0.35);
  vec3 color = mix(gold, vColor, smoothstep(0.0, 0.3, vT));

  float taper = smoothstep(0.0, 0.05, vT) * smoothstep(1.0, 0.9, vT);
  float alpha = (0.18 + glow * 0.9) * (0.5 + 0.5 * taper);

  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  color = mix(color, uFogColor, fog);
  alpha *= 1.0 - fog * 0.8;
  alpha *= 1.0 - uDim * 0.78;

  gl_FragColor = vec4(color, alpha);
}
`;

/** Bright solid strand used to highlight the hovered node's connection. */
export const HIGHLIGHT_STRAND_FRAGMENT = /* glsl */ `
precision highp float;
varying float vT;
varying float vSeed;
varying vec3 vColor;
varying float vDepth;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
void main() {
  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  vec3 color = vec3(1.0, 0.93, 0.72);
  color = mix(color, uFogColor, fog);
  gl_FragColor = vec4(color, 0.9 * (1.0 - fog * 0.5));
}
`;

export const NODE_VERTEX = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uPixelRatio;
uniform float uScale;
uniform float uTime;
uniform float uFlow;
varying vec3 vColor;
varying float vDepth;
varying float vH;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  vH = fract(sin(dot(position, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float twinkle = 1.0 + 0.08 * sin(uTime * 2.0 * uFlow + aSize * 13.0);
  gl_PointSize = aSize * uPixelRatio * uScale / max(-mv.z, 0.1) * twinkle;
  gl_Position = projectionMatrix * mv;
}
`;

export const NODE_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vColor;
varying float vDepth;
varying float vH;
uniform float uDim;
uniform float uDetail;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
void main() {
  if (vH > uDetail) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = length(p);
  if (d > 1.0) discard;
  float alpha = smoothstep(1.0, 0.15, d);
  float fog = smoothstep(uFogNear, uFogFar, vDepth);
  vec3 color = mix(vColor, uFogColor, fog);
  alpha *= 0.9 * (1.0 - uDim * 0.82);
  alpha *= 1.0 - fog * 0.7;
  gl_FragColor = vec4(color, alpha);
}
`;
