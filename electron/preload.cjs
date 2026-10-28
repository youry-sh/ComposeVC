const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("lopster", {
  terminalEnsure: (id) => ipcRenderer.invoke("terminal:ensure", id),
  terminalInput: (id, data) => ipcRenderer.send("terminal:input", { id, data }),
  terminalResize: (id, cols, rows) => ipcRenderer.send("terminal:resize", { id, cols, rows }),
  onTerminalData: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:data", listener);
    return () => ipcRenderer.removeListener("terminal:data", listener);
  },
  onTerminalExit: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("terminal:exit", listener);
    return () => ipcRenderer.removeListener("terminal:exit", listener);
  },
  // Git for the chat shell: status badge, popover details, safe actions.
  gitStatus: (rootPath) => ipcRenderer.invoke("git:status", rootPath || null),
  gitDetails: (rootPath, options) =>
    ipcRenderer.invoke("git:details", rootPath || null, options || {}),
  gitAction: (rootPath, action, payload) =>
    ipcRenderer.invoke("git:action", rootPath || null, action, payload || {}),
  gitAutoCommit: (rootPath, options) =>
    ipcRenderer.invoke("git:autocommit", rootPath || null, options || {}),
  gitAutoPush: (rootPath) => ipcRenderer.invoke("git:autopush", rootPath || null),
  storageAccounts: () => ipcRenderer.invoke("storage:accounts"),
  storagePick: () => ipcRenderer.invoke("storage:pick"),
  storageUpload: (input) => ipcRenderer.invoke("storage:upload", input || {}),
  storageList: () => ipcRenderer.invoke("storage:list"),
  storageDeleteHistory: (id) => ipcRenderer.invoke("storage:deleteHistory", id),
  // Web Engine: per-chat URL binding, localhost probing, clipboard write.
  webEngineGetBinding: (chatKey) => ipcRenderer.invoke("webengine:getBinding", chatKey || ""),
  webEngineSetBinding: (chatKey, url) => ipcRenderer.invoke("webengine:setBinding", chatKey || "", url),
  webEngineProbeLocalhost: (rootPath) => ipcRenderer.invoke("webengine:probeLocalhost", rootPath || null),
  webEngineCopyText: (text) => ipcRenderer.invoke("webengine:copyText", text || ""),
  webEngineCaptureScreenshot: (webContentsId) => ipcRenderer.invoke("webengine:captureScreenshot", webContentsId),
  webEngineClearCache: () => ipcRenderer.invoke("webengine:clearCache"),
  // Setup tab — main process detects / downloads / installs runtimes and tools.
  setupScan: () => ipcRenderer.invoke("setup:scan"),
  setupInstall: (id) => ipcRenderer.invoke("setup:install", id),
  setupInstallAll: () => ipcRenderer.invoke("setup:installAll"),
  setupCancel: (id) => ipcRenderer.invoke("setup:cancel", id),
  setupState: () => ipcRenderer.invoke("setup:state"),
  setupOpenManual: (id) => ipcRenderer.invoke("setup:openManual", id),
  setupOpenDownloads: () => ipcRenderer.invoke("setup:openDownloads"),
  onSetupProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("setup:progress", listener);
    return () => ipcRenderer.removeListener("setup:progress", listener);
  },
  // MultiIDE layout (workspaces + their chat panels) — disk-backed JSON store.
  multiIdeLoadState: () => ipcRenderer.invoke("multiide:loadState"),
  multiIdeSaveState: (patch) => ipcRenderer.invoke("multiide:saveState", patch || {}),
  multiIdeLoadStateSync: () => ipcRenderer.sendSync("multiide:loadStateSync"),
  multiIdeSaveStateSync: (patch) => ipcRenderer.sendSync("multiide:saveStateSync", patch || {}),
  // Expert workspace — whole-project study + prompt composer (disk-backed).
  expertLoadState: () => ipcRenderer.invoke("expert:loadState"),
  expertSaveState: (patch) => ipcRenderer.invoke("expert:saveState", patch || {}),
  expertLoadStateSync: () => ipcRenderer.sendSync("expert:loadStateSync"),
  expertSaveStateSync: (patch) => ipcRenderer.sendSync("expert:saveStateSync", patch || {}),
  expertSend: (payload) => ipcRenderer.invoke("expert:send", payload || {}),
  expertStop: (slotId) => ipcRenderer.invoke("expert:stop", slotId),
  expertStudy: (payload) => ipcRenderer.invoke("expert:study", payload || {}),
  expertSaveSnapshot: (payload) => ipcRenderer.invoke("expert:saveSnapshot", payload || {}),
  expertLoadSession: (sessionId) => ipcRenderer.invoke("expert:loadSession", sessionId),
  expertListSessions: (rootPath) => ipcRenderer.invoke("expert:listSessions", rootPath || null),
  expertNewSession: (input) => ipcRenderer.invoke("expert:newSession", input || {}),
  expertDeleteSession: (sessionId) => ipcRenderer.invoke("expert:deleteSession", sessionId),
  expertRenameSession: (sessionId, title) => ipcRenderer.invoke("expert:renameSession", sessionId, title),
  expertSaveSession: (sessionId, name) => ipcRenderer.invoke("expert:saveSession", sessionId, name || ""),
  expertListSaved: () => ipcRenderer.invoke("expert:listSaved"),
  expertDeleteSaved: (savedId) => ipcRenderer.invoke("expert:deleteSaved", savedId),
  expertOpenSaved: (input) => ipcRenderer.invoke("expert:openSaved", input || {}),
  expertCopySession: (payload) => ipcRenderer.invoke("expert:copySession", payload || {}),
  expertPasteSession: (input) => ipcRenderer.invoke("expert:pasteSession", input || {}),
  expertStudyStatus: (rootPath) => ipcRenderer.invoke("expert:studyStatus", rootPath || null),
  expertReadDossier: (rootPath) => ipcRenderer.invoke("expert:readDossier", rootPath || null),
  expertRestudy: (rootPath) => ipcRenderer.invoke("expert:restudy", rootPath || null),
  onExpertProgress: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("expert:progress", listener);
    return () => ipcRenderer.removeListener("expert:progress", listener);
  },
  // Ctrl+H pressed while a <webview> had focus — the shell opens its switcher.
  onOpenChatSwitcher: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("chat:switcher-toggle", listener);
    return () => ipcRenderer.removeListener("chat:switcher-toggle", listener);
  },
  // Ctrl+Shift+W pressed inside a <webview> — fold the media dock away.
  onFoldWebDock: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("web:dock-fold", listener);
    return () => ipcRenderer.removeListener("web:dock-fold", listener);
  },
  onStorageOpen: (callback) => {
    const listener = () => callback(); ipcRenderer.on("storage:open", listener);
    return () => ipcRenderer.removeListener("storage:open", listener);
  },
  // Workspace hotkeys routed from the main process (Ctrl/Cmd+1…9, Ctrl+P,
  // Ctrl+,, Ctrl+`) — works even while the terminal/webview owns the keyboard.
  onShellHotkey: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("shell:hotkey", listener);
    return () => ipcRenderer.removeListener("shell:hotkey", listener);
  },
  readProviderConfig: () => ipcRenderer.invoke("config:read"),
  writeProviderConfig: (config) => ipcRenderer.invoke("config:write", config),
  readCfMailConfig: () => ipcRenderer.invoke("cfmail:read"),
  writeCfMailConfig: (config) => ipcRenderer.invoke("cfmail:write", config),
  testCfMail: () => ipcRenderer.invoke("cfmail:test"),
  listRunners: () => ipcRenderer.invoke("runner:list"),
  getRunner: (id) => ipcRenderer.invoke("runner:get", id),
  createRunner: (input) => ipcRenderer.invoke("runner:create", input || {}),
  updateRunner: (id, patch) => ipcRenderer.invoke("runner:update", id, patch || {}),
  deleteRunner: (id) => ipcRenderer.invoke("runner:delete", id),
  runRunner: (id, opts) => ipcRenderer.invoke("runner:run", id, opts || {}),
  stopRunner: (id) => ipcRenderer.invoke("runner:stop", id),
  listRunnerReports: (opts) => ipcRenderer.invoke("runner:reports:list", opts || {}),
  getRunnerReport: (runnerId, reportId) =>
    ipcRenderer.invoke("runner:reports:get", runnerId, reportId),
  deleteRunnerReport: (runnerId, reportId) =>
    ipcRenderer.invoke("runner:reports:delete", runnerId, reportId),
  onRunnersChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:changed", listener);
    return () => ipcRenderer.removeListener("runner:changed", listener);
  },
  onRunnerReportChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:report-changed", listener);
    return () => ipcRenderer.removeListener("runner:report-changed", listener);
  },
  onRunnerStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:status", listener);
    return () => ipcRenderer.removeListener("runner:status", listener);
  },
  onRunnerProgress: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("runner:progress", listener);
    return () => ipcRenderer.removeListener("runner:progress", listener);
  },
  onRunnerOpenSendModal: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("runner:open-send", listener);
    return () => ipcRenderer.removeListener("runner:open-send", listener);
  },
  updateTelegramRuntimeContext: (context) => ipcRenderer.invoke("telegram:runtimeContext", context),
  getTelegramStatus: (slotId) => ipcRenderer.invoke("telegram:status", slotId),
  getTelegramSlotStatus: (slotId) => ipcRenderer.invoke("telegram:slotStatus", slotId),
  getTelegramSlotConfig: (slotId) => ipcRenderer.invoke("telegram:slotConfig", slotId),
  configureTelegramSlot: (slotId, config) => ipcRenderer.invoke("telegram:configureSlot", slotId, config),
  listTelegramSlots: () => ipcRenderer.invoke("telegram:listSlots"),
  newWindow: () => ipcRenderer.invoke("window:new"),
  introReady: () => ipcRenderer.send("intro:ready"),
  finishIntro: () => ipcRenderer.send("intro:finished"),
  openProxySubview: (view) => ipcRenderer.invoke("proxy:openSubview", view),
  sendChatRequest: (request) => ipcRenderer.invoke("chat:send", request),
  inlineHintSuggest: (request) => ipcRenderer.invoke("inline-hint:suggest", request || {}),
  getModelLimits: (modelId) => ipcRenderer.invoke("model:limits", modelId),
  stopGeneration: (sessionId) => ipcRenderer.invoke("chat:stop", sessionId || null),
  listRunningChatSessions: () => ipcRenderer.invoke("chat:runningSessions"),
  answerUser: (payload) => ipcRenderer.invoke("agent:answerUser", payload),
  notifyAgentComplete: (payload) => ipcRenderer.invoke("agent:notifyComplete", payload),
  compactChat: (request) => ipcRenderer.invoke("chat:compact", request),
  loadChatSession: (rootPath, sessionId) => ipcRenderer.invoke("memory:loadSession", rootPath, sessionId),
  listChatSessions: (rootPath) => ipcRenderer.invoke("memory:listSessions", rootPath),
  listChatSessionsPage: (rootPath, options) =>
    ipcRenderer.invoke("memory:listSessionsPage", rootPath, options || {}),
  createChatSession: (rootPath, options) => ipcRenderer.invoke("memory:createSession", rootPath, options || {}),
  listChatBookmarks: () => ipcRenderer.invoke("memory:listChatBookmarks"),
  saveChatBookmark: (bookmark) => ipcRenderer.invoke("memory:saveChatBookmark", bookmark),
  deleteChatBookmark: (bookmarkId) => ipcRenderer.invoke("memory:deleteChatBookmark", bookmarkId),
  copyChatSession: (rootPath, sessionId) => ipcRenderer.invoke("memory:copySession", rootPath, sessionId),
  pasteChatSession: (rootPath) => ipcRenderer.invoke("memory:pasteSession", rootPath),
  deleteChatSession: (rootPath, sessionId) => ipcRenderer.invoke("memory:deleteSession", rootPath, sessionId),
  updateChatSessionMeta: (rootPath, sessionId, patch) =>
    ipcRenderer.invoke("memory:updateSessionMeta", rootPath, sessionId, patch || {}),
  clearChatSessionTranscript: (rootPath, sessionId, options) =>
    ipcRenderer.invoke("memory:clearSessionTranscript", rootPath, sessionId, options || {}),
  knowledgeList: () => ipcRenderer.invoke("knowledge:list"),
  knowledgeRead: (id) => ipcRenderer.invoke("knowledge:read", id),
  knowledgeCreate: (input) => ipcRenderer.invoke("knowledge:create", input || {}),
  knowledgeUpdate: (id, patch) => ipcRenderer.invoke("knowledge:update", id, patch || {}),
  knowledgeDelete: (id) => ipcRenderer.invoke("knowledge:delete", id),
  knowledgeExport: (rootPath) => ipcRenderer.invoke("knowledge:export", { rootPath: rootPath || null }),
  knowledgeImport: (zipPath) => ipcRenderer.invoke("knowledge:import", { zipPath: zipPath || null }),
  onKnowledgeChanged: (callback) => {
    const listener = (_event, payload) => callback(payload || { type: "changed" });
    ipcRenderer.on("knowledge:changed", listener);
    return () => ipcRenderer.removeListener("knowledge:changed", listener);
  },
  docsList: () => ipcRenderer.invoke("docs:list"),
  docsRead: (id) => ipcRenderer.invoke("docs:read", id),
  docsAll: () => ipcRenderer.invoke("docs:all"),
  docsCreate: (input) => ipcRenderer.invoke("docs:create", input || {}),
  docsUpdate: (id, patch) => ipcRenderer.invoke("docs:update", id, patch || {}),
  docsDelete: (id) => ipcRenderer.invoke("docs:delete", id),
  onDocsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload || { type: "changed" });
    ipcRenderer.on("docs:changed", listener);
    return () => ipcRenderer.removeListener("docs:changed", listener);
  },
  promptsList: () => ipcRenderer.invoke("prompts:list"),
  promptsCreate: (input) => ipcRenderer.invoke("prompts:create", input || {}),
  promptsUpdate: (id, patch) => ipcRenderer.invoke("prompts:update", id, patch || {}),
  promptsDelete: (id) => ipcRenderer.invoke("prompts:delete", id),
  promptsCopy: (id) => ipcRenderer.invoke("prompts:copy", id),
  onPromptsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload || { type: "changed" });
    ipcRenderer.on("prompts:changed", listener);
    return () => ipcRenderer.removeListener("prompts:changed", listener);
  },
  pluginsList: () => ipcRenderer.invoke("plugins:list"),
  pluginsGet: (id) => ipcRenderer.invoke("plugins:get", id),
  pluginsUpdate: (id, patch) => ipcRenderer.invoke("plugins:update", id, patch || {}),
  pluginsProbe: (id) => ipcRenderer.invoke("plugins:probe", id),
  pluginsJobs: (options) => ipcRenderer.invoke("plugins:jobs", options || {}),
  pluginsJob: (jobId) => ipcRenderer.invoke("plugins:job", jobId),
  pluginsLog: (jobId) => ipcRenderer.invoke("plugins:log", jobId),
  pluginsCancel: (jobId) => ipcRenderer.invoke("plugins:cancel", jobId),
  pluginsDeleteJob: (jobId) => ipcRenderer.invoke("plugins:deleteJob", jobId),
  pluginsPreview: (jobId, name) => ipcRenderer.invoke("plugins:preview", jobId, name || ""),
  pluginsPickExecutable: (id) => ipcRenderer.invoke("plugins:pickExecutable", id || ""),
  pluginsPickDirectory: () => ipcRenderer.invoke("plugins:pickDirectory"),
  pluginsCopyArtifacts: (jobId, targetDir) => ipcRenderer.invoke("plugins:copyArtifacts", jobId, targetDir || ""),
  pluginsOpenPath: (jobId, target) => ipcRenderer.invoke("plugins:openPath", jobId || "", target || ""),
  pluginsOpenInBlender: (jobId, blendPath) => ipcRenderer.invoke("plugins:openInBlender", jobId || "", blendPath || ""),
  pluginsRunDemo: (id) => ipcRenderer.invoke("plugins:runDemo", id || "blender"),
  pluginsGodotDemo: (options) => ipcRenderer.invoke("plugins:godotDemo", options || {}),
  pluginsGodotBuild: (id, options) => ipcRenderer.invoke("plugins:godotBuild", id || "godot", options || {}),
  pluginsGodotImportGlb: (payload) => ipcRenderer.invoke("plugins:godotImportGlb", payload || {}),
  onPluginsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload || { type: "changed" });
    ipcRenderer.on("plugins:changed", listener);
    return () => ipcRenderer.removeListener("plugins:changed", listener);
  },
  onPluginJob: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("plugins:job", listener);
    return () => ipcRenderer.removeListener("plugins:job", listener);
  },

		  estimateContextTokens: (rootPath, projectName) => ipcRenderer.invoke("context:estimateTokens", rootPath, projectName),

			  listMcpServers: () => ipcRenderer.invoke("mcp:list"),
  addMcpServer: (input) => ipcRenderer.invoke("mcp:add", input || {}),
  updateMcpServer: (id, patch) => ipcRenderer.invoke("mcp:update", id, patch || {}),
  removeMcpServer: (id) => ipcRenderer.invoke("mcp:remove", id),
  connectMcpServer: (id) => ipcRenderer.invoke("mcp:connect", id),
  disconnectMcpServer: (id) => ipcRenderer.invoke("mcp:disconnect", id),
  refreshMcpServer: (id) => ipcRenderer.invoke("mcp:refresh", id),
  inspectMcpServer: (id) => ipcRenderer.invoke("mcp:inspect", id),
  importMcpConfig: (config, options) => ipcRenderer.invoke("mcp:import", config, options || {}),
  searchMcpRegistry: (options) => ipcRenderer.invoke("mcp:registrySearch", options || {}),
  installMcpRegistry: (server, overrides) => ipcRenderer.invoke("mcp:registryInstall", server, overrides || {}),
  listProjectMcp: (rootPath) => ipcRenderer.invoke("mcp:projectList", rootPath || null),
  setProjectMcp: (rootPath, serverId, enabled) => ipcRenderer.invoke("mcp:projectSet", rootPath || null, serverId, enabled === true),
  onMcpChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("mcp:changed", listener);
    return () => ipcRenderer.removeListener("mcp:changed", listener);
  },

			  readCustomTools: () => ipcRenderer.invoke("customTools:read"),  addCustomTool: (toolData) => ipcRenderer.invoke("customTools:add", toolData),
  updateCustomTool: (toolId, toolData) => ipcRenderer.invoke("customTools:update", toolId, toolData),
  readCustomToolFile: (toolId) => ipcRenderer.invoke("customTools:readFile", toolId),
  removeCustomTool: (toolId) => ipcRenderer.invoke("customTools:remove", toolId),
  exportCustomTools: (options) => ipcRenderer.invoke("customTools:export", options || {}),
  previewCustomToolsImport: (payload) => ipcRenderer.invoke("customTools:importPreview", payload || {}),
  importCustomTools: (payload) => ipcRenderer.invoke("customTools:import", payload || {}),
  onCustomToolsChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("customTools:changed", listener);
    return () => ipcRenderer.removeListener("customTools:changed", listener);
  },
  readInstructions: (rootPath) => ipcRenderer.invoke("instructions:read", rootPath),
  saveGlobalInstructions: (content) => ipcRenderer.invoke("instructions:saveGlobal", content),
  saveProjectInstructions: (rootPath, content) => ipcRenderer.invoke("instructions:saveProject", rootPath, content),

  readAutoInsertStore: () => ipcRenderer.invoke("autoInsert:read"),
  saveAutoInsert: (data) => ipcRenderer.invoke("autoInsert:save", data),

  onDeskPrompt: (callback) => {
    const listener = (_event, payload) => callback(payload || {});
    ipcRenderer.on("desk:prompt", listener);
    return () => ipcRenderer.removeListener("desk:prompt", listener);
  },
  onDeskClear: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("desk:clear", listener);
    return () => ipcRenderer.removeListener("desk:clear", listener);
  },
  deskReply: (payload) => {
    try {
      fetch("http://127.0.0.1:47741/reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload || {}),
      }).catch(() => {});
    } catch { /* wallpaper bridge is optional */ }
  },
  onAgentProgress: (callback) => {
    const listener = (_event, progress) => callback(progress);
    ipcRenderer.on("agent:progress", listener);
    return () => ipcRenderer.removeListener("agent:progress", listener);
  },
  getWorkTimer: () => ipcRenderer.invoke("worktimer:get"),
  getBackgroundTasks: (sessionId) => ipcRenderer.invoke("bgterm:list", sessionId || null),
  killBackgroundTask: (id) => ipcRenderer.invoke("bgterm:kill", id),
  onBackgroundTasksChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("bgterm:changed", listener);
    return () => ipcRenderer.removeListener("bgterm:changed", listener);
  },
  onAgentRunState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("agent:run-state", listener);
    return () => ipcRenderer.removeListener("agent:run-state", listener);
  },
  onPlayAgentCompleteSound: (callback) => {
    const listener = (_event, soundUrl) => callback(soundUrl);
    ipcRenderer.on("agent:playCompleteSound", listener);
    return () => ipcRenderer.removeListener("agent:playCompleteSound", listener);
  },
  openFolder: () => ipcRenderer.invoke("folder:open"),
  readFolder: (rootPath) => ipcRenderer.invoke("folder:read", rootPath),
  searchProject: (rootPath, query) => ipcRenderer.invoke("project:search", rootPath, query),
  readTasks: () => ipcRenderer.invoke("tasks:read"),
  saveTasks: (tasks) => ipcRenderer.invoke("tasks:save", tasks),
  readFile: (filePath) => ipcRenderer.invoke("file:read", filePath),
  readMediaFile: (filePath) => ipcRenderer.invoke("file:readMedia", filePath),
  writeFile: (filePath, content) => ipcRenderer.invoke("file:write", filePath, content),
  createFile: (parentPath, name) => ipcRenderer.invoke("file:create", parentPath, name),
  createFolder: (parentPath, name) => ipcRenderer.invoke("folder:create", parentPath, name),
  deletePath: (targetPath) => ipcRenderer.invoke("path:delete", targetPath),
  movePath: (sourcePath, targetFolderPath) => ipcRenderer.invoke("path:move", sourcePath, targetFolderPath),
  proxyGetConfig: () => ipcRenderer.invoke("proxy:getConfig"),
  proxySaveConfig: (patch) => ipcRenderer.invoke("proxy:saveConfig", patch),
  proxyStart: (opts) => ipcRenderer.invoke("proxy:start", opts || {}),
  proxyStop: () => ipcRenderer.invoke("proxy:stop"),
  proxyStatus: () => ipcRenderer.invoke("proxy:status"),
  proxyNgrokStatus: () => ipcRenderer.invoke("proxy:ngrokStatus"),
  proxyNgrokRestart: () => ipcRenderer.invoke("proxy:ngrokRestart"),
  localAgentGetConfig: () => ipcRenderer.invoke("localAgent:getConfig"),
  localAgentSetDir: (dir) => ipcRenderer.invoke("localAgent:setDir", dir),
  localAgentPickDir: () => ipcRenderer.invoke("localAgent:pickDir"),
  localAgentStatus: () => ipcRenderer.invoke("localAgent:status"),
  localAgentStart: () => ipcRenderer.invoke("localAgent:start"),
  localAgentStop: () => ipcRenderer.invoke("localAgent:stop"),
  proxyCreateKey: (label) => ipcRenderer.invoke("proxy:createKey", label),
  proxyDeleteKey: (keyId) => ipcRenderer.invoke("proxy:deleteKey", keyId),
  proxyToggleKey: (keyId, enabled) => ipcRenderer.invoke("proxy:toggleKey", keyId, enabled),
  proxyListProviders: () => ipcRenderer.invoke("proxy:listProviders"),
  proxyAddCustomProvider: (input) => ipcRenderer.invoke("proxy:addCustomProvider", input || {}),
  proxyUpdateCustomProvider: (input) =>
    ipcRenderer.invoke("proxy:updateCustomProvider", input || {}),
  proxyDeleteCustomProvider: (providerId) =>
    ipcRenderer.invoke("proxy:deleteCustomProvider", providerId),
  proxyUpsertConnection: (input) => ipcRenderer.invoke("proxy:upsertConnection", input),
  proxyDeleteConnection: (id) => ipcRenderer.invoke("proxy:deleteConnection", id),
  proxyAddApiKeyAccount: (input) => ipcRenderer.invoke("proxy:addApiKeyAccount", input),
  proxyDeleteAccount: (id) => ipcRenderer.invoke("proxy:deleteAccount", id),
  proxyRefreshUsage: (accountId) => ipcRenderer.invoke("proxy:refreshUsage", accountId || null),
  proxyGetUsageStats: () => ipcRenderer.invoke("proxy:getUsageStats"),
  proxyResetUsageStats: () => ipcRenderer.invoke("proxy:resetUsageStats"),
  proxyClearAccountQuota: (accountId) => ipcRenderer.invoke("proxy:clearAccountQuota", accountId),
  proxyListModels: (opts) => ipcRenderer.invoke("proxy:listModels", opts || {}),
  proxyAddModel: (input) => ipcRenderer.invoke("proxy:addModel", input || {}),
  proxyRemoveModel: (input) => ipcRenderer.invoke("proxy:removeModel", input || {}),
  proxyImportGrokCli: () => ipcRenderer.invoke("proxy:importGrokCli"),
  proxyImportGrokTxt: (input) => ipcRenderer.invoke("proxy:importGrokTxt", input || {}),
  proxyImportGrokTxtFile: () => ipcRenderer.invoke("proxy:importGrokTxtFile"),
  proxyImportGeminiCli: () => ipcRenderer.invoke("proxy:importGeminiCli"),
  proxySetGeminiCliProject: (input) =>
    ipcRenderer.invoke("proxy:setGeminiCliProject", input || {}),
  proxyGrokOauthStart: () => ipcRenderer.invoke("proxy:grokOauthStart"),
  proxyAntigravityOauthStart: () => ipcRenderer.invoke("proxy:antigravityOauthStart"),
  proxyGeminiCliOauthStart: () => ipcRenderer.invoke("proxy:geminiCliOauthStart"),
  proxyClaudeCodeOauthStart: () => ipcRenderer.invoke("proxy:claudeCodeOauthStart"),
  proxyClaudeCodeOauthComplete: (input) =>
    ipcRenderer.invoke("proxy:claudeCodeOauthComplete", input || {}),
  proxyImportClaudeCodeCli: () => ipcRenderer.invoke("proxy:importClaudeCodeCli"),
  proxyImportClaudeCodeJson: (text) => ipcRenderer.invoke("proxy:importClaudeCodeJson", text || ""),
  proxyKiroOauthStart: (opts) => ipcRenderer.invoke("proxy:kiroOauthStart", opts || {}),
  proxyImportKiroToken: (input) => ipcRenderer.invoke("proxy:importKiroToken", input || {}),
  proxyImportKiroCli: () => ipcRenderer.invoke("proxy:importKiroCli"),
  proxyImportOauthToken: (input) => ipcRenderer.invoke("proxy:importOauthToken", input || {}),
  proxyImportOauthTokens: (input) => ipcRenderer.invoke("proxy:importOauthTokens", input || {}),
  proxyImportOauthTokensFile: (input) => ipcRenderer.invoke("proxy:importOauthTokensFile", input || {}),
  proxyOauthStart: (providerId) => ipcRenderer.invoke("proxy:oauthStart", providerId || "openai"),
  proxyOauthStatus: (sessionId) => ipcRenderer.invoke("proxy:oauthStatus", sessionId),
  proxyOauthCancel: (sessionId) => ipcRenderer.invoke("proxy:oauthCancel", sessionId),
  proxySetRoute: (model, route) => ipcRenderer.invoke("proxy:setRoute", model, route),
  onProxyLog: (callback) => {
    // Main process batches high-frequency proxy logs (proxy:log/batch). A single
    // log arrives as {entry}, a batch as {entries}. Callback receives the batch
    // array when present, else the single entry — renderer decides what to append.
    const listener = (_event, payload) => {
      if (payload && Array.isArray(payload.entries)) callback({ batch: payload.entries });
      else callback(payload && "entry" in payload ? payload.entry : payload);
    };
    ipcRenderer.on("proxy:log", listener);
    ipcRenderer.on("proxy:log/batch", listener);
    return () => {
      ipcRenderer.removeListener("proxy:log", listener);
      ipcRenderer.removeListener("proxy:log/batch", listener);
    };
  },
  onProxyOauth: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("proxy:oauth", listener);
    return () => ipcRenderer.removeListener("proxy:oauth", listener);
  },
  onProxyConfig: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("proxy:config", listener);
    return () => ipcRenderer.removeListener("proxy:config", listener);
  },
  onProxyUsage: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("proxy:usage", listener);
    return () => ipcRenderer.removeListener("proxy:usage", listener);
  },

  openExternal: (url) => ipcRenderer.invoke("shell:openExternal", url),
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  close: () => ipcRenderer.invoke("window:close"),
  getSystemMetrics: () => ipcRenderer.invoke("system:getMetrics"),
  getWorkerPoolStats: () => ipcRenderer.invoke("workerPool:stats"),
  usageGetSnapshot: () => ipcRenderer.invoke("usage:getSnapshot"),
  captureFullScreenshot: () => ipcRenderer.invoke("screenshot:captureFull"),
  sizeworkoutSnapshot: (workspaceId) => ipcRenderer.invoke("sizeworkout:snapshot", workspaceId || null),
  sizeworkoutUpdate: (input) => ipcRenderer.invoke("sizeworkout:update", input || {}),
  sizeworkoutReset: (workspaceId) => ipcRenderer.invoke("sizeworkout:reset", workspaceId || "default"),
  onSizeworkoutChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("sizeworkout:changed", listener);
    return () => ipcRenderer.removeListener("sizeworkout:changed", listener);
  },
  // ---- auto-update (GitHub Releases of the project repo) -------------------
  updateStatus: () => ipcRenderer.invoke("update:status"),
  updateCheck: () => ipcRenderer.invoke("update:check"),
  updateDownload: () => ipcRenderer.invoke("update:download"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  updateSetConfig: (patch) => ipcRenderer.invoke("update:set-config", patch || {}),
  updateOpenRelease: () => ipcRenderer.invoke("update:open-release"),
  onUpdateStatus: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("update:status", listener);
    return () => ipcRenderer.removeListener("update:status", listener);
  },
});
