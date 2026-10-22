export interface FileNode {
  id: string;
  name: string;
  type: "file" | "folder";
  children?: FileNode[];
  language?: string;
  content?: string;
  path: string;
}

/** Attached / rendered chat image (data URL or remote URL). */
export interface ChatImageAttachment {
  id: string;
  /** Primary display / send URL (usually data:image/...;base64,...) */
  url: string;
  /** Alias of url for older callers */
  dataUrl?: string;
  mimeType?: string;
  name?: string;
  width?: number;
  height?: number;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  toolSteps?: AgentToolProgress[];
  /** User or assistant images shown in the bubble (click → lightbox). */
  images?: ChatImageAttachment[];
  reasoningContent?: string;
}

export type RunnerTrigger =
  | { type: "interval"; intervalMinutes: number }
  | { type: "off" };

export interface RunnerStats {
  totalRuns: number;
  totalErrors: number;
  totalToolCalls: number;
  lastMessage?: string | null;
}

export interface RunnerJob {
  id: string;
  name: string;
  prompt: string;
  modelId: string;
  rootPath?: string | null;
  projectName?: string | null;
  enabled: boolean;
  trigger: RunnerTrigger;
  maxRetries?: number;
  createdAt: number;
  updatedAt: number;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  lastStatus?: string | null;
  lastError?: string | null;
  lastReportId?: string | null;
  stats?: RunnerStats;
  running?: boolean;
  queued?: boolean;
}

export interface RunnerReportSummary {
  id: string;
  runnerId: string;
  runnerName: string;
  trigger?: string;
  message?: string | null;
  startedAt: number;
  finishedAt?: number | null;
  status: string;
  modelId?: string | null;
  modelName?: string | null;
  prompt?: string;
  summary?: string;
  error?: string | null;
  usage?: unknown;
  toolCount?: number;
}

export interface RunnerReport extends RunnerReportSummary {
  text?: string;
  toolSteps?: Array<{
    at?: number;
    type?: string;
    name?: string;
    label?: string;
    ok?: boolean;
    error?: string | null;
  }>;
}

export type ChatRequestRole = "system" | "user" | "assistant" | "tool";

/** OpenAI multimodal content part (subset used by the agent). */
export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface ChatRequestMessage {
  role: ChatRequestRole;
  /** Plain text or OpenAI multimodal parts (vision). */
  content: string | ChatContentPart[];
  toolCalls?: Array<{ id: string; name: string; input?: unknown }>;
  reasoning_content?: string;
  toolCallId?: string;
  toolName?: string;
  /** Optional parallel image list (normalized into content by adapters). */
  images?: ChatImageAttachment[];
}

export type ProviderFormat = "openai" | "openai-compat" | "anthropic" | "gemini";

export interface AIProvider {
  id: string;
  /** UI label (settings / selectors). Does not affect API protocol. */
  name: string;
  type: ProviderFormat;
  baseUrl: string;
  apiKey: string;
}

export interface AIModel {
  id: string;
  name: string;
  providerId: string;
  contextLimit: number;
  outputLimit?: number;
}

export type TokenCountingMode = "provider" | "auto";

export interface TelegramBotConfig {
  enabled: boolean;
  botToken: string;
  allowedChatIds: string[];
}

export interface TelegramBotStatus extends TelegramBotConfig {
  running: boolean;
  botUsername?: string;
  lastError?: string | null;
  lastOkAt?: number;
  reason?: string | null;
  /** MultiIDE slot id when status is per-chat (multi-1 … multi-4) */
  slotId?: string | null;
}

/** Per MultiIDE-slot Telegram bot settings (persisted separately from global ProviderConfig.telegram) */
export type TelegramSlotConfigs = Record<string, TelegramBotConfig>;

export interface AiRuntimeConfig {
  agentCompletionNotifications: boolean;
  /** Legacy field retained for config migration; runtime resolves this per model. */
  maxContextTokens?: number;
  /** Legacy field retained for config migration; runtime compacts automatically at 80%. */
  autoCompactTokens?: number;
  /** LAB-IN stage 1 prompt-refiner model. Empty = active main model. */
  labInPromptModelId?: string;
  /** LAB-IN stage 2 shared-knowledge search model. Empty = active main model. */
  labInSearchModelId?: string;
  /** FoRtani follow-up agent. Empty = active main model. */
  fortaniModelId?: string;
  /** Cloudflare account id for generate_image. */
  cloudflareAccountId?: string;
  /** Cloudflare API token for Workers AI image generation. */
  cloudflareApiToken?: string;
}

export interface ProviderConfig {
  providers: AIProvider[];
  models: AIModel[];
  selectedModelId?: string;
  tokenCountingMode?: TokenCountingMode;
  telegram?: TelegramBotConfig;
  aiRuntime?: AiRuntimeConfig;
}

