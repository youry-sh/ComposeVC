/**
 * DOM + React Fiber introspection for the built-in Element Inspector.
 *
 * Pure logic (no React / DOM event coupling) so it is unit-testable. It reads
 * React's internal fiber tree via the `__reactFiber$…` keys React attaches to
 * DOM nodes, walks up to the nearest custom component, and extracts:
 *   - DOM facts (tag / id / class / selector / geometry / styles / attrs / text)
 *   - the component name, source location, props, hooks (state), and its
 *     ancestor / descendant chain ("connections").
 *
 * All fiber access is defensive: React internals are unstable and may differ
 * between versions, so every field read is optional and bounded (guards on
 * walk depth, serialization depth and string length). When a field is absent
 * the inspector simply shows less, it never throws.
 */

export interface SourceLocation {
  fileName: string;
  lineNumber: number;
  columnNumber: number;
}

export interface DomInfo {
  tag: string;
  id: string;
  className: string;
  selector: string;
  rect: { x: number; y: number; width: number; height: number };
  styles: Array<{ prop: string; value: string }>;
  attributes: Array<{ name: string; value: string }>;
  text: string;
}

export interface HookInfo {
  index: number;
  name: string;
  state: string;
  deps?: string;
}

export interface FiberRef {
  name: string;
  tag: number;
  key: string | null;
}

export interface ComponentInfo {
  name: string;
  tag: number;
  key: string | null;
  source: SourceLocation | null;
  ownerSource: { fileName: string; lineNumber: number } | null;
  props: Array<{ key: string; value: string }>;
  hooks: HookInfo[];
  ancestors: FiberRef[];
  children: FiberRef[];
  rawSource: string | null;
}

export interface InspectorReport {
  dom: DomInfo;
  component: ComponentInfo | null;
}

/* ── React fiber helpers ─────────────────────────────────────────────────── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const FIBER_TAGS: Record<number, string> = {
  0: "Function",
  1: "Class",
  2: "Indeterminate",
  3: "Root",
  4: "Portal",
  5: "Host",
  6: "Text",
  7: "Fragment",
  8: "Mode",
  9: "ContextConsumer",
  10: "ContextProvider",
  11: "ForwardRef",
  12: "Profiler",
  13: "Suspense",
  14: "Memo",
  15: "SimpleMemo",
  16: "Lazy",
  17: "IncompleteClass",
  19: "SuspenseList",
  21: "Scope",
  22: "Offscreen",
  23: "LegacyHidden",
  24: "Cache",
  25: "TracingMarker",
};

export function fiberTagLabel(tag: number): string {
  return FIBER_TAGS[tag] ?? `Tag${tag}`;
}

/** Find the React fiber attached to a DOM node (host component), if any. */
export function findFiber(node: unknown): Any | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key.startsWith("__reactFiber$")) return obj[key];
  }
  return (obj as { __reactContainer$?: { current?: Any } }).__reactContainer$?.current ?? null;
}

/** Climb from a DOM node to the nearest custom (non-host) component fiber. */
export function findComponentFiber(domNode: unknown): Any | null {
  let fiber = findFiber(domNode);
  let guard = 0;
  while (fiber && guard++ < 100) {
    const tag: number = fiber.tag;
    // Skip host elements, text nodes, fragments, mode and suspense wrappers.
    if (tag === 5 || tag === 6 || tag === 7 || tag === 8 || tag === 13) {
      fiber = fiber.return;
      continue;
    }
    return fiber;
  }
  return fiber ?? null;
}

export function getComponentName(fiber: Any): string {
  if (!fiber) return "unknown";
  const tag: number = fiber.tag;
  const type = fiber.type;

  if (typeof type === "string") return type;
  if (tag === 11 && type?.render) {
    return type.render.displayName || type.render.name || "ForwardRef";
  }
  if ((tag === 14 || tag === 15) && type?.type) {
    return (
      type.type.displayName || type.type.name || getComponentName({ type: type.type, tag: 0 })
    );
  }
  if (type?.displayName) return type.displayName;
  if (typeof type?.name === "string") return type.name;
  if (tag === 10) return type?._context?.displayName || "ContextProvider";
  if (tag === 3) return "AppRoot";
  if (tag === 7) return "Fragment";
  if (tag === 16) return fiber.elementType?.name || "Lazy";
  return fiberTagLabel(tag);
}

