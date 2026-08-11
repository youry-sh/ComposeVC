# NOTE tab — personal Markdown knowledge base

The **NOTE** top-bar tab is a full Obsidian-style notes workspace inside ComposeVC.

## Storage (all JSON, pretty-printed)

Everything lives in `userData/notes/` (global — not per-project):

- `notes-index.json` — folders, note summaries (id/title/folderId/tags/pinned/links/unresolvedLinks/linkCount/wordCount/preview/graph pos/createdAt/updatedAt) and the graph `viewport`.
- `<noteId>.json` — one file per note: full markdown `content`, `links` (resolved note ids), `unresolvedLinks` ([[titles]] with no match), `graph: {x,y}`.
- `corrupt/` — quarantine for unreadable JSON (never crashes the app).
- Atomic writes: temp file + rename, serialized per file (`writeJson` in `electron/notesStore.cjs`).
- Limits are intentionally generous: titles and folder names up to **10 000 chars** (`MAX_TITLE` / `MAX_FOLDER_NAME`); note content, tags, links and unresolved links are **unlimited** — the vault is expected to grow very large. Only the exported `.md` filename is capped at 200 chars (filesystem name limit ~255 bytes).

## Graph & wikilinks

- Writing `[[Note Title]]` in a note body creates a link; on every save the store re-scans content and resolves titles → note ids (exact match, then case-insensitive; unresolved titles stay as ghost links).
- `getGraph` returns `{ nodes, edges, viewport }` — nodes carry persisted `x/y`; positions are draggable in the UI and saved via `notes:saveGraphPositions`.
- Deleting a note prunes all incoming/outgoing links (no dangling edges).

## IPC surface (main.cjs)

`notes:list` · `notes:get` · `notes:save` · `notes:delete` · `notes:folders` · `notes:createFolder` · `notes:renameFolder` · `notes:deleteFolder` · `notes:move` · `notes:search` · `notes:graph` · `notes:saveGraphViewport` · `notes:saveGraphPositions` · `notes:export` (dialog: single `.md` or whole vault `.json`) · `notes:import` (dialog: `.md`/`.txt`/`.json`, multi-select) · `notes:changed` broadcast for multi-window sync.

Preload bridge: `window.lopster.listNotes/getNote/saveNote/deleteNote/listNoteFolders/createNoteFolder/renameNoteFolder/deleteNoteFolder/moveNote/searchNotes/getNotesGraph/saveNotesGraphViewport/saveNotesGraphPositions/exportNote/importNotes/onNotesChanged`.

## AI tool: `notes`

Registered in `electron/tools/registry.cjs` (aliases: `note`, `notebook`, `notes_manager`, `md_notes`, `documents`, `notes_search`, `create_note`, …). Actions:

`list_notes` · `search_notes` (title/tag/content) · `get_note` · `create_note` · `update_note` · `rename_note` · `move_note` · `delete_note` · `add_link` · `remove_link` · `list_folders` · `create_folder` · `rename_folder` · `delete_folder` · `get_graph` · `explain`

The system prompt (`electron/context.cjs`, NOTE TOOLS section) teaches the model when/how to use it. The user speaks Russian/Ukrainian/English — answer in their language.

## UI (src/components/NotesWorkspace.tsx + NotesGraph.tsx)

- Left sidebar: search by file name (top), folder tree with expand/collapse, per-row hover actions (pin, rename, move-to-folder, delete), inline creation/rename (no `window.prompt`).
- Center: title + toolbar (Edit/Preview/Split, formatting buttons, `[[wikilink]]` autocomplete picker), textarea or `MarkdownContent` preview (wikilinks are clickable and open the target note), autosave ~600 ms with Saved/Saving…/Save failed, backlinks row, delete confirm modal.
- Graph sub-tab (Ctrl+G): SVG force-ish layout, wheel zoom, drag pan, draggable nodes (positions persist), click node → open note, hover → highlight neighbors, reset/zoom HUD.
- Shortcuts: Ctrl+N new note, Ctrl+S save now, Ctrl+F search, Ctrl+E toggle mode, Ctrl+G graph, Esc close.
- i18n: full en/ru/uk labels (`src/i18n.ts` — `notes*` keys).

## Tests

`npm run test:notes` → `tests/notes/notesStore.test.cjs` (folders, wikilinks, search, delete-cascade + link pruning, sanitization, atomic writes, corrupt quarantine, md/json round-trip).
