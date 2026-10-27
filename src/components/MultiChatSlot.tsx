import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ChatPanel, { LiveTimelineItem } from "./ChatPanel";
import {
  AgentToolProgress,
  ChatImageAttachment,
  ChatMessage,
  ChatRequestMessage,
  ChatSessionSummary,
  CompactionInfo,
  CustomTool,
  LabInPackage,
  MainAgentMode,
  ProviderConfig,
  TodoItem,
} from "../types";
import { countMessagesTokens, SYSTEM_PROMPT_OVERHEAD_ESTIMATE } from "../utils/tokenCount";
import { CONTEXT_METRICS_EVENT } from "./StatusBar";

export type MultiSlotPersist = {
  id: string;
  rootPath: string | null;
  sessionId: string | null;
  selectedModelId: string | null;
  agentMode: MainAgentMode;
};

type QueuedChatMessage = {
  id: string;
  content: string;
  images?: ChatImageAttachment[];
};

function messageTextContent(content: ChatRequestMessage["content"] | string | undefined): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return String(part.text || "");
        if ("text" in part && typeof (part as { text?: unknown }).text === "string") {
          return String((part as { text: string }).text);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

function imagesFromRequestMessage(message: ChatRequestMessage): ChatImageAttachment[] | undefined {
  if (Array.isArray(message.images) && message.images.length) return message.images;
  if (!Array.isArray(message.content)) return undefined;
  const out: ChatImageAttachment[] = [];
  message.content.forEach((part, index) => {
    if (!part || typeof part !== "object") return;
    if (part.type !== "image_url") return;
    const url = part.image_url?.url;
    if (!url) return;
    out.push({
      id: `hist-img-${index}`,
      url,
      dataUrl: url,
      mimeType: url.startsWith("data:") ? url.slice(5, url.indexOf(";")) || "image/*" : "image/*",
      name: `image-${index + 1}`,
    });
  });
  return out.length ? out : undefined;
}

function buildUserRequestContent(
  text: string,
  images?: ChatImageAttachment[]
): ChatRequestMessage["content"] {
  const trimmed = (text || "").trim();
  if (!images?.length) return trimmed;
  const parts: Array<
    | { type: "text"; text: string }
    | { type: "image_url"; image_url: { url: string } }
  > = [];
  if (trimmed) parts.push({ type: "text", text: trimmed });
  for (const img of images) {
    const url = img.url || img.dataUrl || "";
    if (!url) continue;
    parts.push({ type: "image_url", image_url: { url } });
  }
  return parts.length ? parts : trimmed;
}

/** In-memory live UI for a chat session (survives switching to another chat and back). */
type SessionLiveState = {
  messages: ChatMessage[];
  toolActivity: AgentToolProgress[];
  assistantDrafts: string[];
  liveTimeline: LiveTimelineItem[];
  /** Ephemeral model think/reasoning — never persisted into ChatMessage[]. */
  thinkingDraft: string | null;
  /** Running local token count for the current visible think process. */
  thinkingTokens: number;
  agentTodos: TodoItem[];
  contextTokens: number | null;
  compactionBanner: CompactionInfo | null;
  agentStatusLabel: string | null;
  retryInfo: { attempt: number; maxRetries: number } | null;
  compacting: boolean;
  /** LAB-IN package handed off to the main agent (shown via a button while the turn runs). */
  labInPackage: LabInPackage | null;
};

const MAX_LIVE_TOOL_ACTIVITY = 80;
const MAX_LIVE_TIMELINE = 120;
const MAX_ASSISTANT_DRAFTS = 24;
const MAX_UNIT_CHILDREN = 40;
const UI_PROGRESS_FLUSH_MS = 48;

function trimLiveState(state: SessionLiveState): SessionLiveState {
  let next = state;
  if (next.toolActivity.length > MAX_LIVE_TOOL_ACTIVITY) {
    next = {
      ...next,
      toolActivity: next.toolActivity.slice(-MAX_LIVE_TOOL_ACTIVITY),
    };
  }
  if (next.liveTimeline.length > MAX_LIVE_TIMELINE) {
    next = {
      ...next,
      liveTimeline: next.liveTimeline.slice(-MAX_LIVE_TIMELINE),
    };
  }
  if (next.assistantDrafts.length > MAX_ASSISTANT_DRAFTS) {
    next = {
      ...next,
      assistantDrafts: next.assistantDrafts.slice(-MAX_ASSISTANT_DRAFTS),
    };
  }
  if (next.toolActivity.some((t) => (t.units?.length || 0) > 0 || (t.children?.length || 0) > MAX_UNIT_CHILDREN)) {
    next = {
      ...next,
      toolActivity: next.toolActivity.map((t) => {
        let units = t.units;
        if (Array.isArray(units) && units.length) {
          units = units.map((u) =>
            Array.isArray(u.children) && u.children.length > MAX_UNIT_CHILDREN
              ? { ...u, children: u.children.slice(-MAX_UNIT_CHILDREN) }
              : u
          );
        }
        let children = t.children;
        if (Array.isArray(children) && children.length > MAX_UNIT_CHILDREN) {
          children = children.slice(-MAX_UNIT_CHILDREN);
        }
        if (units === t.units && children === t.children) return t;
        return { ...t, units, children };
      }),
    };
  }
  return next;
}

function emptyLiveState(): SessionLiveState {
  return {
    messages: [],
    toolActivity: [],
    assistantDrafts: [],
    liveTimeline: [],
    thinkingDraft: null,
    thinkingTokens: 0,
    agentTodos: [],
    contextTokens: null,
    compactionBanner: null,
    agentStatusLabel: null,
    retryInfo: null,
    compacting: false,
    labInPackage: null,
  };
}

function summarizeToolResultForLive(value: unknown): unknown {
  if (value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return `[${value.length} items]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.stdout === "string" || typeof record.stderr === "string") {
      return {
        stdout: typeof record.stdout === "string" ? record.stdout.slice(0, 4000) : undefined,
        stderr: typeof record.stderr === "string" ? record.stderr.slice(0, 4000) : undefined,
      };
    }
    if (typeof record.answer === "string") {
      return { ...record, answer: record.answer.slice(0, 2500) };
    }
    // A background spawn is only a scheduling acknowledgement. Preserve its
    // state instead of reducing it to a generic object-key string; otherwise
    // the UI cannot distinguish “scheduled” from a completed subagent.
    if (record.background === true && typeof record.jobId === "string") {
      return {
        jobId: record.jobId,
        description: typeof record.description === "string" ? record.description : undefined,
        background: true,
        status: typeof record.status === "string" ? record.status : "running",
      };
    }
    // read_file: keep line stats for console body (drop full content).
    if (
      typeof record.totalLines === "number" ||
      typeof record.returnedLines === "number" ||
      (typeof record.path === "string" && typeof record.content === "string")
    ) {
      return {
        path: typeof record.path === "string" ? record.path : undefined,
        totalLines: typeof record.totalLines === "number" ? record.totalLines : undefined,
        returnedLines: typeof record.returnedLines === "number" ? record.returnedLines : undefined,
        truncated: record.truncated === true,
        nextOffset: typeof record.nextOffset === "number" ? record.nextOffset : undefined,
        offset: typeof record.offset === "number" ? record.offset : undefined,
      };
    }
    // glob tool: keep match stats for the live "N matches" chip (do not collapse to key list).
    // Full matches[] can be huge — drop it; UI only needs counts + mode.
    if (
      record.mode === "files" ||
      record.mode === "content" ||
      typeof record.matchCount === "number" ||
      typeof record.totalFound === "number"
    ) {
      return {
        mode: record.mode,
        matchCount: typeof record.matchCount === "number" ? record.matchCount : undefined,
        totalFound: typeof record.totalFound === "number" ? record.totalFound : undefined,
        filesHit: typeof record.filesHit === "number" ? record.filesHit : undefined,
        truncated: record.truncated === true,
        pattern: typeof record.pattern === "string" ? record.pattern : undefined,
        content: typeof record.content === "string" ? record.content : undefined,
        engine: typeof record.engine === "string" ? record.engine : undefined,
      };
    }
    // web_search: keep result count so UI can show it without full payload
    if (Array.isArray(record.results)) {
      return {
        engine: typeof record.engine === "string" ? record.engine : undefined,
        results: record.results.slice(0, 8),
      };
    }
    return `{${Object.keys(record).slice(0, 8).join(", ")}}`;
  }
  return String(value);
}

/** Apply one agent:progress event onto a session's live UI cache (pure). */
function applyProgressToLiveState(state: SessionLiveState, progress: AgentToolProgress): SessionLiveState {
  let next: SessionLiveState = { ...state };

  if (progress.type === "status") {
    if (next.thinkingMaxLocked) return next;
    const label =
      (typeof progress.label === "string" && progress.label) ||
      (typeof progress.text === "string" ? progress.text : null);
    if (label) next = { ...next, agentStatusLabel: label };
    return next;
  }

  if (progress.type === "lab_in_package" && progress.labInPackage) {
    const pkg = progress.labInPackage;
    next = {
      ...next,
      labInPackage: {
        knowledgePackage: typeof pkg.knowledgePackage === "string" ? pkg.knowledgePackage : "",
        refinedPrompt: typeof pkg.refinedPrompt === "string" ? pkg.refinedPrompt : "",
        chunkCount: typeof pkg.chunkCount === "number" ? pkg.chunkCount : undefined,
        truncated: pkg.truncated === true,
        coverage: pkg.coverage === true,
      },
    };
    return next;
  }

  if (progress.type === "assistant_thinking") {
    // Native provider reasoning is part of a normal model response. It must not
    // impersonate the explicit custom Thinking-max tool/process in the UI.
    if (progress.phase === "reasoning" && !next.thinkingMaxLocked) return next;
    const added = typeof progress.tokenDelta === "number" ? progress.tokenDelta : 0;
    if (progress.phase === "end") {
      return next.thinkingMaxLocked
        ? {
            ...next,
            thinkingDraft: null,
            agentStatusLabel: `Thinking-max${next.thinkingTokens > 0 ? ` · ≈${next.thinkingTokens.toLocaleString()} tokens` : ""}`,
          }
        : { ...next, thinkingDraft: null, thinkingTokens: 0, agentStatusLabel: null };
    }
    const previous = Number.isFinite(next.thinkingTokens) ? next.thinkingTokens : 0;
    const total = progress.phase === "start" && !next.thinkingMaxLocked ? added : previous + added;
    const cycleLabel = progress.thinkCycle && progress.thinkCycleTarget
      ? ` ${progress.thinkCycle}/${progress.thinkCycleTarget}`
      : "";
    return {
      ...next,
      thinkingDraft: progress.text || next.thinkingDraft || "Deep reasoning",
      thinkingTokens: total,
      // Locally tokenized from the actual reasoning stream. Marked approximate because
      // providers may use a different tokenizer and usually report exact usage only at end.
      agentStatusLabel: `Thinking-max${cycleLabel}${total > 0 ? ` · ≈${total.toLocaleString()} tokens` : ""}`,
    };
  }

  if (progress.type === "assistant_text" && progress.text?.trim() && !progress.parentToolCallId) {
    const text = progress.text;
    // Token stream chunks append into one timeline entry. This avoids hundreds
    // of React/Markdown nodes for a single answer while preserving instant text.
    if (progress.delta) {
      const last = next.liveTimeline[next.liveTimeline.length - 1];
      if (last?.kind === "text") {
        next = {
          ...next,
          // liveTimeline is authoritative while streaming. Keeping a second
          // ever-growing copy in assistantDrafts doubled string allocation for
          // every delta; the initial draft remains as a legacy/fallback value.
          assistantDrafts: next.assistantDrafts,
          liveTimeline: [...next.liveTimeline.slice(0, -1), { ...last, text: `${last.text}${text}` }],
        };
      } else {
        next = {
          ...next,
          assistantDrafts: [...next.assistantDrafts, text],
          liveTimeline: [
            ...next.liveTimeline,
            { kind: "text", id: `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text },
          ],
        };
      }
    } else {
      const completedText = text.trim();
      next = {
        ...next,
        assistantDrafts: [...next.assistantDrafts, completedText],
        liveTimeline: [
          ...next.liveTimeline,
          {
            kind: "text",
            id: `text-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            text: completedText,
          },
        ],
      };
    }
  }

  if (progress.parentToolCallId) {
    const current = next.toolActivity;
    const parentIndex = current.findIndex((item) => item.toolCallId === progress.parentToolCallId);
    if (parentIndex !== -1) {
      const parent = current[parentIndex];
      const children = [...(parent.children || [])];
      let units = [...(parent.units || [])];
      let nextParent = parent;
      if (progress.type === "subagent_status") {
        // Batch parent summary (agentId=batch or batch:true) — update header only
        if (progress.batch || progress.agentId === "batch") {
          nextParent = {
            ...parent,
            status: progress.status,
            statusText: progress.text || progress.status,
            description: progress.description || parent.description,
            mode: progress.mode || parent.mode,
            agentId: "batch",
            total: progress.total ?? parent.total,
            completed: progress.completed ?? parent.completed,
            concurrency: progress.concurrency ?? parent.concurrency,
            batch: true,
            units,
          };
        } else if (progress.unit || progress.agentId) {
          // Per-unit live row (batch or single spawn)
          const key = String(progress.agentId || `idx-${progress.index}`);
          // Prefer match by index for queued→running upgrade (queued-0 → sub-xxx)
          let uIdx = -1;
          if (progress.index != null) {
            uIdx = units.findIndex((u) => u.index === progress.index);
          }
          if (uIdx === -1) {
            uIdx = units.findIndex((u) => u.agentId === key || u.agentId === `queued-${progress.index}`);
          }
          const unitRow = {
            agentId: key,
            index: progress.index,
            description: progress.description,
            status: progress.status || "running",
            statusText: progress.text || progress.status || "",
            mode: progress.mode,
            children: uIdx >= 0 ? units[uIdx].children || [] : [],
            ok: progress.status === "done" ? true : progress.status === "error" ? false : undefined,
          };
          if (uIdx === -1) units.push(unitRow);
          else units[uIdx] = { ...units[uIdx], ...unitRow, children: units[uIdx].children || [] };
          // Sort by index for stable UI
          units = units
            .slice()
            .sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
          nextParent = {
            ...parent,
            // Keep parent running while any unit lives; don't overwrite with one unit's title
            status: parent.status === "done" ? parent.status : "running",
            statusText:
              progress.batch || progress.agentId === "batch"
                ? progress.text || parent.statusText
                : parent.statusText || progress.text,
            description: parent.description || progress.description,
            mode: progress.mode || parent.mode,
            agentId: parent.agentId || progress.agentId,
            total: progress.total ?? parent.total,
            units,
          };
        } else {
          // Legacy single spawn_subagent status
          nextParent = {
            ...parent,
            status: progress.status,
            statusText: progress.text || progress.status,
            description: progress.description || parent.description,
            mode: progress.mode || parent.mode,
            agentId: progress.agentId || parent.agentId,
          };
        }
      } else if (progress.type === "tool_start" || progress.type === "tool_end") {
        const childProgress =
          progress.type === "tool_end"
            ? { ...progress, result: summarizeToolResultForLive(progress.result) }
            : progress;
        // Attach child tool under the matching unit when agentId present (batch)
        if (progress.agentId && progress.agentId !== "batch") {
          let uIdx = units.findIndex((u) => u.agentId === progress.agentId);
          if (uIdx === -1 && progress.index != null) {
            uIdx = units.findIndex((u) => u.index === progress.index);
          }
          if (uIdx === -1) {
            units.push({
              agentId: String(progress.agentId),
              index: progress.index,
              status: "running",
              statusText: progress.name || "",
              children: [childProgress],
            });
          } else {
            const uchildren = [...(units[uIdx].children || [])];
            const cIdx = childProgress.toolCallId
              ? uchildren.findIndex((c) => c.toolCallId === childProgress.toolCallId)
              : -1;
            if (cIdx === -1) uchildren.push(childProgress);
            else uchildren[cIdx] = { ...uchildren[cIdx], ...childProgress };
            units[uIdx] = {
              ...units[uIdx],
              children: uchildren,
              statusText:
                progress.type === "tool_start" && progress.name
                  ? progress.name
                  : units[uIdx].statusText,
            };
          }
          units = units.slice().sort((a, b) => (a.index ?? 999) - (b.index ?? 999));
          nextParent = { ...parent, units };
        } else {
          const childIndex = childProgress.toolCallId
            ? children.findIndex((item) => item.toolCallId === childProgress.toolCallId)
            : -1;
          if (childIndex === -1) children.push(childProgress);
          else children[childIndex] = { ...children[childIndex], ...childProgress };
          nextParent = {
            ...parent,
            children,
            statusText:
              progress.type === "tool_start" && progress.name ? progress.name : parent.statusText,
          };
        }
      }
      const toolActivity = [...current];
      toolActivity[parentIndex] = nextParent;
      next = { ...next, toolActivity };
    }
  } else if (progress.name || progress.type === "subagent_status") {
    const displayProgress =
      progress.type === "tool_end"
        ? { ...progress, result: summarizeToolResultForLive(progress.result) }
        : progress;
    // A background spawn returns after scheduling, not after the worker completes.
    // Keep its parent tool live so the small status chip remains honest until a
    // wait_subagents call actually joins the job.
    const isBackgroundSpawn =
      progress.type === "tool_end" &&
      (progress.name === "spawn_subagent" || progress.name === "spawn_subagent_batch") &&
      Boolean(
        progress.result &&
          typeof progress.result === "object" &&
          (progress.result as { background?: unknown }).background === true
      );
    const renderedProgress = isBackgroundSpawn
      ? {
          ...displayProgress,
          type: "tool_start" as const,
          status: "running" as const,
          statusText: "running in background",
        }
      : displayProgress;
    let liveTimeline = next.liveTimeline;
    if (renderedProgress.toolCallId) {
      const hasTool = liveTimeline.some(
        (item) => item.kind === "tool" && item.toolCallId === renderedProgress.toolCallId
      );
      if (!hasTool) {
        liveTimeline = [
          ...liveTimeline,
          { kind: "tool", id: `tool-${renderedProgress.toolCallId}`, toolCallId: renderedProgress.toolCallId },
        ];
      }
    }
    // Tool events may be delivered slightly out of order when calls run in
    // parallel. Keep one canonical row per call ID and never let a late
    // tool_start overwrite an already received tool_end (that made completed
    // tools look permanently pending at the top of the live stack).
    const idx = renderedProgress.toolCallId
      ? next.toolActivity.findIndex((item) => item.toolCallId === renderedProgress.toolCallId)
      : -1;
    let toolActivity: AgentToolProgress[];
    if (idx === -1) {
      toolActivity = [...next.toolActivity, renderedProgress];
    } else if (
      renderedProgress.type === "tool_start" &&
      next.toolActivity[idx].type === "tool_end"
    ) {
      toolActivity = next.toolActivity;
    } else {
      toolActivity = [...next.toolActivity];
      toolActivity[idx] = { ...toolActivity[idx], ...renderedProgress };
    }
    // Keep think draft for the whole live turn (tools/answer below it).
    // Cleared only on turn end via clearAssistantDrafts — not on tool_start.
    next = {
      ...next,
      toolActivity,
      liveTimeline,
    };
  }

  if (progress.type === "todo_update" && Array.isArray(progress.todos)) {
    // Always keep the last valid snapshot from the agent. Empty array means explicit clear
    // (e.g. all tasks completed). Never treat a missing/invalid update as "wipe previous".
    const todos = progress.todos.map((todo) => ({ ...todo }));
    next = {
      ...next,
      // Hide panel only when every task is completed (or list empty).
      agentTodos: todos.some((todo) => todo.status !== "completed") ? todos : [],
    };
  }
  if (
    progress.type === "context_usage" &&
    typeof progress.contextTokens === "number" &&
    progress.contextTokens > 0
  ) {
    next = { ...next, contextTokens: progress.contextTokens };
  }
  if (progress.type === "compact_start" && !progress.parentToolCallId) {
    next = { ...next, compacting: true };
  }
  if (progress.type === "compact_end" && !progress.parentToolCallId) {
    next = {
      ...next,
      compacting: false,
      contextTokens:
        typeof progress.tokensAfter === "number" && progress.tokensAfter > 0
          ? progress.tokensAfter
          : next.contextTokens,
      // Surface compact failure briefly via status label (cleared on next progress/end).
      agentStatusLabel:
        progress.ok === false
          ? `Compact failed${typeof progress.error === "string" && progress.error ? `: ${progress.error}` : ""}`
          : next.agentStatusLabel,
    };
  }
  if (progress.type === "retry" && !progress.parentToolCallId) {
    next = {
      ...next,
      retryInfo: { attempt: progress.attempt || 1, maxRetries: progress.maxRetries || 10 },
    };
  } else if (
    (progress.type === "tool_start" || progress.type === "tool_end") &&
    !progress.parentToolCallId
  ) {
    next = { ...next, retryInfo: null };
  }

  return trimLiveState(next);
}

type Labels = React.ComponentProps<typeof ChatPanel>["labels"] & {
  selectModel: string;
  retrying: string;
  nothingToCompact: string;
  compactFailed: string;
  selectWorkspaceFolder?: string;
  selectFolder?: string;
  aiRequestFailed?: string;
  agentFinished?: string;
  slotN?: string;
  noFolderOpened?: string;
};

interface MultiChatSlotProps {
  slotId: string;
  rootPath: string | null;
  sessionId: string | null;
  selectedModelId: string | null;
  agentMode: MainAgentMode;
  onPersist: (next: MultiSlotPersist) => void;
  /** Live panel status for the shell rail: streaming state + chat count. */
  onStatusChange?: (slotId: string, status: { running: boolean; sessionCount: number }) => void;
  providerConfig: ProviderConfig;
  customTools: CustomTool[];
  onAddCustomTool: (input: {
    name: string;
    title?: string;
    description?: string;
    body: Record<string, unknown> | string;
    tags?: string[];
  }) => Promise<void>;
  onUpdateCustomTool: (
    toolId: string,
    patch: {
      name?: string;
      title?: string;
      description?: string;
      body?: Record<string, unknown> | string;
      enabled?: boolean;
      tags?: string[];
    }
  ) => Promise<void>;
  onRemoveCustomTool: (toolId: string) => Promise<void>;
  labels: Labels;
  index: number;
  focused?: boolean;
}

function projectNameFromPath(path: string | null, emptyLabel = "No folder"): string {
  if (!path) return emptyLabel;
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** Serialize a tool result back into the transcript string form used on disk. */
function serializeToolResultContent(step: AgentToolProgress): string {
  if (step.ok === false) {
    if (typeof step.result === "string") {
      return step.result.startsWith("Error:") ? step.result : `Error: ${step.result}`;
    }
    if (step.error) return `Error: ${step.error}`;
    try {
      return `Error: ${JSON.stringify(step.result ?? "failed")}`;
    } catch {
      return "Error: failed";
    }
  }
  if (typeof step.result === "string") return step.result;
  if (step.result == null) return "";
  try {
    return JSON.stringify(step.result);
  } catch {
    return String(step.result);
  }
}

/**
 * UI ChatMessage[] → agent ChatRequestMessage[].
 * Reconstructs assistant.toolCalls + role=tool rows from toolSteps so compact/send
 * round-trips do not drop tool history.
 */
function toRequestMessages(list: ChatMessage[]): ChatRequestMessage[] {
  const out: ChatRequestMessage[] = [];
  for (const message of list || []) {
    if (message.role === "user") {
      const req: ChatRequestMessage = {
        role: "user",
        content: buildUserRequestContent(message.content, message.images),
      };
      if (message.images?.length) req.images = message.images;
      out.push(req);
      continue;
    }

    const steps = Array.isArray(message.toolSteps) ? message.toolSteps : [];
    const toolSteps = steps.filter(
      (step) =>
        step &&
        step.name &&
        step.type !== "assistant_text" &&
        step.type !== "todo_update" &&
        step.type !== "context_usage" &&
        step.type !== "retry" &&
        step.type !== "compact_start" &&
        step.type !== "compact_end" &&
        step.type !== "auto_continue" &&
        step.type !== "status" &&
        step.type !== "subagent_status"
    );

    if (toolSteps.length > 0) {
      // Dedupe by toolCallId (keep last), preserve first-seen order — same as historical UI.
      const byId = new Map<string, AgentToolProgress>();
      const order: string[] = [];
      toolSteps.forEach((step, index) => {
        const key = step.toolCallId || `${step.name}-${index}`;
        if (!byId.has(key)) order.push(key);
        byId.set(key, step);
      });
      const unique = order.map((key) => byId.get(key)!);
      const toolCalls = unique.map((step, index) => ({
        id: step.toolCallId || `ui-tool-${index}`,
        name: step.name || "tool",
        input: step.input,
      }));
      out.push({ role: "assistant", content: "", toolCalls });
      unique.forEach((step, index) => {
        out.push({
          role: "tool",
          toolCallId: step.toolCallId || toolCalls[index]?.id,
          toolName: step.name || "tool",
          content: serializeToolResultContent(step),
        });
      });
      if (message.content?.trim()) {
        out.push({ role: "assistant", content: message.content });
      }
      continue;
    }

    if (message.role === "assistant") {
      const req: ChatRequestMessage = {
        role: "assistant",
        content: message.content,
      };
      if (message.reasoningContent) req.reasoning_content = message.reasoningContent;
      out.push(req);
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function toVisibleChatMessages(
  list: ChatRequestMessage[] | undefined,
  idPrefix: string,
  timestamp = Date.now()
): ChatMessage[] {
  const visible: ChatMessage[] = [];
  const HIDDEN = new Set([
    "Continue exactly where you left off. Keep working autonomously until the task is fully complete, then give the final answer.",
    "You have reached the maximum number of steps for this turn. Stop calling tools now and reply with a clear final summary of everything you completed, and what (if anything) still remains to be done.",
    "You still have unfinished Agent Tasks in your todo list. Do not give the final answer yet. Continue working, and mark every completed task with the todo tool before finishing.",
  ]);

  /**
   * Internal agent continue/todo boards must never appear as user bubbles.
   * Keep in sync with electron/compact.cjs isInternalAgentNudge.
   */
  const isHiddenUserNudge = (content: ChatRequestMessage["content"] | string): boolean => {
    const text = messageTextContent(content).trim();
    if (!text) return true;
    if (HIDDEN.has(text)) return true;
    if (text.startsWith("Continue exactly where you left off.")) return true;
    if (text.startsWith("You have reached the maximum number of steps for this turn.")) return true;
    if (text.startsWith("You still have unfinished Agent Tasks")) return true;
    if (text.startsWith("TODO IS ON THIS TURN:")) return true;
    if (text.includes("OPEN AGENT TASKS (") && text.includes("unfinished")) return true;
    if (text.includes("close finished ones before the final answer")) return true;
    if (text.startsWith("## code_impact_nudge") || text.startsWith("## code_impact_soft_allow")) return true;
    if (text.includes("todo action=complete id=") && text.includes("OPEN AGENT TASKS")) {
      return true;
    }
    return false;
  };

  // Only tools accumulate during a turn. Mid-turn AI narration (preamble / status lines
  // between tool batches) is dropped on reload — only the last pure-text assistant reply
  // of the turn is shown as the final answer.
  const toolSteps: AgentToolProgress[] = [];
  let pendingFinalText: string | null = null;
  let pendingFinalImages: ChatImageAttachment[] | undefined;
  const pendingToolCalls = new Map<string, { name: string; input?: unknown }>();

  const parseToolResult = (content: string, isError: boolean): unknown => {
    if (isError || !content) return content;
    try {
      return JSON.parse(content) as unknown;
    } catch {
      return content;
    }
  };

  const flushTurn = () => {
    if (toolSteps.length > 0) {
      visible.push({
        id: `${idPrefix}-${visible.length}`,
        role: "assistant",
        content: "",
        timestamp,
        toolSteps: [...toolSteps],
      });
      toolSteps.length = 0;
    }
    // Clear pending call map between real user turns so ids never leak across turns.
    pendingToolCalls.clear();
    if (pendingFinalText || pendingFinalImages?.length) {
      visible.push({
        id: `${idPrefix}-${visible.length}`,
        role: "assistant",
        content: pendingFinalText || "",
        timestamp,
        images: pendingFinalImages,
      });
      pendingFinalText = null;
      pendingFinalImages = undefined;
    }
  };

  for (const message of list || []) {
    // Assistant with tools: hide any narration that came with the call (status/preamble).
    // Also drop buffered mid-turn text — more tools mean that text was intermediate.
    if (message.role === "assistant" && message.toolCalls?.length) {
      pendingFinalText = null;
      pendingFinalImages = undefined;
      for (const call of message.toolCalls) {
        if (call?.id) pendingToolCalls.set(call.id, { name: call.name, input: call.input });
      }
      continue;
    }

    if (message.role === "tool") {
      // Tools after a buffered text reply → that text was mid-turn status, hide it.
      pendingFinalText = null;
      pendingFinalImages = undefined;
      const pending = message.toolCallId ? pendingToolCalls.get(message.toolCallId) : undefined;
      const raw = String(message.content ?? "");
      const isError = raw.startsWith("Error:");
      toolSteps.push({
        type: "tool_end",
        toolCallId: message.toolCallId,
        name: message.toolName || pending?.name || "tool",
        input: pending?.input,
        ok: !isError,
        result: parseToolResult(raw, isError),
      });
      if (message.toolCallId) pendingToolCalls.delete(message.toolCallId);
      continue;
    }

    if (message.role === "user") {
      // Skip hidden continue/todo prompts WITHOUT flushing — keeps one tool card per turn.
      const userText = messageTextContent(message.content);
      const userImages = imagesFromRequestMessage(message);
      // Empty text + no images → treat as hidden/empty
      if (!userImages?.length && isHiddenUserNudge(message.content || "")) continue;
      if (!userText.trim() && !userImages?.length) continue;
      // Internal nudges never carry images — if text is a nudge, hide even with empty images.
      if (userText.trim() && isHiddenUserNudge(userText) && !userImages?.length) continue;
      // Dedupe consecutive same-text user bubbles (e.g. multimodal + plain-text re-inject
      // after a bad hasUser compare left two rows for one request). Prefer the richer one.
      const prev = visible[visible.length - 1];
      if (
        prev &&
        prev.role === "user" &&
        (prev.content || "").trim() === userText.trim()
      ) {
        const prevImgs = prev.images?.length || 0;
        const nextImgs = userImages?.length || 0;
        if (nextImgs > prevImgs) {
          visible[visible.length - 1] = {
            ...prev,
            content: userText,
            images: userImages,
          };
        }
        continue;
      }
      flushTurn();
      visible.push({
        id: `${idPrefix}-${visible.length}`,
        role: "user",
        content: userText,
        timestamp,
        images: userImages,
      });
      continue;
    }

    // Pure assistant text: keep only the latest as candidate final answer.
    // If tools follow later, it will be discarded above.
    const assistantText = messageTextContent(message.content).trim();
    const assistantImages = imagesFromRequestMessage(message);
    const assistantReasoning = typeof message.reasoning_content === "string" ? message.reasoning_content : "";
    if (
      message.role === "assistant" &&
      (assistantText || assistantImages?.length || assistantReasoning) &&
      !message.toolCalls?.length
    ) {
      pendingFinalText = assistantText || "";
      pendingFinalImages = assistantImages;
    }
  }
  flushTurn();
  return visible;
}

const MultiChatSlot: React.FC<MultiChatSlotProps> = ({
  slotId,
  rootPath: initialRootPath,
  sessionId: initialSessionId,
  selectedModelId: initialSelectedModelId,
  agentMode: initialAgentMode,
  onPersist,
  onStatusChange,
  providerConfig,
  customTools,
  onAddCustomTool,
  onUpdateCustomTool,
  onRemoveCustomTool,
  labels,
  index,
  focused = false,
}) => {
  const [rootPath, setRootPath] = useState<string | null>(initialRootPath);
  const [projectName, setProjectName] = useState(() => projectNameFromPath(initialRootPath));
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialSessionId);
  const [oneShotBySession, setOneShotBySession] = useState<Record<string, boolean>>({});
  const oneShotBySessionRef = useRef<Record<string, boolean>>({});
  const [activeOneShot, setActiveOneShot] = useState(false);
  const [runningBySession, setRunningBySession] = useState<Record<string, boolean>>({});
  const runningBySessionRef = useRef<Record<string, boolean>>({});
  const [thinking, setThinking] = useState(false);
  const thinkingMaxStorageKey = `composevc:thinking-max:${slotId}`;
  const [thinkingMaxEnabled, setThinkingMaxEnabled] = useState(() => {
    try {
      return window.localStorage.getItem(thinkingMaxStorageKey) === "1";
    } catch {
      return false;
    }
  });
  const thinkingMaxRef = useRef(thinkingMaxEnabled);
  const toggleThinkingMax = useCallback(() => {
    setThinkingMaxEnabled((current) => {
      const next = !current;
      thinkingMaxRef.current = next;
      try { window.localStorage.setItem(thinkingMaxStorageKey, next ? "1" : "0"); } catch { /* optional */ }
      return next;
    });
  }, [thinkingMaxStorageKey]);
  const [toolActivity, setToolActivity] = useState<AgentToolProgress[]>([]);
  const toolActivityRef = useRef<AgentToolProgress[]>([]);
  const [assistantDrafts, setAssistantDrafts] = useState<string[]>([]);
  const assistantDraftsRef = useRef<string[]>([]);
  const [liveTimeline, setLiveTimeline] = useState<LiveTimelineItem[]>([]);
  const liveTimelineRef = useRef<LiveTimelineItem[]>([]);
  /** Ephemeral think/reasoning — live only, never written into messages. */
  const [thinkingDraft, setThinkingDraft] = useState<string | null>(null);
  const thinkingDraftRef = useRef<string | null>(null);
  const [messageQueue, setMessageQueue] = useState<QueuedChatMessage[]>([]);
  const messageQueuesRef = useRef<Map<string, QueuedChatMessage[]>>(new Map());
  /** Per-session live UI cache — keeps progress/history when switching chats mid-run. */
  const sessionLiveRef = useRef<Map<string, SessionLiveState>>(new Map());
  /** Temp "pending-…" run id still awaiting the backend-resolved session id. */
  const pendingRunRef = useRef<string | null>(null);
  const [compacting, setCompacting] = useState(false);
  const [compactionBanner, setCompactionBanner] = useState<CompactionInfo | null>(null);
  const [compactNotice, setCompactNotice] = useState<{ text: string; tone: "info" | "error" } | null>(null);
  const [contextTokens, setContextTokens] = useState<number | null>(null);
  const [resolvedContextLimit, setResolvedContextLimit] = useState<number | null>(null);
  const [promptTokenEstimate, setPromptTokenEstimate] = useState<number | null>(null);
  const [agentTodos, setAgentTodos] = useState<TodoItem[]>([]);
  // Per-panel model/mode (independent across MultiIDE columns)
  const [selectedModelId, setSelectedModelId] = useState<string | null>(
    () => initialSelectedModelId || providerConfig.selectedModelId || null
  );
  const [agentMode, setAgentMode] = useState<MainAgentMode>(() =>
    initialAgentMode === "lab-in" || initialAgentMode === "fortani"
      ? initialAgentMode
      : "lopster"
  );
  const [agentStatusLabel, setAgentStatusLabel] = useState<string | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxRetries: number } | null>(null);
  const [labInPackage, setLabInPackage] = useState<LabInPackage | null>(null);

  const messagesRef = useRef<ChatMessage[]>([]);
  const activeSessionIdRef = useRef<string | null>(initialSessionId);
  const rootPathRef = useRef<string | null>(initialRootPath);
  const selectedModelIdRef = useRef<string | null>(selectedModelId);
  const agentModeRef = useRef<MainAgentMode>(agentMode);
  /** Coalesce delayed queue drains so the next turn waits for paint of the finished answer. */
  const queueDrainTimersRef = useRef<Map<string, number>>(new Map());

  type SessionAutoInsert = { enabled: boolean; messages: string[]; messageEnabled: boolean[] };
  type AutoInsertStore = { enabled: boolean; messages: string[]; messageEnabled?: boolean[] };
  const autoInsertStoreRef = useRef<AutoInsertStore>({ enabled: true, messages: [], messageEnabled: [] });
  const [sessionAutoInsert, setSessionAutoInsert] = useState<SessionAutoInsert>({
    enabled: true,
    messages: [],
    messageEnabled: [],
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const store = await window.lopster?.readAutoInsertStore?.() as AutoInsertStore | undefined;
        if (!store || cancelled) return;
        const messages = Array.isArray(store.messages)
          ? store.messages.filter((message) => typeof message === "string")
          : [];
        // Stores written before per-message switches have no flags: everything is on.
        const flags = Array.isArray(store.messageEnabled) ? store.messageEnabled : [];
        const normalized: SessionAutoInsert = {
          enabled: store.enabled !== false,
          messages,
          messageEnabled: messages.map((_, index) => flags[index] !== false),
        };
        autoInsertStoreRef.current = normalized;
        setSessionAutoInsert(normalized);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, []);

  async function saveAutoInsert(data: SessionAutoInsert) {
    try {
      const store = autoInsertStoreRef.current;
      store.messages = data.messages;
      store.messageEnabled = data.messageEnabled;
       store.enabled = data.enabled;
       await window.lopster?.saveAutoInsert?.(data);
    } catch { /* ignore */ }
  }

  useEffect(() => {
    messagesRef.current = messages;
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const prev = sessionLiveRef.current.get(sid) || emptyLiveState();
    sessionLiveRef.current.set(sid, { ...prev, messages });
  }, [messages]);

  useEffect(() => {
    rootPathRef.current = rootPath;
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    const configured = providerConfig.models.find((item) => item.id === selectedModelId)?.contextLimit;
    setResolvedContextLimit(Number(configured) > 0 ? Number(configured) : null);
    void window.lopster?.getModelLimits?.(selectedModelId).then((limits) => {
      if (!cancelled && Number(limits?.context) > 0) setResolvedContextLimit(Number(limits.context));
    }).catch(() => {
      // Keep model metadata fallback when the catalog is unavailable.
    });
    return () => { cancelled = true; };
  }, [selectedModelId, providerConfig.models]);

  useEffect(() => {
    selectedModelIdRef.current = selectedModelId;
  }, [selectedModelId]);

  useEffect(() => {
    agentModeRef.current = agentMode;
  }, [agentMode]);

  useEffect(() => {
    activeSessionIdRef.current = activeSessionId;
    setMessageQueue(messageQueuesRef.current.get(activeSessionId || "") || []);
    setThinking(Boolean(activeSessionId && runningBySession[activeSessionId]));
    setActiveOneShot(Boolean(activeSessionId && oneShotBySession[activeSessionId]));
  }, [activeSessionId, runningBySession, oneShotBySession]);

  // Feed the shell rail: whether ANY session of this panel is streaming (so a
  // background panel still shows "think"), plus how many chats it holds.
  useEffect(() => {
    onStatusChange?.(slotId, {
      running: Object.values(runningBySession).some(Boolean),
      sessionCount: sessions.length,
    });
  }, [runningBySession, sessions.length, slotId, onStatusChange]);

  // Keep active-session live meta in the per-session cache so switches restore progress UI.
  useEffect(() => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const prev = sessionLiveRef.current.get(sid) || emptyLiveState();
    sessionLiveRef.current.set(sid, {
      ...prev,
      toolActivity,
      assistantDrafts,
      liveTimeline,
      thinkingDraft,
      agentTodos,
      contextTokens,
      compactionBanner,
      agentStatusLabel,
      retryInfo,
      compacting,
      labInPackage,
    });
    toolActivityRef.current = toolActivity;
    assistantDraftsRef.current = assistantDrafts;
    liveTimelineRef.current = liveTimeline;
    thinkingDraftRef.current = thinkingDraft;
  }, [
    toolActivity,
    assistantDrafts,
    liveTimeline,
    thinkingDraft,
    agentTodos,
    contextTokens,
    compactionBanner,
    agentStatusLabel,
    retryInfo,
    compacting,
    labInPackage,
  ]);

  const persist = useCallback(
    (
      path: string | null = rootPathRef.current,
      sessionId: string | null = activeSessionIdRef.current,
      modelId: string | null = selectedModelIdRef.current,
      mode: MainAgentMode = agentModeRef.current
    ) => {
      onPersist({
        id: slotId,
        rootPath: path,
        sessionId,
        selectedModelId: modelId,
        agentMode: mode,
      });
    },
    [onPersist, slotId]
  );

  // If panel has no model yet, pick the global/first model once configs load — then persist.
  useEffect(() => {
    if (selectedModelId) return;
    const fallback = providerConfig.selectedModelId || providerConfig.models[0]?.id || null;
    if (!fallback) return;
    setSelectedModelId(fallback);
    selectedModelIdRef.current = fallback;
    persist(rootPathRef.current, activeSessionIdRef.current, fallback, agentModeRef.current);
  }, [providerConfig.selectedModelId, providerConfig.models, selectedModelId, persist]);

  const handleSelectModel = useCallback(
    (modelId: string) => {
      setSelectedModelId(modelId);
      selectedModelIdRef.current = modelId;
      persist(rootPathRef.current, activeSessionIdRef.current, modelId, agentModeRef.current);
    },
    [persist]
  );

  const handleSelectAgentMode = useCallback(
    (mode: MainAgentMode) => {
      setAgentMode(mode);
      agentModeRef.current = mode;
      // Mode switch must not wipe/half the ring — recompute full estimate if needed
      const sid = activeSessionIdRef.current;
      if (sid) {
        const live = sessionLiveRef.current.get(sid);
        if (live && !(typeof live.contextTokens === "number" && live.contextTokens > 0)) {
          const tokens =
            countMessagesTokens(toRequestMessages(messagesRef.current)) +
            (promptTokenEstimate ?? SYSTEM_PROMPT_OVERHEAD_ESTIMATE);
          if (tokens > 0) {
            setContextTokens(tokens);
            sessionLiveRef.current.set(sid, { ...live, contextTokens: tokens });
          }
        }
      }
      persist(rootPathRef.current, activeSessionIdRef.current, selectedModelIdRef.current, mode);
    },
    [persist]
  );

  // Tell the main process which folder this MultiIDE slot's Telegram bot should use.
  useEffect(() => {
    void window.lopster?.updateTelegramRuntimeContext?.({
      rootPath,
      projectName,
      slotId,
      sessionId: activeSessionId,
      selectedModelId,
      agentMode,
    });
  }, [rootPath, projectName, slotId, activeSessionId, selectedModelId, agentMode]);

  const markSessionRunning = (sessionId: string, running: boolean) => {
    const prev = runningBySessionRef.current;
    let next: Record<string, boolean>;
    if (running) {
      if (prev[sessionId]) return;
      next = { ...prev, [sessionId]: true };
    } else {
      if (!prev[sessionId]) return;
      next = { ...prev };
      delete next[sessionId];
    }
    runningBySessionRef.current = next;
    setRunningBySession(next);
  };

  const syncSessionQueue = (sessionId: string, next: QueuedChatMessage[]) => {
    if (!sessionId) return;
    if (next.length === 0) messageQueuesRef.current.delete(sessionId);
    else messageQueuesRef.current.set(sessionId, next);
    if (sessionId === activeSessionIdRef.current) setMessageQueue(next);
  };

  const clearMessageQueue = (sessionId?: string | null) => {
    const sid = sessionId ?? activeSessionIdRef.current;
    if (!sid) {
      setMessageQueue([]);
      return;
    }
    syncSessionQueue(sid, []);
  };

  const enqueueMessage = (
    content: string,
    sessionId?: string | null,
    images?: ChatImageAttachment[]
  ) => {
    const sid = sessionId ?? activeSessionIdRef.current;
    if (!sid) return;
    const item: QueuedChatMessage = {
      id: `q-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content,
      images: images?.length ? images : undefined,
    };
    const prev = messageQueuesRef.current.get(sid) || [];
    syncSessionQueue(sid, [...prev, item]);
  };

  const removeQueuedMessage = (id: string) => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const prev = messageQueuesRef.current.get(sid) || [];
    syncSessionQueue(
      sid,
      prev.filter((item) => item.id !== id)
    );
  };

  const editQueuedMessage = (id: string, content: string) => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const prev = messageQueuesRef.current.get(sid) || [];
    syncSessionQueue(
      sid,
      prev.map((item) => (item.id === id ? { ...item, content } : item))
    );
  };

  const clearAssistantDrafts = () => {
    assistantDraftsRef.current = [];
    setAssistantDrafts([]);
    liveTimelineRef.current = [];
    setLiveTimeline([]);
    thinkingDraftRef.current = null;
    setThinkingDraft(null);
  };

  const snapshotActiveSessionLive = () => {
    const sid = activeSessionIdRef.current;
    if (!sid) return;
    const prev = sessionLiveRef.current.get(sid) || emptyLiveState();
    sessionLiveRef.current.set(sid, {
      ...prev,
      messages: messagesRef.current,
      toolActivity: toolActivityRef.current,
      assistantDrafts: assistantDraftsRef.current,
      liveTimeline: liveTimelineRef.current,
      thinkingDraft: thinkingDraftRef.current,
      // Keep agent task list when switching chats mid-turn / after fail.
      agentTodos: prev.agentTodos,
    });
  };

  /**
   * The backend can resolve a temp "pending-…" run to a real session id (it creates
   * the session when the request carries sessionId:null). Bind the run + live cache
   * to that resolved id so progress events and the final answer keep flowing into
   * the visible chat instead of being dropped as "unknown session".
   */
  const adoptPendingRun = (resolvedId: string) => {
    const temp = pendingRunRef.current;
    if (!temp || temp === resolvedId) return;
    pendingRunRef.current = null;
    const live = sessionLiveRef.current.get(temp);
    if (live) {
      sessionLiveRef.current.delete(temp);
      sessionLiveRef.current.set(resolvedId, live);
    }
    if (activeSessionIdRef.current === null || activeSessionIdRef.current === temp) {
      activeSessionIdRef.current = resolvedId;
      setActiveSessionId(resolvedId);
      persist(rootPathRef.current, resolvedId);
    }
  };

  const applyLiveStateToUi = (state: SessionLiveState, sessionId: string, running: boolean) => {
    messagesRef.current = state.messages;
    setMessages(state.messages);
    toolActivityRef.current = state.toolActivity;
    setToolActivity(state.toolActivity);
    assistantDraftsRef.current = state.assistantDrafts;
    setAssistantDrafts(state.assistantDrafts);
    liveTimelineRef.current = state.liveTimeline;
    setLiveTimeline(state.liveTimeline);
    thinkingDraftRef.current = state.thinkingDraft || null;
    setThinkingDraft(state.thinkingDraft || null);
    setAgentTodos(state.agentTodos);
    // Full token figure: prefer saved session count; if missing, compute from messages + overhead
    let tokens = state.contextTokens;
    if (!(typeof tokens === "number" && tokens > 0) && state.messages?.length) {
      tokens =
        countMessagesTokens(toRequestMessages(state.messages)) +
        (promptTokenEstimate ?? SYSTEM_PROMPT_OVERHEAD_ESTIMATE);
    }
    setContextTokens(typeof tokens === "number" && tokens > 0 ? tokens : state.contextTokens);
    setCompactionBanner(state.compactionBanner);
    setAgentStatusLabel(state.agentStatusLabel);
    setRetryInfo(state.retryInfo);
    setLabInPackage(state.labInPackage);
    // Never rehydrate "compacting" when session is not actually running (stuck after quit mid-compact)
    const showCompacting = Boolean(state.compacting && running);
    setCompacting(showCompacting);
    if (state.compacting && !running) {
      sessionLiveRef.current.set(sessionId, { ...state, compacting: false, contextTokens: tokens ?? state.contextTokens });
    }
    setMessageQueue(messageQueuesRef.current.get(sessionId) || []);
    setThinking(running);
  };

  const cacheSessionFromDisk = (
    sessionId: string,
    messages: ChatMessage[],
    contextTokens: number | null
  ) => {
    // Don't wipe live progress if this session is mid-run and already cached.
    const existing = sessionLiveRef.current.get(sessionId);
    if (existing && (existing.toolActivity.length > 0 || existing.liveTimeline.length > 0 || existing.assistantDrafts.length > 0)) {
      sessionLiveRef.current.set(sessionId, {
        ...existing,
        messages: messages.length >= existing.messages.length ? messages : existing.messages,
        contextTokens: contextTokens ?? existing.contextTokens,
      });
      return;
    }
    sessionLiveRef.current.set(sessionId, {
      ...emptyLiveState(),
      messages,
      contextTokens,
      // Keep the LAB-IN "view what was found" button available after a turn ends,
      // across chat switches, until the next request is sent.
      labInPackage: existing?.labInPackage || null,
    });
  };

  const rememberOneShotFlags = (list: ChatSessionSummary[]) => {
    if (!Array.isArray(list) || list.length === 0) return;
    const next = { ...oneShotBySessionRef.current };
    let changed = false;
    for (const item of list) {
      if (!item?.sessionId) continue;
      const flag = item.oneShot === true;
      if (next[item.sessionId] !== flag) {
        next[item.sessionId] = flag;
        changed = true;
      }
    }
    if (!changed) return;
    oneShotBySessionRef.current = next;
    setOneShotBySession(next);
  };

  const setSessionOneShotFlag = (sessionId: string | null | undefined, enabled: boolean) => {
    if (!sessionId) return;
    const next = { ...oneShotBySessionRef.current, [sessionId]: enabled === true };
    oneShotBySessionRef.current = next;
    setOneShotBySession(next);
    if (sessionId === activeSessionIdRef.current) setActiveOneShot(enabled === true);
  };

  const refreshSessions = async (path: string | null) => {
    // Keep the slot state light: history itself loads its requested page on demand.
    // This refresh still supplies flags for the recent chats used by the live panel.
    const result = await window.lopster?.listChatSessionsPage?.(path, { page: 1, pageSize: 20 });
    const list = result?.sessions || (await window.lopster?.listChatSessions(path)) || [];
    setSessions(list);
    rememberOneShotFlags(list);
    return list;
  };

  const refreshPromptTokenEstimate = async (path: string | null, name?: string) => {
    try {
      const tokens = await window.lopster?.estimateContextTokens(path, name ?? projectName);
      setPromptTokenEstimate(typeof tokens === "number" ? tokens : null);
    } catch {
      setPromptTokenEstimate(null);
    }
  };

  const loadSession = async (path: string | null, sessionId?: string | null) => {
    // `active.json` is shared by every terminal that opens the same folder.
    // Never fall back to it here: an empty slot must stay empty rather than
    // silently adopting the session selected by a neighbouring slot.
    const session = sessionId
      ? await window.lopster?.loadChatSession(path, sessionId)
      : null;
    const sid = session?.sessionId ?? null;
    const visible = session?.messages?.length
      ? toVisibleChatMessages(session.messages, session.sessionId, session.updatedAt)
      : [];
    const tokens =
      typeof session?.contextTokens === "number" && session.contextTokens > 0 ? session.contextTokens : null;

    setActiveSessionId(sid);
    activeSessionIdRef.current = sid;
    if (sid) setSessionOneShotFlag(sid, session?.oneShot === true);
    else setActiveOneShot(false);

    if (sid) {
      cacheSessionFromDisk(sid, visible, tokens);
      const live = sessionLiveRef.current.get(sid) || {
        ...emptyLiveState(),
        messages: visible,
        contextTokens: tokens,
      };
      applyLiveStateToUi(live, sid, Boolean(runningBySessionRef.current[sid]));
    } else {
      applyLiveStateToUi(emptyLiveState(), "", false);
    }

    await refreshSessions(path);
    void refreshPromptTokenEstimate(path);
    persist(path, sid);

    // Rehydrate running flags only for sessions this slot already knows
    // (active / live-cached / queued). Do NOT claim other MultiIDE columns' runs.
    try {
      const running = (await window.lopster?.listRunningChatSessions?.()) || [];
      if (Array.isArray(running)) {
        for (const id of running) {
          if (typeof id !== "string" || !id) continue;
          const known =
            id === sid ||
            sessionLiveRef.current.has(id) ||
            messageQueuesRef.current.has(id) ||
            Boolean(runningBySessionRef.current[id]);
          if (known) markSessionRunning(id, true);
        }
      }
    } catch {
      /* ignore */
    }
  };

  // Bootstrap from persisted slot
  useEffect(() => {
    void loadSession(initialRootPath, initialSessionId || undefined);
    if (initialRootPath) {
      setProjectName(projectNameFromPath(initialRootPath));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Clear pending queue-drain timers on unmount so we don't send after the slot dies.
  useEffect(() => {
    return () => {
      for (const timer of queueDrainTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      queueDrainTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const unsub = window.lopster?.onAgentRunState?.((state) => {
      if (!state?.sessionId) return;
      // Track any session this slot already knows (active, running, queued, or live-cached).
      const sid = state.sessionId;
      if (pendingRunRef.current) adoptPendingRun(sid);
      const known =
        sid === activeSessionIdRef.current ||
        Boolean(runningBySessionRef.current[sid]) ||
        sessionLiveRef.current.has(sid) ||
        messageQueuesRef.current.has(sid);
      if (known) markSessionRunning(sid, Boolean(state.running));
      // Turn ended (stop/success/fail): never leave compact spinner stuck across re-entry
      if (known && state.running === false) {
        const live = sessionLiveRef.current.get(sid);
        if (live?.compacting) {
          sessionLiveRef.current.set(sid, { ...live, compacting: false });
        }
        if (sid === activeSessionIdRef.current) {
          setCompacting(false);
        }
      }
    });
    return () => unsub?.();
  }, []);

  useEffect(() => {
    let flushTimer: number | null = null;
    const dirtySessions = new Set<string>();

    const flushUi = () => {
      flushTimer = null;
      const activeSid = activeSessionIdRef.current;
      if (activeSid && dirtySessions.has(activeSid)) {
        const next = sessionLiveRef.current.get(activeSid);
        if (next) {
          toolActivityRef.current = next.toolActivity;
          assistantDraftsRef.current = next.assistantDrafts;
          liveTimelineRef.current = next.liveTimeline;
          thinkingDraftRef.current = next.thinkingDraft || null;
          setToolActivity(next.toolActivity);
          setAssistantDrafts(next.assistantDrafts);
          setLiveTimeline(next.liveTimeline);
          setThinkingDraft(next.thinkingDraft || null);
          setAgentTodos(next.agentTodos);
          if (typeof next.contextTokens === "number" && next.contextTokens > 0) {
            setContextTokens(next.contextTokens);
          }
          setCompacting(next.compacting);
          setRetryInfo(next.retryInfo);
          setLabInPackage(next.labInPackage);
          if (next.agentStatusLabel !== undefined) {
            setAgentStatusLabel(next.agentStatusLabel);
          }
          messagesRef.current = next.messages;
          setMessages(next.messages);
        }
      }
      dirtySessions.clear();
    };

    const scheduleFlush = () => {
      if (flushTimer != null) return;
      flushTimer = window.setTimeout(flushUi, UI_PROGRESS_FLUSH_MS);
    };

    const unsubscribe = window.lopster?.onAgentProgress((progress) => {
      const sid = progress.sessionId || activeSessionIdRef.current;
      if (!sid) return;
      // Backend may have resolved a temp "pending-…" run to a real session id —
      // adopt it so this slot accepts the stream and the final answer.
      if (pendingRunRef.current) adoptPendingRun(sid);

      const known =
        sid === activeSessionIdRef.current ||
        Boolean(runningBySessionRef.current[sid]) ||
        sessionLiveRef.current.has(sid) ||
        messageQueuesRef.current.has(sid);
      if (!known) return;

      const prev = sessionLiveRef.current.get(sid) || emptyLiveState();
      const next = applyProgressToLiveState(prev, progress);
      sessionLiveRef.current.set(sid, next);

      if (
        progress.type === "status" &&
        (progress.agentMode === "lopster" || progress.agentMode === "lab-in" || progress.agentMode === "fortani")
      ) {
        if (typeof progress.label === "string" && progress.label) {
          const live = sessionLiveRef.current.get(sid);
          if (live) {
            sessionLiveRef.current.set(sid, { ...live, agentStatusLabel: progress.label });
          }
        }
      }

      if (sid !== activeSessionIdRef.current) return;

      dirtySessions.add(sid);
      const urgent =
        progress.type === "tool_start" ||
        progress.type === "tool_end" ||
        progress.type === "todo_update" ||
        progress.type === "status" ||
        progress.type === "retry" ||
        progress.type === "compact_start" ||
        progress.type === "compact_end" ||
        progress.type === "subagent_status" ||
        progress.type === "assistant_text" ||
        progress.type === "ask_user" ||
        progress.type === "ask_otp" ||
        progress.type === "lab_in_package";
      if (urgent) {
        if (flushTimer != null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushUi();
      } else {
        scheduleFlush();
      }
    });
    return () => {
      if (flushTimer != null) window.clearTimeout(flushTimer);
      unsubscribe?.();
    };
  }, []);

  const applyCompactedMessages = (compactedMessages: ChatRequestMessage[], banner: CompactionInfo) => {
    let next = toVisibleChatMessages(compactedMessages, `compacted-${Date.now()}`);
    // Never drop the latest real user bubble when compact rewrites history mid-turn.
    const prevUser = [...messagesRef.current].reverse().find((m) => m.role === "user" && m.content?.trim());
    const hasUser = next.some((m) => m.role === "user" && m.content?.trim());
    if (prevUser && !hasUser) {
      next = [
        prevUser,
        ...next,
      ];
    }
    messagesRef.current = next;
    setMessages(next);
    setCompactionBanner(banner);
    // Keep a REAL full token number after compact — never null (ring must stay complete).
    const after =
      typeof banner.tokensAfter === "number" && banner.tokensAfter > 0
        ? banner.tokensAfter
        : countMessagesTokens(compactedMessages) + (promptTokenEstimate ?? SYSTEM_PROMPT_OVERHEAD_ESTIMATE);
    setContextTokens(after);
    const sid = activeSessionIdRef.current;
    if (sid) {
      const live = sessionLiveRef.current.get(sid) || emptyLiveState();
      sessionLiveRef.current.set(sid, {
        ...live,
        messages: next,
        contextTokens: after,
        compacting: false,
        compactionBanner: banner,
      });
    }
    window.setTimeout(() => setCompactionBanner(null), 5000);
  };

  const estimatedTokens = useMemo(() => {
    // Prefer authoritative session/provider count when present and positive.
    if (typeof contextTokens === "number" && contextTokens > 0) return contextTokens;
    // Full estimate: visible messages + system/prompt overhead (never partial "half ring").
    const msgTokens = countMessagesTokens(toRequestMessages(messages));
    const overhead = promptTokenEstimate ?? SYSTEM_PROMPT_OVERHEAD_ESTIMATE;
    return Math.max(0, msgTokens + overhead);
  }, [messages, promptTokenEstimate, contextTokens]);

  useEffect(() => {
    try {
      window.dispatchEvent(
        new CustomEvent(CONTEXT_METRICS_EVENT, {
          detail: { slotId, tokens: estimatedTokens },
        })
      );
    } catch {
      /* ignore */
    }
  }, [slotId, estimatedTokens]);

  const handleOpenFolder = async () => {
    try {
      const root = await window.lopster?.openFolder();
      if (!root?.path) return;

      // A folder's active.json is shared across all terminals. Reset this
      // slot to a fresh, unbound state before loading so it never inherits the
      // other terminal's active conversation for the same folder.
      snapshotActiveSessionLive();
      setRootPath(root.path);
      rootPathRef.current = root.path;
      setProjectName(root.name || projectNameFromPath(root.path));
      setActiveSessionId(null);
      activeSessionIdRef.current = null;
      setActiveOneShot(false);
      applyLiveStateToUi(emptyLiveState(), "", false);
      persist(root.path, null);
      await loadSession(root.path, null);
    } catch (error) {
      console.error("Failed to open workspace folder:", error);
    }
  };

  const handleCopySession = async () => {
    const sessionId = activeSessionIdRef.current;
    if (!sessionId) return;
    const result = await window.lopster?.copyChatSession(rootPathRef.current, sessionId);
    if (!result?.copied) console.error("Failed to copy chat session:", result?.error);
  };

  const handlePasteSession = async () => {
    const pasted = await window.lopster?.pasteChatSession(rootPathRef.current);
    if (!pasted) return;
    snapshotActiveSessionLive();
    setActiveSessionId(pasted.sessionId);
    activeSessionIdRef.current = pasted.sessionId;
    setSessionOneShotFlag(pasted.sessionId, pasted.oneShot === true);
    const visible = toVisibleChatMessages(pasted.messages || [], pasted.sessionId, pasted.updatedAt);
    const tokens = typeof pasted.contextTokens === "number" && pasted.contextTokens > 0 ? pasted.contextTokens : null;
    const live = { ...emptyLiveState(), messages: visible, contextTokens: tokens };
    sessionLiveRef.current.set(pasted.sessionId, live);
    applyLiveStateToUi(live, pasted.sessionId, false);
    clearMessageQueue(pasted.sessionId);
    await refreshSessions(rootPathRef.current);
    void refreshPromptTokenEstimate(rootPathRef.current);
    persist(rootPathRef.current, pasted.sessionId);
  };

  const deskWaitingRef = useRef(false);
  const deskSessionIdRef = useRef<string | null>(null);
  const reportDesk = (text: string) => {
    if (!deskWaitingRef.current) return;
    deskWaitingRef.current = false;
    const sid = deskSessionIdRef.current;
    const live = sid ? sessionLiveRef.current.get(sid) : undefined;
    const tail = (live?.messages || [])
      .filter((message) => message.role === "user")
      .slice(-4)
      .map((message) => String(message.content || "").replace(/\s+/g, " ").slice(0, 160))
      .join("\n");
    window.lopster?.deskReply?.({ text, context: tail });
  };

  const ensureDeskSession = async () => {
    const existing = deskSessionIdRef.current
      ? sessionLiveRef.current.get(deskSessionIdRef.current)
      : undefined;
    const polluted = (existing?.messages || []).some((message) =>
      String(message.content || "").includes("CLEAR")
    );
    if (deskSessionIdRef.current && !polluted) return deskSessionIdRef.current;
    deskSessionIdRef.current = null;
    const created = await window.lopster?.createChatSession(rootPathRef.current, {
      setActive: false,
      title: "Wallpaper",
    });
    const sid = created?.sessionId || null;
    if (!sid) return null;
    deskSessionIdRef.current = sid;
    sessionLiveRef.current.set(sid, emptyLiveState());
    return sid;
  };

  useEffect(() => {
    if (!focused) return;
    const offPrompt = window.lopster?.onDeskPrompt?.((payload) => {
      const text = String(payload?.text || "").trim();
      if (!text) return;
      void (async () => {
        const sid = await ensureDeskSession();
        if (!sid) return;
        deskWaitingRef.current = true;
        void executeSendMessage(text, { sessionId: sid, agentMode: "lopster", isolated: true });
      })();
    });
    const offClear = window.lopster?.onDeskClear?.(() => {
      deskWaitingRef.current = false;
      deskSessionIdRef.current = null;
      window.lopster?.deskReply?.({ text: "", context: "" });
    });
    return () => {
      offPrompt?.();
      offClear?.();
    };
  }, [focused]);

  const handleNewChat = async () => {
    const created = await window.lopster?.createChatSession(rootPath);
    if (!created) return;
    snapshotActiveSessionLive();
    setActiveSessionId(created.sessionId);
    activeSessionIdRef.current = created.sessionId;
    setSessionOneShotFlag(created.sessionId, created.oneShot === true);
    sessionLiveRef.current.set(created.sessionId, emptyLiveState());
    applyLiveStateToUi(emptyLiveState(), created.sessionId, false);
    clearMessageQueue(created.sessionId);
    await refreshSessions(rootPath);
    void refreshPromptTokenEstimate(rootPath);
    persist(rootPath, created.sessionId);
  };

  const handleToggleOneShot = async () => {
    const sid = activeSessionIdRef.current;
    if (!sid || !window.lopster?.updateChatSessionMeta) return;
    const next = !(oneShotBySessionRef.current[sid] === true);
    setSessionOneShotFlag(sid, next);
    try {
      await window.lopster.updateChatSessionMeta(rootPathRef.current, sid, { oneShot: next });
      setSessions((prev) =>
        prev.map((s) => (s.sessionId === sid ? { ...s, oneShot: next } : s))
      );
    } catch (error) {
      setSessionOneShotFlag(sid, !next);
      console.error("Failed to update one-shot flag:", error);
    }
  };

  const handleSelectSession = async (sessionId: string) => {
    if (sessionId === activeSessionId) return;
    // Freeze current chat's live UI so we can restore it when switching back mid-run.
    snapshotActiveSessionLive();

    const cached = sessionLiveRef.current.get(sessionId);
    const isRunning = Boolean(runningBySessionRef.current[sessionId]);
    const hasLiveProgress = Boolean(
      cached &&
        (cached.toolActivity.length > 0 ||
          cached.liveTimeline.length > 0 ||
          cached.assistantDrafts.length > 0 ||
          cached.compacting ||
          cached.retryInfo)
    );

    // While a session is running (or still has buffered live UI), restore memory — do not wipe with disk.
    if (cached && (isRunning || hasLiveProgress)) {
      setActiveSessionId(sessionId);
      activeSessionIdRef.current = sessionId;
      applyLiveStateToUi(cached, sessionId, isRunning);
      void refreshPromptTokenEstimate(rootPath);
      persist(rootPath, sessionId);
      return;
    }

    const session = await window.lopster?.loadChatSession(rootPath, sessionId);
    if (!session) return;
    const visible = toVisibleChatMessages(session.messages, session.sessionId, session.updatedAt);
    const tokens =
      typeof session.contextTokens === "number" && session.contextTokens > 0 ? session.contextTokens : null;
    setActiveSessionId(session.sessionId);
    activeSessionIdRef.current = session.sessionId;
    setSessionOneShotFlag(session.sessionId, session.oneShot === true);
    cacheSessionFromDisk(session.sessionId, visible, tokens);
    const live = sessionLiveRef.current.get(session.sessionId) || {
      ...emptyLiveState(),
      messages: visible,
      contextTokens: tokens,
    };
    applyLiveStateToUi(live, session.sessionId, Boolean(runningBySessionRef.current[session.sessionId]));
    void refreshPromptTokenEstimate(rootPath);
    persist(rootPath, session.sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    if (runningBySessionRef.current[sessionId]) {
      void window.lopster?.stopGeneration(sessionId);
      markSessionRunning(sessionId, false);
    }
    messageQueuesRef.current.delete(sessionId);
    sessionLiveRef.current.delete(sessionId);
    await window.lopster?.deleteChatSession(rootPath, sessionId);
    if (sessionId === activeSessionId) await handleNewChat();
    else await refreshSessions(rootPath);
  };

  const handleCompact = async () => {
    const modelId = selectedModelIdRef.current;
    if (compacting || messages.length === 0 || !modelId) return;
    const sid = activeSessionIdRef.current;
    setCompacting(true);
    setCompactNotice(null);
    if (sid) {
      const live = sessionLiveRef.current.get(sid) || emptyLiveState();
      sessionLiveRef.current.set(sid, { ...live, compacting: true });
    }
    try {
      const response = await window.lopster?.compactChat({
        messages: toRequestMessages(messages),
        modelId,
        rootPath,
        sessionId: activeSessionId,
      });
        if (response && response.removedCount > 0) {
        applyCompactedMessages(response.compactedMessages, {
          tokensBefore: response.tokensBefore,
          tokensAfter: response.tokensAfter,
          removedCount: response.removedCount,
        });
      } else {
        setCompactNotice({ text: labels.nothingToCompact, tone: "info" });
        window.setTimeout(() => setCompactNotice(null), 4000);
      }
    } catch (error) {
      setCompactNotice({
        text: `${labels.compactFailed}${error instanceof Error ? `: ${error.message}` : ""}`,
        tone: "error",
      });
      window.setTimeout(() => setCompactNotice(null), 6000);
    } finally {
      // ALWAYS clear compacting — including if app was mid-compact and user returns later
      setCompacting(false);
      if (sid) {
        const live = sessionLiveRef.current.get(sid) || emptyLiveState();
        sessionLiveRef.current.set(sid, { ...live, compacting: false });
      }
    }
  };

  /**
   * Start the next queued user message ONLY after the previous turn is fully done
   * and the final assistant bubbles have had a chance to paint.
   * Immediate drain felt like the next request "jumped" before the answer finished rendering.
   */
  const drainMessageQueue = (sessionId: string) => {
    if (!sessionId) return;
    const existing = queueDrainTimersRef.current.get(sessionId);
    if (existing) {
      window.clearTimeout(existing);
      queueDrainTimersRef.current.delete(sessionId);
    }

    // Wait for React commit + browser paint, then a short settle so the answer is visible
    // before the next turn starts (tools/status flash, scroll, etc.).
    const PAINT_SETTLE_MS = 450;
    const run = () => {
      queueDrainTimersRef.current.delete(sessionId);
      // Still running (another turn started) → leave queue alone.
      if (runningBySessionRef.current[sessionId]) return;
      const queue = messageQueuesRef.current.get(sessionId) || [];
      if (queue.length === 0) return;
      const [next, ...rest] = queue;
      syncSessionQueue(sessionId, rest);
      void executeSendMessage(next.content, { sessionId, images: next.images });
    };

    // Double rAF ≈ after layout/paint of the final messages we just setState'd.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const timer = window.setTimeout(run, PAINT_SETTLE_MS);
        queueDrainTimersRef.current.set(sessionId, timer);
      });
    });
  };

  /** Panel-level auto-insert: one switch shared by every chat in this panel. */
  const handleToggleAutoInsert = useCallback(() => {
    setSessionAutoInsert((prev) => {
      const next = { ...prev, enabled: !prev.enabled };
      autoInsertStoreRef.current.enabled = next.enabled;
      void saveAutoInsert(next);
      return next;
    });
  }, []);

  const handleAddAutoInsertMessage = useCallback((text: string) => {
    setSessionAutoInsert((prev) => {
      // New messages start switched ON.
      const next = {
        ...prev,
        messages: [...prev.messages, text],
        messageEnabled: [...prev.messageEnabled, true],
      };
      autoInsertStoreRef.current.messages = next.messages;
      autoInsertStoreRef.current.messageEnabled = next.messageEnabled;
      void saveAutoInsert(next);
      return next;
    });
  }, []);

  const handleRemoveAutoInsertMessage = useCallback((index: number) => {
    setSessionAutoInsert((prev) => {
      const next = {
        ...prev,
        messages: prev.messages.filter((_, i) => i !== index),
        messageEnabled: prev.messages
          .map((_, i) => prev.messageEnabled[i] !== false)
          .filter((_, i) => i !== index),
      };
      autoInsertStoreRef.current.messages = next.messages;
      autoInsertStoreRef.current.messageEnabled = next.messageEnabled;
      void saveAutoInsert(next);
      return next;
    });
  }, []);

  /** Per-message switch: unticked messages stay saved but are left out of sends. */
  const handleToggleAutoInsertMessage = useCallback((index: number) => {
    setSessionAutoInsert((prev) => {
      if (index < 0 || index >= prev.messages.length) return prev;
      const messageEnabled = prev.messages.map(
        (_, i) => (i === index ? prev.messageEnabled[i] === false : prev.messageEnabled[i] !== false)
      );
      const next = { ...prev, messageEnabled };
      autoInsertStoreRef.current.messageEnabled = messageEnabled;
      void saveAutoInsert(next);
      return next;
    });
  }, []);

  const handleSendMessage = (content: string, images?: ChatImageAttachment[], options?: { skipAutoInsert?: boolean }) => {	    const trimmed = content.trim();
	    const imgs = images?.length ? images : undefined;
	    if (!trimmed && !imgs?.length) return;
	    const sid = activeSessionIdRef.current;
	    if (sid && runningBySessionRef.current[sid]) {
	      enqueueMessage(trimmed, sid, imgs);
	      return;
	    }
		    void executeSendMessage(trimmed, { images: imgs, skipAutoInsert: options?.skipAutoInsert });
  };

  const executeSendMessage = async (
    content: string,
    options?: {
      sessionId?: string | null;
      images?: ChatImageAttachment[];
      agentMode?: MainAgentMode;
      isolated?: boolean;
      skipAutoInsert?: boolean;
    }
  ) => {
    let effectiveContent = content;
    const sendImages = options?.images?.length ? options.images : undefined;

    const autoInsert = autoInsertStoreRef.current;
    const enabled = autoInsert.enabled;
    // Only ticked messages are appended; unticked ones stay saved but are skipped.
    const enabledAutoInsertMessages = autoInsert.messages.filter(
      (_, index) => (autoInsert.messageEnabled || [])[index] !== false
    );
    if (!options?.skipAutoInsert && enabled && enabledAutoInsertMessages.length > 0) {
      effectiveContent = [effectiveContent, ...enabledAutoInsertMessages].filter(Boolean).join("\n\n");
    }

    let runSessionId = options?.sessionId || activeSessionIdRef.current;
    if (!runSessionId) {
      try {
        const created = await window.lopster?.createChatSession(rootPath);
        runSessionId = created?.sessionId || null;
        if (runSessionId) {
          setActiveSessionId(runSessionId);
          activeSessionIdRef.current = runSessionId;
          setSessionOneShotFlag(runSessionId, created?.oneShot === true);
          await refreshSessions(rootPath);
          persist(rootPath, runSessionId);
        }
      } catch (error) {
        console.error("Failed to create chat session:", error);
      }
    }
    if (!runSessionId) runSessionId = `pending-${Date.now().toString(16)}`;
    pendingRunRef.current = runSessionId.startsWith("pending-") ? runSessionId : null;
    // Mutable mirror of the run's session id — the backend can resolve a temp id
    // mid-run; updating this ref (not the let) keeps TS narrowing intact elsewhere.
    const runSessionRef: { current: string } = { current: runSessionId };

    const isViewingRunSession = () => activeSessionIdRef.current === runSessionRef.current;

    // One-shot: when this chat already has a finished transcript, wipe everything
    // before the next user turn so the model only sees the new request.
    const oneShotEnabled = oneShotBySessionRef.current[runSessionId] === true;
    if (oneShotEnabled && !runSessionId.startsWith("pending-")) {
      const liveBefore = sessionLiveRef.current.get(runSessionRef.current);
      const priorMessages = isViewingRunSession()
        ? messagesRef.current
        : liveBefore?.messages || [];
      if (priorMessages.length > 0) {
        try {
          await window.lopster?.clearChatSessionTranscript?.(rootPath, runSessionId, {
            oneShot: true,
          });
        } catch (error) {
          console.error("Failed to clear one-shot transcript:", error);
        }
        const wiped = emptyLiveState();
        sessionLiveRef.current.set(runSessionRef.current, wiped);
        if (isViewingRunSession()) {
          applyLiveStateToUi(wiped, runSessionId, false);
        }
        clearMessageQueue(runSessionId);
      }
    }

    const userMsg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      role: "user",
      content: effectiveContent,
      timestamp: Date.now(),
      images: sendImages,
    };

    if (isViewingRunSession()) {
      const nextMessages = [...messagesRef.current, userMsg];
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
    } else {
      // Background/queued turn for a non-visible session: keep user turn in live cache.
      const prev = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
      sessionLiveRef.current.set(runSessionRef.current, {
        ...prev,
        messages: [...prev.messages, userMsg],
      });
    }

    const modelIdAtSend = selectedModelIdRef.current;
    if (!modelIdAtSend) {
      if (isViewingRunSession()) {
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: `${Date.now()}-no-model`,
              role: "assistant" as const,
              content: labels.selectModel,
              timestamp: Date.now(),
            },
          ];
          messagesRef.current = next;
          return next;
        });
      }
      return;
    }

    if (runningBySessionRef.current[runSessionId]) {
      enqueueMessage(content, runSessionId, sendImages);
      return;
    }

    markSessionRunning(runSessionId, true);
    // Ensure progress events for this session are accepted + buffered even if user switches away.
    if (!sessionLiveRef.current.has(runSessionId)) {
      sessionLiveRef.current.set(runSessionRef.current, {
        ...emptyLiveState(),
        messages: isViewingRunSession() ? messagesRef.current : [userMsg],
      });
    }
    const modeAtSend = options?.agentMode || agentModeRef.current;
    // Keep unfinished agent todos across fail/abort/retry — except one-shot fresh turns.
    const liveBeforeTurn = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
    const keptTodos = oneShotEnabled
      ? []
      : (liveBeforeTurn.agentTodos || []).filter((todo) => todo && todo.status !== "completed");
    const todos: TodoItem[] = [...keptTodos];

    if (isViewingRunSession()) {
      setToolActivity([]);
      toolActivityRef.current = [];
      clearAssistantDrafts();
      setRetryInfo(null);
      setLabInPackage(null);
      setAgentTodos(todos);
      const initialStatus =
          modeAtSend === "lab-in"
            ? "LAB-IN · improving prompt…"
            : modeAtSend === "fortani"
              ? "FoRtani · LAB-IN starting…"
              : null;
      const liveStatus = initialStatus || (thinkingMaxRef.current ? "Thinking-max" : null);
      if (liveStatus) setAgentStatusLabel(liveStatus);
      sessionLiveRef.current.set(runSessionRef.current, {
        ...(sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState()),
        messages: messagesRef.current,
        toolActivity: [],
        assistantDrafts: [],
        liveTimeline: [],
        agentTodos: todos,
        retryInfo: null,
        agentStatusLabel: liveStatus,
        thinkingMaxLocked: thinkingMaxRef.current,
        thinkingTokens: 0,
        compacting: false,
        labInPackage: null,
      });
    } else {
      const prev = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
      sessionLiveRef.current.set(runSessionRef.current, {
        ...prev,
        toolActivity: [],
        assistantDrafts: [],
        liveTimeline: [],
        // Preserve unfinished todos when user is viewing another session mid-run.
        agentTodos: todos,
        retryInfo: null,
        agentStatusLabel: thinkingMaxRef.current
          ? "Thinking-max"
          : modeAtSend === "lab-in"
            ? "LAB-IN · improving prompt…"
            : modeAtSend === "fortani"
              ? "FoRtani · LAB-IN starting…"
              : null,
        thinkingMaxLocked: thinkingMaxRef.current,
        thinkingTokens: 0,
        compacting: false,
        labInPackage: null,
      });
    }

    let completedSuccessfully = false;
    try {
      // lopster — no local pre-processing; LAB-IN/FoRtani pipelines run in the main process.
      if (isViewingRunSession()) {
        setAgentStatusLabel(
          thinkingMaxRef.current
            ? "Thinking-max"
            : modeAtSend === "lab-in"
              ? "LAB-IN · improving prompt…"
              : modeAtSend === "fortani"
                ? "FoRtani · LAB-IN starting…"
                : null
        );
      }
      // Rebuild tool calls/results from toolSteps so send/merge never drops tool history
      // that only exists in the UI projection after rehydrate.
      const requestMessages = options?.isolated
        ? [
            {
              role: "user" as const,
              content: buildUserRequestContent(effectiveContent, sendImages),
              images: sendImages,
            },
          ]
        : isViewingRunSession()
        ? toRequestMessages(messagesRef.current)
        : [
            {
              role: "user" as const,
              content: buildUserRequestContent(effectiveContent, sendImages),
              images: sendImages,
            },
          ];

      const requestAgentMode: MainAgentMode =
        modeAtSend === "lab-in" || modeAtSend === "fortani" ? modeAtSend : "lopster";

      const response = await window.lopster?.sendChatRequest({
        modelId: modelIdAtSend,
        messages: requestMessages,
        rootPath,
        projectName,
        sessionId: runSessionId.startsWith("pending-") ? null : runSessionId,
        agentMode: requestAgentMode,
        thinkingMax: thinkingMaxRef.current,
        // Rehydrate unfinished agent tasks into the tool so fail/abort does not lose them.
        seedTodos: keptTodos,
      });

      const responseMeta = response as
        | { contextLimit?: unknown; model?: { contextLimit?: unknown } }
        | undefined;
      const resolvedLimit = Number(responseMeta?.contextLimit ?? responseMeta?.model?.contextLimit);
      if (Number.isFinite(resolvedLimit) && resolvedLimit > 0) setResolvedContextLimit(resolvedLimit);

      if (response?.sessionId) {
          const resolvedId = String(response.sessionId);
          const viewingBefore = isViewingRunSession();
          if (pendingRunRef.current) adoptPendingRun(resolvedId);
          if (resolvedId !== runSessionRef.current) {
            // Backend resolved/rotated the session: move buffered live UI to the new id
            // and (if the user is still watching this chat) bind the UI to it so the
            // final answer lands in the visible column instead of an orphaned cache key.
            const tempLive = sessionLiveRef.current.get(runSessionRef.current);
            if (tempLive && !sessionLiveRef.current.has(resolvedId)) {
              sessionLiveRef.current.delete(runSessionRef.current);
              sessionLiveRef.current.set(resolvedId, tempLive);
            }
            if (
              viewingBefore ||
              activeSessionIdRef.current === runSessionRef.current ||
              activeSessionIdRef.current === null
            ) {
              activeSessionIdRef.current = resolvedId;
              setActiveSessionId(resolvedId);
              persist(rootPath, resolvedId);
            }
            runSessionRef.current = resolvedId;
          }
        }

        const buildCompletionBubbles = (
          sourceTools: AgentToolProgress[],
          sourceTimeline: LiveTimelineItem[],
          finalTextRaw: string,
          finalImages?: ChatImageAttachment[]
        ): ChatMessage[] => {
          const stamp = Date.now();

          // Keep latest state per toolCallId (tool_end merges over tool_start).
          // Mid-turn status / narration events are never materialised as chat bubbles.
          const toolsById = new Map<string, AgentToolProgress>();
          const toolsWithoutId: AgentToolProgress[] = [];
          for (const step of sourceTools || []) {
            if (!step) continue;
            if (
              step.type === "assistant_text" ||
              step.type === "todo_update" ||
              step.type === "context_usage" ||
              step.type === "retry" ||
              step.type === "compact_start" ||
              step.type === "compact_end" ||
              step.type === "auto_continue" ||
              step.type === "status" ||
              step.type === "subagent_status"
            ) {
              continue;
            }
            if (step.toolCallId) toolsById.set(step.toolCallId, step);
            else if (step.name) toolsWithoutId.push(step);
          }

          // One ordered tool list for the whole turn (timeline order, then leftovers).
          const orderedTools: AgentToolProgress[] = [];
          const seenIds = new Set<string>();
          for (const item of sourceTimeline || []) {
            if (item.kind !== "tool") continue;
            const step = toolsById.get(item.toolCallId);
            if (!step || seenIds.has(item.toolCallId)) continue;
            seenIds.add(item.toolCallId);
            orderedTools.push(step);
          }
          for (const [id, step] of toolsById) {
            if (seenIds.has(id)) continue;
            seenIds.add(id);
            orderedTools.push(step);
          }
          orderedTools.push(...toolsWithoutId);

          // Snapshot so later clear of toolActivityRef cannot mutate history.
          const snapshotTools = (steps: AgentToolProgress[]) =>
            steps.map((step) => ({
              ...step,
              children: step.children ? [...step.children] : step.children,
            }));

          // Target shape after a turn ends:
          //   1) single "Used N tools" card (all tool results for the turn)
          //   2) single final assistant answer
          // Intermediate live narration ("Нашёл…", "Продолжаю…") is NOT kept as messages.
          const bubbles: ChatMessage[] = [];
          if (orderedTools.length > 0) {
            bubbles.push({
              id: `${stamp}-tools`,
              role: "assistant",
              content: "",
              timestamp: stamp,
              toolSteps: snapshotTools(orderedTools),
            });
          }

          const finalText = (finalTextRaw || "").trim();
          const imgs = finalImages?.length ? finalImages : undefined;
          if (finalText || imgs?.length) {
            bubbles.push({
              id: `${stamp}-final`,
              role: "assistant",
              content: finalText,
              timestamp: stamp,
              images: imgs,
            });
          } else if (bubbles.length === 0) {
            bubbles.push({
              id: `${stamp}-empty`,
              role: "assistant",
              content: finalTextRaw || "",
              timestamp: stamp,
            });
          }

          return bubbles;
        };

        if (isViewingRunSession()) {
          // Prefer provider/session count from the completed turn; never drop to null.
          const liveBefore = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
          const endTokens =
            typeof response?.contextTokens === "number" && response.contextTokens > 0
              ? response.contextTokens
              : typeof liveBefore.contextTokens === "number" && liveBefore.contextTokens > 0
                ? liveBefore.contextTokens
                : null;
          if (typeof endTokens === "number" && endTokens > 0) {
            setContextTokens(endTokens);
          }
          if (response?.compactedMessages && response.compactionInfo) {
            applyCompactedMessages(response.compactedMessages, response.compactionInfo);
          }

          // Snapshot live tools/timeline BEFORE clearing — paint final bubbles first,
          // then drop Thinking in the same tick (React 18 batches) so there is no blank gap.
          const toolsSnap = toolActivityRef.current;
          const timelineSnap = liveTimelineRef.current;
          const responseImages = Array.isArray((response as { images?: ChatImageAttachment[] })?.images)
            ? (response as { images?: ChatImageAttachment[] }).images
            : undefined;
          const bubbles = buildCompletionBubbles(
            toolsSnap,
            timelineSnap,
            response?.text || "",
            responseImages
          );
          // Commit the authoritative transcript + cache synchronously before asking
          // React to paint it. Previously the cache was updated inside the setState
          // updater; a queued progress flush could run first, read the stale cache and
          // overwrite the just-finished answer. The answer then only reappeared after
          // the next turn reloaded the saved transcript from disk.
          const nextMessages = [...messagesRef.current, ...bubbles];
          messagesRef.current = nextMessages;
          const live = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
          sessionLiveRef.current.set(runSessionRef.current, {
            ...live,
            messages: nextMessages,
            toolActivity: [],
            assistantDrafts: [],
            liveTimeline: [],
            thinkingDraft: null,
            contextTokens:
              typeof endTokens === "number" && endTokens > 0
                ? endTokens
                : live.contextTokens,
            compacting: false,
            agentStatusLabel: null,
            retryInfo: null,
          });
          setMessages(nextMessages);
          clearAssistantDrafts();
          setToolActivity([]);
          toolActivityRef.current = [];
          setRetryInfo(null);
          setAgentStatusLabel(null);
          // Always clear compact spinner on successful turn end.
          setCompacting(false);
        } else {
          // User switched away: commit completion into the session live cache (not the active UI).
          const live = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
          const responseImages = Array.isArray((response as { images?: ChatImageAttachment[] })?.images)
            ? (response as { images?: ChatImageAttachment[] }).images
            : undefined;
          const bubbles = buildCompletionBubbles(
            live.toolActivity,
            live.liveTimeline,
            response?.text || "",
            responseImages
          );
          const nextMessages = [...live.messages, ...bubbles];
          const tokens =
            typeof response?.contextTokens === "number" && response.contextTokens > 0
              ? response.contextTokens
              : live.contextTokens;
          // Keep last agentTodos snapshot — do not wipe on completion of a background session.
          sessionLiveRef.current.set(runSessionRef.current, {
            ...emptyLiveState(),
            messages: nextMessages,
            contextTokens: tokens,
            agentTodos: live.agentTodos || [],
            labInPackage: live.labInPackage,
            compacting: false,
          });
        }
        // Clear running AFTER messages are staged — proxy may already be done; do not await list refresh.
      markSessionRunning(runSessionId, false);
      completedSuccessfully = true;
      reportDesk(response?.text || "");
      void refreshSessions(rootPath);
    } catch (error) {
      markSessionRunning(runSessionId, false);
      reportDesk(error instanceof Error ? error.message : "failed");
      if (isViewingRunSession()) {
        setRetryInfo(null);
        setAgentStatusLabel(null);
        // Error path must clear compact spinner even if compact_end never arrived.
        setCompacting(false);
        setMessages((prev) => {
          const next = [
            ...prev,
            {
              id: `${Date.now()}-error`,
              role: "assistant" as const,
              content: error instanceof Error ? error.message : labels.aiRequestFailed || "AI request failed",
              timestamp: Date.now(),
              toolSteps: toolActivityRef.current.length > 0 ? toolActivityRef.current : undefined,
            },
          ];
          messagesRef.current = next;
          return next;
        });
        clearAssistantDrafts();
        setToolActivity([]);
        toolActivityRef.current = [];
        // agentTodos stay as last todo_update snapshot (UI + live cache via effect) — never wipe on fail.
      } else {
        const live = sessionLiveRef.current.get(runSessionRef.current) || emptyLiveState();
        const errMsg: ChatMessage = {
          id: `${Date.now()}-error`,
          role: "assistant",
          content: error instanceof Error ? error.message : labels.aiRequestFailed || "AI request failed",
          timestamp: Date.now(),
          toolSteps: live.toolActivity.length > 0 ? live.toolActivity : undefined,
        };
        // Preserve agentTodos after failed background turn.
        sessionLiveRef.current.set(runSessionRef.current, {
          ...emptyLiveState(),
          messages: [...live.messages, errMsg],
          contextTokens: live.contextTokens,
          agentTodos: live.agentTodos || [],
          labInPackage: live.labInPackage,
          compacting: false,
        });
      }
    } finally {
      // Safety net if an early return skipped the explicit clear.
      pendingRunRef.current = null;
      markSessionRunning(runSessionId, false);
      if (isViewingRunSession()) {
        setRetryInfo(null);
        setAgentStatusLabel(null);
        // Always drop compact spinner on turn end (success, fail, abort).
        setCompacting(false);
        const live = sessionLiveRef.current.get(runSessionRef.current);
        if (live) {
          sessionLiveRef.current.set(runSessionRef.current, {
            ...live,
            compacting: false,
            retryInfo: null,
            agentStatusLabel: null,
          });
        }
      } else {
        const live = sessionLiveRef.current.get(runSessionRef.current);
        if (live) {
          sessionLiveRef.current.set(runSessionRef.current, {
            ...live,
            retryInfo: null,
            agentStatusLabel: null,
            compacting: false,
          });
        }
      }
      if (completedSuccessfully && providerConfig.aiRuntime?.agentCompletionNotifications !== false) {
        const slotLabel = (labels.slotN || "Slot {n}").replace("{n}", String(index + 1));
        const finishedName = projectName || slotLabel;
        void window.lopster?.notifyAgentComplete({
          body: (labels.agentFinished || "{name}: agent finished").replace("{name}", finishedName),
          force: document.visibilityState !== "visible",
          theme:
            document.documentElement.getAttribute("data-theme") ||
            window.localStorage.getItem("lopster-theme") ||
            "mono",
        });
      }
      drainMessageQueue(runSessionId);
    }
  };

  const handleStopGeneration = () => {
    const sid = activeSessionIdRef.current;
    // Optimistic UI: mark not-running immediately; main also stops registered tool work.
    if (sid) markSessionRunning(sid, false);
    void window.lopster?.stopGeneration(sid).catch(() => {
      /* best-effort */
    });
  };

  const slotLabel = String(index + 1).padStart(2, "0");
  const displayModels = providerConfig.models.map((item) =>
    item.id === selectedModelId && resolvedContextLimit
      ? { ...item, contextLimit: resolvedContextLimit }
      : item
  );

  return (
    <section
      className="multi-slot h-full min-w-0 flex-1 flex flex-col overflow-hidden"
      aria-label={`Chat terminal ${slotLabel}`}
    >
      <header className="multi-slot-header">
        <span className="multi-slot-index" aria-label={`Terminal ${slotLabel}`}>T{slotLabel}</span>
        <button
          type="button"
          onClick={() => void handleOpenFolder()}
          title={rootPath || labels.selectWorkspaceFolder || "Select workspace folder"}
          className="multi-slot-folder"
        >
          {rootPath ? (
            <span className="truncate block" title={rootPath}>
              {projectName}
            </span>
          ) : (
            <span className="text-ink-500">{labels.selectFolder || "Select folder…"}</span>
          )}
        </button>
      </header>
      <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
        <ChatPanel
          fill
          slotIndex={index}
          messages={messages}
          thinking={thinking}
          toolActivity={toolActivity}
          assistantDrafts={assistantDrafts}
          liveTimeline={liveTimeline}
          thinkingDraft={thinking ? thinkingDraft : null}
          messageQueue={messageQueue}
          onRemoveQueuedMessage={removeQueuedMessage}
          onEditQueuedMessage={editQueuedMessage}
          onClearMessageQueue={clearMessageQueue}
          statusLabel={
            agentStatusLabel ||
            (retryInfo ? `${labels.retrying} ${retryInfo.attempt}/${retryInfo.maxRetries}…` : undefined)
          }
          labInPackage={labInPackage}
          usedTokens={estimatedTokens}
           contextLimit={resolvedContextLimit || 500000}
          compacting={compacting}
          compactionBanner={compactionBanner}
          compactNotice={compactNotice}
          onCompact={handleCompact}
          sessions={sessions}
          activeSessionId={activeSessionId}
          runningSessionIds={runningBySession}
          onNewChat={handleNewChat}
          onCopySession={handleCopySession}
          onPasteSession={handlePasteSession}
          onDeleteSession={handleDeleteSession}
          oneShotEnabled={activeOneShot}
          onToggleOneShot={() => {
            void handleToggleOneShot();
          }}
          onRefreshSessions={() => {
            void refreshSessions(rootPath);
          }}
          autoInsertEnabled={sessionAutoInsert.enabled}
          autoInsertMessages={sessionAutoInsert.messages}
          autoInsertMessageEnabled={sessionAutoInsert.messageEnabled}
          onToggleAutoInsert={handleToggleAutoInsert}
          onToggleAutoInsertMessage={handleToggleAutoInsertMessage}
          onAddAutoInsertMessage={handleAddAutoInsertMessage}
          onRemoveAutoInsertMessage={handleRemoveAutoInsertMessage}
          agentTodos={agentTodos}
          rootPath={rootPath}
                    onSelectSession={handleSelectSession}
          providers={providerConfig.providers}
           models={displayModels}
          selectedModelId={selectedModelId || undefined}
          inlineHint={{
            enabled: providerConfig.aiRuntime?.inlineHintEnabled === true,
            modelId: providerConfig.aiRuntime?.inlineHintModelId || "",
          }}
          onSelectModel={handleSelectModel}
          agentMode={agentMode}
          onSelectAgentMode={handleSelectAgentMode}
          thinkingMaxEnabled={thinkingMaxEnabled}
          onToggleThinkingMax={toggleThinkingMax}
          onSend={handleSendMessage}
          onStop={handleStopGeneration}
          telegramSlotId={slotId}
          labels={labels}
        />
      </div>
    </section>
  );
};

export default MultiChatSlot;