/* ── Value serialization ─────────────────────────────────────────────────── */

export function serializeValue(value: Any, depth = 0, seen?: WeakSet<object>): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return JSON.stringify(value.length > 200 ? value.slice(0, 200) + "…" : value);
  if (t === "number" || t === "boolean") return String(value);
  if (t === "bigint") return value.toString() + "n";
  if (t === "symbol") return value.toString();
  if (t === "function") return "ƒ " + (value.name || "anonymous") + "()";
  if (depth > 3) return "[…]";

  const currentSeen = seen ?? new WeakSet<object>();
  if (typeof value !== "object") return String(value);
  if (currentSeen.has(value)) return "[Circular]";
  currentSeen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (typeof value.$$typeof === "symbol" || typeof value.$$typeof === "number") {
      const typeName =
        typeof value.type === "string"
          ? value.type
          : value.type?.displayName || value.type?.name || "Component";
      return `<${typeName}${value.key != null ? " key=" + JSON.stringify(value.key) : ""}>`;
    }
    if (Array.isArray(value)) {
      const n = value.length;
      if (n === 0) return "[]";
      const head = value
        .slice(0, 5)
        .map((v: Any) => serializeValue(v, depth + 1, currentSeen))
        .join(", ");
      return `[${head}${n > 5 ? `, … (${n} items)` : ""}]`;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const head = keys
      .slice(0, 8)
      .map((k) => `${k}: ${serializeValue(value[k], depth + 1, currentSeen)}`)
      .join(", ");
    return `{ ${head}${keys.length > 8 ? `, … (${keys.length} keys)` : ""} }`;
  } finally {
    currentSeen.delete(value);
  }
}

export function serializeProps(props: Any): Array<{ key: string; value: string }> {
  if (!props || typeof props !== "object") return [];
  const out: Array<{ key: string; value: string }> = [];
  for (const key of Object.keys(props)) {
    if (key === "children" || key === "ref" || key === "key") continue;
    out.push({ key, value: serializeValue(props[key]) });
  }
  return out;
}

/* ── Hooks / ancestors / children ────────────────────────────────────────── */

function describeHook(hook: Any, index: number): HookInfo {
  const ms = hook?.memoizedState;
  // effect hook shape: { create, destroy, deps, tag }
  if (ms && typeof ms === "object" && "deps" in ms && ("create" in ms || "destroy" in ms)) {
    const name =
      ms.tag === 1 ? "useLayoutEffect" : ms.tag === 2 ? "useInsertionEffect" : "useEffect";
    return { index, name, state: serializeValue(ms.create), deps: serializeValue(ms.deps) };
  }
  // ref hook shape: { current }
  if (
    ms &&
    typeof ms === "object" &&
    !Array.isArray(ms) &&
    "current" in ms &&
    Object.keys(ms).length === 1
  ) {
    return { index, name: "useRef", state: serializeValue(ms.current) };
  }
  // memo / callback: [value, deps]
  if (Array.isArray(ms) && ms.length === 2 && (Array.isArray(ms[1]) || ms[1] == null)) {
    const name = typeof ms[0] === "function" ? "useCallback" : "useMemo";
    return { index, name, state: serializeValue(ms[0]), deps: serializeValue(ms[1]) };
  }
  // state hook (useState / useReducer)
  if (hook?.queue) {
    return { index, name: "useState", state: serializeValue(ms) };
  }
  return { index, name: "hook", state: serializeValue(ms) };
}

function collectHooks(firstHook: Any): HookInfo[] {
  const hooks: HookInfo[] = [];
  let hook = firstHook;
  let i = 0;
  while (hook && i < 80) {
    hooks.push(describeHook(hook, i));
    hook = hook.next;
    i++;
  }
  return hooks;
}

function toFiberRef(fiber: Any): FiberRef {
  return {
    name: getComponentName(fiber),
    tag: fiber.tag,
    key: fiber.key != null ? String(fiber.key) : null,
  };
}

