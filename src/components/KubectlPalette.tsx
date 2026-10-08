import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, X, Trash2, Loader2 } from "lucide-react";
import { useAppStore } from "../store/app";

const HISTORY_KEY = "kubectl-palette-history";
const MAX_HISTORY = 50;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(history: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {
    // ignore
  }
}

function addToHistory(input: string, current: string[]): string[] {
  const deduped = current.filter((h) => h !== input);
  return [input, ...deduped].slice(0, MAX_HISTORY);
}

export interface KubectlPaletteProps {
  open: boolean;
  onClose: () => void;
}

export function KubectlPalette({ open, onClose }: KubectlPaletteProps) {
  const activeContext = useAppStore((s) => s.activeContext);
  const activeNamespace = useAppStore((s) => s.activeNamespace);

  const inputRef = useRef<HTMLInputElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  const [input, setInput] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [isError, setIsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [showSuggestions, setShowSuggestions] = useState(false);

  // Load history when opened
  useEffect(() => {
    if (open) {
      setHistory(loadHistory());
      setInput("");
      setOutput(null);
      setIsError(false);
      setHistoryIndex(-1);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Cmd+Shift+P global shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
        e.preventDefault();
        if (open) onClose();
        // If closed, parent controls open — this handles close-on-re-trigger
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const filteredHistory = useCallback(() => {
    if (!input.trim()) return history;
    return history.filter((h) =>
      h.toLowerCase().includes(input.toLowerCase())
    );
  }, [input, history]);

  const runCommand = useCallback(async (rawInput: string) => {
    const trimmed = rawInput.trim();
    if (!trimmed) return;

    const args = trimmed.split(/\s+/).filter(Boolean);

    // Record history
    const updated = addToHistory(trimmed, history);
    setHistory(updated);
    saveHistory(updated);
    setHistoryIndex(-1);
    setShowSuggestions(false);
    setLoading(true);
    setOutput(null);
    setIsError(false);

    try {
      const result = await invoke<string>("run_kubectl_command", {
        context: activeContext,
        namespace: activeNamespace,
        args,
      });
      setOutput(result || "(no output)");
      setIsError(false);
    } catch (err) {
      setOutput(String(err));
      setIsError(true);
    } finally {
      setLoading(false);
      setTimeout(() => {
        outputRef.current?.scrollTo({ top: 0 });
      }, 0);
    }
  }, [activeContext, activeNamespace, history]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      const suggestions = filteredHistory();

      if (e.key === "Enter") {
        e.preventDefault();
        runCommand(input);
      } else if (e.key === "Escape") {
        e.preventDefault();
        if (showSuggestions) {
          setShowSuggestions(false);
        } else {
          onClose();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        if (suggestions.length === 0) return;
        const next = Math.min(historyIndex + 1, suggestions.length - 1);
        setHistoryIndex(next);
        setInput(suggestions[next]);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        if (historyIndex <= 0) {
          setHistoryIndex(-1);
          setInput("");
        } else {
          const next = historyIndex - 1;
          setHistoryIndex(next);
          setInput(suggestions[next]);
        }
      }
    },
    [input, historyIndex, filteredHistory, runCommand, showSuggestions, onClose]
  );

  if (!open) return null;

  const preview = `kubectl --context ${activeContext || "<context>"} -n ${activeNamespace || "<namespace>"} ${input}`;
  const suggestions = filteredHistory();

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24 px-4"
      style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-2xl rounded-xl border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-300 dark:border-slate-700">
          <Terminal size={16} className="text-slate-500 dark:text-slate-400 shrink-0" />
          <span className="text-sm font-medium text-slate-700 dark:text-slate-300">kubectl</span>
          <span className="ml-auto text-xs text-slate-500 dark:text-slate-500">
            ↑↓ history · Enter to run · Esc close
          </span>
          <button
            onClick={onClose}
            className="ml-2 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
          >
            <X size={14} />
          </button>
        </div>

        {/* Preview */}
        <div className="px-4 py-2 bg-slate-100 dark:bg-slate-950 border-b border-slate-200 dark:border-slate-800">
          <p className="font-mono text-xs text-slate-500 dark:text-slate-500 truncate">{preview}</p>
        </div>

        {/* Input */}
        <div className="flex items-center px-4 py-3 gap-2">
          <span className="font-mono text-xs text-slate-500 dark:text-slate-500 shrink-0">$</span>
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setShowSuggestions(true);
              setHistoryIndex(-1);
            }}
            onFocus={() => setShowSuggestions(true)}
            onKeyDown={handleKeyDown}
            placeholder="get pods -l app=nginx"
            className="flex-1 bg-transparent font-mono text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-500 dark:placeholder:text-slate-600 outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {loading && (
            <Loader2 size={14} className="text-slate-400 animate-spin shrink-0" />
          )}
        </div>

        {/* History suggestions */}
        {showSuggestions && suggestions.length > 0 && !loading && (
          <div className="border-t border-slate-200 dark:border-slate-800 max-h-40 overflow-y-auto">
            {suggestions.slice(0, 10).map((item, idx) => (
              <button
                key={idx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setInput(item);
                  setShowSuggestions(false);
                  inputRef.current?.focus();
                }}
                className={`w-full text-left px-4 py-1.5 font-mono text-xs truncate transition-colors ${
                  idx === historyIndex
                    ? "bg-slate-200 dark:bg-slate-700 text-slate-900 dark:text-slate-100"
                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200"
                }`}
              >
                {item}
              </button>
            ))}
          </div>
        )}

        {/* Output */}
        {(output !== null || loading) && (
          <div className="border-t border-slate-200 dark:border-slate-800">
            <div className="flex items-center justify-between px-4 py-1.5">
              <span className="text-xs text-slate-500 dark:text-slate-500">Output</span>
              <button
                onClick={() => { setOutput(null); setIsError(false); }}
                className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 transition-colors"
              >
                <Trash2 size={11} />
                Clear
              </button>
            </div>
            <div
              ref={outputRef}
              className="px-4 pb-4 max-h-64 overflow-y-auto"
            >
              {loading ? (
                <div className="flex items-center gap-2 text-slate-500 dark:text-slate-400 text-xs font-mono py-2">
                  <Loader2 size={12} className="animate-spin" />
                  Running…
                </div>
              ) : (
                <pre
                  className={`font-mono text-xs whitespace-pre-wrap break-all leading-relaxed ${
                    isError ? "text-red-400" : "text-green-400"
                  }`}
                >
                  {output}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
