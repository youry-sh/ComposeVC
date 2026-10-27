type SizeworkoutEvent = {
  id: number;
  type: string;
  payload: unknown;
  createdAt: number;
};

type SizeworkoutWorkspace = {
  id: string;
  name: string;
  status: string;
  progress: number;
  activeTask: string | null;
  updatedAt: number;
  events: SizeworkoutEvent[];
};

type SizeworkoutUpdate = {
  workspaceId?: string;
  workspaceName?: string;
  status?: string;
  progress?: number;
  activeTask?: string | null;
  type?: string;
  payload?: unknown;
};

import { AgentToolProgress, CfMailConfig, ChatExecutionRequest, ChatExecutionResponse, ChatMessage, ChatRequestMessage, ChatSession, ChatSessionPage, ChatSessionSummary, CompactChatRequest, CompactChatResponse, ComposeVCPlugin, ComposeVCPluginConfig, ComposeVCPluginJob, ComposeVCPluginStatus, ComposeVCPluginsState, FileNode, KnowledgeChunk, KnowledgeChunkSummary, KnowledgeExportResult, KnowledgeImportCanceled, KnowledgeImportResult, KnowledgeListResponse, ProblemItem, ProjectSearchResult, ProviderConfig, TaskItem, RunnerJob, RunnerReport, RunnerReportSummary } from "./types";

/** Snapshot of a chat folder's repository — see electron/gitService.cjs */
export type GitStatus =
  | { isRepo: false; reason: "no-folder" | "not-a-repo" | "git-missing" | "error"; error?: string }
  | {
      isRepo: true;
      root: string;
      folderName: string;
      /** owner/repo from the origin URL, or the folder name when there is no remote */
      repoName: string;
      remoteUrl: string | null;
      branch: string | null;
      upstream: string | null;
      detached: boolean;
      ahead: number;
      behind: number;
      staged: number;
      modified: number;
      untracked: number;
      conflicted: number;
      dirty: boolean;
      lastCommit: { hash: string; subject: string; author: string; when: string } | null;
    };

export type GitAutoCommitResult = {
  ok: boolean;
  committed: boolean;
  /** Why nothing was committed — clean, conflicts, merge-in-progress, too-many, … */
  reason?: string;
  hash?: string | null;
  message?: string;
  files?: number;
  error?: string;
};

export type GitAutoPushResult = {
  ok: boolean;
  pushed: boolean;
  /** nothing-to-push, behind, detached, push-failed, not-a-repo, error */
  reason?: string;
  commits?: number;
  branch?: string;
  behind?: number;
  output?: string;
  error?: string;
};

export type StorageAccount = { phone: string; name: string; username?: string; isPremium: boolean; error?: string };
export type StorageFile = { path: string; name: string; size: number };
export type StorageItem = { id: string; phone: string; name: string; path: string; size: number; jobId: string; status: "queued" | "uploading" | "completed" | "failed"; progress: number; uploaded?: number; error?: string | null; resultId?: string | null; createdAt: number; updatedAt: number };

export type GitBranch = { name: string; current: boolean };
export type GitChangedFile = { code: string; staged: boolean; path: string };
export type GitCommit = { hash: string; subject: string; author: string; when: string };