function collectAncestors(returnFiber: Any): FiberRef[] {
  const list: FiberRef[] = [];
  let cur = returnFiber;
  let guard = 0;
  while (cur && guard++ < 60) {
    if (cur.tag !== 5 && cur.tag !== 6 && cur.tag !== 7) list.push(toFiberRef(cur));
    cur = cur.return;
  }
  return list;
}

function collectChildren(child: Any): FiberRef[] {
  const list: FiberRef[] = [];
  let cur = child;
  let guard = 0;
  while (cur && guard++ < 100) {
    list.push(toFiberRef(cur));
    cur = cur.sibling;
  }
  return list;
}

/* ── DOM introspection ───────────────────────────────────────────────────── */

function buildSelector(node: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = node;
  let guard = 0;
  while (cur && cur.nodeType === 1 && guard++ < 6) {
    let part = cur.tagName.toLowerCase();
    if (cur.id) {
      part += "#" + cur.id;
      parts.unshift(part);
      break;
    }
    const cls = (typeof cur.className === "string" ? cur.className : "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2);
    if (cls.length) part += "." + cls.join(".");
    parts.unshift(part);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

const STYLE_PROPS = [
  "display",
  "position",
  "flex-direction",
  "grid-template-columns",
  "font-family",
  "font-size",
  "font-weight",
  "line-height",
  "color",
  "background-color",
  "padding",
  "margin",
  "border",
  "border-radius",
  "overflow",
  "opacity",
  "z-index",
  "cursor",
];

const ATTR_WHITELIST = new Set([
  "role",
  "title",
  "type",
  "href",
  "src",
  "placeholder",
  "value",
  "name",
  "tabindex",
  "disabled",
  "checked",
  "selected",
  "aria-label",
  "aria-expanded",
  "aria-pressed",
]);

export function buildDomInfo(node: HTMLElement): DomInfo {
  const rect = node.getBoundingClientRect();
  const computed = typeof getComputedStyle === "function" ? getComputedStyle(node) : null;
  const styles = STYLE_PROPS.map((prop) => ({
    prop,
    value: computed ? computed.getPropertyValue(prop) : "",
  })).filter((s) => s.value && s.value.trim() !== "");

  const attributes: Array<{ name: string; value: string }> = [];
  for (const attr of Array.from(node.attributes || [])) {
    const n = attr.name;
    if (n === "class" || n === "style" || n === "id") continue;
    if (n.startsWith("data-") || ATTR_WHITELIST.has(n)) {
      attributes.push({ name: n, value: attr.value });
    }
  }

  const text = (node.textContent || "").trim().replace(/\s+/g, " ").slice(0, 200);

  return {
    tag: node.tagName.toLowerCase(),
    id: node.id || "",
    className: typeof node.className === "string" ? node.className : "",
    selector: buildSelector(node),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    styles,
    attributes,
    text,
  };
}

/* ── Full report assembly ────────────────────────────────────────────────── */

export function collectComponentInfo(fiber: Any): ComponentInfo | null {
  if (!fiber) return null;
  const source = fiber._debugSource
    ? {
        fileName: String(fiber._debugSource.fileName || ""),
        lineNumber: Number(fiber._debugSource.lineNumber) || 0,
        columnNumber: Number(fiber._debugSource.columnNumber) || 0,
      }
    : null;
  const ownerSource = fiber._debugOwner?._debugSource
    ? {
        fileName: String(fiber._debugOwner._debugSource.fileName || ""),
        lineNumber: Number(fiber._debugOwner._debugSource.lineNumber) || 0,
      }
    : null;

  let rawSource: string | null = null;
  try {
    if (typeof fiber.type === "function") rawSource = fiber.type.toString();
    else if (typeof fiber.type?.render === "function") rawSource = fiber.type.render.toString();
  } catch {
    rawSource = null;
  }

  return {
    name: getComponentName(fiber),
    tag: fiber.tag,
    key: fiber.key != null ? String(fiber.key) : null,
    source,
    ownerSource,
    props: serializeProps(fiber.memoizedProps ?? fiber.pendingProps),
    hooks: collectHooks(fiber.memoizedState),
    ancestors: collectAncestors(fiber.return),
    children: collectChildren(fiber.child),
    rawSource,
  };
}

export function buildReport(node: HTMLElement): InspectorReport {
  const dom = buildDomInfo(node);
  const component = collectComponentInfo(findComponentFiber(node));
  return { dom, component };
}

/* ── Clipboard text ──────────────────────────────────────────────────────── */

export function formatReportText(report: InspectorReport): string {
  const lines: string[] = [];
  const { dom, component } = report;
  lines.push("## Element Inspector");
  lines.push("");
  lines.push("### DOM");
  lines.push(`tag      ${dom.tag}${dom.id ? " #" + dom.id : ""}`);
  if (dom.className) lines.push(`class    .${dom.className.split(/\s+/).join(" .")}`);
  lines.push(`selector ${dom.selector}`);
  lines.push(
    `size     ${Math.round(dom.rect.width)} × ${Math.round(dom.rect.height)}px @ (${Math.round(
      dom.rect.x
    )}, ${Math.round(dom.rect.y)})`
  );
  if (dom.text) lines.push(`text     ${dom.text}`);
  if (dom.attributes.length) {
    lines.push("attrs:");
    for (const a of dom.attributes) lines.push(`  ${a.name}="${a.value}"`);
  }
  if (dom.styles.length) {
    lines.push("styles:");
    for (const s of dom.styles) lines.push(`  ${s.prop}: ${s.value}`);
  }

  if (component) {
    lines.push("");
    lines.push("### Component");
    lines.push(
      `name     ${component.name} (${fiberTagLabel(component.tag)}${
        component.key != null ? ` key=${component.key}` : ""
      })`
    );
    if (component.source) {
      lines.push(
        `source   ${component.source.fileName}:${component.source.lineNumber}:${component.source.columnNumber}`
      );
    }
    if (component.ownerSource) {
      lines.push(`owner    ${component.ownerSource.fileName}:${component.ownerSource.lineNumber}`);
    }
    if (component.props.length) {
      lines.push("props:");
      for (const p of component.props) lines.push(`  ${p.key} = ${p.value}`);
    }
    if (component.hooks.length) {
      lines.push("hooks:");
      for (const h of component.hooks) {
        lines.push(`  #${h.index} ${h.name} = ${h.state}`);
        if (h.deps != null) lines.push(`       deps: ${h.deps}`);
      }
    }
    if (component.ancestors.length) {
      lines.push("ancestors:");
      for (const a of component.ancestors) lines.push(`  ${a.name} (${fiberTagLabel(a.tag)})`);
    }
    if (component.children.length) {
      lines.push("children:");
      for (const c of component.children) lines.push(`  ${c.name} (${fiberTagLabel(c.tag)})`);
    }
    if (component.rawSource) {
      lines.push("");
      lines.push("### Source");
      lines.push(component.rawSource.slice(0, 6000));
    }
  }

  return lines.join("\n");
}

/* ── Source snippet (best-effort, dev only) ──────────────────────────────── */

export async function fetchSourceSnippet(
  source: SourceLocation,
  timeoutMs = 3000
): Promise<string | null> {
  const { fileName, lineNumber } = source;
  if (!fileName || typeof fileName !== "string" || !/^(https?:|\/|\.\/|\.\.\/)/.test(fileName)) {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let text: string | null = null;
    // `?raw` returns the untouched source (correct line numbers); the plain
    // fetch returns the transformed module as a fallback.
    for (const url of [fileName + "?raw", fileName]) {
      try {
        const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
        if (res.ok) {
          text = await res.text();
          break;
        }
      } catch {
        /* try the next URL */
      }
    }
    if (text == null) return null;
    const lines = text.split(/\r?\n/);
    const center = Math.max(0, lineNumber - 1);
    const start = Math.max(0, center - 8);
    const end = Math.min(lines.length, center + 13);
    const out: string[] = [];
    for (let i = start; i < end; i++) {
      const num = String(i + 1).padStart(5, " ");
      const marker = i === center ? "›" : " ";
      out.push(`${num} ${marker} ${lines[i]}`);
    }
    return out.join("\n");
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
