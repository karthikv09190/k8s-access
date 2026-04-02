import { useState, useMemo, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { compareClusters, listNamespaces } from "../lib/tauri";
import type { CompareResult, DiffStatus, ResourceDiff } from "../types/k8s";
import { cn } from "../lib/utils";
import {
  AlertCircle,
  ChevronDown,
  ChevronRight,
  GitCompare,
  Loader2,
  Search,
  X,
} from "lucide-react";

const RESOURCE_KINDS = [
  "Deployment",
  "StatefulSet",
  "Secret",
  "ConfigMap",
  "Service",
];

const STATUS_CONFIG: Record<
  DiffStatus,
  { label: string; color: string; bg: string; dot: string }
> = {
  identical: {
    label: "Identical",
    color: "text-green-400",
    bg: "bg-green-400/10 border-green-800",
    dot: "bg-green-400",
  },
  different: {
    label: "Different",
    color: "text-yellow-400",
    bg: "bg-yellow-400/10 border-yellow-800",
    dot: "bg-yellow-400",
  },
  leftOnly: {
    label: "Left Only",
    color: "text-blue-400",
    bg: "bg-blue-400/10 border-blue-800",
    dot: "bg-blue-400",
  },
  rightOnly: {
    label: "Right Only",
    color: "text-purple-400",
    bg: "bg-purple-400/10 border-purple-800",
    dot: "bg-purple-400",
  },
};

const LABEL_TO_STATUS: Record<string, DiffStatus | "all"> = {
  Total: "all",
  Identical: "identical",
  Different: "different",
  "Left Only": "leftOnly",
  "Right Only": "rightOnly",
};

function SummaryBar({
  result,
  activeFilter,
  onFilter,
}: {
  result: CompareResult;
  activeFilter: DiffStatus | "all";
  onFilter: (f: DiffStatus | "all") => void;
}) {
  const s = result.summary;
  const cards: Array<[string, number, string, string]> = [
    ["Total", s.total, "text-slate-200", "border-slate-600"],
    ["Identical", s.identical, "text-green-400", "border-green-600"],
    ["Different", s.different, "text-yellow-400", "border-yellow-600"],
    ["Left Only", s.leftOnly, "text-blue-400", "border-blue-600"],
    ["Right Only", s.rightOnly, "text-purple-400", "border-purple-600"],
  ];

  return (
    <div className="grid grid-cols-5 gap-3">
      {cards.map(([label, val, color, activeBorder]) => {
        const status = LABEL_TO_STATUS[label];
        const isActive = activeFilter === status;
        return (
          <button
            key={label}
            onClick={() => onFilter(isActive ? "all" : status)}
            className={cn(
              "bg-slate-900 border rounded-lg p-3 text-center transition-all hover:brightness-110",
              isActive
                ? `${activeBorder} ring-1 ring-inset ${activeBorder.replace("border-", "ring-")}`
                : "border-slate-800"
            )}
          >
            <div className={`text-2xl font-bold ${color}`}>{val}</div>
            <div className="text-xs text-slate-500 mt-0.5">{label}</div>
          </button>
        );
      })}
    </div>
  );
}

function DiffRow({
  diff,
  leftCtx,
  rightCtx,
}: {
  diff: ResourceDiff;
  leftCtx: string;
  rightCtx: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const cfg = STATUS_CONFIG[diff.status] ?? STATUS_CONFIG["different"];

  return (
    <div className={cn("border rounded-lg mb-2 overflow-hidden", cfg.bg)}>
      <button
        className="w-full flex items-center gap-3 px-4 py-2.5 text-left hover:brightness-110"
        onClick={() => setExpanded(!expanded)}
      >
        <span className={cn("w-2 h-2 rounded-full flex-shrink-0", cfg.dot)} />
        <span className="text-xs font-medium text-slate-500 w-24 shrink-0">{diff.kind}</span>
        <span className="font-mono text-sm text-slate-200 flex-1 truncate">{diff.name}</span>
        <span className={cn("text-xs font-medium px-2 py-0.5 rounded shrink-0", cfg.color)}>
          {cfg.label}
        </span>
        {expanded ? (
          <ChevronDown size={14} className="text-slate-500 shrink-0" />
        ) : (
          <ChevronRight size={14} className="text-slate-500 shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="border-t border-slate-700/50 grid grid-cols-2 divide-x divide-slate-700/50">
          <div className="p-4">
            <div className="text-xs font-semibold text-blue-400 mb-3 uppercase tracking-wider truncate">
              {leftCtx}
            </div>
            {diff.left ? (
              <SnapshotDetail snapshot={diff.left} other={diff.right} />
            ) : (
              <span className="text-xs text-slate-600 italic">Not present in this cluster</span>
            )}
          </div>
          <div className="p-4">
            <div className="text-xs font-semibold text-purple-400 mb-3 uppercase tracking-wider truncate">
              {rightCtx}
            </div>
            {diff.right ? (
              <SnapshotDetail snapshot={diff.right} other={diff.left} />
            ) : (
              <span className="text-xs text-slate-600 italic">Not present in this cluster</span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SnapshotDetail({
  snapshot,
  other,
}: {
  snapshot: NonNullable<ResourceDiff["left"]>;
  other: ResourceDiff["right"];
}) {
  const rows: Array<{ label: string; value: React.ReactNode; differs: boolean }> = [];

  if (snapshot.replicas !== null) {
    rows.push({
      label: "Replicas",
      value: snapshot.replicas,
      differs: other?.replicas !== snapshot.replicas,
    });
  }
  if (snapshot.readyReplicas !== null) {
    rows.push({
      label: "Ready Replicas",
      value: snapshot.readyReplicas,
      differs: other?.readyReplicas !== snapshot.readyReplicas,
    });
  }
  if (snapshot.serviceType) {
    rows.push({
      label: "Service Type",
      value: snapshot.serviceType,
      differs: other?.serviceType !== snapshot.serviceType,
    });
  }
  if (snapshot.servicePort !== null) {
    rows.push({
      label: "Port",
      value: snapshot.servicePort,
      differs: other?.servicePort !== snapshot.servicePort,
    });
  }
  if (snapshot.secretKeys) {
    const otherKeys = other?.secretKeys ?? [];
    const extra = snapshot.secretKeys.filter((k) => !otherKeys.includes(k));
    const missing = otherKeys.filter((k) => !snapshot.secretKeys!.includes(k));

    rows.push({
      label: "Secret Keys",
      value: (
        <div className="space-y-0.5 mt-0.5">
          {snapshot.secretKeys.map((k) => (
            <div
              key={k}
              className={cn(
                "text-xs font-mono",
                extra.includes(k) ? "text-yellow-400" : "text-slate-400"
              )}
            >
              {k}
              {extra.includes(k) && (
                <span className="ml-1 text-[10px] text-yellow-500">(extra)</span>
              )}
            </div>
          ))}
          {missing.map((k) => (
            <div key={k} className="text-xs font-mono text-red-400">
              {k} <span className="text-[10px]">(missing here)</span>
            </div>
          ))}
        </div>
      ),
      differs:
        JSON.stringify([...snapshot.secretKeys].sort()) !==
        JSON.stringify([...otherKeys].sort()),
    });
  }
  if (snapshot.configmapKeys) {
    const otherKeys = other?.configmapKeys ?? [];
    const extra = snapshot.configmapKeys.filter((k) => !otherKeys.includes(k));
    const missing = otherKeys.filter((k) => !snapshot.configmapKeys!.includes(k));

    rows.push({
      label: "ConfigMap Keys",
      value: (
        <div className="flex flex-wrap gap-1 mt-0.5">
          {snapshot.configmapKeys.map((k) => (
            <span
              key={k}
              className={cn(
                "text-xs font-mono px-1 py-0.5 rounded",
                extra.includes(k)
                  ? "bg-yellow-400/20 text-yellow-400"
                  : "bg-slate-800 text-slate-400"
              )}
            >
              {k}
            </span>
          ))}
          {missing.map((k) => (
            <span key={k} className="text-xs font-mono px-1 py-0.5 rounded bg-red-400/10 text-red-400">
              {k} <span className="text-[10px]">missing</span>
            </span>
          ))}
        </div>
      ),
      differs:
        JSON.stringify([...snapshot.configmapKeys].sort()) !==
        JSON.stringify([...otherKeys].sort()),
    });
  }

  return (
    <div className="space-y-2">
      {rows.map(({ label, value, differs }) => (
        <div
          key={label}
          className={cn(
            "text-xs rounded px-2 py-1",
            differs ? "bg-yellow-400/10" : ""
          )}
        >
          <span className="text-slate-500">{label}: </span>
          <span className={cn("text-slate-300", differs && "text-yellow-300")}>
            {value}
          </span>
          {differs && (
            <span className="ml-1 text-yellow-500 text-[10px]">⚠ differs</span>
          )}
        </div>
      ))}
      {rows.length === 0 && (
        <span className="text-xs text-slate-600 italic">No comparable fields</span>
      )}
    </div>
  );
}

export function ComparePage() {
  const { contexts } = useAppStore();

  // Config state
  const [leftCtx, setLeftCtx] = useState<string>("");
  const [rightCtx, setRightCtx] = useState<string>("");
  const [namespace, setNamespace] = useState("default");
  const [selectedKinds, setSelectedKinds] = useState<string[]>(RESOURCE_KINDS);

  // Result state — manual fetch, NOT TanStack Query
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filter state (applied after result arrives)
  const [filterStatus, setFilterStatus] = useState<DiffStatus | "all">("all");
  const [filterKind, setFilterKind] = useState<string>("all");
  const [search, setSearch] = useState("");

  // Namespace list from left cluster (best-effort)
  const { data: leftNs = [] } = useQuery({
    queryKey: ["namespaces", leftCtx],
    queryFn: () => listNamespaces(leftCtx),
    enabled: !!leftCtx,
  });

  const canCompare =
    !!leftCtx && !!rightCtx && selectedKinds.length > 0;

  const runCompare = useCallback(async () => {
    if (!canCompare) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await compareClusters({
        leftContext: leftCtx,
        rightContext: rightCtx,
        namespace,
        resourceKinds: selectedKinds,
      });
      setResult(res);
    } catch (e: any) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [leftCtx, rightCtx, namespace, selectedKinds, canCompare]);

  const toggleKind = (kind: string) => {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    );
  };

  const filteredDiffs = useMemo(() => {
    if (!result) return [];
    return result.diffs.filter((d) => {
      if (filterStatus !== "all" && d.status !== filterStatus) return false;
      if (filterKind !== "all" && d.kind !== filterKind) return false;
      if (search && !d.name.toLowerCase().includes(search.toLowerCase()))
        return false;
      return true;
    });
  }, [result, filterStatus, filterKind, search]);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2 border-b border-slate-800 flex items-center gap-2">
        <GitCompare size={16} className="text-blue-400" />
        <h2 className="text-sm font-semibold text-slate-200">Compare Clusters</h2>
      </div>

      {/* Config panel */}
      <div className="p-4 border-b border-slate-800 bg-slate-900/50 space-y-3">
        {/* Context pickers */}
        <div className="grid grid-cols-3 gap-4 items-end">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Left Cluster</label>
            <select
              value={leftCtx}
              onChange={(e) => { setLeftCtx(e.target.value); setResult(null); }}
              className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
              disabled={loading}
            >
              <option value="">Select context...</option>
              {contexts.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-center">
            <span className="text-slate-600 text-xl font-bold select-none">⇄</span>
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1">Right Cluster</label>
            <select
              value={rightCtx}
              onChange={(e) => { setRightCtx(e.target.value); setResult(null); }}
              className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
              disabled={loading}
            >
              <option value="">Select context...</option>
              {contexts.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Namespace + Kinds + Compare button */}
        <div className="flex items-end gap-4 flex-wrap">
          <div>
            <label className="text-xs text-slate-500 block mb-1">Namespace</label>
            <select
              value={namespace}
              onChange={(e) => setNamespace(e.target.value)}
              className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
              disabled={loading}
            >
              {/* Always show current value + loaded options */}
              {!leftNs.includes(namespace) && (
                <option value={namespace}>{namespace}</option>
              )}
              {leftNs.map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-xs text-slate-500 block mb-1">Resource Types</label>
            <div className="flex gap-1.5 flex-wrap">
              {RESOURCE_KINDS.map((kind) => (
                <button
                  key={kind}
                  onClick={() => toggleKind(kind)}
                  disabled={loading}
                  className={cn(
                    "text-xs px-2 py-1 rounded border transition-colors disabled:opacity-40",
                    selectedKinds.includes(kind)
                      ? "bg-blue-600/20 border-blue-600 text-blue-400"
                      : "bg-slate-800 border-slate-700 text-slate-500 hover:text-slate-300"
                  )}
                >
                  {kind}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={runCompare}
            disabled={!canCompare || loading}
            className="flex items-center gap-2 px-4 py-1.5 bg-blue-600 text-white text-xs font-medium rounded hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? (
              <>
                <Loader2 size={12} className="animate-spin" />
                Comparing...
              </>
            ) : (
              <>
                <GitCompare size={12} />
                Compare
              </>
            )}
          </button>
        </div>
      </div>

      {/* Results area */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Empty state */}
        {!loading && !result && !error && (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
            <GitCompare size={40} className="opacity-30" />
            <p className="text-sm">Select two clusters and click Compare</p>
            <p className="text-xs opacity-60">
              Compares resources across namespaces — secrets shown as key names only
            </p>
          </div>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 p-4 bg-red-400/10 border border-red-800 rounded-lg text-red-400">
            <AlertCircle size={16} className="shrink-0 mt-0.5" />
            <div>
              <div className="text-sm font-medium mb-1">Compare failed</div>
              <div className="text-xs font-mono text-red-400/80 break-all">{error}</div>
            </div>
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <>
            <SummaryBar
              result={result}
              activeFilter={filterStatus}
              onFilter={setFilterStatus}
            />

            {/* Filters row */}
            <div className="flex items-center gap-3 flex-wrap">
              <div className="relative">
                <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  placeholder="Search by name..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded pl-6 pr-6 py-1.5 w-44 focus:outline-none focus:border-blue-500"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>

              <select
                value={filterKind}
                onChange={(e) => setFilterKind(e.target.value)}
                className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
              >
                <option value="all">All kinds</option>
                {selectedKinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>

              <span className="text-xs text-slate-500">
                {filteredDiffs.length} / {result.diffs.length} resources
              </span>

              <button
                onClick={() => { setResult(null); setError(null); }}
                className="ml-auto text-xs text-slate-500 hover:text-slate-300"
              >
                Clear results
              </button>
            </div>

            {/* Diff list */}
            <div>
              {filteredDiffs.map((diff) => (
                <DiffRow
                  key={`${diff.kind}/${diff.name}`}
                  diff={diff}
                  leftCtx={leftCtx}
                  rightCtx={rightCtx}
                />
              ))}
              {filteredDiffs.length === 0 && (
                <div className="text-center text-slate-600 text-sm py-10">
                  No results match your filters
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
