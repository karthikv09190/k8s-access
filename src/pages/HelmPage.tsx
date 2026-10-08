import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listHelmReleases, uninstallHelmRelease, type HelmRelease } from "../lib/tauri";
import {
  Package,
  RefreshCw,
  Search,
  X,
  Clock,
  AlertTriangle,
  ChevronRight,
  Trash2,
} from "lucide-react";

// ── Helpers ─────────────────────────────────────────────────────────────────────

function formatUpdated(raw: string): string {
  if (!raw) return "-";
  // helm outputs e.g. "2024-01-15 10:23:45.123456 +0000 UTC"
  const d = new Date(raw);
  if (isNaN(d.getTime())) return raw;
  const now = new Date();
  const seconds = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
  { label: "2m", value: 120_000 },
];

// ── Status Badge ────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let cls = "";
  if (s === "deployed") {
    cls = "bg-green-500/15 text-green-400 border-green-500/20";
  } else if (s === "failed") {
    cls = "bg-red-500/15 text-red-400 border-red-500/20";
  } else if (s.startsWith("pending") || s === "uninstalling") {
    cls = "bg-amber-500/15 text-amber-400 border-amber-500/20";
  } else if (s === "superseded") {
    cls = "bg-slate-700/40 text-slate-500 border-slate-700/40";
  } else {
    cls = "bg-slate-700/40 text-slate-400 border-slate-700/40";
  }
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${cls}`}
    >
      {status}
    </span>
  );
}

// ── Detail Side Panel ───────────────────────────────────────────────────────────

function DetailPanel({
  release,
  context,
  onClose,
  onUninstalled,
}: {
  release: HelmRelease;
  context: string;
  onClose: () => void;
  onUninstalled: () => void;
}) {
  const [confirmStep, setConfirmStep] = useState<0 | 1 | 2>(0);
  const queryClient = useQueryClient();

  const { mutate: doUninstall, isPending } = useMutation({
    mutationFn: () =>
      uninstallHelmRelease({
        context,
        namespace: release.namespace,
        name: release.name,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["helm", context] });
      onUninstalled();
    },
  });

  const fields: [string, string][] = [
    ["Name", release.name],
    ["Namespace", release.namespace],
    ["Chart", release.chart],
    ["App Version", release.appVersion || "-"],
    ["Revision", release.revision],
    ["Status", release.status],
    ["Updated", formatUpdated(release.updated)],
  ];

  return (
    <div className="w-80 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col overflow-hidden">
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <Package size={14} className="text-blue-600 dark:text-blue-400" />
          <span className="text-sm font-semibold text-slate-800 dark:text-slate-200 truncate max-w-[180px]">
            {release.name}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 text-slate-600 hover:text-slate-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* Details */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <div className="space-y-2">
          {fields.map(([label, value]) => (
            <div key={label}>
              <p className="text-[11px] text-slate-500 dark:text-slate-600 uppercase tracking-wider mb-0.5">
                {label}
              </p>
              {label === "Status" ? (
                <StatusBadge status={value} />
              ) : (
                <p className="text-xs text-slate-700 dark:text-slate-300 font-mono break-all">{value}</p>
              )}
            </div>
          ))}
        </div>

        {/* Raw updated timestamp */}
        <div>
          <p className="text-[11px] text-slate-500 dark:text-slate-600 uppercase tracking-wider mb-0.5">
            Updated (raw)
          </p>
          <p className="text-[11px] text-slate-500 font-mono break-all">{release.updated}</p>
        </div>
      </div>

      {/* Uninstall section */}
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-800 p-4 space-y-2">
        {confirmStep === 0 && (
          <button
            onClick={() => setConfirmStep(1)}
            className="flex items-center gap-1.5 w-full px-3 py-2 rounded-md border border-red-900/60 text-red-400 text-xs hover:bg-red-950/30 transition-colors"
          >
            <Trash2 size={13} />
            Uninstall release…
          </button>
        )}

        {confirmStep === 1 && (
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-2 rounded-md bg-red-950/20 border border-red-900/40">
              <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
              <p className="text-xs text-red-300">
                This will permanently uninstall{" "}
                <span className="font-semibold">{release.name}</span> from{" "}
                <span className="font-mono">{release.namespace}</span>. This cannot
                be undone.
              </p>
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => setConfirmStep(0)}
                className="flex-1 px-3 py-1.5 rounded-md border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-xs hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  setConfirmStep(2);
                  doUninstall();
                }}
                className="flex-1 px-3 py-1.5 rounded-md bg-red-700 hover:bg-red-600 text-white text-xs font-medium transition-colors"
              >
                Confirm Uninstall
              </button>
            </div>
          </div>
        )}

        {confirmStep === 2 && (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            {isPending ? (
              <>
                <RefreshCw size={12} className="animate-spin" />
                Uninstalling…
              </>
            ) : (
              "Done"
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Helm Not Found Banner ───────────────────────────────────────────────────────

function HelmNotFound({ message }: { message: string }) {
  const isNotFound =
    message.toLowerCase().includes("helm not found") ||
    message.toLowerCase().includes("no such file") ||
    message.toLowerCase().includes("not found on path");

  if (isNotFound) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-4">
        <Package size={32} className="opacity-30" />
        <div className="text-center space-y-1">
          <p className="text-sm text-slate-400 font-medium">helm is not installed</p>
          <p className="text-xs text-slate-600">
            Install it with:{" "}
            <span className="font-mono text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
              brew install helm
            </span>
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center h-full text-slate-500 gap-3">
      <AlertTriangle size={28} className="text-red-400 opacity-70" />
      <div className="text-center space-y-1 max-w-sm">
        <p className="text-sm text-slate-400 font-medium">Error fetching releases</p>
        <p className="text-xs text-slate-600 font-mono break-all">{message}</p>
      </div>
    </div>
  );
}

// ── Main Page ───────────────────────────────────────────────────────────────────

export function HelmPage() {
  const { activeContext } = useAppStore();

  const [search, setSearch] = useState("");
  const [refreshInterval, setRefreshInterval] = useState(0);
  const [selected, setSelected] = useState<HelmRelease | null>(null);

  const {
    data: releases = [],
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["helm", activeContext],
    queryFn: () => listHelmReleases(activeContext),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  const filtered = useMemo(() => {
    if (!search.trim()) return releases;
    const q = search.toLowerCase();
    return releases.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.namespace.toLowerCase().includes(q) ||
        r.chart.toLowerCase().includes(q) ||
        r.status.toLowerCase().includes(q) ||
        r.appVersion.toLowerCase().includes(q)
    );
  }, [releases, search]);

  if (!activeContext) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm">
        Select a cluster context
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <Package size={16} className="animate-pulse" />
        Loading helm releases…
      </div>
    );
  }

  if (error) {
    return <HelmNotFound message={String(error)} />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Package size={15} className="text-blue-600 dark:text-blue-400" />
            <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Helm Releases</h1>
            <span className="text-xs text-slate-600">
              {filtered.length}
              {filtered.length !== releases.length && ` / ${releases.length}`}
            </span>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* Search */}
            <div className="relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search releases…"
                className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded-md pl-7 pr-7 py-1.5 w-48 focus:outline-none focus:border-blue-500 placeholder:text-slate-400 dark:placeholder:text-slate-600"
              />
              {search && (
                <button
                  onClick={() => setSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400"
                >
                  <X size={12} />
                </button>
              )}
            </div>

            {/* Auto-refresh */}
            <div className="flex items-center gap-1.5">
              <Clock size={11} className="text-slate-600" />
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
              >
                {REFRESH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value ? `⏱ ${opt.label}` : "Auto: Off"}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Table */}
        <div className="flex-1 overflow-auto">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
              <Package size={28} className="opacity-30" />
              <div className="text-sm">
                {releases.length === 0
                  ? "No helm releases found in this cluster"
                  : "No releases match your search"}
              </div>
              {releases.length > 0 && search && (
                <button
                  onClick={() => setSearch("")}
                  className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
                >
                  Clear search
                </button>
              )}
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-3 py-2">Namespace</th>
                  <th className="px-3 py-2">Chart</th>
                  <th className="px-3 py-2 w-24">App Version</th>
                  <th className="px-3 py-2 w-28">Status</th>
                  <th className="px-3 py-2 w-16 text-center">Rev</th>
                  <th className="px-3 py-2 w-24 text-right pr-4">Updated</th>
                  <th className="px-3 py-2 w-6" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => {
                  const isSelected = selected?.name === r.name && selected?.namespace === r.namespace;
                  return (
                    <tr
                      key={`${r.namespace}/${r.name}`}
                      onClick={() => setSelected(isSelected ? null : r)}
                      className={`group cursor-pointer border-b border-slate-200/50 dark:border-slate-800/50 transition-colors
                        ${isSelected
                          ? "bg-blue-100 dark:bg-blue-600/10 border-l-2 border-l-blue-500"
                          : "hover:bg-slate-100 dark:hover:bg-slate-800/40"
                        }`}
                    >
                      <td className="px-3 py-2">
                        <span className="text-xs font-medium text-slate-200">{r.name}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs font-mono text-slate-500">{r.namespace}</span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs text-slate-400 font-mono truncate max-w-[180px] block">
                          {r.chart}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs text-slate-500 font-mono">{r.appVersion || "-"}</span>
                      </td>
                      <td className="px-3 py-2">
                        <StatusBadge status={r.status} />
                      </td>
                      <td className="px-3 py-2 text-center">
                        <span className="text-xs font-mono text-slate-500">{r.revision}</span>
                      </td>
                      <td className="px-3 py-2 text-right pr-4">
                        <span className="text-xs text-slate-500 whitespace-nowrap">
                          {formatUpdated(r.updated)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <ChevronRight
                          size={12}
                          className={`transition-colors ${
                            isSelected ? "text-blue-400" : "text-slate-700 group-hover:text-slate-500"
                          }`}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Side panel */}
        {selected && (
          <DetailPanel
            release={selected}
            context={activeContext}
            onClose={() => setSelected(null)}
            onUninstalled={() => setSelected(null)}
          />
        )}
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-600">
        <span>
          {filtered.length} release{filtered.length !== 1 ? "s" : ""}
          {filtered.length !== releases.length && ` (${releases.length} total)`}
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
