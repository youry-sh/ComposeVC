import React, { useEffect, useState } from "react";
import TitleBar from "./components/TitleBar";
import SettingsModal from "./components/SettingsModal";
import ProvidersModal from "./components/ProvidersModal";
import SearchOverlay from "./components/SearchOverlay";
import ProxyWorkspace from "./components/ProxyWorkspace";
import RunnerWorkspace from "./components/RunnerWorkspace";
import RunnerSendModal from "./components/RunnerSendModal";
import CustomToolsWorkspace from "./components/CustomToolsWorkspace";
import MultiIdeWorkspace, {
  loadMultiIdeSlots,
  saveMultiIdeSlots,
  MultiIdeSlotState,
} from "./components/MultiIdeWorkspace";
import {
  AppLanguage,
  applyLanguage,
  getStoredLanguage,
  translations,
} from "./i18n";
import { CustomTool, ProjectSearchResult, ProviderConfig } from "./types";
import { dispatchInsertChatInput, loadMouseSnippets, textForMouseButton } from "./utils/mouseSnippets";

type Panel = "multiide" | "proxy" | "settings" | "customtools" | "runner";

const App: React.FC = () => {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string>(() => translations[getStoredLanguage()].noFolderOpened);
  const [providerConfig, setProviderConfig] = useState<ProviderConfig>({
    providers: [],
    models: [],
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providersOpen, setProvidersOpen] = useState(false);
  const [activePanel, setActivePanel] = useState<Panel>(() => {
    try {
      const saved = window.localStorage.getItem("lopster-active-panel");
      if (saved === "files" || saved === "multiide") return "multiide";
      if (saved === "proxy") return "proxy";
      if (saved === "runner") return "runner";
      if (saved === "customtools") return "customtools";
    } catch {
      /* ignore */
    }
    return "multiide";
  });
  const [multiIdeSlots, setMultiIdeSlots] = useState<MultiIdeSlotState[]>(() => loadMultiIdeSlots());
  const [multiIdeMounted, setMultiIdeMounted] = useState(() => {
    try {
      const saved = window.localStorage.getItem("lopster-active-panel");
      return saved !== "proxy";
    } catch {
      return true;
    }
  });
  const [searchOpen, setSearchOpen] = useState(false);
  const [runnerSendOpen, setRunnerSendOpen] = useState(false);
  const [runnerSendTarget, setRunnerSendTarget] = useState<string | null>(null);
  const [customTools, setCustomTools] = useState<CustomTool[]>([]);
  const [appLanguage, setAppLanguage] = useState<AppLanguage>(() => getStoredLanguage());
  const t = translations[appLanguage];

  useEffect(() => {
    applyLanguage(appLanguage);
  }, [appLanguage]);

  useEffect(() => {
    try {
      window.localStorage.setItem("lopster-active-panel", activePanel);
    } catch {
      /* ignore */
    }
  }, [activePanel]);

  useEffect(() => {
    saveMultiIdeSlots(multiIdeSlots);
  }, [multiIdeSlots]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSearchOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const openSend = window.lopster?.onRunnerOpenSendModal?.(() => {
      setRunnerSendTarget(null);
      setRunnerSendOpen(true);
    });
    return () => openSend?.();
  }, []);

  // Mouse side buttons → insert snippet into the active chat input only
  // (ChatPanel filters by focus/hover so MultiIDE never fills all 4 columns).
  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      const config = loadMouseSnippets();
      const text = textForMouseButton(config, event.button);
      if (!text) return;
      event.preventDefault();
      event.stopPropagation();
      dispatchInsertChatInput(text, config.append);
    };
    const blockNav = (event: MouseEvent) => {
      if (event.button !== 3 && event.button !== 4) return;
      const config = loadMouseSnippets();
      if (!textForMouseButton(config, event.button)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("mouseup", blockNav, true);
    window.addEventListener("auxclick", blockNav, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("mouseup", blockNav, true);
      window.removeEventListener("auxclick", blockNav, true);
    };
  }, []);

  useEffect(() => {
    window.lopster?.readProviderConfig().then(setProviderConfig);
    window.lopster?.readCustomTools?.().then((list) => {
      if (list) setCustomTools(list as CustomTool[]);
    });

    const unsubCustomTools = window.lopster?.onCustomToolsChanged?.((payload) => {
      if (payload?.type === "added" && payload.tool) {
        const tool = payload.tool as CustomTool;
        setCustomTools((prev) => {
          if (prev.some((t) => t.id === tool.id)) {
            return prev.map((t) => (t.id === tool.id ? tool : t));
          }
          return [...prev, tool];
        });
        return;
      }
      if (payload?.type === "updated" && payload.tool) {
        const tool = payload.tool as CustomTool;
        setCustomTools((prev) => prev.map((t) => (t.id === tool.id ? tool : t)));
        return;
      }
      if (payload?.type === "removed" && payload.toolId) {
        setCustomTools((prev) => prev.filter((t) => t.id !== payload.toolId));
        return;
      }
      window.lopster?.readCustomTools?.().then((list) => {
        if (list) setCustomTools(list as CustomTool[]);
      });
    });

    const savedPath = window.localStorage.getItem("lopster-last-folder");
    if (savedPath) {
      window.lopster?.readFolder(savedPath).then((root) => {
        if (root) {
          setRootPath(root.path);
          setProjectName(root.name);
        }
      });
    }

    return () => {
      unsubCustomTools?.();
    };
  }, []);

  useEffect(() => {
    void window.lopster?.updateTelegramRuntimeContext({ rootPath, projectName });
  }, [rootPath, projectName]);

  useEffect(() => {
    const removeSoundListener = window.lopster?.onPlayAgentCompleteSound((soundUrl) => {
      const audio = new Audio(soundUrl);
      audio.volume = 0.75;
      void audio.play().catch(() => undefined);
    });
    return () => removeSoundListener?.();
  }, []);

  const saveProviderConfig = async (nextConfig: ProviderConfig) => {
    setProviderConfig(nextConfig);
    const saved = (await window.lopster?.writeProviderConfig(nextConfig)) as
      | ProviderConfig
      | undefined;
    const merged = (saved && typeof saved === "object" ? saved : nextConfig) as ProviderConfig;
    setProviderConfig(merged);
    return merged;
  };

  const handleAddCustomTool = async (input: {
    name: string;
    title?: string;
    description?: string;
    code?: string;
    runtime?: string;
    entry?: string;
    tags?: string[];
    inputSchema?: Record<string, unknown>;
  }) => {
    try {
      const tool = await window.lopster?.addCustomTool?.(input);
      if (tool) {
        setCustomTools((prev) => {
          if (prev.some((t) => t.id === tool.id)) {
            return prev.map((t) => (t.id === tool.id ? (tool as CustomTool) : t));
          }
          return [...prev, tool as CustomTool];
        });
      }
    } catch (error) {
      console.error("Failed to add custom tool:", error);
      throw error;
    }
  };

  const handleUpdateCustomTool = async (
    toolId: string,
    patch: {
      name?: string;
      title?: string;
      description?: string;
      code?: string;
      runtime?: string;
      entry?: string;
      enabled?: boolean;
      tags?: string[];
      inputSchema?: Record<string, unknown>;
    }
  ) => {
    try {
      if (patch.enabled === true || patch.enabled === false) {
        setCustomTools((prev) =>
          prev.map((t) => (t.id === toolId ? { ...t, enabled: patch.enabled } : t))
        );
      }
      const tool = await window.lopster?.updateCustomTool?.(toolId, patch);
      if (tool) {
        setCustomTools((prev) => prev.map((t) => (t.id === toolId ? (tool as CustomTool) : t)));
      }
    } catch (error) {
      console.error("Failed to update custom tool:", error);
      const list = await window.lopster?.readCustomTools?.();
      if (list) setCustomTools(list as CustomTool[]);
      throw error;
    }
  };

  const handleRemoveCustomTool = async (toolId: string) => {
    await window.lopster?.removeCustomTool?.(toolId);
    setCustomTools((prev) => prev.filter((t) => t.id !== toolId));
  };

  const handleSearchOpen = async (result: ProjectSearchResult) => {
    // No code editor in MultiIDE shell — close search after pick.
    setSearchOpen(false);
    void result;
  };

  const handlePanelSelect = (panel: Panel) => {
    if (panel === "settings") {
      setSettingsOpen(true);
      return;
    }
    if (panel === "multiide") {
      setMultiIdeMounted(true);
    }
    setActivePanel(panel);
  };

  // First MultiIDE slot folder (if any) drives shared shell project context.
  useEffect(() => {
    const firstPath = multiIdeSlots.find((s) => s.rootPath)?.rootPath || null;
    if (!firstPath) return;
    if (firstPath === rootPath) return;
    window.lopster?.readFolder(firstPath).then((root) => {
      if (!root) return;
      setRootPath(root.path);
      setProjectName(root.name);
      window.localStorage.setItem("lopster-last-folder", root.path);
    });
  }, [multiIdeSlots, rootPath]);

  const chatPanelLabels = {
    chat: t.chat,
    askAnything: t.askAnything,
    noConversationYet: t.noConversationYet,
    askAnythingToStart: t.askAnythingToStart,
    send: t.send,
    stop: t.stop,
    thinking: t.thinking,
    selectModel: t.selectModel,
    noModelsConfigured: t.noModelsConfigured,
    searchModels: t.searchModels,
    noModelsFound: t.noModelsFound,
    contextUsage: t.contextUsage,
    compacting: t.compacting,
    clickToCompact: t.clickToCompact,
    compactedBanner: t.compactedBanner,
    newChat: t.newChat,
    oneShot: t.oneShot,
    oneShotOn: t.oneShotOn,
    oneShotOff: t.oneShotOff,
    chatHistory: t.chatHistory,
    noChatsYet: t.noChatsYet,
    searchChats: t.searchChats,
    usedTools: t.usedTools,
    tool: t.tool,
    toolsPlural: t.toolsPlural,
    queue: t.queue,
    queueClear: t.queueClear,
    queueWaiting: t.queueWaiting,
    tools: t.tools,
    autoInsert: t.autoInsert,
    autoInsertHint: t.autoInsertHint,
    autoInsertOn: t.autoInsertOn,
    autoInsertOff: t.autoInsertOff,
    autoInsertEmpty: t.autoInsertEmpty,
    autoInsertPlaceholder: t.autoInsertPlaceholder,
    autoInsertAdd: t.autoInsertAdd,
    autoInsertSearch: t.autoInsertSearch,
    customTools: t.customTools,
    customToolsHint: t.customToolsHint,
    customToolsEmpty: t.customToolsEmpty,
    customToolName: t.customToolName,
    customToolNamePlaceholder: t.customToolNamePlaceholder,
    customToolTitle: t.customToolTitle,
    customToolTitlePlaceholder: t.customToolTitlePlaceholder,
    customToolDescription: t.customToolDescription,
    customToolDescriptionPlaceholder: t.customToolDescriptionPlaceholder,
    customToolBody: t.customToolBody,
    customToolBodyPlaceholder: t.customToolBodyPlaceholder,
    customToolSave: t.customToolSave,
    customToolDelete: t.customToolDelete,
    customToolEnabled: t.customToolEnabled,
    customToolDisabled: t.customToolDisabled,
    customToolsSearch: t.customToolsSearch,
    customToolTags: t.customToolTags,
    customToolTagsPlaceholder: t.customToolTagsPlaceholder,
    customToolInvalidJson: t.customToolInvalidJson,
    customToolExport: t.customToolExport,
    customToolExportAll: t.customToolExportAll,
    customToolExportOne: t.customToolExportOne,
    customToolImport: t.customToolImport,
    customToolImportAll: t.customToolImportAll,
    customToolImportOne: t.customToolImportOne,
    customToolImportPick: t.customToolImportPick,
    customToolImportPickHint: t.customToolImportPickHint,
    customToolImportSelected: t.customToolImportSelected,
    customToolImportCancel: t.customToolImportCancel,
    customToolCopyPack: t.customToolCopyPack,
    customToolCopyOne: t.customToolCopyOne,
    customToolCopied: t.customToolCopied,
    customToolExportSaved: t.customToolExportSaved,
    customToolImportDone: t.customToolImportDone,
    customToolImportMode: t.customToolImportMode,
    customToolImportSkip: t.customToolImportSkip,
    customToolImportOverwrite: t.customToolImportOverwrite,
	    customToolImportRename: t.customToolImportRename,
	    noResults: t.noResults,    agentTodo: t.agentTodo,
    agentTodoHint: t.agentTodoHint,
    agentTodoEmpty: t.agentTodoEmpty,
    instructions: t.instructions,
    instructionsHint: t.instructionsHint,
    instructionsGlobal: t.instructionsGlobal,
    instructionsProject: t.instructionsProject,
    instructionsGlobalHint: t.instructionsGlobalHint,
    instructionsProjectHint: t.instructionsProjectHint,
    instructionsProjectNoFolder: t.instructionsProjectNoFolder,
    instructionsPlaceholder: t.instructionsPlaceholder,
    instructionsSave: t.instructionsSave,
    instructionsSaved: t.instructionsSaved,
    retrying: t.retrying,
    nothingToCompact: t.nothingToCompact,
    compactFailed: t.compactFailed,
    more: t.more,
    moreCount: t.moreCount,
    collapse: t.collapse,
    collapseUnits: t.collapseUnits,
    allUnitsCount: t.allUnitsCount,
    msgsSavedTokens: t.msgsSavedTokens,
    justNow: t.justNow,
    minutesAgo: t.minutesAgo,
    hoursAgo: t.hoursAgo,
    daysAgo: t.daysAgo,
    selectWorkspaceFolder: t.selectWorkspaceFolder,
    selectFolder: t.selectFolder,
    aiRequestFailed: t.aiRequestFailed,
		    agentFinished: t.agentFinished,
		    slotN: t.slotN,
		  };  const handleLanguageChange = (lang: AppLanguage) => {
    setAppLanguage(lang);
    applyLanguage(lang);
    if (!rootPath) setProjectName(translations[lang].noFolderOpened);
  };

  return (
    <div className="relative h-full w-full flex flex-col overflow-hidden" style={{ background: "var(--bg)" }}>
      <TitleBar
        subtitle={t.multiIdeSubtitle}
        active={activePanel}
        onSelect={handlePanelSelect}
        onOpenProviders={() => setProvidersOpen(true)}
        labels={{
          multiIde: t.multiIde,
          proxy: t.activityProxy,
          settings: t.activitySettings,
          providers: t.settingsRouting,
        }}
      />

      <div className="flex-1 flex flex-col overflow-hidden relative z-0">
        <div className="app-bg" aria-hidden />
        <div className="flex-1 flex min-w-0 overflow-hidden relative z-10">
          {multiIdeMounted && (
            <div
              className={
                activePanel === "multiide"
                  ? "flex-1 min-w-0 min-h-0 flex overflow-hidden"
                  : "hidden"
              }
            >
              <MultiIdeWorkspace
                providerConfig={providerConfig}
                customTools={customTools}
                onAddCustomTool={handleAddCustomTool}
                onUpdateCustomTool={handleUpdateCustomTool}
                onRemoveCustomTool={handleRemoveCustomTool}
                labels={chatPanelLabels}
                slots={multiIdeSlots}
                onSlotsChange={setMultiIdeSlots}
                onOpenRunners={() => setActivePanel("runner")}
              />
            </div>
          )}

          {activePanel === "proxy" && <ProxyWorkspace labels={t} />}
          {activePanel === "runner" && (
            <RunnerWorkspace
              providerConfig={providerConfig}
              rootPath={rootPath}
              projectName={projectName}
              onSendToRunner={(runnerId) => {
                setRunnerSendTarget(runnerId);
                setRunnerSendOpen(true);
              }}
            />
          )}
          {activePanel === "customtools" && (
            <div className="flex-1 min-w-0 min-h-0 flex overflow-hidden">
              <CustomToolsWorkspace
                tools={customTools}
                onAdd={handleAddCustomTool}
                onUpdate={handleUpdateCustomTool}
                onRemove={handleRemoveCustomTool}
                labels={chatPanelLabels}
              />
            </div>
          )}
        </div>
      </div>

      <SearchOverlay
        open={searchOpen}
        rootPath={rootPath}
        projectName={projectName}
        labels={{
          searchPlaceholder: t.searchPlaceholder,
          noFolderOpened: t.noFolderOpened,
          searching: t.searching,
          results: t.results,
          openFolderFirst: t.openFolderFirst,
          startTypingSearch: t.startTypingSearch,
        }}
        onClose={() => setSearchOpen(false)}
        onOpenResult={handleSearchOpen}
      />

      <RunnerSendModal
        open={runnerSendOpen}
        initialRunnerId={runnerSendTarget}
        onClose={() => {
          setRunnerSendOpen(false);
          setRunnerSendTarget(null);
        }}
        onOpenRunnerTab={() => setActivePanel("runner")}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={providerConfig}
        labels={t}
        language={appLanguage}
        onLanguageChange={handleLanguageChange}
        onChange={saveProviderConfig}
      />

      <ProvidersModal
        open={providersOpen}
        onClose={() => setProvidersOpen(false)}
        config={providerConfig}
        labels={t}
        onChange={saveProviderConfig}
      />
    </div>
  );
};

export default App;
