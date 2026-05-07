import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listArgoApps, syncArgoApp, type ArgoApp } from "../lib/tauri";
import {
  GitBranch,
  RefreshCw,
  Clock,
  X,
  ExternalLink,
  Info,
  RotateCcw,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return "-";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return date.toLocaleDateString();
}

function truncate(str: string, max: number): string {
  return str.length > max ? str.slice(0, max) + "…" : str;
}

// ── Badges ─────────────────────────────────────────────────────────────────────

function SyncBadge({ status }: { status: string }) {
  const cls =
    status === "Synced"
      ? "bg-green-900/40 text-green-400 border-green-700/30"
      : status === "OutOfSync"
      ? "bg-amber-900/40 text-amber-400 border-amber-700/30"
      : "bg-slate-700/40 text-slate-400 border-slate-600/30";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${cls}`}
    >
      {status}
    </span>
  );
}

function HealthBadge({ status }: { status: string }) {
  const cls =
    status === "Healthy"
      ? "bg-green-900/40 text-green-400 border-green-700/30"
      : status === "Degraded"
      ? "bg-red-900/40 text-red-400 border-red-700/30"
      : status === "Progressing"
      ? "bg-blue-900/40 text-blue-400 border-blue-700/30"
      : status === "Missing"
      ? "bg-amber-900/40 text-amber-400 border-amber-700/30"
      : "bg-slate-700/40 text-slate-400 border-slate-600/30";
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${cls}`}
    >
      {status}
    </span>
  );
}

// ── Summary Row ────────────────────────────────────────────────────────────────

function SummaryRow({ apps }: { apps: ArgoApp[] }) {
  const total = apps.length;
  const synced = apps.filter((a) => a.syncStatus === "Synced").length;
  const outOfSync = apps.filter((a) => a.syncStatus === "OutOfSync").length;
  const degraded = apps.filter((a) => a.healthStatus === "Degraded").length;

  const pills = [
    { label: "Total", count: total, cls: "text-slate-300" },
    { label: "Synced", count: synced, cls: "text-green-400" },
    { label: "OutOfSync", count: outOfSync, cls: "text-amber-400" },
    { label: "Degraded", count: degraded, cls: "text-red-400" },
  ];

  return (
    <div className="flex items-center gap-4">
      {pills.map((p) => (
        <div key={p.label} className="flex items-center gap-1.5 text-xs">
          <span className={`font-semibold font-mono ${p.cls}`}>{p.count}</span>
          <span className="text-slate-500">{p.label}</span>
        </div>
      ))}
    </div>
  );
}

// ── Side Panel ─────────────────────────────────────────────────────────────────

