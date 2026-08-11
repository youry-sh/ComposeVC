const { EventEmitter } = require("events");

const MAX_EVENTS = 200;
const MAX_WORKSPACES = 32;

function now() {
  return Date.now();
}

function createWorkspace(id, name) {
  return {
    id,
    name: String(name || id),
    status: "idle",
    progress: 0,
    activeTask: null,
    updatedAt: now(),
    events: [],
  };
}

function cloneWorkspace(workspace) {
  return {
    ...workspace,
    events: workspace.events.map((event) => ({ ...event })),
  };
}

class SizeworkoutRuntime extends EventEmitter {
  constructor() {
    super();
    this.workspaces = new Map();
    this.sequence = 0;
    this.disposed = false;
  }

  ensureWorkspace(id, name) {
    const key = String(id || "default");
    let workspace = this.workspaces.get(key);
    if (!workspace) {
      if (this.workspaces.size >= MAX_WORKSPACES) {
        throw new Error("Sizeworkout workspace limit reached");
      }
      workspace = createWorkspace(key, name);
      this.workspaces.set(key, workspace);
    } else if (name) {
      workspace.name = String(name);
    }
    return workspace;
  }

  publish(workspace, type, payload) {
    const event = {
      id: ++this.sequence,
      type: String(type || "update"),
      payload: payload && typeof payload === "object" ? { ...payload } : payload ?? null,
      createdAt: now(),
    };
    workspace.events = [...workspace.events, event].slice(-MAX_EVENTS);
    workspace.updatedAt = event.createdAt;
    this.emit("changed", this.snapshot(workspace.id));
    return event;
  }

  update(input = {}) {
    if (this.disposed) throw new Error("Sizeworkout runtime is disposed");
    const workspace = this.ensureWorkspace(input.workspaceId, input.workspaceName);
    if (input.status !== undefined) workspace.status = String(input.status);
    if (input.progress !== undefined) {
      const value = Number(input.progress);
      workspace.progress = Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : workspace.progress;
    }
    if (input.activeTask !== undefined) workspace.activeTask = input.activeTask == null ? null : String(input.activeTask);
    this.publish(workspace, input.type, input.payload);
    return this.snapshot(workspace.id);
  }

  snapshot(id) {
    if (id) {
      const workspace = this.workspaces.get(String(id));
      return workspace ? cloneWorkspace(workspace) : null;
    }
    return Array.from(this.workspaces.values(), cloneWorkspace);
  }

  reset(id) {
    const key = String(id || "default");
    const workspace = this.ensureWorkspace(key);
    workspace.status = "idle";
    workspace.progress = 0;
    workspace.activeTask = null;
    workspace.events = [];
    workspace.updatedAt = now();
    this.emit("changed", this.snapshot(key));
    return this.snapshot(key);
  }

  dispose() {
    this.disposed = true;
    this.removeAllListeners();
    this.workspaces.clear();
  }
}

const runtime = new SizeworkoutRuntime();

module.exports = {
  runtime,
  SizeworkoutRuntime,
};
