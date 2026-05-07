import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listPods, listNodes } from "../lib/tauri";
import {
  AlertTriangle,
  Activity,
  CheckCircle2,
  Clock,
  RefreshCw,
  Server,
  Skull,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
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

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "15s", value: 15_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

// ── Types ──────────────────────────────────────────────────────────────────────

interface OOMEntry {
  podName: string;
  namespace: string;
  container: string;
  exitCode: number | null;
  oomKillTime: string | null;
  restartCount: number;
}

interface CrashEntry {
  podName: string;
  namespace: string;
  container: string;
  restartCount: number;
  lastStarted: string | null;
  reason: string;
}

interface PressureEntry {
  nodeName: string;
  condition: string;
  since: string | null;
}

// ── Data extraction ────────────────────────────────────────────────────────────

function extractOOMKilled(pods: any[]): OOMEntry[] {
  const results: OOMEntry[] = [];
  for (const pod of pods) {
    const containerStatuses: any[] = pod.status?.containerStatuses ?? [];
    for (const cs of containerStatuses) {
      const inCurrent = cs.state?.terminated?.reason === "OOMKilled";
      const inLast = cs.lastState?.terminated?.reason === "OOMKilled";
      if (inCurrent || inLast) {
        const terminated = inCurrent ? cs.state.terminated : cs.lastState?.terminated;
        results.push({
          podName: pod.metadata?.name ?? "-",
          namespace: pod.metadata?.namespace ?? "-",
          container: cs.name ?? "-",
          exitCode: terminated?.exitCode ?? null,
          oomKillTime: terminated?.finishedAt ?? null,
          restartCount: cs.restartCount ?? 0,
        });
      }
    }
  }
  return results;
}

function extractCrashLoop(pods: any[]): CrashEntry[] {
  const results: CrashEntry[] = [];
  for (const pod of pods) {
    const containerStatuses: any[] = pod.status?.containerStatuses ?? [];
    for (const cs of containerStatuses) {
      const reason = cs.state?.waiting?.reason ?? "";
      const isCrashLoop = reason === "CrashLoopBackOff" || cs.restartCount > 5;
      if (isCrashLoop) {
        results.push({
          podName: pod.metadata?.name ?? "-",
          namespace: pod.metadata?.namespace ?? "-",
          container: cs.name ?? "-",
          restartCount: cs.restartCount ?? 0,
          lastStarted: cs.lastState?.terminated?.startedAt ?? cs.state?.running?.startedAt ?? null,
          reason: reason || (cs.restartCount > 5 ? "HighRestartCount" : "-"),
        });
      }
    }
  }
  return results;
}

function extractNodePressure(nodes: any[]): PressureEntry[] {
  const results: PressureEntry[] = [];
  const pressureTypes = ["MemoryPressure", "DiskPressure", "PIDPressure"];
  for (const node of nodes) {
    const conditions: any[] = node.status?.conditions ?? [];
    for (const cond of conditions) {
      if (pressureTypes.includes(cond.type) && cond.status === "True") {
        results.push({
          nodeName: node.metadata?.name ?? "-",
          condition: cond.type,
          since: cond.lastTransitionTime ?? null,
        });
      }
    }
  }
  return results;
}

// ── Section wrapper ────────────────────────────────────────────────────────────

function Section({
  title,
  icon,
  count,
  colorClass,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  count: number;
  colorClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${colorClass} overflow-hidden`}>
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-inherit">
        {icon}
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {title}
        </span>
        <span className={`ml-auto text-xs font-mono font-semibold ${count > 0 ? "text-amber-300" : "text-slate-600"}`}>
          {count}
        </span>
      </div>
      {children}
    </div>
  );
}

// ── OOMKilled Table ────────────────────────────────────────────────────────────

function OOMTable({ entries }: { entries: OOMEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-slate-600">
        No OOMKilled pods detected
      </div>
    );
  }
  return (
    <table className="w-full text-left">
      <thead className="bg-red-950/30">
        <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
          <th className="px-4 py-2">Pod Name</th>
          <th className="px-3 py-2">Namespace</th>
          <th className="px-3 py-2">Container</th>
          <th className="px-3 py-2 w-20 text-center">Exit Code</th>
          <th className="px-3 py-2 w-32">OOMKill Time</th>
          <th className="px-3 py-2 w-24 text-center">Restarts</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr
            key={`${e.podName}-${e.container}-${i}`}
            className="border-t border-red-900/20 bg-red-950/10 hover:bg-red-950/25 transition-colors"
          >
            <td className="px-4 py-2">
              <span className="font-mono text-xs text-slate-200">{e.podName}</span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-500 font-mono">{e.namespace}</span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-400">{e.container}</span>
            </td>
            <td className="px-3 py-2 text-center">
              <span className="font-mono text-xs text-red-400">
                {e.exitCode ?? "-"}
              </span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-500">{timeAgo(e.oomKillTime)}</span>
            </td>
            <td className="px-3 py-2 text-center">
              <span className={`text-xs font-mono font-semibold ${e.restartCount > 0 ? "text-red-400" : "text-slate-600"}`}>
                {e.restartCount}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── CrashLoop Table ────────────────────────────────────────────────────────────

function CrashTable({ entries }: { entries: CrashEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-slate-600">
        No CrashLoopBackOff pods detected
      </div>
    );
  }
  return (
    <table className="w-full text-left">
      <thead className="bg-amber-950/30">
        <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
          <th className="px-4 py-2">Pod Name</th>
          <th className="px-3 py-2">Namespace</th>
          <th className="px-3 py-2">Container</th>
          <th className="px-3 py-2 w-24 text-center">Restarts</th>
          <th className="px-3 py-2 w-32">Last Started</th>
          <th className="px-3 py-2 w-40">Reason</th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e, i) => (
          <tr
            key={`${e.podName}-${e.container}-${i}`}
            className="border-t border-amber-900/20 bg-amber-950/10 hover:bg-amber-950/25 transition-colors"
          >
            <td className="px-4 py-2">
              <span className="font-mono text-xs text-slate-200">{e.podName}</span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-500 font-mono">{e.namespace}</span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-400">{e.container}</span>
            </td>
            <td className="px-3 py-2 text-center">
              <span className={`font-mono text-xs font-semibold ${e.restartCount > 5 ? "text-amber-400" : "text-slate-400"}`}>
                {e.restartCount}
              </span>
            </td>
            <td className="px-3 py-2">
              <span className="text-xs text-slate-500">{timeAgo(e.lastStarted)}</span>
            </td>
            <td className="px-3 py-2">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
                {e.reason}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ── Node Pressure Cards ────────────────────────────────────────────────────────

function NodePressureCards({ entries }: { entries: PressureEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-xs text-slate-600">
        No nodes under memory/disk/PID pressure
      </div>
    );
  }
  return (
    <div className="p-3 flex flex-wrap gap-2">
      {entries.map((e, i) => (
        <div
          key={`${e.nodeName}-${e.condition}-${i}`}
          className="flex items-center gap-3 px-3 py-2 rounded-md bg-amber-950/20 border border-amber-900/40 text-xs"
        >
          <Server size={13} className="text-amber-400 shrink-0" />
          <div>
            <div className="font-mono text-slate-200">{e.nodeName}</div>
            <div className="text-amber-400 font-medium">{e.condition}</div>
          </div>
          <div className="text-slate-500 text-[11px] ml-2">since {timeAgo(e.since)}</div>
        </div>
      ))}
    </div>
  );
}

// ── All Clear Banner ───────────────────────────────────────────────────────────

function AllClearBanner() {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-green-950/20 border border-green-900/40">
      <CheckCircle2 size={16} className="text-green-400 shrink-0" />
      <span className="text-sm text-green-400 font-medium">All Clear</span>
      <span className="text-xs text-slate-500">
        No OOMKilled pods, CrashLoops, or node pressure detected
      </span>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function ProblemPodsPage() {
  const { activeContext } = useAppStore();
  const [refreshInterval, setRefreshInterval] = useState(30_000);

  // Fetch all pods across all namespaces
  const {
    data: podsRaw = [],
    isLoading: podsLoading,
    isFetching: podsFetching,
    refetch: refetchPods,
  } = useQuery({
    queryKey: ["problemPods-pods", activeContext],
    queryFn: () => listPods({ context: activeContext }),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  // Fetch all nodes
  const {
    data: nodesRaw = [],
    isLoading: nodesLoading,
    isFetching: nodesFetching,
    refetch: refetchNodes,
  } = useQuery({
    queryKey: ["problemPods-nodes", activeContext],
    queryFn: () => listNodes({ context: activeContext }),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  const isFetching = podsFetching || nodesFetching;
  const isLoading = podsLoading || nodesLoading;

  const pods = podsRaw as any[];
  const nodes = nodesRaw as any[];

  const oomEntries = useMemo(() => extractOOMKilled(pods), [pods]);
  const crashEntries = useMemo(() => extractCrashLoop(pods), [pods]);
  const pressureEntries = useMemo(() => extractNodePressure(nodes), [nodes]);

  const totalProblems = oomEntries.length + crashEntries.length + pressureEntries.length;

  function handleRefresh() {
    refetchPods();
    refetchNodes();
  }

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <Activity size={16} className="animate-pulse" />
        Loading problem pods data…
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
            <AlertTriangle size={15} className="text-amber-600 dark:text-amber-400" />
            <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Problem Pods</h1>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
          </div>
          <div className="flex items-center gap-2">
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
                    {opt.value ? `⏱ ${opt.label}` : "Auto: Off"}
                  </option>
                ))}
              </select>
            </div>
            <button
              onClick={handleRefresh}
              disabled={isFetching}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-40"
            >
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Summary badges */}
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border bg-red-950/20 border-red-900/40 text-red-400">
            <Skull size={11} />
            {oomEntries.length} OOMKilled
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border bg-amber-950/20 border-amber-900/40 text-amber-400">
            <AlertTriangle size={11} />
            {crashEntries.length} CrashLooping
          </span>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border bg-amber-950/20 border-amber-900/40 text-amber-400">
            <Server size={11} />
            {pressureEntries.length} Node
            {pressureEntries.length !== 1 ? "s" : ""} Pressured
          </span>
        </div>
      </div>

      {/* ── Content ── */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* All clear */}
        {totalProblems === 0 && <AllClearBanner />}

        {/* OOMKilled section */}
        <Section
          title="OOMKilled Pods"
          icon={<Skull size={13} className="text-red-400" />}
          count={oomEntries.length}
          colorClass="bg-red-950/20 border-red-900/40"
        >
          <OOMTable entries={oomEntries} />
        </Section>

        {/* CrashLoopBackOff section */}
        <Section
          title="CrashLoopBackOff"
          icon={<AlertTriangle size={13} className="text-amber-400" />}
          count={crashEntries.length}
          colorClass="bg-amber-950/20 border-amber-900/40"
        >
          <CrashTable entries={crashEntries} />
        </Section>

        {/* Node pressure section */}
        <Section
          title="Nodes with Pressure"
          icon={<Server size={13} className="text-amber-400" />}
          count={pressureEntries.length}
          colorClass="bg-amber-950/20 border-amber-900/40"
        >
          <NodePressureCards entries={pressureEntries} />
        </Section>
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-600">
        <span>
          {pods.length} pod{pods.length !== 1 ? "s" : ""} scanned ·{" "}
          {nodes.length} node{nodes.length !== 1 ? "s" : ""} checked · all namespaces
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