declare global {
  type MultiIdeDiskWorkspace = {
    id: string;
    /** User-visible name; "" means the rail shows "Workspace N". */
    name?: string;
    activeId?: string | null;
    openIds?: string[];
  };

  type MultiIdeDiskSlot = {
    id: string;
    rootPath?: string | null;
    sessionId?: string | null;
    selectedModelId?: string | null;
    agentMode?: string;
    workspaceId?: string;
  };

  type MultiIdeDiskUi = {
    /** Left column (workspaces + chat panels) folded away. */
    railCollapsed?: boolean;
    /** Right column (overview + runners) folded away. */
    asideCollapsed?: boolean;
  };

  type MultiIdeDiskState = {
    version?: number;
    updatedAt?: number;
    activeWorkspaceId?: string | null;
    ui?: MultiIdeDiskUi;
    workspaces?: MultiIdeDiskWorkspace[];
    slots?: MultiIdeDiskSlot[];
  };

  type LocalAgentState = {
    agentDir: string;
    exists: boolean;
    busy: boolean;
    port: number;
    localOk: boolean;
    serverPids: number[];
    tunnelRunning: boolean;
    publicOk: boolean | null;
    running: boolean;
    error: string | null;
    connector: {
      name: string;
      url: string;
      transport: string;
      auth: string;
      prefix: string;
      token: string;
      description: string;
    };
    instruction: string;
  };
  /** Electron's <webview> guest — used by the aside media dock. */
  namespace JSX {
    interface IntrinsicElements {
      webview: import("react").DetailedHTMLProps<
        import("react").HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        src?: string;
        partition?: string;
        useragent?: string;
        preload?: string;
        httpreferrer?: string;
        allowpopups?: boolean;
        webpreferences?: string;
      };
    }
  }

  interface ComposeVCUpdateStatus {
    status:
      | "idle"
      | "dev"
      | "checking"
      | "available"
      | "downloading"
      | "downloaded"
      | "up-to-date"
      | "error";
    currentVersion: string;
    version?: string | null;
    percent?: number;
    transferred?: number;
    total?: number;
    bytesPerSecond?: number;
    releaseNotes?: string;
    releaseDate?: string | null;
    checkedAt?: number | null;
    error?: string | null;
    repo?: string;
    channel?: string;
    autoCheck?: boolean;
    autoDownload?: boolean;
    hasToken?: boolean;
    releasesUrl?: string;
  }

  interface Window {
    lopster?: {
      // ---- auto-update (GitHub Releases) ----
      updateStatus: () => Promise<ComposeVCUpdateStatus>;
      updateCheck: () => Promise<ComposeVCUpdateStatus>;
      updateDownload: () => Promise<ComposeVCUpdateStatus>;
      updateInstall: () => Promise<{ ok: boolean; error?: string }>;
      updateSetConfig: (patch: {
        token?: string;
        owner?: string;
        repo?: string;
        channel?: "latest" | "beta";
        autoCheck?: boolean;
        autoDownload?: boolean;
      }) => Promise<ComposeVCUpdateStatus>;
      updateOpenRelease: () => Promise<{ ok: boolean; url?: string }>;
      onUpdateStatus: (callback: (status: ComposeVCUpdateStatus) => void) => () => void;
      terminalEnsure: (id: "1" | "2") => Promise<{ id: string; pid: number; cwd: string }>;
      terminalInput: (id: "1" | "2", data: string) => void;
      terminalResize: (id: "1" | "2", cols: number, rows: number) => void;
      onTerminalData: (callback: (payload: { id: string; data: string }) => void) => () => void;
      onTerminalExit: (callback: (payload: { id: string; exitCode: number }) => void) => () => void;
      gitStatus: (rootPath: string | null) => Promise<GitStatus>;
      gitDetails: (
        rootPath: string | null,
        options?: { limit?: number }
      ) => Promise<{
        ok: boolean;
        branches?: GitBranch[];
        files?: GitChangedFile[];
        /** `git log --graph` lines: "<graph>\t<hash>\t<date>\t<author>\t<subject>" */
        graph?: string[];
        totalCommits?: number;
        shown?: number;
        error?: string;
      }>;
      gitAction: (
        rootPath: string | null,
        action: "fetch" | "pull" | "push" | "checkout",
        payload?: { branch?: string }
      ) => Promise<{ ok: boolean; output?: string; error?: string | null }>;
      gitAutoCommit: (
        rootPath: string | null,
        options?: { prefix?: string }
      ) => Promise<GitAutoCommitResult>;
      gitAutoPush: (rootPath: string | null) => Promise<GitAutoPushResult>;
      storageAccounts: () => Promise<{ ok: boolean; accounts?: StorageAccount[]; error?: string }>;
      storagePick: () => Promise<{ ok: boolean; canceled?: boolean; files?: StorageFile[]; error?: string }>;
      storageUpload: (input: { phone: string; filePath: string; caption?: string; premium?: boolean }) => Promise<{ ok: boolean; item?: StorageItem; error?: string }>;
      storageList: () => Promise<{ ok: boolean; items?: StorageItem[]; error?: string }>;
      storageDeleteHistory: (id: string) => Promise<{ ok: boolean }>;
      webEngineGetBinding: (chatKey: string) => Promise<{ url: string | null; updatedAt?: number | null; error?: string }>;
      webEngineSetBinding: (chatKey: string, url: string) => Promise<{ ok: boolean; url?: string; error?: string }>;
      webEngineProbeLocalhost: (rootPath: string | null) => Promise<{ ok: boolean; url: string | null; error?: string }>;
      webEngineCopyText: (text: string) => Promise<{ ok: boolean; error?: string }>;
      webEngineCaptureScreenshot: (webContentsId: number) => Promise<{ ok: boolean; error?: string }>;
      webEngineClearCache: () => Promise<{ ok: boolean; error?: string }>;
      // MultiIDE layout (workspaces + their chat panels) — disk-backed JSON store.
      multiIdeLoadState: () => Promise<MultiIdeDiskState>;
      multiIdeSaveState: (patch: {
        slots?: MultiIdeDiskSlot[];
        workspaces?: MultiIdeDiskWorkspace[];
        activeWorkspaceId?: string | null;
        ui?: MultiIdeDiskUi;
      }) => Promise<{ ok: boolean; state?: MultiIdeDiskState; error?: string }>;
      multiIdeLoadStateSync: () => MultiIdeDiskState;
      multiIdeSaveStateSync: (patch: {
        slots?: MultiIdeDiskSlot[];
        workspaces?: MultiIdeDiskWorkspace[];
        activeWorkspaceId?: string | null;
        ui?: MultiIdeDiskUi;
      }) => { ok: boolean; state?: MultiIdeDiskState; error?: string };
      // Expert workspace — whole-project study + prompt composer (disk-backed).
      expertLoadState: () => Promise<{
        version: number;
        ui: { activeSlot?: string };
        slots: Array<{
          id: string;
          rootPath: string | null;
          projectName: string | null;
          selectedModelId: string | null;
          sessionId: string | null;
          draft: string;
          updatedAt: number;
        }>;
        saved: Array<{
          id: string;
          name: string;
          sessionId: string;
          title: string;
          rootPath: string | null;
          projectName: string | null;
          messageCount: number;
          createdAt: number;
          updatedAt: number;
        }>;
      }>;
      expertSaveState: (patch: {
        slots?: Array<Record<string, unknown>>;
        ui?: Record<string, unknown>;
        saved?: Array<Record<string, unknown>>;
      }) => Promise<{ ok: boolean; error?: string }>;
      expertLoadStateSync: () => {
        version: number;
        ui: { activeSlot?: string };
        slots: Array<{
          id: string;
          rootPath: string | null;
          projectName: string | null;
          selectedModelId: string | null;
          sessionId: string | null;
          draft: string;
          updatedAt: number;
        }>;
        saved: Array<Record<string, unknown>>;
      };
      expertSaveStateSync: (patch: {
        slots?: Array<Record<string, unknown>>;
        ui?: Record<string, unknown>;
        saved?: Array<Record<string, unknown>>;
      }) => { ok: boolean; error?: string };
      expertSend: (payload: {
        slotId: string;
        task: string;
        modelId?: string | null;
        rootPath?: string | null;
        projectName?: string | null;
        sessionId?: string | null;
      }) => Promise<{
        ok: boolean;
        error?: string;
        runId?: string;
        sessionId?: string;
        title?: string;
        stopped?: boolean;
        contextTokens?: number;
        contextLimit?: number;
        study?: Record<string, unknown> | null;
        message?: {
          id: string;
          role: "user" | "assistant";
          content: string;
          createdAt: number;
          meta?: Record<string, unknown>;
        };
      }>;
      expertStop: (slotId: string) => Promise<{ ok: boolean; error?: string }>;
      expertStudy: (payload: {
        slotId: string;
        rootPath: string;
        projectName?: string | null;
        modelId?: string | null;
        sessionId?: string | null;
        force?: boolean;
      }) => Promise<{
        ok: boolean;
        error?: string;
        stopped?: boolean;
        meta?: Record<string, number | string>;
        study?: Record<string, unknown> | null;
      }>;
      expertSaveSnapshot: (payload: {
        slotId: string;
        name?: string;
        title?: string;
        rootPath?: string | null;
        projectName?: string | null;
        modelId?: string | null;
        sessionId?: string | null;
        messages?: Array<{
          id?: string;
          role: "user" | "assistant";
          content: string;
          createdAt?: number;
          meta?: Record<string, unknown>;
        }>;
      }) => Promise<{
        ok: boolean;
        error?: string;
        sessionId?: string;
        entry?: Record<string, unknown>;
      }>;
      expertLoadSession: (sessionId: string) => Promise<{
        sessionId: string;
        title: string;
        rootPath: string | null;
        projectName: string | null;
        messages: Array<{
          id: string;
          role: "user" | "assistant";
          content: string;
          createdAt: number;
          meta?: Record<string, unknown>;
        }>;
        updatedAt: number;
        contextTokens?: number;
        contextLimit?: number;
      } | null>;
      expertListSessions: (rootPath: string | null) => Promise<
        Array<{
          sessionId: string;
          title: string;
          rootPath: string | null;
          projectName: string | null;
          messageCount: number;
          promptCount: number;
          updatedAt: number;
          createdAt: number;
        }>
      >;
      expertNewSession: (input: {
        rootPath?: string | null;
        projectName?: string | null;
        slotId?: string | null;
      }) => Promise<{ ok: boolean; session?: Record<string, unknown>; error?: string }>;
      expertDeleteSession: (sessionId: string) => Promise<{ deleted: boolean }>;
      expertRenameSession: (
        sessionId: string,
        title: string
      ) => Promise<{ ok: boolean; session?: Record<string, unknown>; error?: string }>;
      expertSaveSession: (
        sessionId: string,
        name?: string
      ) => Promise<{ ok: boolean; entry?: Record<string, unknown>; error?: string }>;
      expertListSaved: () => Promise<
        Array<{
          id: string;
          name: string;
          sessionId: string;
          title: string;
          rootPath: string | null;
          projectName: string | null;
          messageCount: number;
          createdAt: number;
          updatedAt: number;
        }>
      >;
      expertDeleteSaved: (savedId: string) => Promise<{ deleted: boolean }>;
      expertOpenSaved: (input: {
        savedId: string;
        slotId?: string | null;
      }) => Promise<{ ok: boolean; session?: Record<string, unknown>; error?: string }>;
      expertCopySession: (payload: {
        sessionId: string;
      }) => Promise<{ ok: boolean; messageCount?: number; error?: string }>;
      expertPasteSession: (input: {
        rootPath?: string | null;
        projectName?: string | null;
        slotId?: string | null;
      }) => Promise<{ ok: boolean; session?: Record<string, unknown>; error?: string }>;
      expertStudyStatus: (rootPath: string | null) => Promise<{
        ok: boolean;
        study?: Record<string, unknown>;
        meta?: Record<string, number | string>;
      }>;
      expertReadDossier: (rootPath: string | null) => Promise<{
        ok: boolean;
        error?: string;
        meta?: Record<string, number | string>;
        dossier?: Record<string, unknown> | null;
        text?: string;
        digest?: string;
      }>;
      expertRestudy: (rootPath: string | null) => Promise<{ ok: boolean; error?: string }>;
      onExpertProgress: (callback: (payload: Record<string, unknown>) => void) => () => void;
      onOpenChatSwitcher: (callback: () => void) => () => void;
      onFoldWebDock: (callback: () => void) => () => void;
      onStorageOpen: (callback: () => void) => () => void;
      onShellHotkey: (
        callback: (
          payload:
            | {
                type: "panel";
                panel:
                  | "multiide"
                  | "webengine"
                  | "proxy"
                  | "runner"
                  | "terminal"
                  | "customtools"
                  | "plugins"
                  | "knowledge"
                  | "docs"
                  | "usage";
              }
            | { type: "toggle"; target: "search" | "settings" | "prompts" }
        ) => void
      ) => () => void;
      readProviderConfig: () => Promise<ProviderConfig>;
      writeProviderConfig: (config: ProviderConfig) => Promise<ProviderConfig>;
      readCfMailConfig: () => Promise<CfMailConfig>;
      writeCfMailConfig: (config: Partial<CfMailConfig>) => Promise<CfMailConfig>;
      testCfMail: () => Promise<{
        ok: boolean;
        configured?: boolean;
        status?: number;
        reason?: string;
      }>;
      listRunners: () => Promise<{ ok: boolean; runners?: RunnerJob[]; error?: string }>;
      getRunner: (id: string) => Promise<{ ok: boolean; runner?: RunnerJob; error?: string }>;
      createRunner: (input: {
        name?: string;
        prompt?: string;
        modelId?: string;
        rootPath?: string | null;
        projectName?: string | null;
        enabled?: boolean;
        trigger?: { type?: string; intervalMinutes?: number };
        maxRetries?: number;
      }) => Promise<{ ok: boolean; runner?: RunnerJob; error?: string }>;
      updateRunner: (
        id: string,
        patch: {
          name?: string;
          prompt?: string;
          modelId?: string;
          rootPath?: string | null;
          projectName?: string | null;
          enabled?: boolean;
          trigger?: { type?: string; intervalMinutes?: number };
          maxRetries?: number;
        }
      ) => Promise<{ ok: boolean; runner?: RunnerJob; error?: string }>;
      deleteRunner: (id: string) => Promise<{ ok: boolean; error?: string }>;
      runRunner: (id: string, opts?: {
        message?: string;
      }) => Promise<{
        ok: boolean;
        queued?: boolean;
        status?: string;
        report?: RunnerReport;
        error?: string;
      }>;
      stopRunner: (id: string) => Promise<{ ok: boolean; error?: string }>;
      listRunnerReports: (opts?: {
        limit?: number;
        runnerId?: string | null;
      }) => Promise<{ ok: boolean; reports?: RunnerReportSummary[]; error?: string }>;
      getRunnerReport: (runnerId: string, reportId: string) => Promise<{
        ok: boolean;
        report?: RunnerReport;
        error?: string;
      }>;
      deleteRunnerReport: (runnerId: string, reportId: string) => Promise<{
        ok: boolean;
        error?: string;
      }>;
      onRunnersChanged: (callback: (payload: {
        runners?: RunnerJob[];
        deleted?: boolean;
        id?: string;
      }) => void) => () => void;
      onRunnerReportChanged: (
        callback: (payload: { report?: RunnerReport; deleted?: boolean; id?: string }) => void
      ) => () => void;
      onRunnerStatus: (
        callback: (payload: {
          runnerId?: string;
          reportId?: string;
          status?: string;
          nextRunAt?: number | null;
          trigger?: string;
        }) => void
      ) => () => void;
      onRunnerProgress: (
        callback: (payload: { runnerId?: string; reportId?: string; progress?: unknown }) => void
      ) => () => void;
      onRunnerOpenSendModal: (callback: (payload: Record<string, unknown>) => void) => () => void;
      updateTelegramRuntimeContext: (context: {
        rootPath: string | null;
        projectName: string;
        slotId?: string;
        sessionId?: string | null;
        selectedModelId?: string | null;
        agentMode?: string;
        title?: string | null;
        messageCount?: number;
        running?: boolean;
        lastMessagePreview?: string;
      }) => Promise<boolean>;
      getTelegramStatus: (slotId?: string) => Promise<{
        enabled: boolean;
        botToken: string;
        allowedChatIds: string[];
        running: boolean;
        botUsername?: string;
        lastError?: string | null;
        lastOkAt?: number;
        reason?: string | null;
        slotId?: string | null;
      }>;
      getTelegramSlotStatus: (slotId: string) => Promise<{
        enabled: boolean;
        botToken: string;
        allowedChatIds: string[];
        running: boolean;
        botUsername?: string;
        lastError?: string | null;
        lastOkAt?: number;
        reason?: string | null;
        slotId?: string | null;
      }>;
      getTelegramSlotConfig: (slotId: string) => Promise<{
        enabled: boolean;
        botToken: string;
        allowedChatIds: string[];
      }>;
      configureTelegramSlot: (
        slotId: string,
        config: { enabled: boolean; botToken: string; allowedChatIds: string[] }
      ) => Promise<{
        enabled: boolean;
        botToken: string;
        allowedChatIds: string[];
        running: boolean;
        botUsername?: string;
        lastError?: string | null;
        lastOkAt?: number;
        reason?: string | null;
        slotId?: string | null;
      }>;
      listTelegramSlots: () => Promise<
        Record<
          string,
          {
            enabled: boolean;
            botToken: string;
            allowedChatIds: string[];
            running: boolean;
            botUsername?: string;
            lastError?: string | null;
            lastOkAt?: number;
            reason?: string | null;
            slotId?: string | null;
          }
        >
      >;
      newWindow: () => Promise<boolean | { ok: boolean; instanceId?: string; error?: string }>;
      openProxySubview: (view: "usage" | "settings") => Promise<{ ok: boolean; error?: string }>;
      sendChatRequest: (request: ChatExecutionRequest) => Promise<ChatExecutionResponse>;
      /** Ghost-text autocomplete for the chat composer (whole draft + caret). */
      inlineHintSuggest: (request: {
        text: string;
        caret?: number;
        modelId?: string | null;
        projectName?: string | null;
      }) => Promise<{ ok: boolean; text?: string; model?: string; error?: string }>;
      getModelLimits: (modelId: string | null) => Promise<{ context: number | null; output: number | null }>;
      sizeworkoutSnapshot: (workspaceId?: string | null) => Promise<{
        ok: boolean;
        workspaces: SizeworkoutWorkspace | SizeworkoutWorkspace[] | null;
      }>;
      sizeworkoutUpdate: (input: SizeworkoutUpdate) => Promise<{ ok: boolean; workspace: SizeworkoutWorkspace }>;
      sizeworkoutReset: (workspaceId?: string) => Promise<{ ok: boolean; workspace: SizeworkoutWorkspace }>;
      onSizeworkoutChanged: (callback: (payload: { ok: boolean; workspace: SizeworkoutWorkspace }) => void) => () => void;
      stopGeneration: (
        sessionId?: string | null
      ) => Promise<boolean | { ok: boolean; aborted?: boolean; killReport?: unknown }>;
      listRunningChatSessions: () => Promise<string[]>;
      onAgentRunState: (
        callback: (state: { sessionId: string; running: boolean; stopped?: boolean }) => void
      ) => () => void;
      answerUser: (payload: {
        toolCallId: string;
        answer?: string;
        selected?: string[];
      }) => Promise<{ ok: boolean; error?: string }>;
      notifyAgentComplete: (payload: { title?: string; body?: string; force?: boolean; theme?: string }) => Promise<{ shown: boolean; reason?: string; mode?: string }>;
      onPlayAgentCompleteSound: (callback: (soundUrl: string) => void) => () => void;
      compactChat: (request: CompactChatRequest) => Promise<CompactChatResponse>;
      loadChatSession: (rootPath: string | null, sessionId?: string | null) => Promise<ChatSession>;
      listChatSessions: (rootPath: string | null) => Promise<ChatSessionSummary[]>;
      listChatSessionsPage: (
        rootPath: string | null,
        options?: { page?: number; pageSize?: number; query?: string }
      ) => Promise<ChatSessionPage>;
      createChatSession: (
        rootPath: string | null,
        options?: { setActive?: boolean; title?: string }
      ) => Promise<ChatSession>;
      listChatBookmarks: () => Promise<Array<{ id: string; chatId: string; name: string; createdAt: number; updatedAt: number }>>;
      saveChatBookmark: (bookmark: { chatId: string; name: string }) => Promise<{ id: string; chatId: string; name: string; createdAt: number; updatedAt: number }>;
      deleteChatBookmark: (bookmarkId: string) => Promise<{ deleted: boolean }>;
      copyChatSession: (
        rootPath: string | null,
        sessionId: string
      ) => Promise<{ copied: boolean; sessionId?: string; messageCount?: number; error?: string }>;
      pasteChatSession: (rootPath: string | null) => Promise<ChatSession | null>;
      deleteChatSession: (rootPath: string | null, sessionId: string) => Promise<{ deleted: boolean }>;
      updateChatSessionMeta: (
        rootPath: string | null,
        sessionId: string,
        patch: { oneShot?: boolean; title?: string }
      ) => Promise<ChatSession>;
      clearChatSessionTranscript: (
        rootPath: string | null,
        sessionId: string,
        options?: { oneShot?: boolean; title?: string }
      ) => Promise<ChatSession>;
      knowledgeList: () => Promise<KnowledgeListResponse>;
      knowledgeRead: (id: string) => Promise<KnowledgeChunk>;
      knowledgeCreate: (input: {
        title: string;
        content: string;
        tags?: string[];
        links?: string[];
        source?: string;
      }) => Promise<{ created: KnowledgeChunkSummary[]; duplicates: KnowledgeChunkSummary[] }>;
      knowledgeUpdate: (
        id: string,
        patch: { title?: string; content?: string; tags?: string[]; links?: string[]; source?: string }
      ) => Promise<KnowledgeChunkSummary>;
      knowledgeDelete: (id: string) => Promise<{ deleted: KnowledgeChunkSummary; trashPath: string }>;
      knowledgeExport: (rootPath?: string | null) => Promise<KnowledgeExportResult>;
      knowledgeImport: (
        zipPath?: string | null
      ) => Promise<KnowledgeImportResult | KnowledgeImportCanceled>;
      onKnowledgeChanged: (callback: (payload: {
        type?: "added" | "updated" | "deleted" | "changed" | string;
        chunk?: KnowledgeChunkSummary;
        chunks?: KnowledgeChunkSummary[];
        chunkId?: string;
      }) => void) => () => void;
      docsList: () => Promise<{
        version: number;
        sectionCount: number;
        updatedAt: number;
        sections: Array<{ id: string; title: string; summary: string; order: number; createdAt: number; updatedAt: number }>;
      }>;
      docsRead: (id: string) => Promise<{ id: string; title: string; summary: string; order: number; content: string; createdAt: number; updatedAt: number }>;
      docsAll: () => Promise<{
        version: number;
        sectionCount: number;
        updatedAt: number;
        sections: Array<{ id: string; title: string; summary: string; order: number; content: string; createdAt: number; updatedAt: number }>;
      }>;
      docsCreate: (input: { title: string; content: string; summary?: string; order?: number }) => Promise<{ id: string; title: string; summary: string; order: number; content: string; createdAt: number; updatedAt: number }>;
      docsUpdate: (id: string, patch: { title?: string; content?: string; summary?: string; order?: number }) => Promise<{ id: string; title: string; summary: string; order: number; content: string; createdAt: number; updatedAt: number }>;
      docsDelete: (id: string) => Promise<{ deleted: boolean; id?: string }>;
      onDocsChanged: (callback: (payload: { type?: string }) => void) => () => void;
      promptsList: () => Promise<{
        version: number;
        createdAt: number;
        updatedAt: number;
        prompts: Array<{ id: string; title: string; text: string; createdAt: number; updatedAt: number }>;
        error?: string;
      }>;
      promptsCreate: (input: { title: string; text: string }) => Promise<{ id: string; title: string; text: string; createdAt: number; updatedAt: number }>;
      promptsUpdate: (id: string, patch: { title?: string; text?: string }) => Promise<{ id: string; title: string; text: string; createdAt: number; updatedAt: number }>;
      promptsDelete: (id: string) => Promise<{ deleted: boolean; id?: string }>;
      promptsCopy: (id: string) => Promise<{ ok: boolean; title?: string; error?: string }>;
      onPromptsChanged: (callback: (payload: { type?: string }) => void) => () => void;
      pluginsList: () => Promise<ComposeVCPluginsState>;
      pluginsGet: (id: string) => Promise<{ ok: boolean; plugin?: ComposeVCPlugin; error?: string }>;
      pluginsUpdate: (
        id: string,
        patch: { enabled?: boolean; config?: Partial<ComposeVCPluginConfig> }
      ) => Promise<{ ok: boolean; plugin?: ComposeVCPlugin; error?: string }>;
      pluginsProbe: (
        id: string
      ) => Promise<{ ok: boolean; probe?: NonNullable<ComposeVCPluginStatus["probe"]>; error?: string }>;
      pluginsJobs: (options?: {
        limit?: number;
        pluginId?: string;
      }) => Promise<{ ok: boolean; jobs?: ComposeVCPluginJob[]; running?: string[]; error?: string }>;
      pluginsJob: (jobId: string) => Promise<{ ok: boolean; job?: ComposeVCPluginJob; error?: string }>;
      pluginsLog: (jobId: string) => Promise<{ ok: boolean; log?: string; path?: string; size?: number; error?: string }>;
      pluginsCancel: (jobId: string) => Promise<{ ok: boolean; canceled?: boolean; error?: string }>;
      pluginsDeleteJob: (jobId: string) => Promise<{ ok: boolean; error?: string }>;
      pluginsPreview: (
        jobId: string,
        name?: string
      ) => Promise<{ ok: boolean; dataUrl?: string; path?: string; bytes?: number; error?: string }>;
      pluginsPickExecutable: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      pluginsPickDirectory: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
      pluginsCopyArtifacts: (
        jobId: string,
        targetDir?: string
      ) => Promise<{ ok: boolean; folder?: string; copied?: string[]; outputDir?: string; error?: string }>;
      pluginsOpenPath: (jobId?: string, target?: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      pluginsOpenInBlender: (
        jobId?: string,
        blendPath?: string
      ) => Promise<{ ok: boolean; file?: string; executable?: string; error?: string }>;
      pluginsRunDemo: (id?: string) => Promise<{ ok: boolean; job?: ComposeVCPluginJob; error?: string }>;
      onPluginsChanged: (
        callback: (payload: { type?: string; pluginId?: string; jobId?: string; status?: string }) => void
      ) => () => void;
      onPluginJob: (
        callback: (payload: {
          jobId?: string;
          pluginId?: string;
          stage?: string;
          percent?: number;
          status?: string;
          done?: boolean;
          error?: string;
        }) => void
      ) => () => void;
      estimateContextTokens: (rootPath: string | null, projectName?: string) => Promise<number>;
      listMcpServers: () => Promise<import("./types").McpServer[]>;
      addMcpServer: (input: Partial<import("./types").McpServer> & { name: string }) => Promise<import("./types").McpServer>;
      updateMcpServer: (id: string, patch: Partial<import("./types").McpServer>) => Promise<import("./types").McpServer>;
      removeMcpServer: (id: string) => Promise<{ deleted: boolean; server?: import("./types").McpServer }>;
      connectMcpServer: (id: string) => Promise<{ server: import("./types").McpServer; tools: import("./types").McpToolInfo[] }>;
      disconnectMcpServer: (id: string) => Promise<{ disconnected: boolean; name: string }>;
      refreshMcpServer: (id: string) => Promise<{ server: import("./types").McpServer; tools: import("./types").McpToolInfo[] }>;
      inspectMcpServer: (id: string) => Promise<Record<string, unknown>>;
      importMcpConfig: (config: string | Record<string, unknown>, options?: { overwrite?: boolean }) => Promise<{ imported: number; servers: import("./types").McpServer[] }>;
      searchMcpRegistry: (options?: { query?: string; cursor?: string; limit?: number }) => Promise<{
        registry: string;
        servers: Array<{
          name: string;
          title: string;
          description: string;
          version: string;
          repository: string;
          transport: string;
          packageName: string;
          runtime: string;
          remoteUrl: string;
          raw: unknown;
        }>;
        nextCursor: string | null;
        count: number;
      }>;
      installMcpRegistry: (server: unknown, overrides?: { environment?: Record<string, string>; headers?: Record<string, string> }) => Promise<{ installed: boolean; already: boolean; updated?: boolean; server: import("./types").McpServer; warnings?: string[] }>;
      listProjectMcp: (rootPath: string | null) => Promise<{ rootPath: string | null; serverIds: string[] }>;
      setProjectMcp: (rootPath: string | null, serverId: string, enabled: boolean) => Promise<{ rootPath: string; serverIds: string[]; server: import("./types").McpServer }>;
      onMcpChanged: (callback: (payload: Record<string, unknown>) => void) => () => void;
      readCustomTools: () => Promise<
        Array<{
          id: string;
          name: string;
          title: string;
          description?: string;
          body: Record<string, unknown>;
          inputSchema?: Record<string, unknown>;
          enabled?: boolean;
          tags?: string[];
          createdAt?: number;
          updatedAt?: number;
        }>
      >;
      addCustomTool: (toolData: {
        name: string;
        title?: string;
        description?: string;
        code?: string;
        content?: string;
        files?: Array<{ path: string; content: string }>;
        runtime?: string;
        lang?: string;
        language?: string;
        entry?: string;
        body?: Record<string, unknown>;
        source?: string;
        inputSchema?: Record<string, unknown>;
        schema?: Record<string, unknown>;
        enabled?: boolean;
        tags?: string[];
        timeout_ms?: number;
      }) => Promise<{
        id: string;
        name: string;
        title: string;
        description?: string;
        body: Record<string, unknown>;
        inputSchema?: Record<string, unknown>;
        enabled?: boolean;
        tags?: string[];
        createdAt?: number;
        updatedAt?: number;
      }>;
      updateCustomTool: (
        toolId: string,
        toolData: {
          name?: string;
          title?: string;
          description?: string;
          code?: string;
          content?: string;
          files?: Array<{ path: string; content: string }>;
          runtime?: string;
          lang?: string;
          language?: string;
          entry?: string;
          body?: Record<string, unknown>;
          source?: string;
          inputSchema?: Record<string, unknown>;
          schema?: Record<string, unknown>;
          enabled?: boolean;
          tags?: string[];
          timeout_ms?: number;
        }
      ) => Promise<{
        id: string;
        name: string;
        title: string;
        description?: string;
        body: Record<string, unknown>;
        inputSchema?: Record<string, unknown>;
        enabled?: boolean;
        tags?: string[];
        createdAt?: number;
        updatedAt?: number;
      }>;
      readCustomToolFile: (toolId: string) => Promise<{
        ok: boolean;
        id: string;
        name: string;
        path: string;
        file: string;
        runtime: string;
        content: string;
      }>;
      removeCustomTool: (toolId: string) => Promise<{ deleted: boolean; tool?: unknown }>;
      exportCustomTools: (options?: {
        ids?: string[];
        names?: string[];
        name?: string;
        includeDisabled?: boolean;
        saveToFile?: boolean;
        dialog?: boolean;
        format?: "zip" | "json";
        zip?: boolean | string;
        path?: string;
        filePath?: string;
        includeWork?: boolean;
      }) => Promise<{
        pack?: {
          format?: string;
          version?: number;
          exportedAt?: number;
          count?: number;
          tools?: unknown[];
        };
        text?: string | null;
        count?: number;
        names?: string[];
        saved?: boolean;
        path?: string;
        canceled?: boolean;
        format?: string;
        bytes?: number;
        ok?: boolean;
      }>;
      previewCustomToolsImport: (payload?: {
        source?: unknown;
        text?: string;
        json?: string;
        pack?: unknown;
        path?: string;
        filePath?: string;
        zip?: boolean | string;
        format?: "zip" | "json";
        dialog?: boolean;
        openDialog?: boolean;
        names?: string[];
        name?: string;
        tool?: string;
        ids?: string[];
        indices?: number[];
        onlyOne?: boolean;
      }) => Promise<{
        ok?: boolean;
        canceled?: boolean;
        count?: number;
        totalInPack?: number;
        tools?: Array<{
          index?: number;
          id?: string;
          name?: string;
          title?: string;
          description?: string;
          kind?: string;
          enabled?: boolean;
          tags?: string[];
          valid?: boolean;
          error?: string | null;
        }>;
        path?: string | null;
        text?: string | null;
        format?: string | null;
      }>;
      importCustomTools: (payload?: {
        source?: unknown;
        text?: string;
        json?: string;
        pack?: unknown;
        path?: string;
        filePath?: string;
        zip?: boolean | string;
        format?: "zip" | "json";
        dialog?: boolean;
        openDialog?: boolean;
        mode?: "skip" | "overwrite" | "rename";
        onConflict?: "skip" | "overwrite" | "rename";
        names?: string[];
        name?: string;
        tool?: string;
        ids?: string[];
        indices?: number[];
        onlyOne?: boolean;
      }) => Promise<{
        ok?: boolean;
        canceled?: boolean;
        mode?: string;
        imported?: unknown[];
        updated?: unknown[];
        skipped?: unknown[];
        renamed?: Array<{ from: string; to: string }>;
        errors?: Array<{ index?: number; name?: string; error?: string }>;
        count?: number;
        totalInPack?: number;
        tools?: unknown[];
        path?: string | null;
        format?: string;
      }>;
      onCustomToolsChanged: (
        callback: (payload: {
          type?: string;
          tool?: unknown;
          toolId?: string;
          result?: unknown;
        }) => void
      ) => () => void;
      readInstructions: (rootPath: string | null) => Promise<{ global: string; project: string }>;
      saveGlobalInstructions: (content: string) => Promise<boolean>;
      saveProjectInstructions: (rootPath: string | null, content: string) => Promise<boolean>;
      readAutoInsertStore: () => Promise<{
        enabled: boolean;
        messages: string[];
        messageEnabled?: boolean[];
      }>;
      saveAutoInsert: (data: {
        enabled: boolean;
        messages: string[];
        messageEnabled?: boolean[];
      }) => Promise<boolean>;
      onDeskPrompt: (callback: (payload: { text?: string }) => void) => () => void;
      onDeskClear: (callback: () => void) => () => void;
      deskReply: (payload: { text?: string; context?: string }) => void;
      onAgentProgress: (callback: (progress: AgentToolProgress) => void) => () => void;
      getWorkTimer: () => Promise<{
        set: boolean;
        active: boolean;
        startedAt: number | null;
        deadlineAt: number | null;
        totalMinutes: number | null;
        sessionId: string | null;
        remainingSeconds: number;
        remainingMinutes: number;
        elapsedSeconds: number;
      }>;
      getBackgroundTasks: (sessionId: string | null) => Promise<{
        ok: boolean;
        tasks: Array<{
          id: string;
          pid: number;
          command: string;
          cwd: string;
          sessionId: string | null;
          startedAt: number;
          logFile: string | null;
        }>;
      }>;
      killBackgroundTask: (id: string) => Promise<{ ok: boolean; id?: string; pid?: number; error?: string }>;
      onBackgroundTasksChanged: (callback: (payload: unknown) => void) => () => void;
      openFolder: () => Promise<FileNode | null>;
      readFolder: (rootPath: string) => Promise<FileNode>;
      searchProject: (rootPath: string, query: string) => Promise<ProjectSearchResult[]>;
      readTasks: () => Promise<TaskItem[]>;
      saveTasks: (tasks: TaskItem[]) => Promise<TaskItem[]>;
      readFile: (filePath: string) => Promise<string>;
      readMediaFile: (filePath: string) => Promise<{ dataUrl: string; mimeType: string; size: number }>;
      writeFile: (filePath: string, content: string) => Promise<boolean>;
      createFile: (parentPath: string, name: string) => Promise<string>;
      createFolder: (parentPath: string, name: string) => Promise<string>;
      deletePath: (targetPath: string) => Promise<boolean>;
      movePath: (sourcePath: string, targetFolderPath: string) => Promise<string>;
      proxyGetConfig: () => Promise<{ ok: boolean; config?: any; status?: any }>;
      proxySaveConfig: (patch: Record<string, unknown>) => Promise<{
        ok: boolean;
        config?: any;
        status?: any;
        tunnel?: any;
        error?: string;
      }>;
      proxyStart: (opts?: { host?: string; port?: number }) => Promise<{ ok: boolean; status?: any; error?: string }>;
      proxyStop: () => Promise<{ ok: boolean; status?: any; error?: string }>;
      proxyStatus: () => Promise<{ ok: boolean; status?: any; logs?: any[] }>;
      proxyNgrokStatus: () => Promise<{ ok: boolean; ngrok?: any; status?: any }>;
      proxyNgrokRestart: () => Promise<{ ok: boolean; tunnel?: any; status?: any; error?: string }>;
      proxyCreateKey: (label?: string) => Promise<{ ok: boolean; key?: any; config?: any; error?: string }>;
      proxyDeleteKey: (keyId: string) => Promise<{ ok: boolean; config?: any }>;
      proxyToggleKey: (keyId: string, enabled: boolean) => Promise<{ ok: boolean; config?: any }>;
      proxyListProviders: () => Promise<{ ok: boolean; providers?: any[]; converters?: string[] }>;
      proxyAddCustomProvider: (input: {
        name?: string;
        baseUrl?: string;
        endpoint?: string;
        modelTag?: string;
        id?: string;
        models?: string | string[];
        model?: string;
        description?: string;
      }) => Promise<{
        ok: boolean;
        providerId?: string;
        provider?: any;
        config?: any;
        providers?: any[];
        error?: string;
      }>;
      proxyUpdateCustomProvider: (input: Record<string, unknown>) => Promise<{
        ok: boolean;
        config?: any;
        providers?: any[];
        error?: string;
      }>;
      proxyDeleteCustomProvider: (providerId: string) => Promise<{
        ok: boolean;
        config?: any;
        providers?: any[];
        error?: string;
      }>;
      proxyUpsertConnection: (input: Record<string, unknown>) => Promise<{ ok: boolean; connectionId?: string; config?: any; error?: string }>;
      proxyDeleteConnection: (id: string) => Promise<{ ok: boolean; config?: any }>;
      proxyAddApiKeyAccount: (input: Record<string, unknown>) => Promise<{
        ok: boolean;
        accountId?: string;
        config?: any;
        error?: string;
        duplicateKey?: boolean;
        duplicateCount?: number;
        duplicateProviders?: string[];
      }>;
      proxyDeleteAccount: (id: string) => Promise<{ ok: boolean; config?: any }>;
      proxyRefreshUsage: (accountId?: string | null) => Promise<{ ok: boolean; account?: any; config?: any; error?: string }>;
      proxyGetUsageStats: () => Promise<{
        ok: boolean;
        usage?: {
          totals?: {
            requests?: string;
            promptTokens?: string;
            completionTokens?: string;
            totalTokens?: string;
            streamRequests?: string;
            jsonRequests?: string;
            errorRequests?: string;
          };
          models?: Array<{
            id: string;
            requests?: string;
            promptTokens?: string;
            completionTokens?: string;
            totalTokens?: string;
            streamRequests?: string;
            jsonRequests?: string;
            errorRequests?: string;
          }>;
          providers?: Array<{
            id: string;
            requests?: string;
            promptTokens?: string;
            completionTokens?: string;
            totalTokens?: string;
            streamRequests?: string;
            jsonRequests?: string;
            errorRequests?: string;
          }>;
          modelCount?: number;
          providerCount?: number;
          updatedAt?: number;
          createdAt?: number;
        };
        error?: string;
      }>;
      proxyResetUsageStats: () => Promise<{ ok: boolean; usage?: any; error?: string }>;
      proxyClearAccountQuota: (accountId: string) => Promise<{
        ok: boolean;
        account?: any;
        config?: any;
        status?: any;
        error?: string;
      }>;
      proxyListModels: (opts?: {
        providerId?: string;
        accountId?: string | null;
        chatOnly?: boolean;
        refreshLive?: boolean;
      }) => Promise<{
        ok: boolean;
        source?: string;
        sources?: string[];
        models?: Array<{
          id: string;
          owned_by?: string;
          kind?: string;
          created?: number | null;
          source?: string;
        }>;
        count?: number;
        warning?: string;
        error?: string;
      }>;
      proxyAddModel: (input: {
        providerId?: string;
        id?: string;
        model?: string;
        kind?: string;
      }) => Promise<{ ok: boolean; models?: any[]; error?: string; warning?: string; source?: string }>;
      proxyRemoveModel: (input: {
        providerId?: string;
        id?: string;
        model?: string;
      }) => Promise<{ ok: boolean; models?: any[]; error?: string }>;
      proxyImportGrokCli: () => Promise<{
        ok: boolean;
        email?: string;
        path?: string | null;
        config?: any;
        error?: string;
        modelsCache?: any;
      }>;
      proxyImportGrokTxt: (input: { text: string }) => Promise<{
        ok: boolean;
        email?: string;
        emails?: string[];
        imported?: number;
        refreshed?: number;
        expired?: number;
        path?: string | null;
        config?: any;
        error?: string;
        modelsCache?: any;
      }>;
      proxyImportGrokTxtFile: () => Promise<{
        ok: boolean;
        canceled?: boolean;
        email?: string;
        emails?: string[];
        imported?: number;
        refreshed?: number;
        expired?: number;
        path?: string | null;
        config?: any;
        error?: string;
        modelsCache?: any;
      }>;
      proxyImportGeminiCli: () => Promise<{
        ok: boolean;
        email?: string;
        path?: string;
        config?: any;
        error?: string;
      }>;
      proxySetGeminiCliProject: (input: {
        accountId: string;
        projectId: string;
      }) => Promise<{ ok: boolean; config?: any; error?: string }>;
      proxyGrokOauthStart: () => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        authorizeUrl?: string | null;
        redirectUri?: string | null;
        error?: string;
      }>;
      proxyAntigravityOauthStart: () => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        authorizeUrl?: string | null;
        redirectUri?: string | null;
        providerId?: string;
        error?: string;
      }>;
      proxyGeminiCliOauthStart: () => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        authorizeUrl?: string | null;
        redirectUri?: string | null;
        providerId?: string;
        error?: string;
      }>;
      proxyClaudeCodeOauthStart: () => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        authorizeUrl?: string | null;
        redirectUri?: string | null;
        needsPasteCode?: boolean;
        providerId?: string;
        error?: string;
      }>;
      proxyClaudeCodeOauthComplete: (input: {
        sessionId: string;
        code: string;
      }) => Promise<{ ok: boolean; status?: string; email?: string | null; error?: string }>;
      proxyImportClaudeCodeCli: () => Promise<{
        ok: boolean;
        email?: string;
        path?: string;
        config?: any;
        error?: string;
      }>;
      proxyImportClaudeCodeJson: (text: string) => Promise<{
        ok: boolean;
        email?: string;
        config?: any;
        error?: string;
      }>;
      proxyKiroOauthStart: (opts?: {
        region?: string;
        startUrl?: string;
      }) => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        userCode?: string | null;
        verificationUri?: string | null;
        authorizeUrl?: string | null;
        providerId?: string;
        error?: string;
      }>;
      proxyImportKiroToken: (input: {
        refreshToken?: string;
        token?: string;
        text?: string;
        region?: string;
        email?: string;
      }) => Promise<{ ok: boolean; email?: string; config?: any; error?: string }>;
      proxyImportKiroCli: () => Promise<{
        ok: boolean;
        email?: string;
        path?: string;
        config?: any;
        error?: string;
      }>;
      proxyImportOauthToken: (input: {
        providerId: string;
        accessToken: string;
        refreshToken?: string;
        baseUrl?: string;
        name?: string;
      }) => Promise<{ ok: boolean; accountId?: string; mode?: string; config?: any; error?: string }>;
      proxyImportOauthTokens: (input: {
        providerId: string;
        text: string;
      }) => Promise<{
        ok: boolean;
        added?: number;
        updated?: number;
        skipped?: number;
        failed?: number;
        errors?: Array<{ email?: string | null; token?: string | null; error?: string }>;
        config?: any;
        error?: string;
      }>;
      proxyImportOauthTokensFile: (input: {
        providerId: string;
      }) => Promise<{
        ok: boolean;
        canceled?: boolean;
        path?: string;
        added?: number;
        updated?: number;
        skipped?: number;
        failed?: number;
        errors?: Array<{ email?: string | null; token?: string | null; error?: string }>;
        config?: any;
        error?: string;
      }>;
      proxyOauthStart: (providerId?: string) => Promise<{
        ok: boolean;
        sessionId?: string;
        status?: string;
        userCode?: string | null;
        verificationUri?: string;
        error?: string;
      }>;
      proxyOauthStatus: (sessionId: string) => Promise<{
        ok: boolean;
        status?: string;
        userCode?: string | null;
        verificationUri?: string;
        authorizeUrl?: string | null;
        needsPasteCode?: boolean;
        providerId?: string;
        error?: string;
      }>;
      proxyOauthCancel: (sessionId: string) => Promise<{ ok: boolean }>;
      proxySetRoute: (model: string, route: Record<string, unknown> | null) => Promise<{ ok: boolean; config?: any; error?: string }>;
      onProxyLog: (callback: (
        payload:
          | { batch: Array<{ ts: number; level: string; msg: string; model?: string }> }
          | { entry: { ts: number; level: string; msg: string; model?: string } }
          | { ts: number; level: string; msg: string; model?: string }
      ) => void) => () => void;
      onProxyOauth: (callback: (payload: any) => void) => () => void;
      onProxyConfig: (callback: (payload: any) => void) => () => void;
      onProxyUsage: (callback: (payload: any) => void) => () => void;
      localAgentGetConfig: () => Promise<{ ok: boolean; agentDir?: string; exists?: boolean }>;
      localAgentSetDir: (dir: string) => Promise<{ ok: boolean; agentDir?: string; exists?: boolean }>;
      localAgentPickDir: () => Promise<{ ok: boolean; agentDir?: string; exists?: boolean }>;
      localAgentStatus: () => Promise<{ ok: boolean; state?: LocalAgentState }>;
      localAgentStart: () => Promise<{ ok: boolean; state?: LocalAgentState; error?: string }>;
      localAgentStop: () => Promise<{ ok: boolean; state?: LocalAgentState }>;
      openExternal: (url: string) => Promise<boolean>;
      minimize: () => Promise<void>;
      toggleMaximize: () => Promise<void>;
      close: () => Promise<void>;
      getWorkerPoolStats: () => Promise<{
        ok: boolean;
        stats?: {
          maxWorkers: number;
          activeWorkers: number;
          runningWorkers: number;
          busyWorkers: number;
          pendingTasks: number;
          poolReady: boolean;
        };
      }>;
      getSystemMetrics: () => Promise<{
		    ok: boolean;
		    rss?: number;
		    heapUsed?: number;
		    heapTotal?: number;
		    external?: number;
		    workingSetBytes?: number;
		    uptimeSec?: number;
		    totalRuntimeSec?: number;
		    error?: string;
			  }>;
      usageGetSnapshot: () => Promise<{
        ok: boolean;
        error?: string;
        usage: {
          v: number;
          createdAt: string;
          updatedAt: string;
          counters: {
            filesCreated: number;
            linesAdded: number;
            linesRemoved: number;
            terminalsOpened: number;
            toolCalls: number;
            toolErrors: number;
            userPromptChars: number;
            userPrompts: number;
          };
          tools: Array<{ name: string; calls: number; errors: number }>;
          daily: Array<{
            date: string;
            toolCalls: number;
            promptChars: number;
            filesCreated: number;
            linesAdded: number;
            linesRemoved: number;
            terminals: number;
          }>;
        };
        runtime: {
          totalRuntimeSec: number;
          uptimeSec: number;
          sessions: number;
        };
      }>;
      captureFullScreenshot: () => Promise<{
        ok: boolean;
        error?: string;
        width?: number;
        height?: number;
        displays?: number;
        watermark?: boolean;
      }>;
				};  }	}

	export {};
