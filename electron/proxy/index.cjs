/**
 * ComposeVC Proxy — OpenAI-compatible local gateway.
 * Public API + IPC handlers.
 */

const fs = require("fs");
const { shell, dialog } = require("electron");
const storeApi = require("./store.cjs");
const proxyProcess = require("./processManager.cjs");
const accountsApi = require("./accounts.cjs");
const codexAuth = require("./oauth/codexAuth.cjs");
const modelsApi = require("./models.cjs");
const usageStats = require("./usageStats.cjs");
const {
  listProviders,
  bootstrap,
  registerCustomProvidersFromStore,
  getProvider,
} = require("./providers/registry.cjs");
const {
  createCustomProviderModule,
  normalizeEndpoint,
  slugifyProviderId,
} = require("./providers/customFactory.cjs");
const { listConverters, bootstrap: bootConv } = require("./convert/registry.cjs");

function broadcast(channel, payload) {
  try {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  } catch {
    /* */
  }
}

function registerProxyHandlers(ipcMain, getUserDataPath) {
  bootstrap();
  bootConv();

  const ud = () => getUserDataPath();

  async function loadStoreWithCustoms() {
    const path = ud();
    const store = await storeApi.load(path);
    try {
      registerCustomProvidersFromStore(store);
    } catch {
      /* */
    }
    return { path, store };
  }

  function findApiKeyDuplicates(store, apiKey) {
    const normalizedKey = String(apiKey || "").trim();
    if (!normalizedKey) return [];
    const accountDuplicates = (store.accounts || []).filter(
      (account) => String(account.apiKey || "").trim() === normalizedKey
    );
    const accountIds = new Set(accountDuplicates.map((account) => account.id));
    const legacyDuplicates = (store.connections || [])
      .filter((connection) => String(connection.apiKey || "").trim() === normalizedKey)
      .filter((connection) => !accountIds.has(connection.id))
      .map((connection) => ({ ...connection, authType: "apikey" }));
    return [...accountDuplicates, ...legacyDuplicates];
  }

  async function upsertGrokAccount(payload) {
    const path = ud();
    const store = await storeApi.load(path);

    const existing = (store.accounts || []).find(
      (a) =>
        a.providerId === "grok" &&
        a.authType === "oauth" &&
        (a.email === payload.email || a.name === payload.email)
    );
    if (existing) {
      Object.assign(existing, {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
        expiresAt: payload.expiresAt,
        planType: payload.planType,
        workspaceId: payload.workspaceId,
        baseUrl: payload.baseUrl,
        providerMeta: payload.providerMeta,
        enabled: true,
        usageError: null,
      });
    } else {
      store.accounts.push({
        id: storeApi.newId("acc"),
        ...payload,
      });
    }

    let next = await storeApi.save(path, store);
    const accId =
      existing?.id ||
      next.accounts.find((a) => a.providerId === "grok" && a.email === payload.email)?.id;
    if (accId) {
      try {
        await accountsApi.refreshAccountUsage(path, accId);
        next = await storeApi.load(path);
      } catch {
        /* */
      }
    }

    return { path, config: storeApi.publicView(next) };
  }

  async function persistOAuthAccount(providerId, payload) {
    const path = ud();
    const store = await storeApi.load(path);
    const existing = (store.accounts || []).find(
      (account) =>
        account.providerId === providerId &&
        account.authType === "oauth" &&
        ((payload.email && account.email === payload.email) ||
          (payload.refreshToken && account.refreshToken === payload.refreshToken))
    );
    if (existing) {
      Object.assign(existing, payload, {
        id: existing.id,
        providerId,
        authType: "oauth",
        enabled: true,
        usageError: null,
      });
    } else {
      store.accounts.push({
        id: storeApi.newId("acc"),
        ...payload,
        providerId,
        authType: "oauth",
        enabled: true,
      });
    }
    let next = await storeApi.save(path, store);
    const account = existing || next.accounts[next.accounts.length - 1];
    if (account?.id) {
      try {
        await accountsApi.refreshAccountUsage(path, account.id);
        next = await storeApi.load(path);
      } catch {
      }
    }
    return { accountId: account?.id || null, config: storeApi.publicView(next) };
  }

  const oauthProviderModules = {
    "github-copilot": "githubCopilotOauth.cjs",
    windsurf: "windsurfOauth.cjs",
    cursor: "cursorOauth.cjs",
    codebuddy: "codebuddyOauth.cjs",
    "codebuddy-cn": "codebuddyCnOauth.cjs",
    qoder: "qoderOauth.cjs",
    qauth: "qauthOauth.cjs",
  };

  // The proxy gateway itself runs in a SEPARATE child process (standalone.cjs):
  // heavy streaming + log volume must never freeze the app. Here we only manage
  // the child lifecycle (spawn / stop / status / log relay) and the store file.
  proxyProcess.setUserDataPath(ud());

  ipcMain.handle("proxy:getConfig", async () => {
    const path = ud();
    proxyProcess.setUserDataPath(path);
    const store = await storeApi.load(path);
    try {
      registerCustomProvidersFromStore(store);
    } catch {
      /* */
    }
    return {
      ok: true,
      config: storeApi.publicView(store),
      status: await proxyProcess.refreshStatus(),
    };
  });

  ipcMain.handle("proxy:saveConfig", async (_e, patch = {}) => {
    const path = ud();
    const store = await storeApi.load(path);
    if (patch.host != null) store.host = String(patch.host).trim() || "127.0.0.1";
    if (patch.port != null) store.port = Math.max(1, Math.min(65535, Number(patch.port) || 8787));
    if (patch.routes && typeof patch.routes === "object") store.routes = patch.routes;

    let ngrokTouched = false;
    if (patch.ngrok && typeof patch.ngrok === "object") {
      ngrokTouched = true;
      const prev = storeApi.normalizeNgrok(store.ngrok);
      const nextNgrok = { ...prev };
      if (patch.ngrok.enabled != null) nextNgrok.enabled = Boolean(patch.ngrok.enabled);
      if (patch.ngrok.authtoken != null) nextNgrok.authtoken = String(patch.ngrok.authtoken);
      if (patch.ngrok.domain != null) nextNgrok.domain = String(patch.ngrok.domain).trim();
      if (patch.ngrok.region != null) nextNgrok.region = String(patch.ngrok.region).trim();
      store.ngrok = storeApi.normalizeNgrok(nextNgrok);
    }

    // Lopster Guard settings (OFF by default; only explicit true enables)
    if (patch.guard && typeof patch.guard === "object") {
      const prev = storeApi.normalizeGuard(store.guard);
      const nextGuard = { ...prev };
      if (patch.guard.enabled != null) nextGuard.enabled = Boolean(patch.guard.enabled);
      if (patch.guard.mode != null) nextGuard.mode = String(patch.guard.mode);
      if (patch.guard.blockOn != null) nextGuard.blockOn = String(patch.guard.blockOn);
      if (patch.guard.scrubOn != null) nextGuard.scrubOn = String(patch.guard.scrubOn);
      if (patch.guard.scrubReplacement != null) {
        nextGuard.scrubReplacement = String(patch.guard.scrubReplacement);
      }
      if (patch.guard.unsolicitedTools != null) {
        nextGuard.unsolicitedTools = Boolean(patch.guard.unsolicitedTools);
      }
      if (patch.guard.scanThinking != null) {
        nextGuard.scanThinking = Boolean(patch.guard.scanThinking);
      }
      if (patch.guard.maxFindings != null) {
        nextGuard.maxFindings = Number(patch.guard.maxFindings);
      }
      store.guard = storeApi.normalizeGuard(nextGuard);
    }

    const next = await storeApi.save(path, store);

    // If proxy is already up, apply tunnel changes immediately (the child
    // process owns the ngrok tunnel).
    let tunnel = null;
    if (ngrokTouched) {
      try {
        tunnel = await proxyProcess.command("ngrok-restart", {}, 10000);
      } catch (e) {
        tunnel = { ...((await proxyProcess.status()).ngrok || {}), error: e.message || String(e) };
      }
    }
    // Custom provider definitions may have changed → child re-registers them.
    void proxyProcess.command("reload-providers", {}, 3000).catch(() => {});

    return {
      ok: true,
      config: storeApi.publicView(next),
      status: await proxyProcess.refreshStatus(),
      tunnel,
    };
  });

  ipcMain.handle("proxy:start", async (_e, opts = {}) => {
    try {
      const st = await proxyProcess.start(ud(), opts);
      return { ok: true, status: st };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:stop", async () => {
    try {
      const st = await proxyProcess.stop();
      return { ok: true, status: st };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:status", async () => {
    proxyProcess.setUserDataPath(ud());
    return {
      ok: true,
      status: await proxyProcess.refreshStatus(),
      logs: proxyProcess.getLogs().slice(-50),
    };
  });

  // Lopster Guard — injection scanner status / recent decisions (scans run in
  // the child proxy process, so query it there; fall back to a config-only view).
  ipcMain.handle("proxy:guardStatus", async () => {
    try {
      const guard = await proxyProcess.command("guard-status", {}, 6000);
      return { ok: true, guard };
    } catch {
      try {
        const guard = require("./guard/index.cjs");
        const store = await storeApi.load(ud());
        return { ok: true, guard: guard.status(store?.guard) };
      } catch (e) {
        return { ok: false, error: e.message || String(e) };
      }
    }
  });

  ipcMain.handle("proxy:ngrokStatus", async () => {
    proxyProcess.setUserDataPath(ud());
    const st = await proxyProcess.refreshStatus();
    return { ok: true, ngrok: st.ngrok || null, status: st };
  });

  ipcMain.handle("proxy:ngrokRestart", async () => {
    try {
      proxyProcess.setUserDataPath(ud());
      const tunnel = await proxyProcess.command("ngrok-restart", {}, 15000);
      return { ok: true, tunnel, status: await proxyProcess.refreshStatus() };
    } catch (e) {
      return { ok: false, error: e.message || String(e), status: await proxyProcess.status() };
    }
  });

  ipcMain.handle("proxy:createKey", async (_e, label) => {
    const path = ud();
    const store = await storeApi.load(path);
    const rec = storeApi.newKeyRecord(label);
    store.keys.push(rec);
    const next = await storeApi.save(path, store);
    return { ok: true, key: rec, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:deleteKey", async (_e, keyId) => {
    const path = ud();
    const store = await storeApi.load(path);
    store.keys = (store.keys || []).filter((k) => k.id !== keyId);
    const next = await storeApi.save(path, store);
    return { ok: true, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:toggleKey", async (_e, keyId, enabled) => {
    const path = ud();
    const store = await storeApi.load(path);
    const k = (store.keys || []).find((x) => x.id === keyId);
    if (k) k.enabled = Boolean(enabled);
    const next = await storeApi.save(path, store);
    return { ok: true, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:listProviders", async () => {
    bootstrap();
    try {
      const store = await storeApi.load(ud());
      registerCustomProvidersFromStore(store);
    } catch {
      /* */
    }
    return {
      ok: true,
      providers: listProviders(),
      converters: listConverters(),
    };
  });

  // ── Custom OpenAI-compatible providers (manual endpoint + models) ──
  ipcMain.handle("proxy:addCustomProvider", async (_e, input = {}) => {
    try {
      const path = ud();
      const store = await storeApi.load(path);
      if (!Array.isArray(store.customProviders)) store.customProviders = [];
      if (!store.customModels || typeof store.customModels !== "object") store.customModels = {};

      const name = String(input.name || "").trim();
      const baseUrl = normalizeEndpoint(input.baseUrl || input.endpoint || "");
      if (!name) return { ok: false, error: "name required" };
      if (!baseUrl) return { ok: false, error: "endpoint / baseUrl required" };

      // Prefer user modelTag, else slug from name
      let id = String(input.id || input.modelTag || slugifyProviderId(name, "custom")).trim();
      id = id
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 48);
      if (!id) id = `custom-${storeApi.newId("p").slice(-6)}`;

      // Avoid clobbering built-in providers
      bootstrap();
      const existingMod = getProvider(id);
      const alreadyCustom = (store.customProviders || []).some((p) => p.id === id);
      if (existingMod && !alreadyCustom && !existingMod.custom && !existingMod.isCustom) {
        id = `${id}-${storeApi.newId("p").slice(-4)}`;
      }
      // Unique among customs
      let unique = id;
      let n = 2;
      while ((store.customProviders || []).some((p) => p.id === unique)) {
        unique = `${id}-${n++}`;
      }
      id = unique;

      const modelTag = String(input.modelTag || id)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, "-")
        .replace(/^-+|-+$/g, "") || id;

      const rec = {
        id,
        name,
        baseUrl,
        modelTag,
        description: String(input.description || "").trim(),
        failoverOnAnyError: input.failoverOnAnyError !== false,
        maxFailoverAttempts:
          input.maxFailoverAttempts != null ? Number(input.maxFailoverAttempts) || 30 : 30,
        createdAt: Date.now(),
      };

      // Validate module can be built
      createCustomProviderModule(rec);

      store.customProviders.push(rec);

      // Optional models at create time (string | string[] | newline/comma list)
      const rawModels = input.models ?? input.modelIds ?? input.model;
      const modelIds = [];
      if (Array.isArray(rawModels)) {
        for (const m of rawModels) {
          const s = String(m || "").trim();
          if (s) modelIds.push(s);
        }
      } else if (rawModels != null && String(rawModels).trim()) {
        for (const part of String(rawModels).split(/[\n,;]+/)) {
          const s = part.trim();
          if (s) modelIds.push(s);
        }
      }
      if (!Array.isArray(store.customModels[id])) store.customModels[id] = [];
      for (const mid of modelIds) {
        const clean = mid.replace(/^\/+/, "").trim();
        if (!clean) continue;
        if (!store.customModels[id].some((m) => String(m.id || m) === clean)) {
          store.customModels[id].push({
            id: clean,
            kind: "chat",
            owned_by: id,
            created: Date.now(),
            source: "manual",
          });
        }
      }

      const next = await storeApi.save(path, store);
      registerCustomProvidersFromStore(next);
      // Child process re-registers custom providers so routes resolve live.
      void proxyProcess.command("reload-providers", {}, 3000).catch(() => {});
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        providerId: id,
        provider: listProviders().find((p) => p.id === id) || null,
        config: storeApi.publicView(next),
        providers: listProviders(),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:updateCustomProvider", async (_e, input = {}) => {
    try {
      const path = ud();
      const store = await storeApi.load(path);
      const providerId = String(input.id || input.providerId || "").trim();
      if (!providerId) return { ok: false, error: "id required" };
      if (!Array.isArray(store.customProviders)) store.customProviders = [];
      const ix = store.customProviders.findIndex((p) => p.id === providerId);
      if (ix < 0) return { ok: false, error: "custom provider not found" };

      const prev = store.customProviders[ix];
      const nextRec = {
        ...prev,
        name: input.name != null ? String(input.name).trim() || prev.name : prev.name,
        baseUrl:
          input.baseUrl != null || input.endpoint != null
            ? normalizeEndpoint(input.baseUrl || input.endpoint)
            : prev.baseUrl,
        modelTag:
          input.modelTag != null
            ? String(input.modelTag)
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9._-]+/g, "-")
                .replace(/^-+|-+$/g, "") || prev.modelTag
            : prev.modelTag,
        description:
          input.description != null ? String(input.description).trim() : prev.description || "",
      };
      if (!nextRec.baseUrl) return { ok: false, error: "endpoint / baseUrl required" };
      createCustomProviderModule(nextRec);
      store.customProviders[ix] = nextRec;

      // Keep account baseUrls in sync with provider endpoint
      for (const a of store.accounts || []) {
        if (a.providerId === providerId && a.authType === "apikey") {
          a.baseUrl = nextRec.baseUrl;
        }
      }
      for (const c of store.connections || []) {
        if (c.providerId === providerId) c.baseUrl = nextRec.baseUrl;
      }

      const next = await storeApi.save(path, store);
      registerCustomProvidersFromStore(next);
      // Child process re-registers custom providers so routes resolve live.
      void proxyProcess.command("reload-providers", {}, 3000).catch(() => {});
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        config: storeApi.publicView(next),
        providers: listProviders(),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:deleteCustomProvider", async (_e, providerId) => {
    try {
      const path = ud();
      const store = await storeApi.load(path);
      const id = String(providerId || "").trim();
      if (!id) return { ok: false, error: "providerId required" };
      if (!Array.isArray(store.customProviders)) store.customProviders = [];
      if (!store.customProviders.some((p) => p.id === id)) {
        return { ok: false, error: "custom provider not found" };
      }
      store.customProviders = store.customProviders.filter((p) => p.id !== id);
      // Drop manual models for this provider
      if (store.customModels && store.customModels[id]) delete store.customModels[id];
      // Drop accounts / connections for this provider
      store.accounts = (store.accounts || []).filter((a) => a.providerId !== id);
      store.connections = (store.connections || []).filter((c) => c.providerId !== id);
      // Drop routes that pointed at this provider
      if (store.routes && typeof store.routes === "object") {
        for (const [k, r] of Object.entries(store.routes)) {
          if (r && r.providerId === id) delete store.routes[k];
        }
      }
      const next = await storeApi.save(path, store);
      registerCustomProvidersFromStore(next);
      // Child process re-registers custom providers so routes resolve live.
      void proxyProcess.command("reload-providers", {}, 3000).catch(() => {});
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        config: storeApi.publicView(next),
        providers: listProviders(),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  async function importGrokExtractedItems(extractedItems) {
    const grokAuth = require("./oauth/grokAuth.cjs");
    let saved = null;
    const emails = [];
    let refreshed = 0;
    let expired = 0;
    for (const raw of extractedItems) {
      const extracted = await grokAuth.ensureExtractedFresh(raw);
      if (extracted.meta?.autoRefreshed) refreshed += 1;
      const payload = grokAuth.toAccountPayload(extracted);
      if (payload.usageError && String(payload.usageError).includes("expired")) expired += 1;
      saved = await upsertGrokAccount(payload);
      emails.push(payload.email);
    }
    return {
      ok: true,
      email: emails[0],
      emails,
      imported: emails.length,
      refreshed,
      expired,
      config: saved?.config,
      modelsCache: grokAuth.readLocalModelsCache(),
    };
  }

  /** Import Grok Build CLI session from ~/.grok/auth.json (Google/X login via official CLI) */
  ipcMain.handle("proxy:importGrokCli", async () => {
    try {
      const grokAuth = require("./oauth/grokAuth.cjs");
      const local = grokAuth.readLocalAuthFile();
      if (!local.ok) return { ok: false, error: local.error, path: local.path };

      const result = await importGrokExtractedItems([local]);
      return {
        ...result,
        path: local.path,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importGrokTxt", async (_e, input = {}) => {
    try {
      const grokAuth = require("./oauth/grokAuth.cjs");
      const text = String(input.text || input || "").trim();
      if (!text) {
        return {
          ok: false,
          error: "Paste JWT / email:password:JWT / email:JWT:refresh_token lines",
        };
      }

      const items = grokAuth.extractTxtCredentialLines(text);
      const extractedItems = items.length ? items : [grokAuth.extractFromAuthInput(text)];
      const result = await importGrokExtractedItems(extractedItems);
      return { ...result, path: null };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importGrokTxtFile", async () => {
    try {
      const selected = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Text files", extensions: ["txt"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: false, canceled: true };

      const filePath = selected.filePaths[0];
      const text = fs.readFileSync(filePath, "utf8");
      const grokAuth = require("./oauth/grokAuth.cjs");
      const items = grokAuth.extractTxtCredentialLines(text);
      if (!items.length) {
        return {
          ok: false,
          error: "No valid Grok JWT / email:password:JWT / refresh lines found",
          path: filePath,
        };
      }

      const result = await importGrokExtractedItems(items);
      return { ...result, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:listModels", async (_e, opts = {}) => {
    try {
      return await modelsApi.listModelsFor(ud(), {
        providerId: opts.providerId || "openai",
        accountId: opts.accountId || null,
        chatOnly: opts.chatOnly !== false,
        refreshLive: opts.refreshLive !== false,
      });
    } catch (e) {
      return { ok: false, error: e.message || String(e), models: [] };
    }
  });

  ipcMain.handle("proxy:addModel", async (_e, input = {}) => {
    try {
      const providerId = String(input.providerId || "openai").trim();
      const modelId = String(input.id || input.model || "").trim();
      const listed = await modelsApi.addCustomModel(ud(), providerId, modelId, {
        kind: input.kind,
        owned_by: input.owned_by,
      });
      return { ok: true, ...listed };
    } catch (e) {
      return { ok: false, error: e.message || String(e), models: [] };
    }
  });

  ipcMain.handle("proxy:removeModel", async (_e, input = {}) => {
    try {
      const providerId = String(input.providerId || "openai").trim();
      const modelId = String(input.id || input.model || "").trim();
      const listed = await modelsApi.removeCustomModel(ud(), providerId, modelId);
      return { ok: true, ...listed };
    } catch (e) {
      return { ok: false, error: e.message || String(e), models: [] };
    }
  });

  // ── Accounts ─────────────────────────────────────────────
  ipcMain.handle("proxy:addApiKeyAccount", async (_e, input = {}) => {
    const path = ud();
    const store = await storeApi.load(path);
    const providerId = String(input.providerId || "").trim();
    const apiKey = String(input.apiKey || "").trim();
    if (!providerId) return { ok: false, error: "providerId required" };
    if (!apiKey) return { ok: false, error: "apiKey required" };

    const duplicateAccounts = findApiKeyDuplicates(store, apiKey);
    if (duplicateAccounts.length > 0 && input.confirmDuplicate !== true) {
      return {
        ok: false,
        duplicateKey: true,
        duplicateCount: duplicateAccounts.length,
        duplicateProviders: [...new Set(duplicateAccounts.map((a) => a.providerId).filter(Boolean))],
        error: "This API key already exists. Confirm to add it again.",
      };
    }

    const account = {
      id: storeApi.newId("acc"),
      providerId,
      authType: "apikey",
      name: input.name || providerId,
      email: null,
      planType: null,
      workspaceId: null,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
      apiKey,
      baseUrl: input.baseUrl || "",
      defaultModel: input.defaultModel || "",
      enabled: true,
      usage: null,
      usageError: null,
      usageUpdatedAt: null,
      createdAt: Date.now(),
    };
    store.accounts.push(account);
    // Keep legacy connections in sync for older routers
    store.connections.push({
      id: account.id,
      providerId,
      name: account.name,
      baseUrl: account.baseUrl,
      apiKey: account.apiKey,
      defaultModel: account.defaultModel,
      enabled: true,
      createdAt: account.createdAt,
    });
    const next = await storeApi.save(path, store);
    try {
      await accountsApi.refreshAccountUsage(path, account.id);
      const refreshed = await storeApi.load(path);
      return { ok: true, accountId: account.id, config: storeApi.publicView(refreshed) };
    } catch {
      return { ok: true, accountId: account.id, config: storeApi.publicView(next) };
    }
  });

  ipcMain.handle("proxy:importOauthToken", async (_e, input = {}) => {
    try {
      const oauthImport = require("./oauthImport.cjs");
      const result = await oauthImport.importOauthTokens(ud(), input || {});
      if (result.ok && result.config) {
        broadcast("proxy:config", { config: result.config });
      }
      return {
        ok: result.ok,
        mode: result.mode || null,
        accountId: result.accountId || null,
        email: result.email || null,
        config: result.config || null,
        error: result.error || null,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importOauthTokens", async (_e, input = {}) => {
    try {
      const oauthImport = require("./oauthImport.cjs");
      const result = await oauthImport.importOauthTokensText(
        ud(),
        String(input.providerId || "").trim(),
        String(input.text || "").trim()
      );
      if (result.ok && result.config) {
        broadcast("proxy:config", { config: result.config });
      }
      return result;
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importOauthTokensFile", async (_e, input = {}) => {
    try {
      const providerId = String(input.providerId || "").trim();
      if (!providerId) return { ok: false, error: "providerId required" };
      const selected = await dialog.showOpenDialog({
        properties: ["openFile"],
        filters: [
          { name: "Text files", extensions: ["txt"] },
          { name: "All files", extensions: ["*"] },
        ],
      });
      if (selected.canceled || !selected.filePaths?.[0]) return { ok: false, canceled: true };
      const filePath = selected.filePaths[0];
      const text = fs.readFileSync(filePath, "utf8");
      const oauthImport = require("./oauthImport.cjs");
      const result = await oauthImport.importOauthTokensText(ud(), providerId, text);
      if (result.ok && result.config) {
        broadcast("proxy:config", { config: result.config });
      }
      return { ...result, path: filePath };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:deleteAccount", async (_e, accountId) => {
    const path = ud();
    const store = await storeApi.load(path);
    store.accounts = (store.accounts || []).filter((a) => a.id !== accountId);
    store.connections = (store.connections || []).filter((c) => c.id !== accountId);
    const next = await storeApi.save(path, store);
    return { ok: true, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:refreshUsage", async (_e, accountId) => {
    try {
      if (accountId) {
        const r = await accountsApi.refreshAccountUsage(ud(), accountId);
        const store = await storeApi.load(ud());
        return { ok: r.ok, account: r.account, config: storeApi.publicView(store), error: r.error };
      }
      await accountsApi.refreshAllUsage(ud());
      const store = await storeApi.load(ud());
      return { ok: true, config: storeApi.publicView(store) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  /** Manual clear of quota / rate-limit routing block (24h cooldown may be too long). */
  ipcMain.handle("proxy:clearAccountQuota", async (_e, accountId) => {
    try {
      if (!accountId) return { ok: false, error: "accountId required" };
      const accountRouter = require("./routing/accountRouter.cjs");
      const path = ud();
      const store = await storeApi.load(path);
      const idx = (store.accounts || []).findIndex((a) => a.id === accountId);
      if (idx < 0) return { ok: false, error: "account not found" };
      const account = store.accounts[idx];
      accountRouter.hydrateFromAccount(account);
      const cleared = accountRouter.clearQuotaBlock(accountId, account);
      if (!cleared?.ok) return { ok: false, error: cleared?.error || "clear failed" };
      store.accounts[idx] = account;
      const next = await storeApi.save(path, store);
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        account: storeApi.publicView(next).accounts.find((a) => a.id === accountId),
        config: storeApi.publicView(next),
        status: cleared.status,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:routingStatus", async () => {
    // Live router state lives in the child process (health worker + pipeline
    // updates it there). Query it first; fall back to a store-derived view.
    try {
      const payload = await proxyProcess.command("routing-status", {}, 8000);
      if (payload && payload.statuses) {
        return { ok: true, statuses: payload.statuses, accounts: payload.accounts };
      }
    } catch {
      /* child not running — fall back below */
    }
    try {
      const accountRouter = require("./routing/accountRouter.cjs");
      const store = await storeApi.load(ud());
      // hydrate all
      for (const a of store.accounts || []) accountRouter.hydrateFromAccount(a);
      return {
        ok: true,
        statuses: accountRouter.getAllStatuses(),
        accounts: storeApi.publicView(store).accounts,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Grok browser OAuth (Google / X via auth.x.ai PKCE) ───
  ipcMain.handle("proxy:grokOauthStart", async () => {
    const grokOauth = require("./oauth/grokOauth.cjs");
    const sessionId = grokOauth.startSession();
    void (async () => {
      try {
        const accountPayload = await grokOauth.runBrowserOauth(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const existing = (store.accounts || []).find(
          (a) =>
            a.providerId === "grok" &&
            a.authType === "oauth" &&
            accountPayload.email &&
            a.email === accountPayload.email
        );
        if (existing) {
          Object.assign(existing, {
            accessToken: accountPayload.accessToken,
            refreshToken: accountPayload.refreshToken,
            expiresAt: accountPayload.expiresAt,
            planType: accountPayload.planType,
            workspaceId: accountPayload.workspaceId,
            baseUrl: accountPayload.baseUrl,
            providerMeta: accountPayload.providerMeta,
            enabled: true,
          });
        } else {
          store.accounts.push({
            id: storeApi.newId("acc"),
            ...accountPayload,
          });
        }
        let next = await storeApi.save(path, store);
        // Pull plan + monthly billing immediately
        try {
          const accId =
            existing?.id ||
            next.accounts.find((a) => a.providerId === "grok" && a.email === accountPayload.email)
              ?.id;
          if (accId) await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          providerId: "grok",
          config: storeApi.publicView(next),
        });
        broadcast("proxy:config", { config: storeApi.publicView(next) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          providerId: "grok",
          error: e.message || String(e),
        });
      }
    })();

    await sleep(500);
    let session = grokOauth.getSession(sessionId);
    for (let i = 0; i < 20 && session && !session.authorizeUrl && session.status !== "error"; i++) {
      await sleep(150);
      session = grokOauth.getSession(sessionId);
    }
    session = grokOauth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "starting",
      authorizeUrl: session?.authorizeUrl || null,
      redirectUri: session?.redirectUri || null,
      error: session?.error || null,
    };
  });

  // ── Gemini CLI: set / bind GCP projectId on an account ───
  ipcMain.handle("proxy:setGeminiCliProject", async (_e, { accountId, projectId } = {}) => {
    try {
      const path = ud();
      const store = await storeApi.load(path);
      const idx = (store.accounts || []).findIndex((a) => a.id === accountId);
      if (idx < 0) return { ok: false, error: "account not found" };
      const account = store.accounts[idx];
      if (account.providerId !== "gemini-cli") {
        return { ok: false, error: "only gemini-cli accounts support project binding" };
      }
      const pid = String(projectId || "").trim().replace(/^projects\//, "");
      if (!pid) return { ok: false, error: "projectId required" };

      account.providerMeta = {
        ...(account.providerMeta || {}),
        projectId: pid,
      };
      account.workspaceId = pid;
      account.usageError = null;
      store.accounts[idx] = account;
      await storeApi.save(path, store);

      // onboard + refresh quotas with new project
      try {
        await accountsApi.ensureFreshToken(path, account);
        const geminiCliAuth = require("./oauth/geminiCliAuth.cjs");
        if (account.accessToken) {
          await geminiCliAuth.ensureProjectAssigned(account.accessToken, {
            preferredProjectId: pid,
            email: account.email,
            accounts: store.accounts,
          });
        }
      } catch {
        /* */
      }
      try {
        await accountsApi.refreshAccountUsage(path, accountId);
      } catch {
        /* */
      }
      const next = await storeApi.load(path);
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return { ok: true, config: storeApi.publicView(next) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Gemini CLI: import ~/.gemini/oauth_creds.json ────────
  ipcMain.handle("proxy:importGeminiCli", async () => {
    try {
      const geminiCliAuth = require("./oauth/geminiCliAuth.cjs");
      const local = geminiCliAuth.readLocalGeminiAuthFile();
      if (!local.ok) return { ok: false, error: local.error, path: local.path };

      const path = ud();
      const store = await storeApi.load(path);
      let enr = {};
      try {
        enr = await geminiCliAuth.enrichWithBackend(local.accessToken, {
          accounts: store.accounts || [],
        });
      } catch {
        /* */
      }
      const payload = geminiCliAuth.toAccountPayload(local, {
        ...enr,
        source: "gemini_cli_import",
      });

      const existing = (store.accounts || []).find(
        (a) =>
          a.providerId === "gemini-cli" &&
          a.authType === "oauth" &&
          ((payload.email && a.email === payload.email) ||
            a.accessToken === payload.accessToken)
      );
      if (existing) {
        Object.assign(existing, {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          expiresAt: payload.expiresAt,
          name: payload.name,
          email: payload.email,
          planType: payload.planType,
          workspaceId: payload.workspaceId,
          baseUrl: payload.baseUrl,
          providerMeta: payload.providerMeta,
          enabled: true,
          usageError: null,
        });
      } else {
        store.accounts.push({ id: storeApi.newId("acc"), ...payload });
      }
      let next = await storeApi.save(path, store);
      const accId =
        existing?.id ||
        next.accounts.find(
          (a) => a.providerId === "gemini-cli" && a.email === payload.email
        )?.id;
      if (accId) {
        try {
          await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
      }
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        email: payload.email,
        path: local.path,
        config: storeApi.publicView(next),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Gemini CLI Google browser OAuth ──────────────────────
  ipcMain.handle("proxy:geminiCliOauthStart", async () => {
    const pid = "gemini-cli";
    const geminiCliOauth = require("./oauth/geminiCliOauth.cjs");
    const sessionId = geminiCliOauth.startSession();
    // Preload sibling Cloud Code accounts so project can be reused after OAuth
    try {
      const store0 = await storeApi.load(ud());
      const sess = geminiCliOauth.getSession(sessionId);
      if (sess) sess.accounts = store0.accounts || [];
    } catch {
      /* */
    }
    void (async () => {
      try {
        const accountPayload = await geminiCliOauth.runBrowserOauth(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const existing = (store.accounts || []).find(
          (a) =>
            a.providerId === pid &&
            a.authType === "oauth" &&
            accountPayload.email &&
            a.email === accountPayload.email
        );
        if (existing) {
          Object.assign(existing, {
            accessToken: accountPayload.accessToken,
            refreshToken: accountPayload.refreshToken,
            expiresAt: accountPayload.expiresAt,
            planType: accountPayload.planType,
            workspaceId: accountPayload.workspaceId,
            baseUrl: accountPayload.baseUrl,
            providerMeta: accountPayload.providerMeta,
            enabled: true,
            usageError: null,
            usage: accountPayload.usage ?? existing.usage,
          });
        } else {
          store.accounts.push({ id: storeApi.newId("acc"), ...accountPayload });
        }
        let next = await storeApi.save(path, store);
        try {
          const accId =
            existing?.id ||
            next.accounts.find(
              (a) => a.providerId === pid && a.email === accountPayload.email
            )?.id;
          // Re-bind project after save using full store (Antigravity/agy siblings)
          if (accId && !accountPayload.workspaceId && !accountPayload.providerMeta?.projectId) {
            try {
              const geminiCliAuth = require("./oauth/geminiCliAuth.cjs");
              const acc = next.accounts.find((a) => a.id === accId);
              if (acc?.accessToken) {
                const disc = await geminiCliAuth.ensureProjectAssigned(acc.accessToken, {
                  email: acc.email,
                  accounts: next.accounts,
                });
                if (disc.projectId) {
                  acc.workspaceId = disc.projectId;
                  acc.providerMeta = {
                    ...(acc.providerMeta || {}),
                    projectId: disc.projectId,
                    tier: disc.tier || acc.providerMeta?.tier,
                  };
                  acc.planType = disc.tier
                    ? `${disc.tier} · ${disc.projectId}`
                    : `GCP · ${disc.projectId}`;
                  acc.usageError = null;
                  next = await storeApi.save(path, next);
                }
              }
            } catch {
              /* */
            }
          }
          if (accId) await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          providerId: pid,
          config: storeApi.publicView(next),
        });
        broadcast("proxy:config", { config: storeApi.publicView(next) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          providerId: pid,
          error: e.message || String(e),
        });
      }
    })();

    await sleep(400);
    let session = geminiCliOauth.getSession(sessionId);
    for (let i = 0; i < 20 && session && !session.authorizeUrl && session.status !== "error"; i++) {
      await sleep(150);
      session = geminiCliOauth.getSession(sessionId);
    }
    session = geminiCliOauth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "starting",
      authorizeUrl: session?.authorizeUrl || null,
      redirectUri: session?.redirectUri || null,
      providerId: pid,
      error: session?.error || null,
    };
  });

  // ── Antigravity Google browser OAuth ─────────────────────
  ipcMain.handle("proxy:antigravityOauthStart", async () => {
    const pid = "antigravity";
    const antigravityOauth = require("./oauth/antigravityOauth.cjs");
    const sessionId = antigravityOauth.startSession(pid);
    void (async () => {
      try {
        const accountPayload = await antigravityOauth.runBrowserOauth(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const existing = (store.accounts || []).find(
          (a) =>
            a.providerId === pid &&
            a.authType === "oauth" &&
            accountPayload.email &&
            a.email === accountPayload.email
        );
        if (existing) {
          Object.assign(existing, {
            accessToken: accountPayload.accessToken,
            refreshToken: accountPayload.refreshToken,
            expiresAt: accountPayload.expiresAt,
            planType: accountPayload.planType,
            workspaceId: accountPayload.workspaceId,
            baseUrl: accountPayload.baseUrl,
            providerMeta: accountPayload.providerMeta,
            enabled: true,
          });
        } else {
          store.accounts.push({
            id: storeApi.newId("acc"),
            ...accountPayload,
          });
        }
        let next = await storeApi.save(path, store);
        try {
          const accId =
            existing?.id ||
            next.accounts.find((a) => a.providerId === pid && a.email === accountPayload.email)?.id;
          if (accId) await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          providerId: pid,
          config: storeApi.publicView(next),
        });
        broadcast("proxy:config", { config: storeApi.publicView(next) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          providerId: pid,
          error: e.message || String(e),
        });
      }
    })();

    await sleep(500);
    let session = antigravityOauth.getSession(sessionId);
    for (let i = 0; i < 20 && session && !session.authorizeUrl && session.status !== "error"; i++) {
      await sleep(150);
      session = antigravityOauth.getSession(sessionId);
    }
    session = antigravityOauth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "starting",
      authorizeUrl: session?.authorizeUrl || null,
      redirectUri: session?.redirectUri || null,
      providerId: pid,
      error: session?.error || null,
    };
  });

  // ── Claude Code OAuth (PKCE + paste code#state) ───────────
  ipcMain.handle("proxy:claudeCodeOauthStart", async () => {
    const pid = "claude-code";
    const claudeCodeOauth = require("./oauth/claudeCodeOauth.cjs");
    const sessionId = claudeCodeOauth.startSession();
    void (async () => {
      try {
        const accountPayload = await claudeCodeOauth.runBrowserOauth(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const existing = (store.accounts || []).find(
          (a) =>
            a.providerId === pid &&
            a.authType === "oauth" &&
            accountPayload.email &&
            a.email === accountPayload.email
        );
        if (existing) {
          Object.assign(existing, {
            accessToken: accountPayload.accessToken,
            refreshToken: accountPayload.refreshToken,
            expiresAt: accountPayload.expiresAt,
            planType: accountPayload.planType,
            workspaceId: accountPayload.workspaceId,
            baseUrl: accountPayload.baseUrl,
            providerMeta: {
              ...(existing.providerMeta || {}),
              ...(accountPayload.providerMeta || {}),
              cliUserID:
                existing.providerMeta?.cliUserID || accountPayload.providerMeta?.cliUserID,
            },
            name: accountPayload.name || existing.name,
            email: accountPayload.email || existing.email,
            enabled: true,
            usageError: null,
          });
        } else {
          store.accounts.push({
            id: storeApi.newId("acc"),
            ...accountPayload,
          });
        }
        let next = await storeApi.save(path, store);
        try {
          const accId =
            existing?.id ||
            next.accounts.find(
              (a) => a.providerId === pid && a.email === accountPayload.email
            )?.id ||
            next.accounts.filter((a) => a.providerId === pid).slice(-1)[0]?.id;
          if (accId) await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          providerId: pid,
          config: storeApi.publicView(next),
        });
        broadcast("proxy:config", { config: storeApi.publicView(next) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          providerId: pid,
          error: e.message || String(e),
        });
      }
    })();

    await sleep(200);
    const session = claudeCodeOauth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "waiting_code",
      authorizeUrl: session?.authorizeUrl || null,
      redirectUri: session?.redirectUri || claudeCodeOauth.REDIRECT_URI,
      needsPasteCode: true,
      providerId: pid,
      error: session?.error || null,
    };
  });

  ipcMain.handle("proxy:claudeCodeOauthComplete", async (_e, { sessionId, code } = {}) => {
    try {
      const claudeCodeOauth = require("./oauth/claudeCodeOauth.cjs");
      const payload = await claudeCodeOauth.completeSession(sessionId, code);
      // runBrowserOauth waiter will persist; also persist here for safety if race
      return {
        ok: true,
        sessionId,
        status: "exchanging",
        email: payload?.email || null,
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importClaudeCodeCli", async () => {
    try {
      const claudeCodeAuth = require("./oauth/claudeCodeAuth.cjs");
      const local = claudeCodeAuth.readLocalClaudeAuthFile();
      if (!local.ok) return { ok: false, error: local.error, path: local.path };

      const path = ud();
      const store = await storeApi.load(path);
      let enr = {};
      try {
        enr = await claudeCodeAuth.enrichWithBackend(local.access_token, local);
      } catch {
        /* */
      }
      const payload = claudeCodeAuth.toAccountPayload(
        {
          access_token: local.access_token,
          refresh_token: local.refresh_token,
          expiresAt: local.expiresAt,
        },
        {
          ...enr,
          scopes: local.scopes,
          plan: enr.plan || local.subscriptionType || local.rateLimitTier,
          rateLimitTier: enr.rateLimitTier || local.rateLimitTier,
          source: "claude_code_cli_import",
        }
      );

      const existing = (store.accounts || []).find(
        (a) =>
          a.providerId === "claude-code" &&
          a.authType === "oauth" &&
          ((payload.email && a.email === payload.email) ||
            a.accessToken === payload.accessToken)
      );
      if (existing) {
        Object.assign(existing, {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          expiresAt: payload.expiresAt,
          name: payload.name,
          email: payload.email,
          planType: payload.planType,
          workspaceId: payload.workspaceId,
          baseUrl: payload.baseUrl,
          providerMeta: {
            ...(existing.providerMeta || {}),
            ...(payload.providerMeta || {}),
            cliUserID: existing.providerMeta?.cliUserID || payload.providerMeta?.cliUserID,
          },
          enabled: true,
          usageError: null,
        });
      } else {
        store.accounts.push({ id: storeApi.newId("acc"), ...payload });
      }
      let next = await storeApi.save(path, store);
      const accId =
        existing?.id ||
        next.accounts.find(
          (a) => a.providerId === "claude-code" && a.email === payload.email
        )?.id ||
        next.accounts.filter((a) => a.providerId === "claude-code").slice(-1)[0]?.id;
      if (accId) {
        try {
          await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
      }
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        email: payload.email,
        path: local.path,
        config: storeApi.publicView(next),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importClaudeCodeJson", async (_e, text = "") => {
    try {
      const claudeCodeAuth = require("./oauth/claudeCodeAuth.cjs");
      const parsed = claudeCodeAuth.parseClaudeAuthJsonText(text);
      const path = ud();
      const store = await storeApi.load(path);
      let enr = {};
      try {
        enr = await claudeCodeAuth.enrichWithBackend(parsed.access_token, parsed);
      } catch {
        /* */
      }
      const payload = claudeCodeAuth.toAccountPayload(
        {
          access_token: parsed.access_token,
          refresh_token: parsed.refresh_token,
          expiresAt: parsed.expiresAt,
        },
        {
          ...enr,
          scopes: parsed.scopes,
          plan: enr.plan || parsed.subscriptionType || parsed.rateLimitTier,
          rateLimitTier: enr.rateLimitTier || parsed.rateLimitTier,
          source: "claude_code_json_import",
        }
      );
      const existing = (store.accounts || []).find(
        (a) =>
          a.providerId === "claude-code" &&
          a.authType === "oauth" &&
          ((payload.email && a.email === payload.email) ||
            a.accessToken === payload.accessToken)
      );
      if (existing) {
        Object.assign(existing, {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          expiresAt: payload.expiresAt,
          name: payload.name,
          email: payload.email,
          planType: payload.planType,
          workspaceId: payload.workspaceId,
          baseUrl: payload.baseUrl,
          providerMeta: {
            ...(existing.providerMeta || {}),
            ...(payload.providerMeta || {}),
            cliUserID: existing.providerMeta?.cliUserID || payload.providerMeta?.cliUserID,
          },
          enabled: true,
          usageError: null,
        });
      } else {
        store.accounts.push({ id: storeApi.newId("acc"), ...payload });
      }
      let next = await storeApi.save(path, store);
      const accId =
        existing?.id ||
        next.accounts.find(
          (a) => a.providerId === "claude-code" && a.email === payload.email
        )?.id ||
        next.accounts.filter((a) => a.providerId === "claude-code").slice(-1)[0]?.id;
      if (accId) {
        try {
          await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
      }
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return { ok: true, email: payload.email, config: storeApi.publicView(next) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── Kiro OAuth (AWS Builder ID device code) ──────────────
  ipcMain.handle("proxy:kiroOauthStart", async (_e, opts = {}) => {
    const pid = "kiro";
    const kiroOauth = require("./oauth/kiroOauth.cjs");
    const sessionId = kiroOauth.startSession({
      region: opts.region || "us-east-1",
      startUrl: opts.startUrl,
    });
    void (async () => {
      try {
        const accountPayload = await kiroOauth.runDeviceOauth(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const existing = (store.accounts || []).find(
          (a) =>
            a.providerId === pid &&
            a.authType === "oauth" &&
            ((accountPayload.email && a.email === accountPayload.email) ||
              (accountPayload.refreshToken && a.refreshToken === accountPayload.refreshToken))
        );
        if (existing) {
          Object.assign(existing, {
            accessToken: accountPayload.accessToken,
            refreshToken: accountPayload.refreshToken,
            expiresAt: accountPayload.expiresAt,
            planType: accountPayload.planType,
            workspaceId: accountPayload.workspaceId,
            baseUrl: accountPayload.baseUrl,
            providerMeta: {
              ...(existing.providerMeta || {}),
              ...(accountPayload.providerMeta || {}),
            },
            name: accountPayload.name || existing.name,
            email: accountPayload.email || existing.email,
            enabled: true,
            usageError: null,
          });
        } else {
          store.accounts.push({ id: storeApi.newId("acc"), ...accountPayload });
        }
        let next = await storeApi.save(path, store);
        try {
          const accId =
            existing?.id ||
            next.accounts.find(
              (a) => a.providerId === pid && a.email === accountPayload.email
            )?.id ||
            next.accounts.filter((a) => a.providerId === pid).slice(-1)[0]?.id;
          if (accId) await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          providerId: pid,
          config: storeApi.publicView(next),
        });
        broadcast("proxy:config", { config: storeApi.publicView(next) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          providerId: pid,
          error: e.message || String(e),
        });
      }
    })();

    await sleep(400);
    let session = kiroOauth.getSession(sessionId);
    for (let i = 0; i < 30 && session && !session.userCode && session.status !== "error"; i++) {
      await sleep(150);
      session = kiroOauth.getSession(sessionId);
    }
    session = kiroOauth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "starting",
      userCode: session?.userCode || null,
      verificationUri: session?.verificationUri || session?.authorizeUrl || null,
      authorizeUrl: session?.authorizeUrl || null,
      providerId: pid,
      error: session?.error || null,
    };
  });

  ipcMain.handle("proxy:importKiroToken", async (_e, input = {}) => {
    try {
      const token = String(input.refreshToken || input.token || input.text || "").trim();
      if (!token) return { ok: false, error: "Paste a Kiro refresh token" };
      const region = String(input.region || "us-east-1").trim() || "us-east-1";
      const kiroAuth = require("./oauth/kiroAuth.cjs");
      const validated = await kiroAuth.validateImportToken(token, region);
      const payload = kiroAuth.toAccountPayload(
        {
          access_token: validated.accessToken,
          refresh_token: validated.refreshToken,
          expires_in: validated.expiresIn,
        },
        {
          region: validated.region || region,
          profileArn: validated.profileArn,
          clientId: validated.clientId,
          clientSecret: validated.clientSecret,
          authMethod: validated.authMethod || "imported",
          source: "kiro_token_import",
          email: input.email || undefined,
        }
      );
      const path = ud();
      const store = await storeApi.load(path);
      const existing = (store.accounts || []).find(
        (a) =>
          a.providerId === "kiro" &&
          a.authType === "oauth" &&
          ((payload.email && a.email === payload.email) ||
            a.refreshToken === payload.refreshToken)
      );
      if (existing) {
        Object.assign(existing, {
          accessToken: payload.accessToken,
          refreshToken: payload.refreshToken,
          expiresAt: payload.expiresAt,
          planType: payload.planType,
          workspaceId: payload.workspaceId,
          baseUrl: payload.baseUrl,
          providerMeta: {
            ...(existing.providerMeta || {}),
            ...(payload.providerMeta || {}),
          },
          enabled: true,
          usageError: null,
        });
      } else {
        store.accounts.push({ id: storeApi.newId("acc"), ...payload });
      }
      let next = await storeApi.save(path, store);
      const accId =
        existing?.id ||
        next.accounts.filter((a) => a.providerId === "kiro").slice(-1)[0]?.id;
      if (accId) {
        try {
          await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
      }
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return { ok: true, email: payload.email, config: storeApi.publicView(next) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:importKiroCli", async () => {
    try {
      const kiroAuth = require("./oauth/kiroAuth.cjs");
      const local = kiroAuth.readLocalKiroAuthFile();
      if (!local.ok) return { ok: false, error: local.error, path: local.path };
      if (!local.refreshToken && !local.accessToken) {
        return { ok: false, error: "Local Kiro file has no tokens", path: local.path };
      }
      let payload;
      if (local.refreshToken) {
        const validated = await kiroAuth.validateImportToken(
          local.refreshToken,
          local.region || "us-east-1"
        );
        payload = kiroAuth.toAccountPayload(
          {
            access_token: validated.accessToken,
            refresh_token: validated.refreshToken,
            expires_in: validated.expiresIn,
          },
          {
            region: validated.region || local.region || "us-east-1",
            profileArn: validated.profileArn || local.profileArn,
            clientId: validated.clientId || local.clientId,
            clientSecret: validated.clientSecret || local.clientSecret,
            authMethod: validated.authMethod || "builder-id",
            source: "kiro_cli_import",
          }
        );
      } else {
        payload = kiroAuth.toAccountPayload(
          {
            access_token: local.accessToken,
            refresh_token: local.refreshToken || "",
            expires_in: 3600,
          },
          {
            region: local.region || "us-east-1",
            profileArn: local.profileArn,
            clientId: local.clientId,
            clientSecret: local.clientSecret,
            authMethod: "imported",
            source: "kiro_cli_import",
          }
        );
      }
      const path = ud();
      const store = await storeApi.load(path);
      store.accounts.push({ id: storeApi.newId("acc"), ...payload });
      let next = await storeApi.save(path, store);
      const accId = next.accounts.filter((a) => a.providerId === "kiro").slice(-1)[0]?.id;
      if (accId) {
        try {
          await accountsApi.refreshAccountUsage(path, accId);
          next = await storeApi.load(path);
        } catch {
          /* */
        }
      }
      broadcast("proxy:config", { config: storeApi.publicView(next) });
      return {
        ok: true,
        email: payload.email,
        path: local.path,
        config: storeApi.publicView(next),
      };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // ── OpenAI OAuth (Codex device flow) ─────────────────────
  ipcMain.handle("proxy:oauthStart", async (_e, providerId = "openai") => {
    const genericProviders = new Set([
      "github-copilot",
      "windsurf",
      "cursor",
      "codebuddy",
      "codebuddy-cn",
      "qoder",
      "qauth",
    ]);
    if (genericProviders.has(providerId)) {
      const moduleName = oauthProviderModules[providerId];
      const oauth = require(`./oauth/${moduleName}`);
      const sessionId = oauth.startSession();
      void (async () => {
        try {
          const payload = await oauth.runBrowserOauth(sessionId, {
            openExternal: (url) => shell.openExternal(url),
          });
          const saved = await persistOAuthAccount(providerId, payload);
          broadcast("proxy:oauth", {
            sessionId,
            status: "done",
            providerId,
            accountId: saved.accountId,
            config: saved.config,
          });
          broadcast("proxy:config", { config: saved.config });
        } catch (e) {
          broadcast("proxy:oauth", {
            sessionId,
            status: "error",
            providerId,
            error: e.message || String(e),
          });
        }
      })();
      await sleep(200);
      const session = oauth.getSession(sessionId);
      return {
        ok: true,
        sessionId,
        providerId,
        status: session?.status || "starting",
        authorizeUrl: session?.authorizeUrl || null,
        verificationUri: session?.verificationUri || session?.authorizeUrl || null,
        error: session?.error || null,
      };
    }
    if (providerId === "grok") {
      return { ok: false, error: "Use Sign in with browser on Grok card (proxy:grokOauthStart)" };
    }
    if (providerId === "antigravity") {
      return {
        ok: false,
        error: "Use Sign in with Google on Antigravity card (proxy:antigravityOauthStart)",
      };
    }
    if (providerId === "gemini-cli") {
      return {
        ok: false,
        error: "Use Sign in with Google / Import CLI on Gemini CLI card",
      };
    }
    if (providerId === "claude-code") {
      return {
        ok: false,
        error: "Use Sign in Claude Code on Claude Code card (proxy:claudeCodeOauthStart)",
      };
    }
    if (providerId === "kiro") {
      return {
        ok: false,
        error: "Use Sign in with Builder ID on Kiro card (proxy:kiroOauthStart)",
      };
    }
    if (providerId !== "openai") {
      return {
        ok: false,
        error:
          "OAuth: openai device, grok browser, antigravity Google, gemini-cli Google, claude-code, or kiro",
      };
    }
    const sessionId = codexAuth.startSession();
    // Fire-and-forget flow
    void (async () => {
      try {
        const accountPayload = await codexAuth.runDeviceFlow(sessionId, {
          openExternal: (url) => shell.openExternal(url),
        });
        const path = ud();
        const store = await storeApi.load(path);
        const account = {
          id: storeApi.newId("acc"),
          providerId: "openai",
          authType: "oauth",
          name: accountPayload.email || "ChatGPT",
          email: accountPayload.email,
          planType: accountPayload.planType,
          workspaceId: accountPayload.workspaceId,
          accessToken: accountPayload.accessToken,
          refreshToken: accountPayload.refreshToken,
          idToken: accountPayload.idToken,
          expiresAt: accountPayload.expiresAt,
          apiKey: "",
          // OAuth uses Codex backend, not Platform API (platform needs separate billing)
          baseUrl: "https://chatgpt.com/backend-api/codex",
          defaultModel: "",
          enabled: true,
          usage: null,
          usageError: null,
          usageUpdatedAt: null,
          createdAt: Date.now(),
        };
        store.accounts.push(account);
        await storeApi.save(path, store);
        // Fetch usage immediately
        try {
          await accountsApi.refreshAccountUsage(path, account.id);
        } catch {
          /* */
        }
        const store2 = await storeApi.load(path);
        broadcast("proxy:oauth", {
          sessionId,
          status: "done",
          accountId: account.id,
          config: storeApi.publicView(store2),
        });
        broadcast("proxy:config", { config: storeApi.publicView(store2) });
      } catch (e) {
        broadcast("proxy:oauth", {
          sessionId,
          status: "error",
          error: e.message || String(e),
        });
      }
    })();

    // Wait briefly for user code
    await sleep(400);
    let session = codexAuth.getSession(sessionId);
    for (let i = 0; i < 20 && session && !session.userCode && session.status !== "error"; i++) {
      await sleep(150);
      session = codexAuth.getSession(sessionId);
    }
    session = codexAuth.getSession(sessionId);
    return {
      ok: true,
      sessionId,
      status: session?.status || "starting",
      userCode: session?.userCode || null,
      verificationUri: session?.verificationUri || codexAuth.VERIFICATION_URI,
      error: session?.error || null,
    };
  });

  ipcMain.handle("proxy:oauthStatus", async (_e, sessionId) => {
    const sid = String(sessionId || "");
    if (sid.startsWith("grok_oauth_")) {
      const grokOauth = require("./oauth/grokOauth.cjs");
      const session = grokOauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: null,
        verificationUri: session.authorizeUrl,
        authorizeUrl: session.authorizeUrl,
        error: session.error,
      };
    }
    if (sid.startsWith("gemini_cli_oauth_")) {
      const geminiCliOauth = require("./oauth/geminiCliOauth.cjs");
      const session = geminiCliOauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: null,
        verificationUri: session.authorizeUrl,
        authorizeUrl: session.authorizeUrl,
        providerId: "gemini-cli",
        error: session.error,
      };
    }
    if (sid.startsWith("antigravity_oauth_") || sid.startsWith("agy_oauth_")) {
      const antigravityOauth = require("./oauth/antigravityOauth.cjs");
      const session = antigravityOauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: null,
        verificationUri: session.authorizeUrl,
        authorizeUrl: session.authorizeUrl,
        providerId: "antigravity",
        error: session.error,
      };
    }
    if (sid.startsWith("claude_code_oauth_")) {
      const claudeCodeOauth = require("./oauth/claudeCodeOauth.cjs");
      const session = claudeCodeOauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: null,
        verificationUri: session.authorizeUrl,
        authorizeUrl: session.authorizeUrl,
        redirectUri: session.redirectUri,
        needsPasteCode: true,
        providerId: "claude-code",
        error: session.error,
      };
    }
    for (const [providerId, moduleName] of Object.entries(oauthProviderModules)) {
      if (!sid.startsWith(`${providerId.replace(/-/g, "_")}_oauth_`)) continue;
      const oauth = require(`./oauth/${moduleName}`);
      const session = oauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: session.userCode || null,
        verificationUri: session.verificationUri || session.authorizeUrl || null,
        authorizeUrl: session.authorizeUrl || null,
        providerId,
        error: session.error || null,
      };
    }
    if (sid.startsWith("kiro_oauth_")) {
      const kiroOauth = require("./oauth/kiroOauth.cjs");
      const session = kiroOauth.getSession(sid);
      if (!session) return { ok: false, error: "session not found" };
      return {
        ok: true,
        sessionId: sid,
        status: session.status,
        userCode: session.userCode,
        verificationUri: session.verificationUri || session.authorizeUrl,
        authorizeUrl: session.authorizeUrl,
        providerId: "kiro",
        error: session.error,
      };
    }
    const session = codexAuth.getSession(sessionId);
    if (!session) return { ok: false, error: "session not found" };
    return {
      ok: true,
      sessionId,
      status: session.status,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      error: session.error,
    };
  });

  ipcMain.handle("proxy:oauthCancel", async (_e, sessionId) => {
    const sid = String(sessionId || "");
    if (sid.startsWith("grok_oauth_")) {
      require("./oauth/grokOauth.cjs").cancelSession(sid);
    } else if (sid.startsWith("gemini_cli_oauth_")) {
      require("./oauth/geminiCliOauth.cjs").cancelSession(sid);
    } else if (sid.startsWith("antigravity_oauth_") || sid.startsWith("agy_oauth_")) {
      require("./oauth/antigravityOauth.cjs").cancelSession(sid);
    } else if (sid.startsWith("claude_code_oauth_")) {
      require("./oauth/claudeCodeOauth.cjs").cancelSession(sid);
    } else if (sid.startsWith("kiro_oauth_")) {
      require("./oauth/kiroOauth.cjs").cancelSession(sid);
    } else {
      for (const [providerId, moduleName] of Object.entries(oauthProviderModules)) {
        if (sid.startsWith(`${providerId.replace(/-/g, "_")}_oauth_`)) {
          require(`./oauth/${moduleName}`).cancelSession(sid);
          return { ok: true };
        }
      }
      codexAuth.cancelSession(sessionId);
    }
    return { ok: true };
  });

  ipcMain.handle("proxy:upsertConnection", async (_e, input = {}) => {
    const path = ud();
    const store = await storeApi.load(path);
    const providerId = String(input.providerId || "").trim();
    if (!providerId) return { ok: false, error: "providerId required" };
    if (!input.apiKey && !input.id) return { ok: false, error: "apiKey required" };
    const account = {
      id: storeApi.newId("acc"),
      providerId,
      authType: "apikey",
      name: input.name || providerId,
      email: null,
      planType: null,
      workspaceId: null,
      accessToken: null,
      refreshToken: null,
      idToken: null,
      expiresAt: null,
      apiKey: input.apiKey || "",
      baseUrl: input.baseUrl || "",
      defaultModel: input.defaultModel || "",
      enabled: true,
      usage: null,
      usageError: null,
      usageUpdatedAt: null,
      createdAt: Date.now(),
    };
    store.accounts.push(account);
    const next = await storeApi.save(path, store);
    return { ok: true, connectionId: account.id, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:deleteConnection", async (_e, connectionId) => {
    const path = ud();
    const store = await storeApi.load(path);
    store.accounts = (store.accounts || []).filter((a) => a.id !== connectionId);
    store.connections = (store.connections || []).filter((c) => c.id !== connectionId);
    const next = await storeApi.save(path, store);
    return { ok: true, config: storeApi.publicView(next) };
  });

  ipcMain.handle("proxy:setRoute", async (_e, model, route) => {
    const path = ud();
    const store = await storeApi.load(path);
    if (!model) return { ok: false, error: "model required" };
    if (!route) delete store.routes[model];
    else {
      store.routes[model] = {
        providerId: route.providerId,
        upstreamModel: route.upstreamModel || model,
        accountId: route.accountId || route.connectionId,
      };
    }
    const next = await storeApi.save(path, store);
    return { ok: true, config: storeApi.publicView(next) };
  });

  const logBatcher = require("./logBatcher.cjs").createLogBatcher(
    (batch) => broadcast("proxy:log/batch", { entries: batch }),
    { maxBatch: 50, flushMs: 120, maxQueued: 500 }
  );
  // Proxy logs now arrive over the child process pipe (relayed + rate-bounded).
  proxyProcess.onLog((entry) => logBatcher.push(entry));

  // Proxy request usage is recorded in the child process and forwarded here.
  // THIS process stays the single disk writer of usage-stats.json, so the
  // external-usage records and the proxy records never clobber each other.
  let usageInitPromise = null;
  proxyProcess.onUsageRecord((entry) => {
    try {
      usageInitPromise = usageInitPromise || usageStats.init(ud()).catch(() => {});
      usageInitPromise.then(() => {
        try {
          usageStats.record(entry);
        } catch {
          /* */
        }
      });
    } catch {
      /* */
    }
  });

  // Aggregate token/request usage from all providers (persisted separately from account quotas)
  ipcMain.handle("proxy:getUsageStats", async () => {
    try {
      await usageStats.init(ud());
      return { ok: true, usage: usageStats.publicView(80) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  ipcMain.handle("proxy:resetUsageStats", async () => {
    try {
      await usageStats.init(ud());
      const usage = await usageStats.reset();
      return { ok: true, usage: usageStats.publicView(80) };
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  usageStats.onUpdate((snap) => {
    try {
      broadcast("proxy:usage", usageStats.publicView(80));
    } catch {
      /* */
    }
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  registerProxyHandlers,
  store: storeApi,
  process: proxyProcess,
};
