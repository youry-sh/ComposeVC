import React from "react";
import { BookOpen, FileText } from "lucide-react";

/**
 * IDE documentation workspace.
 * Intentionally empty for now — the manual will be written incrementally.
 * Keeps a native ComposeVC shell (toolbar + empty state) so the tab is wired
 * end-to-end and ready to receive content.
 */
const DocsWorkspace: React.FC = () => {
  return (
    <section className="docs-workspace">
      <header className="docs-toolbar">
        <div className="docs-toolbar-copy">
          <span className="docs-kicker">DOCS / IDE MANUAL</span>
          <div className="docs-document-id">
            <FileText className="h-3.5 w-3.5" />
            <span>no content yet</span>
          </div>
        </div>
      </header>

      <main className="docs-empty">
        <BookOpen className="h-10 w-10" aria-hidden />
        <h2>Documentation</h2>
        <p>
          The full ComposeVC manual will live here and be written a piece at a
          time. Nothing has been added yet.
        </p>
      </main>
    </section>
  );
};

export default DocsWorkspace;
