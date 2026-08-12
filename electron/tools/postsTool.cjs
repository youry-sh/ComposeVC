const postsStore = require("../postsStore.cjs");

/**
 * Markdown posts for the agent: list, read, create, update, delete.
 * Bodies are full markdown (headings, tables, lists, code — anything the
 * post renderer supports). Changes broadcast to the POST tab via
 * context.onPostsChanged so the UI refreshes live.
 */
module.exports = {
  name: "posts",
  description:
    "Manage the user's markdown posts and folders (the POST tab). " +
    "Post actions: list, read, create, update, delete, move (into a folder). " +
    "Folder actions: create_folder, rename_folder, delete_folder. " +
    "Bodies are full markdown — headings, bold/italic, lists, tables, code blocks, links, images. " +
    "Pass folderId on create/update/move to file a post into a folder (null/omit = root). " +
    "Use list to discover folder ids alongside posts.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "list",
          "read",
          "create",
          "update",
          "delete",
          "move",
          "create_folder",
          "rename_folder",
          "delete_folder",
        ],
        description: "Which operation to run",
      },
      id: { type: "string", description: "Post id (read, update, delete, move)" },
      title: { type: "string", description: "Post title (create, update)" },
      content: { type: "string", description: "Markdown body (create, update)" },
      folderId: { type: "string", description: "Target folder id (create, update, move); omit or null = root" },
      folderName: { type: "string", description: "Folder name (create_folder, rename_folder)" },
    },
    required: ["action"],
  },

  async execute(input = {}, context = {}) {
    const userDataPath = context.userDataPath;
    if (!userDataPath) return { ok: false, error: "No userData path in context" };
    const action = String(input.action || "").trim();
    const notify = (payload) => {
      try {
        context.onPostsChanged?.(payload);
      } catch {
        /* non-fatal */
      }
    };

    try {
      switch (action) {
        case "list": {
          const posts = postsStore.listPosts(userDataPath);
          const folders = postsStore.listFolders(userDataPath);
          return {
            ok: true,
            count: posts.length,
            folders: folders.map((f) => ({ id: f.id, name: f.name })),
            posts: posts.map((p) => ({ id: p.id, title: p.title, folderId: p.folderId, updatedAt: p.updatedAt })),
          };
        }
        case "read": {
          const id = String(input.id || "").trim();
          if (!id) return { ok: false, error: "id is required for read" };
          const post = await postsStore.getPost(userDataPath, id);
          if (!post) return { ok: false, error: `post not found: ${id}` };
          return { ok: true, id: post.id, title: post.title, content: post.content };
        }
        case "create": {
          const post = await postsStore.createPost(userDataPath, {
            title: input.title,
            content: input.content,
            folderId: input.folderId,
          });
          notify({ type: "created", id: post.id });
          return { ok: true, id: post.id, title: post.title, folderId: post.folderId };
        }
        case "update": {
          const id = String(input.id || "").trim();
          if (!id) return { ok: false, error: "id is required for update" };
          const patch = {};
          if (typeof input.title === "string") patch.title = input.title;
          if (typeof input.content === "string") patch.content = input.content;
          if ("folderId" in input) patch.folderId = input.folderId;
          if (Object.keys(patch).length === 0) {
            return { ok: false, error: "provide title, content and/or folderId to update" };
          }
          const post = await postsStore.updatePost(userDataPath, id, patch);
          notify({ type: "updated", id: post.id });
          return { ok: true, id: post.id, title: post.title, folderId: post.folderId };
        }
        case "move": {
          const id = String(input.id || "").trim();
          if (!id) return { ok: false, error: "id is required for move" };
          const meta = await postsStore.movePost(userDataPath, id, input.folderId ?? null);
          notify({ type: "moved", id });
          return { ok: true, id, folderId: meta.folderId };
        }
        case "create_folder": {
          const folder = await postsStore.createFolder(userDataPath, { name: input.folderName });
          notify({ type: "folder", id: folder.id });
          return { ok: true, folderId: folder.id, name: folder.name };
        }
        case "rename_folder": {
          const id = String(input.folderId || input.id || "").trim();
          if (!id) return { ok: false, error: "folderId is required for rename_folder" };
          const folder = await postsStore.renameFolder(userDataPath, id, input.folderName);
          notify({ type: "folder", id });
          return { ok: true, folderId: folder.id, name: folder.name };
        }
        case "delete_folder": {
          const id = String(input.folderId || input.id || "").trim();
          if (!id) return { ok: false, error: "folderId is required for delete_folder" };
          const res = await postsStore.removeFolder(userDataPath, id);
          if (!res.ok) return { ok: false, error: `folder not found: ${id}` };
          notify({ type: "folder", id });
          return { ok: true, folderId: id };
        }
        case "delete": {
          const id = String(input.id || "").trim();
          if (!id) return { ok: false, error: "id is required for delete" };
          const res = await postsStore.removePost(userDataPath, id);
          if (!res.ok) return { ok: false, error: `post not found: ${id}` };
          notify({ type: "deleted", id });
          return { ok: true, id };
        }
        default:
          return { ok: false, error: `Unknown action "${action}". Use list, read, create, update, delete.` };
      }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) };
    }
  },
};
