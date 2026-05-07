import { useEffect, useRef, useState, useCallback } from "react";
import { Search, Loader2 } from "lucide-react";
import { useAppStore } from "../store/app";
import {
  listPods,
  listDeployments,
  listStatefulsets,
  listDaemonsets,
  listServices,
  listConfigmaps,
  listSecrets,
  listNodes,
  listIngresses,
} from "../lib/tauri";

interface SearchResult {
  kind: string;
  name: string;
  namespace: string;
  page: string;
}

interface GlobalSearchProps {
  onClose: () => void;
  onNavigate: (page: string) => void;
}

const KIND_PAGE_MAP: Record<string, string> = {
  Pod: "pods",
  Deployment: "deployments",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Service: "services",
  ConfigMap: "configmaps",
  Secret: "secrets",
  Node: "nodes",
  Ingress: "ingresses",
};

const KIND_BADGE_COLORS: Record<string, string> = {
  Pod: "bg-blue-500/20 text-blue-300",
  Deployment: "bg-green-500/20 text-green-300",
  Service: "bg-purple-500/20 text-purple-300",
  ConfigMap: "bg-amber-500/20 text-amber-300",
  Secret: "bg-amber-500/20 text-amber-300",
  Node: "bg-slate-500/20 text-slate-300",
};

function kindBadgeColor(kind: string): string {
  return KIND_BADGE_COLORS[kind] ?? "bg-slate-500/20 text-slate-300";
}

const QUICK_SHORTCUTS: { kind: string; page: string; label: string }[] = [
  { kind: "Pod", page: "pods", label: "Pods" },
  { kind: "Deployment", page: "deployments", label: "Deployments" },
  { kind: "Service", page: "services", label: "Services" },
  { kind: "Node", page: "nodes", label: "Nodes" },
  { kind: "ConfigMap", page: "configmaps", label: "ConfigMaps" },
  { kind: "Secret", page: "secrets", label: "Secrets" },
  { kind: "Ingress", page: "ingresses", label: "Ingresses" },
  { kind: "StatefulSet", page: "statefulsets", label: "StatefulSets" },
  { kind: "DaemonSet", page: "daemonsets", label: "DaemonSets" },
];

