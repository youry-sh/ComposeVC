import React, { useEffect, useRef, useState } from "react";
import { FileSearch, Search, X } from "lucide-react";
import { ProjectSearchResult } from "../types";

interface SearchOverlayProps {
  open: boolean;
  rootPath: string | null;
  projectName: string;
  labels: {
    searchPlaceholder: string;
    noFolderOpened: string;
    searching: string;
    results: string;
    openFolderFirst: string;
    startTypingSearch: string;
  };
  onClose: () => void;
  onOpenResult: (result: ProjectSearchResult) => void;
}

const SearchOverlay: React.FC<SearchOverlayProps> = ({
  open,
  rootPath,
  projectName,
  labels,
  onClose,
  onOpenResult,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ProjectSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setResults([]);
    setSelectedIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 30);
  }, [open]);

  useEffect(() => {
    if (!open || !rootPath) return;

    const handle = window.setTimeout(async () => {
      setLoading(true);
      const nextResults = await window.lopster?.searchProject(rootPath, query);
      setResults(nextResults || []);
      setSelectedIndex(0);
      setLoading(false);
    }, 140);

    return () => window.clearTimeout(handle);
  }, [open, rootPath, query]);

  if (!open) return null;

  const selectedResult = results[selectedIndex];

  const openResult = (result?: ProjectSearchResult) => {
    if (!result) return;
    onOpenResult(result);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center theme-scrim pt-24 animate-fade-in">
      <div className="w-[720px] overflow-hidden rounded-xl border border-ink-200 bg-ink-0 shadow-modal">
        <div className="theme-strip h-12 flex items-center gap-3 px-4">
          <Search className="w-4 h-4 text-ink-600" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelectedIndex((index) => Math.min(index + 1, results.length - 1));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelectedIndex((index) => Math.max(index - 1, 0));
              }
              if (event.key === "Enter") {
                event.preventDefault();
                openResult(selectedResult);
              }
            }}
            placeholder={labels.searchPlaceholder}
            className="flex-1 bg-transparent text-[14px] text-ink-950 placeholder-ink-600 outline-none"
          />
          <button
            onClick={onClose}
            className="p-1.5 rounded-md text-ink-600 outline-none hover:bg-ink-100 hover:text-ink-950 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="theme-strip h-8 flex items-center justify-between px-4 text-[11px] text-ink-600">
          <span>{rootPath ? projectName : labels.noFolderOpened}</span>
          <span>{loading ? labels.searching : `${results.length} ${labels.results}`}</span>
        </div>

        <div className="max-h-[460px] overflow-y-auto scrollbar-thin p-2">
          {!rootPath && (
            <div className="px-3 py-10 text-center text-[13px] text-ink-600">
              {labels.openFolderFirst}
            </div>
          )}

          {rootPath && results.length === 0 && !loading && (
            <div className="px-3 py-10 text-center text-[13px] text-ink-600">
              {labels.startTypingSearch}
            </div>
          )}

          {results.map((result, index) => (
            <button
              key={result.id}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => openResult(result)}
              className={`w-full rounded-xl px-3 py-2.5 text-left outline-none transition-colors ${
                index === selectedIndex
                  ? "bg-ink-100 text-ink-950"
                  : "text-ink-800 hover:bg-ink-50 hover:text-ink-950"
              }`}
            >
              <div className="flex items-center gap-2">
                <FileSearch className="w-3.5 h-3.5 text-ink-600" />
                <span className="truncate text-[13px] font-medium">{result.name}</span>
                {result.line > 0 && (
                  <span className="text-[11px] text-ink-600">:{result.line}</span>
                )}
                <span className="ml-auto rounded-md theme-panel px-1.5 py-0.5 text-[10px] text-ink-600">
                  {result.type}
                </span>
              </div>
              <div className="mt-1 truncate font-mono text-[11px] text-ink-600">
                {result.relativePath}
              </div>
              {result.type === "content" && (
                <div className="mt-1 truncate text-[12px] text-ink-700">
                  {result.preview}
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

export default SearchOverlay;