/** CF Mail (cf_mail) tool credentials — persisted under runtime-app/data/config.json. */
export interface CfMailConfig {
  cfworker_api_url: string;
  cfworker_admin_token: string;
  cfworker_domain: string;
  cfworker_fingerprint: string;
  enable_prefix: boolean;
  configured?: boolean;
  config_path?: string;
}

export interface ProjectSearchResult {
  id: string;
  type: "file" | "content";
  name: string;
  path: string;
  relativePath: string;
  line: number;
  preview: string;
  score: number;
}

export interface KnowledgeChunkSummary {
  id: string;
  title: string;
  file: string;
  tags: string[];
  links: string[];
  source: string;
  hash: string;
  charCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeChunk extends KnowledgeChunkSummary {
  content: string;
  path: string;
}

export interface KnowledgeListResponse {
  root: string;
  manifestPath: string;
  chunkCount: number;
  totalChars: number;
  updatedAt: number;
  chunks: KnowledgeChunkSummary[];
}

/** lopster = ComposeVC; lab-in = refine + research + execute; fortani = lab-in then a follow-up agent */
export type MainAgentMode = "lopster" | "lab-in" | "fortani";

export interface ChatExecutionRequest {
  modelId: string;
  messages: ChatRequestMessage[];
  rootPath?: string | null;
  projectName?: string | null;
  sessionId?: string | null;
  agentMode?: MainAgentMode;
  /** Force at least one custom Thinking-max cycle before the final answer. */
  thinkingMax?: boolean;
  /**
   * Unfinished agent todos from a previous turn (e.g. after a failed generation).
   * Rehydrated into the agent todo tool so tasks survive crash/abort/retry.
   */
  seedTodos?: TodoItem[];
}

export interface CompactionInfo {
  tokensBefore: number;
  tokensAfter: number;
  removedCount: number;
}

export interface McpToolInfo {
  name: string;
  publicName: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpServer {
  id: string;
  name: string;
  title: string;
  description?: string;
  type: "local" | "remote";
  enabled: boolean;
  command?: string;
  args?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout?: { startup?: number; request?: number };
  marketplace?: { registry?: string; name?: string; version?: string; repository?: string };
  envSpec?: Array<{ name: string; description?: string; required?: boolean; secret?: boolean }>;
  headerSpec?: Array<{ name: string; description?: string; required?: boolean; secret?: boolean }>;
  needsProjectPath?: boolean;
  status?: "connected" | "disconnected" | "disabled" | "error";
  tools?: McpToolInfo[];
  createdAt?: number;
  updatedAt?: number;
}

/** Agent-authored custom tool — FOLDER TOOL (real code in userData/custom-tools/<name>/). */
export interface CustomTool {
  id: string;
  name: string;
  title: string;
  description?: string;
  /** Folder meta: { kind:'folder', runtime, entry, timeout_ms, toolDir } — NOT a CTL body */
  body: Record<string, unknown>;
  inputSchema?: Record<string, unknown>;
  enabled?: boolean;
  tags?: string[];
  dependencies?: string[];
  createdAt?: number;
  updatedAt?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimated?: boolean;
}

export interface ChatExecutionResponse {
  text: string;
  provider: AIProvider;
  model: AIModel;
  sessionId?: string;
  sessionTitle?: string;
  usage?: TokenUsage;
  contextTokens?: number;
  contextLimit?: number;
  outputLimit?: number;
  /** Assistant-generated images from multimodal providers (data URLs / http). */
  images?: ChatImageAttachment[];
  compactedMessages?: ChatRequestMessage[];
  compactionInfo?: CompactionInfo;
  stopped?: boolean;
  agentMode?: MainAgentMode | string;
  /** LAB-IN preparation summary (prompt refinement + audited shared-memory research). */
  labIn?: {
    ok?: boolean;
    stopped?: boolean;
    error?: string;
    chunkCount?: number;
    knowledgeRoot?: string;
    promptModelId?: string;
    promptModelName?: string;
    searchModelId?: string;
    searchModelName?: string;
    coverage?: boolean;
    searchPasses?: number;
    truncated?: boolean;
    warnings?: string[];
    counts?: { search: number; read: number; links: number; total: number };
    required?: { search: number; read: number; links: number };
  };
  /** swarm subagent-batch summary (workers done → main verifies). */
  swarm?: {
    ok?: boolean;
    runId?: string;
    okCount?: number;
    errorCount?: number;
    stoppedCount?: number;
    planned?: boolean;
    planNote?: string | null;
    stopped?: boolean;
    error?: string;
  };
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  pinned: boolean;
  createdAt: number;
  completedAt?: number;
}


export interface AgentToolProgress {
  type:
    | "tool_start"
    | "tool_end"
    | "tool_limit"
    | "assistant_text"
    /** Ephemeral model reasoning — live UI only, never persisted into chat messages. */
    | "assistant_thinking"
    | "compact_start"
    | "compact_end"
    | "auto_continue"
    | "retry"
    | "todo_update"
    | "subagent_status"
    | "context_usage"
    | "ask_user"
    | "ask_otp"
    | "status"
    | "work_timer";
  toolCallId?: string;
  name?: string;
  text?: string;
  /** assistant_text is an incremental token chunk rather than a completed assistant turn. */
  delta?: boolean;
  /** Human-readable status line. */
  label?: string;
  phase?: string;
  /** Thinking-max metadata. Raw private reasoning is never sent to the UI. */
  processId?: string;
  tokenDelta?: number;
  thinkCycle?: number;
  thinkCycleTarget?: number;
  agentMode?: MainAgentMode | string;
  /** swarm subagent-batch live meta (phase, workers). */
  swarm?: {
    phase?: string;
    runId?: string;
    workerLimit?: number;
    total?: number;
    completed?: number;
    okCount?: number;
    errorCount?: number;
    planned?: boolean;
  };
  input?: unknown;
  ok?: boolean;
  /** Optional short error text (e.g. compact_end failure). */
  error?: string;
  result?: unknown;
  reason?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  removedCount?: number;
  /** Live context window usage (updated after model steps and tools). */
  contextTokens?: number;
  estimated?: boolean;
  notification?: { title?: string; body?: string };
  kind?: string;
  iteration?: number;
  attempt?: number;
  maxRetries?: number;
  todos?: TodoItem[];
  limit?: number;
  attempted?: number;
  agentId?: string;
  /** When set, this progress belongs to a nested subagent under the parent spawn tool. */
  parentToolCallId?: string;
  status?: "running" | "done" | "stopped" | "error" | "queued";
  description?: string;
  mode?: string;
  /** Resolved model config id (may differ from API name). */
  modelId?: string;
  /** API model name sent to the provider. */
  modelName?: string;
  /** Human label for UI (prefer name over stale id like gpt-4o). */
  displayLabel?: string;
  /** Nested child tool steps (filled by the UI for spawn_subagent). */
  children?: AgentToolProgress[];
  statusText?: string;
  /** Which chat session this progress belongs to (multi-session runs). */
  sessionId?: string;
  /** spawn_subagent_batch: unit index 0..n-1 */
  index?: number;
  /** spawn_subagent_batch: total units */
  total?: number;
  completed?: number;
  concurrency?: number;
  /** True for per-unit progress rows inside a batch */
  unit?: boolean;
  /** True for parent batch summary card */
  batch?: boolean;
  queued?: boolean;
  /**
   * Batch parent only: live map of units (by agentId or index).
   * Filled by MultiChatSlot from subagent_status unit events.
   */
  units?: Array<{
    agentId: string;
    index?: number;
    description?: string;
    status?: string;
    statusText?: string;
    mode?: string;
    children?: AgentToolProgress[];
    answer?: string;
    ok?: boolean;
  }>;
}

export interface ChatSession {
  sessionId: string;
  title?: string;
  messages: ChatRequestMessage[];
  updatedAt: number;
  usage?: TokenUsage;
  contextTokens?: number;
  /**
   * Per-chat one-shot mode: first request runs to completion with full turn context;
   * the next user send wipes all prior transcript so every new request is a fresh context.
   */
  oneShot?: boolean;
}

export interface ChatSessionSummary {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageCount: number;
  /** Client-side: agent is running in this session (background-capable). */
  running?: boolean;
  /** Per-chat one-shot context mode (persisted with the session). */
  oneShot?: boolean;
}

/** A single server-side history page. The renderer never needs to load every chat at once. */
export interface ChatSessionPage {
  sessions: ChatSessionSummary[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  query: string;
}

/** A manually saved reference to a chat ID, stored in the user's JSON history. */
export interface ChatBookmark {
  id: string;
  chatId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
}

export interface CompactChatRequest {
  messages: ChatRequestMessage[];
  modelId: string;
  rootPath?: string | null;
  sessionId?: string | null;
  keepRecent?: number;
}

export interface CompactChatResponse {
  compactedMessages: ChatRequestMessage[];
  tokensBefore: number;
  tokensAfter: number;
  removedCount: number;
  summary?: string | null;
}

export type EditorTabKind = "text" | "image" | "audio";

export interface EditorTab {
  id: string;
  name: string;
  path: string;
  language: string;
  content: string;
  dirty: boolean;
  kind?: EditorTabKind;
  mediaUrl?: string;
  mimeType?: string;
  size?: number;
}

export interface ProblemItem {
  filePath: string;
  fileName: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

export interface ProjectTask {
  id: string;
  text: string;
  completed: boolean;
  createdAt: number;
  updatedAt: number;
}
