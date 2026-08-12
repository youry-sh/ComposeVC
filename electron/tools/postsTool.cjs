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
    "Manage the user's markdown posts (the POST tab). Actions: list, read, create, update, delete. " +
    "Bodies are full markdown — headings, bold/italic, lists, tables, code blocks, links, images. " +
    "Use create for a new post, update to rewrite title and/or content, delete to remove one.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["list", "read", "create", "update", "delete"],
        description: "Which operation to run",
      },
      id: { type: "string", description: "Post id (read, update, delete)" },
      title: { type: "string", description: "Post title (create, update)" },
      content: { type: "string", description: "Markdown body (create, update)" },
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
          return {
            ok: true,
            count: posts.length,
            posts: posts.map((p) => ({ id: p.id, title: p.title, updatedAt: p.updatedAt })),
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
          });
          notify({ type: "created", id: post.id });
          return { ok: true, id: post.id, title: post.title };
        }
        case "update": {
          const id = String(input.id || "").trim();
          if (!id) return { ok: false, error: "id is required for update" };
          if (typeof input.title !== "string" && typeof input.content !== "string") {
            return { ok: false, error: "provide title and/or content to update" };
          }
          const post = await postsStore.updatePost(userDataPath, id, {
            title: input.title,
            content: input.content,
          });
          notify({ type: "updated", id: post.id });
          return { ok: true, id: post.id, title: post.title };
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
