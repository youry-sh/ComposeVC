const booksStore = require("../booksStore.cjs");

module.exports = {
  name: "books",
  description: "Manage the user's Books library. List/read/create/update/delete books. Create converts text once into cached reader pages. Use create when the user asks to add a book; provide title, author, description, cover (URL/data URL), and full text content.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["list", "read", "create", "update", "delete"] },
      id: { type: "string" }, title: { type: "string" }, author: { type: "string" },
      description: { type: "string" }, cover: { type: "string" }, content: { type: "string" },
      read: { type: "boolean" },
    },
    required: ["action"],
  },
  async execute(input = {}, context = {}) {
    const ud = context.userDataPath; if (!ud) return { ok: false, error: "No userData path" };
    const notify = (payload) => { try { context.onBooksChanged?.(payload); } catch {} };
    try {
      if (input.action === "list") return { ok: true, books: booksStore.listBooks(ud).map(({ id, title, author, description, read, progress }) => ({ id, title, author, description, read, progress })) };
      if (input.action === "read") { const book = await booksStore.getBook(ud, input.id); return book ? { ok: true, book } : { ok: false, error: "not found" }; }
      if (input.action === "create") { const book = await booksStore.createBook(ud, input); notify({ type: "created", id: book.id }); return { ok: true, book }; }
      if (input.action === "update") { const book = await booksStore.updateBook(ud, input.id, input); notify({ type: "updated", id: book.id }); return { ok: true, book }; }
      if (input.action === "delete") { const ok = await booksStore.removeBook(ud, input.id); if (ok) notify({ type: "deleted", id: input.id }); return { ok }; }
      return { ok: false, error: "unknown action" };
    } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  },
};
