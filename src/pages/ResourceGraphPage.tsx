import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import {
  listPods,
  listDeployments,
  listReplicasets,
  listStatefulsets,
  listDaemonsets,
} from "../lib/tauri";
import { GitBranch, RefreshCw, Search, X, Layers } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OwnerRef {
  uid: string;
  name: string;
  kind: string;
  apiVersion?: string;
}

interface K8sMetadata {
  name: string;
  namespace?: string;
  uid?: string;
  ownerReferences?: OwnerRef[];
}

interface RawPod {
  metadata?: K8sMetadata;
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      state?: {
        waiting?: { reason?: string };
        terminated?: { reason?: string };
      };
    }>;
  };
}

interface RawReplicaSet {
  metadata?: K8sMetadata;
  status?: { replicas?: number };
}

interface RawDeployment {
  metadata?: K8sMetadata;
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; replicas?: number };
}

interface RawStatefulSet {
  metadata?: K8sMetadata;
  spec?: { replicas?: number };
  status?: { readyReplicas?: number; replicas?: number };
}

interface RawDaemonSet {
  metadata?: K8sMetadata;
  status?: {
    numberReady?: number;
    desiredNumberScheduled?: number;
    currentNumberScheduled?: number;
  };
}

// ── Graph model ────────────────────────────────────────────────────────────────

type WorkloadKind = "Deployment" | "StatefulSet" | "DaemonSet";
type PodStatus = "Running" | "Pending" | "Failed";

interface PodNode {
  uid: string;
  name: string;
  shortName: string;
  status: PodStatus;
}

interface ReplicaSetNode {
  uid: string;
  name: string;
  pods: PodNode[];
}