function SidePanel({
  app,
  onClose,
  onRefresh,
  refreshing,
}: {
  app: ArgoApp;
  onClose: () => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="w-80 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60 flex flex-col overflow-hidden">
      {/* header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <span className="text-sm font-semibold text-slate-800 dark:text-slate-200 font-mono truncate">
          {app.name}
        </span>
        <button
          onClick={onClose}
          className="text-slate-500 hover:text-slate-300 transition-colors"
        >
          <X size={14} />
        </button>
      </div>

      {/* body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4 text-xs">
        {/* status badges */}
        <div className="flex items-center gap-2">
          <SyncBadge status={app.syncStatus} />
          <HealthBadge status={app.healthStatus} />
        </div>

        <Field label="Project" value={app.project} />
        <Field label="Destination NS" value={app.destNamespace || "-"} />
        <Field label="Revision" value={app.targetRevision} mono />

        {/* Repo URL */}
        <div>
          <span className="text-slate-500 block mb-1">Repo URL</span>
          <span className="text-slate-300 font-mono text-[11px] break-all">
            {app.repoUrl || "-"}
          </span>
        </div>

        {app.path && <Field label="Path" value={app.path} mono />}

        {/* Last synced */}
        <Field
          label="Last Synced"
          value={app.lastSyncedAt ? timeAgo(app.lastSyncedAt) : "-"}
        />

        {/* Images */}
        {app.images.length > 0 && (
          <div>
            <span className="text-slate-500 block mb-1">
              Images ({app.images.length})
            </span>
            <div className="space-y-1">
              {app.images.map((img) => (
                <div
                  key={img}
                  className="text-[10px] font-mono text-slate-400 break-all bg-slate-800/50 rounded px-2 py-1"
                >
                  {img}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Message */}
        {app.message && (
          <div>
            <span className="text-slate-500 block mb-1">Status Message</span>
            <p className="text-slate-400 text-[11px] break-words whitespace-pre-wrap">
              {app.message}
            </p>
          </div>
        )}
      </div>

      {/* footer — refresh button */}
      <div className="shrink-0 px-4 py-3 border-t border-slate-200 dark:border-slate-800">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="w-full flex items-center justify-center gap-1.5 text-xs py-1.5 rounded bg-blue-600/20 text-blue-400 border border-blue-600/30 hover:bg-blue-600/30 transition-colors disabled:opacity-40"
        >
          <RotateCcw size={12} className={refreshing ? "animate-spin" : ""} />
          {refreshing ? "Refreshing…" : "Trigger Refresh"}
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <span className="text-slate-500 block mb-0.5">{label}</span>
      <span className={`text-slate-300 ${mono ? "font-mono" : ""}`}>
        {value}
      </span>
    </div>
  );
}

// ── App Row ────────────────────────────────────────────────────────────────────

function AppRow({
  app,
  selected,
  onSelect,
  onRefresh,
  refreshing,
}: {
  app: ArgoApp;
  selected: boolean;
  onSelect: () => void;
  onRefresh: (e: React.MouseEvent) => void;
  refreshing: boolean;
}) {
  return (
    <tr
      onClick={onSelect}
      className={`group cursor-pointer border-b border-slate-200/50 dark:border-slate-800/50 transition-colors
        ${selected ? "bg-blue-50 dark:bg-blue-950/30" : "hover:bg-slate-100 dark:hover:bg-slate-800/40"}`}
    >
      {/* Name */}
      <td className="px-3 py-2">
        <span className="text-xs font-mono text-slate-200">{app.name}</span>
      </td>

      {/* Project */}
      <td className="px-2 py-2">
        <span className="text-xs text-slate-400">{app.project}</span>
      </td>

      {/* Repo URL */}
      <td className="px-2 py-2 max-w-[180px]">
        <span
          className="text-xs font-mono text-slate-500 truncate block"
          title={app.repoUrl}
        >
          {truncate(app.repoUrl, 40)}
        </span>
      </td>

      {/* Path */}
      <td className="px-2 py-2">
        <span className="text-xs font-mono text-slate-500">
          {app.path || "-"}
        </span>
      </td>

      {/* Revision */}
      <td className="px-2 py-2">
        <span className="text-xs font-mono text-slate-400">
          {app.targetRevision}
        </span>
      </td>

      {/* Sync Status */}
      <td className="px-2 py-2">
        <SyncBadge status={app.syncStatus} />
      </td>

      {/* Health Status */}
      <td className="px-2 py-2">
        <HealthBadge status={app.healthStatus} />
      </td>

      {/* Last Synced */}
      <td className="px-2 py-2">
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {app.lastSyncedAt ? timeAgo(app.lastSyncedAt) : "-"}
        </span>
      </td>

      {/* Refresh */}
      <td className="px-2 py-2 pr-3 text-right w-12">
        <button
          onClick={onRefresh}
          disabled={refreshing}
          title="Trigger refresh"
          className="opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded text-slate-500 hover:text-blue-400 hover:bg-blue-900/20 disabled:opacity-30"
        >
          <RotateCcw
            size={12}
            className={refreshing ? "animate-spin" : ""}
          />
        </button>
      </td>
    </tr>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

export function GitOpsPage() {
  const { activeContext } = useAppStore();

  const [refreshInterval, setRefreshInterval] = useState(30_000);
  const [selectedApp, setSelectedApp] = useState<ArgoApp | null>(null);
  const [refreshingApps, setRefreshingApps] = useState<Set<string>>(new Set());

  const {
    data: apps = [],
    isLoading,
    isFetching,
    refetch,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ["argo-apps", activeContext],
    queryFn: () => listArgoApps(activeContext),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  const lastRefreshed = dataUpdatedAt
    ? new Date(dataUpdatedAt).toLocaleTimeString()
    : null;

  async function handleSyncApp(app: ArgoApp) {
    const key = `${app.namespace}/${app.name}`;
    setRefreshingApps((prev) => new Set(prev).add(key));
    try {
      await syncArgoApp({
        context: activeContext,
        namespace: app.namespace,
        name: app.name,
      });
    } finally {
      setRefreshingApps((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  // ── Loading ──────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <GitBranch size={16} className="animate-pulse" />
        Loading ArgoCD applications…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 dark:border-slate-800 space-y-3">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="text-purple-400" />
            <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200">
              GitOps (ArgoCD)
            </h1>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
          </div>
          <div className="flex items-center gap-2">
            {lastRefreshed && (
              <span className="text-[11px] text-slate-600">
                Updated {lastRefreshed}
              </span>
            )}
            {/* Auto-refresh selector */}
            <div className="flex items-center gap-1.5">
              <Clock size={11} className="text-slate-600" />
              <select
                value={refreshInterval}
                onChange={(e) => setRefreshInterval(Number(e.target.value))}
                className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
              >
                {REFRESH_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.value ? `${opt.label}` : "Auto: Off"}
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

        {/* Summary row */}
        {apps.length > 0 && <SummaryRow apps={apps} />}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 flex overflow-hidden">
        {/* Main content */}
        <div className="flex-1 overflow-auto">
          {apps.length === 0 ? (
            /* ArgoCD not installed banner */
            <div className="flex flex-col items-center justify-center h-full gap-4">
              <div className="flex items-start gap-3 max-w-md bg-blue-950/30 border border-blue-800/40 rounded-lg px-5 py-4">
                <Info size={16} className="text-blue-400 mt-0.5 shrink-0" />
                <div className="space-y-1">
                  <p className="text-sm text-slate-300 font-medium">
                    ArgoCD not detected in this cluster
                  </p>
                  <p className="text-xs text-slate-500">
                    Install ArgoCD to use GitOps features. Applications
                    managed by ArgoCD will appear here once the
                    controller is running.
                  </p>
                  <a
                    href="https://argo-cd.readthedocs.io/en/stable/getting_started/"
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors mt-1"
                  >
                    Install ArgoCD
                    <ExternalLink size={10} />
                  </a>
                </div>
              </div>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="sticky top-0 z-10 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
                <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="px-3 py-2">Name</th>
                  <th className="px-2 py-2">Project</th>
                  <th className="px-2 py-2">Repo URL</th>
                  <th className="px-2 py-2">Path</th>
                  <th className="px-2 py-2">Revision</th>
                  <th className="px-2 py-2">Sync</th>
                  <th className="px-2 py-2">Health</th>
                  <th className="px-2 py-2">Last Synced</th>
                  <th className="px-2 py-2 pr-3 w-12" />
                </tr>
              </thead>
              <tbody>
                {apps.map((app) => {
                  const key = `${app.namespace}/${app.name}`;
                  return (
                    <AppRow
                      key={key}
                      app={app}
                      selected={
                        selectedApp?.name === app.name &&
                        selectedApp?.namespace === app.namespace
                      }
                      onSelect={() =>
                        setSelectedApp((prev) =>
                          prev?.name === app.name &&
                          prev?.namespace === app.namespace
                            ? null
                            : app
                        )
                      }
                      onRefresh={(e) => {
                        e.stopPropagation();
                        handleSyncApp(app);
                      }}
                      refreshing={refreshingApps.has(key)}
                    />
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Side panel */}
        {selectedApp && (
          <SidePanel
            app={selectedApp}
            onClose={() => setSelectedApp(null)}
            onRefresh={() => handleSyncApp(selectedApp)}
            refreshing={refreshingApps.has(
              `${selectedApp.namespace}/${selectedApp.name}`
            )}
          />
        )}
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-600">
        <span>
          {apps.length} application{apps.length !== 1 ? "s" : ""}
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