export function GlobalSearch({ onClose, onNavigate }: GlobalSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [allResources, setAllResources] = useState<SearchResult[]>([]);
  const [fetched, setFetched] = useState(false);

  const activeContext = useAppStore((s) => s.activeContext);
  const activeNamespace = useAppStore((s) => s.activeNamespace);

  // Fetch all resources on open
  useEffect(() => {
    if (fetched) return;

    const args = { context: activeContext, namespace: activeNamespace };
    const clusterArgs = { context: activeContext };

    setLoading(true);

    const toResults = (kind: string, items: unknown[]): SearchResult[] =>
      items.map((item: any) => ({
        kind,
        name: item?.metadata?.name ?? "",
        namespace: item?.metadata?.namespace ?? "",
        page: KIND_PAGE_MAP[kind] ?? kind.toLowerCase() + "s",
      })).filter((r) => r.name !== "");

    Promise.allSettled([
      listPods(args).then((r) => toResults("Pod", r)),
      listDeployments(args).then((r) => toResults("Deployment", r)),
      listStatefulsets(args).then((r) => toResults("StatefulSet", r)),
      listDaemonsets(args).then((r) => toResults("DaemonSet", r)),
      listServices(args).then((r) => toResults("Service", r)),
      listConfigmaps(args).then((r) => toResults("ConfigMap", r)),
      listSecrets(args).then((r) => toResults("Secret", r)),
      listNodes(clusterArgs).then((r) => toResults("Node", r)),
      listIngresses(args).then((r) => toResults("Ingress", r)),
    ]).then((settled) => {
      const combined: SearchResult[] = [];
      for (const result of settled) {
        if (result.status === "fulfilled") {
          combined.push(...result.value);
        }
      }
      setAllResources(combined);
      setFetched(true);
      setLoading(false);
    });
  }, [activeContext, activeNamespace, fetched]);

  // Filter on query change
  useEffect(() => {
    if (!query.trim()) {
      setResults([]);
      setSelectedIndex(0);
      return;
    }

    const q = query.toLowerCase();
    const exact: SearchResult[] = [];
    const partial: SearchResult[] = [];

    for (const r of allResources) {
      const name = r.name.toLowerCase();
      if (name === q) {
        exact.push(r);
      } else if (name.includes(q)) {
        partial.push(r);
      }
    }

    setResults([...exact, ...partial].slice(0, 50));
    setSelectedIndex(0);
  }, [query, allResources]);

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector(`[data-idx="${selectedIndex}"]`);
    if (el) {
      (el as HTMLElement).scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const itemCount = query.trim() ? results.length : QUICK_SHORTCUTS.length;

      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (i + 1) % Math.max(itemCount, 1));
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) => (i - 1 + Math.max(itemCount, 1)) % Math.max(itemCount, 1));
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        if (query.trim() && results.length > 0) {
          onNavigate(results[selectedIndex]?.page ?? "");
        } else if (!query.trim()) {
          onNavigate(QUICK_SHORTCUTS[selectedIndex]?.page ?? "");
        }
        return;
      }
    },
    [query, results, selectedIndex, onClose, onNavigate]
  );

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      onClose();
    }
  };

  const showResults = query.trim().length > 0;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center pt-[15vh]"
      onMouseDown={handleOverlayClick}
    >
      <div
        className="w-full max-w-xl bg-slate-900 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Search input */}
        <div className="flex items-center gap-2 px-3 border-b border-slate-800">
          {loading ? (
            <Loader2 size={15} className="shrink-0 text-slate-500 animate-spin" />
          ) : (
            <Search size={15} className="shrink-0 text-slate-500" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search pods, deployments, services..."
            className="w-full bg-transparent px-1 py-3 text-sm text-slate-100 placeholder-slate-500 outline-none"
          />
        </div>

        {/* Results area */}
        <div ref={listRef} className="max-h-80 overflow-y-auto">
          {showResults ? (
            loading ? (
              <div className="px-4 py-6 text-sm text-slate-500 text-center">
                Searching...
              </div>
            ) : results.length === 0 ? (
              <div className="px-4 py-6 text-sm text-slate-500 text-center">
                No results for &ldquo;{query}&rdquo;
              </div>
            ) : (
              results.map((r, i) => (
                <button
                  key={`${r.kind}-${r.namespace}-${r.name}-${i}`}
                  data-idx={i}
                  onClick={() => onNavigate(r.page)}
                  className={`flex items-center gap-3 w-full px-4 py-2.5 text-left transition-colors ${
                    i === selectedIndex
                      ? "bg-blue-600/20 text-blue-100"
                      : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${kindBadgeColor(r.kind)}`}
                  >
                    {r.kind}
                  </span>
                  <span className="flex-1 text-sm font-mono truncate">{r.name}</span>
                  {r.namespace && (
                    <span className="text-xs text-slate-500 shrink-0">{r.namespace}</span>
                  )}
                </button>
              ))
            )
          ) : (
            /* Pre-search: quick shortcuts */
            <div className="py-2">
              <div className="px-4 py-1.5 text-[10px] font-semibold text-slate-600 uppercase tracking-wider">
                Quick Navigate
              </div>
              {QUICK_SHORTCUTS.map((s, i) => (
                <button
                  key={s.page}
                  data-idx={i}
                  onClick={() => onNavigate(s.page)}
                  className={`flex items-center gap-3 w-full px-4 py-2 text-left transition-colors ${
                    i === selectedIndex
                      ? "bg-blue-600/20 text-blue-100"
                      : "text-slate-300 hover:bg-white/5"
                  }`}
                >
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${kindBadgeColor(s.kind)}`}
                  >
                    {s.kind}
                  </span>
                  <span className="text-sm">{s.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-slate-800 text-[11px] text-slate-600 flex gap-4">
          <span>↑↓ navigate</span>
          <span>Enter select</span>
          <span>Esc close</span>
        </div>
      </div>
    </div>
  );
}