interface WorkloadNode {
  uid: string;
  name: string;
  kind: WorkloadKind;
  readyReplicas: number;
  totalReplicas: number;
  replicaSets: ReplicaSetNode[];
  // For DaemonSets and StatefulSets that own pods directly (no RS layer)
  directPods: PodNode[];
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function getPodStatus(pod: RawPod): PodStatus {
  const phase = pod.status?.phase;
  if (phase === "Running") return "Running";
  if (phase === "Pending") return "Pending";
  // Check for CrashLoopBackOff
  const cs = pod.status?.containerStatuses?.[0];
  const waitReason = cs?.state?.waiting?.reason;
  if (waitReason === "CrashLoopBackOff" || waitReason === "Error") return "Failed";
  if (phase === "Succeeded") return "Running"; // treat completed as ok
  return "Failed";
}

function shortenPodName(name: string): string {
  const parts = name.split("-");
  if (parts.length >= 2) {
    // Last segment (pod hash), e.g. "x2k4p"
    const last = parts[parts.length - 1];
    return last.length > 0 ? last : name.slice(-12);
  }
  return name.slice(-12);
}

function podStatusDot(status: PodStatus): string {
  if (status === "Running") return "bg-emerald-500";
  if (status === "Pending") return "bg-amber-400";
  return "bg-red-500";
}

function podStatusRing(status: PodStatus): string {
  if (status === "Running") return "border-emerald-700";
  if (status === "Pending") return "border-amber-700";
  return "border-red-800";
}

function workloadIcon(kind: WorkloadKind): string {
  if (kind === "Deployment") return "D";
  if (kind === "StatefulSet") return "S";
  return "DS";
}

function workloadColor(kind: WorkloadKind): string {
  if (kind === "Deployment") return "text-blue-400 border-blue-700/50 bg-blue-500/10";
  if (kind === "StatefulSet") return "text-purple-400 border-purple-700/50 bg-purple-500/10";
  return "text-orange-400 border-orange-700/50 bg-orange-500/10";
}

function readyColor(ready: number, total: number): string {
  if (total === 0) return "text-slate-500";
  if (ready === total) return "text-emerald-400";
  if (ready > 0) return "text-amber-400";
  return "text-red-400";
}

// ── Build ownership graph ──────────────────────────────────────────────────────

function buildGraph(
  pods: RawPod[],
  deployments: RawDeployment[],
  replicasets: RawReplicaSet[],
  statefulsets: RawStatefulSet[],
  daemonsets: RawDaemonSet[]
): WorkloadNode[] {
  // uid → workload
  const deployMap = new Map<string, RawDeployment>();
  const ssMap = new Map<string, RawStatefulSet>();
  const dsMap = new Map<string, RawDaemonSet>();
  const rsMap = new Map<string, RawReplicaSet>();

  for (const d of deployments) {
    if (d.metadata?.uid) deployMap.set(d.metadata.uid, d);
  }
  for (const s of statefulsets) {
    if (s.metadata?.uid) ssMap.set(s.metadata.uid, s);
  }
  for (const ds of daemonsets) {
    if (ds.metadata?.uid) dsMap.set(ds.metadata.uid, ds);
  }
  for (const rs of replicasets) {
    if (rs.metadata?.uid) rsMap.set(rs.metadata.uid, rs);
  }

  // rs.uid → deployment or statefulset
  const rsOwnerMap = new Map<string, { uid: string; kind: string }>();
  for (const rs of replicasets) {
    const ownerRef = rs.metadata?.ownerReferences?.[0];
    if (ownerRef?.uid && ownerRef.kind) {
      rsOwnerMap.set(rs.metadata!.uid!, { uid: ownerRef.uid, kind: ownerRef.kind });
    }
  }

  // group pods by their owner (rs or ds or statefulset)
  const podsByOwner = new Map<string, RawPod[]>();
  for (const pod of pods) {
    const ownerRef = pod.metadata?.ownerReferences?.[0];
    if (ownerRef?.uid) {
      const existing = podsByOwner.get(ownerRef.uid) ?? [];
      existing.push(pod);
      podsByOwner.set(ownerRef.uid, existing);
    }
  }

  const result: WorkloadNode[] = [];

  // ── Deployments ──
  for (const dep of deployments) {
    const uid = dep.metadata?.uid;
    if (!uid) continue;

    // Find all RSes owned by this deployment
    const ownedRSes = replicasets.filter((rs) => {
      const ownerRef = rs.metadata?.ownerReferences?.[0];
      return ownerRef?.uid === uid;
    });

    // Only show RSes that have pods (non-zero replicas) or the most recent one
    const rsNodes: ReplicaSetNode[] = ownedRSes
      .map((rs) => {
        const rsUid = rs.metadata?.uid ?? "";
        const rsPods = (podsByOwner.get(rsUid) ?? []).map((p) => ({
          uid: p.metadata?.uid ?? p.metadata?.name ?? Math.random().toString(),
          name: p.metadata?.name ?? "unknown",
          shortName: shortenPodName(p.metadata?.name ?? ""),
          status: getPodStatus(p),
        }));
        return { uid: rsUid, name: rs.metadata?.name ?? "unknown", pods: rsPods };
      })
      .filter((rs) => rs.pods.length > 0);

    const ready = dep.status?.readyReplicas ?? 0;
    const total = dep.status?.replicas ?? dep.spec?.replicas ?? 0;

    result.push({
      uid,
      name: dep.metadata?.name ?? "unknown",
      kind: "Deployment",
      readyReplicas: ready,
      totalReplicas: total,
      replicaSets: rsNodes,
      directPods: [],
    });
  }

  // ── StatefulSets ──
  for (const ss of statefulsets) {
    const uid = ss.metadata?.uid;
    if (!uid) continue;

    // StatefulSets can own pods directly (ownerRef kind=StatefulSet)
    // or via an intermediate (rare). Check direct ownership first.
    const directPodList = (podsByOwner.get(uid) ?? []).map((p) => ({
      uid: p.metadata?.uid ?? p.metadata?.name ?? Math.random().toString(),
      name: p.metadata?.name ?? "unknown",
      shortName: shortenPodName(p.metadata?.name ?? ""),
      status: getPodStatus(p),
    }));

    // Also check RSes owned by this SS
    const ownedRSes = replicasets.filter((rs) => {
      const ownerRef = rs.metadata?.ownerReferences?.[0];
      return ownerRef?.uid === uid;
    });
    const rsNodes: ReplicaSetNode[] = ownedRSes
      .map((rs) => {
        const rsUid = rs.metadata?.uid ?? "";
        const rsPods = (podsByOwner.get(rsUid) ?? []).map((p) => ({
          uid: p.metadata?.uid ?? p.metadata?.name ?? Math.random().toString(),
          name: p.metadata?.name ?? "unknown",
          shortName: shortenPodName(p.metadata?.name ?? ""),
          status: getPodStatus(p),
        }));
        return { uid: rsUid, name: rs.metadata?.name ?? "unknown", pods: rsPods };
      })
      .filter((rs) => rs.pods.length > 0);

    const ready = ss.status?.readyReplicas ?? 0;
    const total = ss.status?.replicas ?? ss.spec?.replicas ?? 0;

    result.push({
      uid,
      name: ss.metadata?.name ?? "unknown",
      kind: "StatefulSet",
      readyReplicas: ready,
      totalReplicas: total,
      replicaSets: rsNodes,
      directPods: directPodList,
    });
  }

  // ── DaemonSets ──
  for (const ds of daemonsets) {
    const uid = ds.metadata?.uid;
    if (!uid) continue;

    const directPodList = (podsByOwner.get(uid) ?? []).map((p) => ({
      uid: p.metadata?.uid ?? p.metadata?.name ?? Math.random().toString(),
      name: p.metadata?.name ?? "unknown",
      shortName: shortenPodName(p.metadata?.name ?? ""),
      status: getPodStatus(p),
    }));

    const ready = ds.status?.numberReady ?? 0;
    const total = ds.status?.desiredNumberScheduled ?? ds.status?.currentNumberScheduled ?? 0;

    result.push({
      uid,
      name: ds.metadata?.name ?? "unknown",
      kind: "DaemonSet",
      readyReplicas: ready,
      totalReplicas: total,
      replicaSets: [],
      directPods: directPodList,
    });
  }

  return result;
}

// ── Pod Card ───────────────────────────────────────────────────────────────────

function PodCard({ pod }: { pod: PodNode }) {
  return (
    <div
      className={`flex flex-col items-center gap-1 px-2.5 py-2 rounded-lg border bg-slate-50 dark:bg-slate-900 min-w-[72px] max-w-[88px] ${podStatusRing(pod.status)}`}
      title={pod.name}
    >
      <span className={`w-2 h-2 rounded-full ${podStatusDot(pod.status)}`} />
      <span className="text-[10px] font-mono text-slate-500 dark:text-slate-400 truncate w-full text-center leading-tight">
        {pod.shortName}
      </span>
    </div>
  );
}

// ── ReplicaSet Card ────────────────────────────────────────────────────────────

function ReplicaSetCard({ rs }: { rs: ReplicaSetNode }) {
  const shortRsName = rs.name.length > 20 ? rs.name.slice(-20) : rs.name;

  return (
    <div className="flex flex-col items-center">
      {/* RS box */}
      <div className="bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg px-3 py-2 min-w-[160px] max-w-[220px]">
        <div className="flex items-center gap-1.5 mb-0.5">
          <span className="text-[9px] font-semibold text-slate-500 dark:text-slate-600 uppercase tracking-wider">
            ReplicaSet
          </span>
          <span className="ml-auto text-[10px] text-slate-500 font-mono">
            {rs.pods.length}p
          </span>
        </div>
        <div
          className="text-xs text-slate-700 dark:text-slate-300 font-mono truncate"
          title={rs.name}
        >
          {shortRsName}
        </div>
      </div>

      {/* Vertical line to pods */}
      {rs.pods.length > 0 && (
        <>
          <div className="w-px h-4 bg-slate-700" />
          <PodRow pods={rs.pods} />
        </>
      )}
    </div>
  );
}

// ── Pod Row ────────────────────────────────────────────────────────────────────

function PodRow({ pods }: { pods: PodNode[] }) {
  const MAX_VISIBLE = 8;
  const visible = pods.slice(0, MAX_VISIBLE);
  const overflow = pods.length - MAX_VISIBLE;

  return (
    <div className="relative flex items-start justify-center">
      {/* Horizontal bar connecting pods */}
      {visible.length > 1 && (
        <div
          className="absolute top-0 left-0 right-0 h-px bg-slate-700"
          style={{ left: "calc(50% - (50% - 36px))", right: "calc(50% - (50% - 36px))" }}
        />
      )}
      <div className="flex items-start gap-2 flex-wrap justify-center pt-0">
        {visible.map((pod, idx) => (
          <div key={pod.uid} className="flex flex-col items-center">
            {/* Vertical stem from bar to pod */}
            <div className={`w-px bg-slate-700 ${idx === 0 || idx === visible.length - 1 ? "h-0" : "h-4"}`} />
            <PodCard pod={pod} />
          </div>
        ))}
        {overflow > 0 && (
          <div className="flex flex-col items-center pt-0">
            <div className="flex flex-col items-center gap-1 px-2.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 min-w-[72px] max-w-[88px]">
              <span className="text-[10px] text-slate-500">+{overflow}</span>
              <span className="text-[10px] text-slate-500 dark:text-slate-600">more</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Tree Visualization ─────────────────────────────────────────────────────────

function WorkloadTree({ workload }: { workload: WorkloadNode }) {
  const colorClass = workloadColor(workload.kind);
  const rColor = readyColor(workload.readyReplicas, workload.totalReplicas);

  const hasRSLayer = workload.replicaSets.length > 0;
  const hasDirectPods = workload.directPods.length > 0;

  return (
    <div className="flex flex-col items-center select-none">
      {/* Root workload card */}
      <div
        className={`rounded-xl border px-4 py-3 min-w-[200px] max-w-[280px] ${colorClass}`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold uppercase tracking-wider opacity-70">
            {workload.kind}
          </span>
          <span className={`ml-auto text-xs font-mono font-semibold ${rColor}`}>
            {workload.readyReplicas}/{workload.totalReplicas}
          </span>
        </div>
        <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate" title={workload.name}>
          {workload.name}
        </div>
      </div>

      {/* Children */}
      {hasRSLayer && (
        <>
          {/* Vertical line down from root */}
          <div className="w-px h-5 bg-slate-700" />

          {workload.replicaSets.length === 1 ? (
            <ReplicaSetCard rs={workload.replicaSets[0]} />
          ) : (
            // Multiple RS: fan out
            <div className="relative flex items-start gap-6">
              {/* Horizontal bar */}
              <div
                className="absolute top-0 h-px bg-slate-700"
                style={{ left: "10%", right: "10%" }}
              />
              {workload.replicaSets.map((rs) => (
                <div key={rs.uid} className="flex flex-col items-center pt-0">
                  <div className="w-px h-4 bg-slate-700" />
                  <ReplicaSetCard rs={rs} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {hasDirectPods && !hasRSLayer && (
        <>
          <div className="w-px h-5 bg-slate-700" />
          <PodRow pods={workload.directPods} />
        </>
      )}

      {!hasRSLayer && !hasDirectPods && (
        <div className="mt-3 text-xs text-slate-600 italic">No running pods</div>
      )}
    </div>
  );
}

// ── Workload List Item ─────────────────────────────────────────────────────────

function WorkloadListItem({
  workload,
  selected,
  onClick,
}: {
  workload: WorkloadNode;
  selected: boolean;
  onClick: () => void;
}) {
  const colorClass = workloadColor(workload.kind);
  const rColor = readyColor(workload.readyReplicas, workload.totalReplicas);
  const totalPods =
    workload.directPods.length +
    workload.replicaSets.reduce((sum, rs) => sum + rs.pods.length, 0);

  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-all mb-1 group
        ${selected
          ? "bg-slate-200 dark:bg-slate-800 border-slate-400 dark:border-slate-600"
          : "bg-slate-50/50 dark:bg-slate-900/50 border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:border-slate-300 dark:hover:border-slate-700"
        }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded border ${colorClass}`}
        >
          {workloadIcon(workload.kind)}
        </span>
        <span className="text-xs text-slate-800 dark:text-slate-200 font-medium truncate flex-1" title={workload.name}>
          {workload.name}
        </span>
        <span className={`text-[10px] font-mono font-semibold shrink-0 ${rColor}`}>
          {workload.readyReplicas}/{workload.totalReplicas}
        </span>
      </div>
      {totalPods > 0 && (
        <div className="mt-1 flex items-center gap-1 pl-[26px]">
          <span className="text-[10px] text-slate-600">{totalPods} pod{totalPods !== 1 ? "s" : ""}</span>
        </div>
      )}
    </button>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function ResourceGraphPage() {
  const { activeContext, activeNamespace } = useAppStore();
  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const namespace = activeNamespace || undefined;
  const args = { context: activeContext, namespace };

  const { data: pods = [], isLoading: podsLoading, refetch: refetchPods } = useQuery({
    queryKey: ["graph-pods", activeContext, namespace],
    queryFn: () => listPods(args) as Promise<RawPod[]>,
    enabled: !!activeContext,
  });

  const { data: deployments = [], isLoading: depsLoading, refetch: refetchDeps } = useQuery({
    queryKey: ["graph-deployments", activeContext, namespace],
    queryFn: () => listDeployments(args) as Promise<RawDeployment[]>,
    enabled: !!activeContext,
  });

  const { data: replicasets = [], isLoading: rsLoading, refetch: refetchRS } = useQuery({
    queryKey: ["graph-replicasets", activeContext, namespace],
    queryFn: () => listReplicasets(args) as Promise<RawReplicaSet[]>,
    enabled: !!activeContext,
  });

  const { data: statefulsets = [], isLoading: ssLoading, refetch: refetchSS } = useQuery({
    queryKey: ["graph-statefulsets", activeContext, namespace],
    queryFn: () => listStatefulsets(args) as Promise<RawStatefulSet[]>,
    enabled: !!activeContext,
  });

  const { data: daemonsets = [], isLoading: dsLoading, refetch: refetchDS } = useQuery({
    queryKey: ["graph-daemonsets", activeContext, namespace],
    queryFn: () => listDaemonsets(args) as Promise<RawDaemonSet[]>,
    enabled: !!activeContext,
  });

  const isLoading = podsLoading || depsLoading || rsLoading || ssLoading || dsLoading;
  function handleRefresh() {
    refetchPods();
    refetchDeps();
    refetchRS();
    refetchSS();
    refetchDS();
  }

  const graph = useMemo(
    () => buildGraph(pods, deployments, replicasets, statefulsets, daemonsets),
    [pods, deployments, replicasets, statefulsets, daemonsets]
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return graph;
    const q = search.toLowerCase();
    return graph.filter((w) => w.name.toLowerCase().includes(q));
  }, [graph, search]);

  const selected = useMemo(
    () => graph.find((w) => w.uid === selectedUid) ?? null,
    [graph, selectedUid]
  );

  // Auto-select first item if none selected
  const displayWorkload = selected ?? (filtered.length > 0 ? filtered[0] : null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <GitBranch size={16} className="animate-pulse" />
        Building resource graph…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <GitBranch size={15} className="text-blue-600 dark:text-blue-400" />
            <h1 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Resource Graph</h1>
            {activeNamespace && (
              <span className="text-xs text-slate-500 font-mono bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded">
                {activeNamespace}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-slate-600 font-mono">
              {graph.length} workload{graph.length !== 1 ? "s" : ""}
            </span>
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-900 dark:hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800"
            >
              <RefreshCw size={12} />
              Refresh
            </button>
          </div>
        </div>
      </div>

      {/* ── Body ── */}
      {graph.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
          <Layers size={28} className="opacity-30" />
          <div className="text-sm">No workloads found in namespace</div>
        </div>
      ) : (
        <div className="flex-1 flex overflow-hidden">
          {/* ── Left panel: workload list ── */}
          <div className="w-1/3 min-w-[220px] max-w-[300px] border-r border-slate-200 dark:border-slate-800 flex flex-col overflow-hidden">
            {/* Search */}
            <div className="px-3 py-2.5 border-b border-slate-200 dark:border-slate-800">
              <div className="relative">
                <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-600" />
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter workloads…"
                  className="w-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded-md pl-7 pr-7 py-1.5 focus:outline-none focus:border-blue-500 placeholder:text-slate-400 dark:placeholder:text-slate-600"
                />
                {search && (
                  <button
                    onClick={() => setSearch("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400"
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            </div>

            {/* List */}
            <div className="flex-1 overflow-y-auto p-2">
              {filtered.length === 0 ? (
                <div className="text-center text-xs text-slate-600 mt-8">No matches</div>
              ) : (
                filtered.map((w) => (
                  <WorkloadListItem
                    key={w.uid}
                    workload={w}
                    selected={displayWorkload?.uid === w.uid}
                    onClick={() => setSelectedUid(w.uid)}
                  />
                ))
              )}
            </div>
          </div>

          {/* ── Right panel: tree view ── */}
          <div className="flex-1 overflow-auto p-6">
            {displayWorkload ? (
              <WorkloadTree workload={displayWorkload} />
            ) : (
              <div className="flex items-center justify-center h-full text-slate-600 text-sm">
                Select a workload to view its resource tree
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-200 dark:border-slate-800 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-600">
        <span>
          {deployments.length}D · {statefulsets.length}SS · {daemonsets.length}DS ·{" "}
          {replicasets.length}RS · {pods.length}P
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
