import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listCrds, listCustomResources, type CrdInfo } from "../lib/tauri";
import {
  Boxes,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Search,
  X,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return days < 30 ? `${days}d ago` : date.toLocaleDateString();
}

// ── Scope Badge ────────────────────────────────────────────────────────────────

function ScopeBadge({ scope }: { scope: string }) {
  if (scope === "Namespaced") {
    return (
      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-300 border border-blue-300 dark:border-blue-700/30">
        Namespaced
      </span>
    );
  }
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 border border-slate-600/30">
      Cluster
    </span>
  );
}

// ── Established Dot ────────────────────────────────────────────────────────────

function EstablishedDot({ established }: { established: boolean }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${
        established ? "bg-emerald-400" : "bg-amber-400"
      }`}
      title={established ? "Established" : "Not established"}
    />
  );
}

// ── Resource Detail Panel ──────────────────────────────────────────────────────

function ResourceDetailPanel({
  item,
  onClose,
}: {
  item: Record<string, unknown>;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-y-0 right-0 w-[480px] bg-slate-50 dark:bg-slate-900 border-l border-slate-300 dark:border-slate-700 flex flex-col z-50 shadow-xl">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-300 dark:border-slate-700 shrink-0">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-200">
          {(item as { metadata?: { name?: string } }).metadata?.name ?? "Resource"}
        </span>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-white dark:hover:bg-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>
      <div className="flex-1 overflow-auto p-4">
        <pre className="text-[11px] text-slate-700 dark:text-slate-300 font-mono whitespace-pre-wrap break-words leading-relaxed">
          {JSON.stringify(item, null, 2)}
        </pre>
      </div>
    </div>
  );
}

// ── CRD List ───────────────────────────────────────────────────────────────────

function CrdList({
  crds,
  selectedCrd,
  onSelect,
}: {
  crds: CrdInfo[];
  selectedCrd: CrdInfo | null;
  onSelect: (crd: CrdInfo) => void;
}) {
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const filtered = useMemo(() => {
    if (!search.trim()) return crds;
    const q = search.toLowerCase();
    return crds.filter(
      (c) =>
        c.kind.toLowerCase().includes(q) ||
        c.group.toLowerCase().includes(q) ||
        c.name.toLowerCase().includes(q)
    );
  }, [crds, search]);

  const grouped = useMemo(() => {
    const map = new Map<string, CrdInfo[]>();
    for (const crd of filtered) {
      const g = crd.group || "unknown";
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(crd);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  const toggleGroup = (group: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="p-2 border-b border-slate-200 dark:border-slate-800 shrink-0">
        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by kind or group…"
            className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded-md pl-7 pr-7 py-1.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 dark:text-slate-600 dark:hover:text-slate-400"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Groups */}
      <div className="flex-1 overflow-auto">
        {grouped.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-600 text-xs">
            No CRDs match
          </div>
        ) : (
          grouped.map(([group, items]) => {
            const collapsed = collapsedGroups.has(group);
            return (
              <div key={group}>
                {/* Group header */}
                <button
                  onClick={() => toggleGroup(group)}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 bg-slate-50 dark:bg-slate-900 hover:bg-slate-200/60 dark:hover:bg-slate-800/60 transition-colors border-b border-slate-200/60 dark:border-slate-800/60 text-left"
                >
                  {collapsed ? (
                    <ChevronRight size={11} className="text-slate-500 dark:text-slate-600 shrink-0" />
                  ) : (
                    <ChevronDown size={11} className="text-slate-500 dark:text-slate-600 shrink-0" />
                  )}
                  <span className="text-[11px] font-semibold text-slate-500 truncate flex-1">
                    {group}
                  </span>
                  <span className="text-[10px] text-slate-600 font-mono shrink-0">
                    {items.length}
                  </span>
                </button>

                {/* CRD items */}
                {!collapsed &&
                  items.map((crd) => {
                    const isSelected = selectedCrd?.name === crd.name;
                    return (
                      <button
                        key={crd.name}
                        onClick={() => onSelect(crd)}
                        className={`w-full flex items-start gap-2 px-3 py-2 text-left border-b border-slate-200/40 dark:border-slate-800/40 transition-colors ${
                          isSelected
                            ? "bg-blue-100 dark:bg-blue-600/20 border-l-2 border-l-blue-500"
                            : "hover:bg-slate-200/50 dark:hover:bg-slate-800/50 border-l-2 border-l-transparent"
                        }`}
                      >
                        <EstablishedDot established={crd.established} />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={`text-xs font-medium truncate ${
                                isSelected ? "text-blue-600 dark:text-blue-300" : "text-slate-700 dark:text-slate-300"
                              }`}
                            >
                              {crd.kind}
                            </span>
                            <ScopeBadge scope={crd.scope} />
                          </div>
                          <span className="text-[10px] text-slate-600 font-mono truncate block mt-0.5">
                            {crd.group}
                          </span>
                        </div>
                      </button>
                    );
                  })}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Resources Table ────────────────────────────────────────────────────────────

type ResourceItem = {
  metadata?: {
    name?: string;
    namespace?: string;
    creationTimestamp?: string;
    deletionTimestamp?: string;
  };
  [key: string]: unknown;
};

function ResourcesPanel({
  crd,
  context,
  namespace,
}: {
  crd: CrdInfo;
  context: string;
  namespace: string;
}) {
  const [selectedItem, setSelectedItem] = useState<ResourceItem | null>(null);

  const queryNamespace = namespace || undefined;

  const { data: rawJson, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ["custom-resources", context, crd.name, queryNamespace],
    queryFn: () =>
      listCustomResources({ context, crdName: crd.name, namespace: queryNamespace }),
    enabled: !!context && !!crd.name,
  });

  const items: ResourceItem[] = useMemo(() => {
    if (!rawJson) return [];
    try {
      const parsed = JSON.parse(rawJson);
      return (parsed.items ?? []) as ResourceItem[];
    } catch {
      return [];
    }
  }, [rawJson]);

  const showNamespace = crd.scope === "Namespaced";

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-900 dark:text-slate-200">{crd.kind}</span>
          <ScopeBadge scope={crd.scope} />
          <span className="text-[10px] text-slate-600 font-mono">{crd.group}</span>
          {crd.versions.length > 0 && (
            <span className="text-[10px] text-slate-700 font-mono">
              {crd.versions.join(", ")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {items.length > 0 && (
            <span className="text-[11px] text-slate-500 font-mono">{items.length} items</span>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-black/5 dark:hover:bg-white/5 disabled:opacity-40"
          >
            <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm gap-2">
          <RefreshCw size={14} className="animate-spin" />
          Loading…
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-1">
            <p className="text-sm text-red-400">Failed to fetch resources</p>
            <p className="text-xs text-slate-600 font-mono max-w-sm break-words">
              {String(error)}
            </p>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-600 gap-2">
          <Boxes size={24} className="opacity-30" />
          <span className="text-sm">No {crd.kind} instances found</span>
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-left">
            <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="px-3 py-2">Name</th>
                {showNamespace && <th className="px-3 py-2">Namespace</th>}
                <th className="px-3 py-2 w-28">Age</th>
                <th className="px-3 py-2 w-28">Status</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, idx) => {
                const name = item.metadata?.name ?? `item-${idx}`;
                const ns = item.metadata?.namespace;
                const createdAt = item.metadata?.creationTimestamp;
                const terminating = !!item.metadata?.deletionTimestamp;
                return (
                  <tr
                    key={`${ns ?? ""}-${name}`}
                    onClick={() => setSelectedItem(item)}
                    className="group cursor-pointer border-b border-slate-800/50 hover:bg-slate-800/40 transition-colors"
                  >
                    <td className="px-3 py-2">
                      <span className="text-xs text-slate-300 font-mono">{name}</span>
                    </td>
                    {showNamespace && (
                      <td className="px-3 py-2">
                        <span className="text-xs text-slate-500 font-mono">{ns ?? "-"}</span>
                      </td>
                    )}
                    <td className="px-3 py-2">
                      <span className="text-xs text-slate-500">{timeAgo(createdAt)}</span>
                    </td>
                    <td className="px-3 py-2">
                      {terminating ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                          Terminating
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                          Active
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Detail side panel */}
      {selectedItem && (
        <ResourceDetailPanel
          item={selectedItem}
          onClose={() => setSelectedItem(null)}
        />
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function CrdBrowserPage() {
  const { activeContext, activeNamespace } = useAppStore();
  const [selectedCrd, setSelectedCrd] = useState<CrdInfo | null>(null);

  const { data: crds = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ["crds", activeContext],
    queryFn: () => listCrds(activeContext),
    enabled: !!activeContext,
  });

  return (
    <div className="h-full flex flex-col overflow-hidden bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Boxes size={15} className="text-blue-400" />
            <h1 className="text-sm font-semibold text-slate-200">CRD Browser</h1>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
            {activeContext && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-400 font-mono border border-slate-700">
                {activeContext}
              </span>
            )}
            {crds.length > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded bg-slate-800 text-slate-500 font-mono border border-slate-700">
                {crds.length} CRDs
              </span>
            )}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-800 disabled:opacity-40"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Body: two-panel split ── */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-slate-500 text-sm gap-2">
          <RefreshCw size={14} className="animate-spin" />
          Loading CRDs…
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* Left: CRD list (1/3) */}
          <div className="w-1/3 border-r border-slate-800 overflow-hidden flex flex-col">
            <CrdList crds={crds} selectedCrd={selectedCrd} onSelect={setSelectedCrd} />
          </div>

          {/* Right: resources (2/3) */}
          <div className="flex-1 overflow-hidden">
            {selectedCrd ? (
              <ResourcesPanel
                crd={selectedCrd}
                context={activeContext}
                namespace={activeNamespace}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
                <Boxes size={32} className="opacity-20" />
                <span className="text-sm">Select a CRD from the left panel</span>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
