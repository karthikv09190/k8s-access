import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { HeartPulse, Loader2, Radar, Search, Settings, ShieldCheck } from "lucide-react";
import { useAppStore } from "../store/app";
import { getHealingAiStatus, getHealingIncidents, getHealingStats, scanHealingIncidents } from "../lib/tauri";
import { BatchAnalyze, PendingQueue } from "../components/healing/PendingQueue";
import { RefreshSelect } from "../components/ui/RefreshSelect";
import { IncidentDetail } from "../components/healing/IncidentDetail";
import { HealingSettings } from "../components/healing/HealingSettings";
import { ago, errorText, HealingStatusBadge, RiskBadge, SeverityLabel } from "../components/healing/shared";
import { CLOSED_STATUSES, type Incident } from "../types/healing";

type Filter = "open" | "pending" | "closed" | "all";

function approvalLabel(inc: Incident): string {
  const p = inc.proposals.find((x) => x.id === inc.activeProposalId);
  if (!p) return "—";
  if (p.blockedReason || p.risk === "CRITICAL") return "Manual only";
  if (inc.status === "PENDING_APPROVAL") return "Awaiting approval";
  if (inc.status === "REJECTED") return "Rejected";
  if (inc.status === "EXPIRED") return "Expired";
  const a = inc.approvals.filter((x) => x.proposalId === p.id).reverse()[0];
  return a ? `Approved · ${a.operator.osUser}` : "—";
}

function StatCard({ label, value, tone }: { label: string; value: number | undefined; tone: string }) {
  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 px-3 py-2">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xl font-semibold font-mono ${value ? tone : "text-slate-400 dark:text-slate-600"}`}>{value ?? "–"}</div>
    </div>
  );
}

export function SelfHealingPage() {
  const qc = useQueryClient();
  const { activeContext, focusedIncidentId, setFocusedIncidentId } = useAppStore();
  const [selectedId, setSelectedId] = useState<string | null>(focusedIncidentId);
  const [filter, setFilter] = useState<Filter>("open");
  const [search, setSearch] = useState("");
  const [scanEvery, setScanEvery] = useState(60_000);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tab, setTab] = useState<"incidents" | "pending">("incidents");
  const { data: aiStatus } = useQuery({ queryKey: ["healing-ai-status"], queryFn: getHealingAiStatus });

  // Deep links from Pods / Problem Pods / Events / search.
  useEffect(() => {
    if (focusedIncidentId) {
      setSelectedId(focusedIncidentId);
      setFocusedIncidentId(null);
    }
  }, [focusedIncidentId, setFocusedIncidentId]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["healing-incidents"] });
    qc.invalidateQueries({ queryKey: ["healing-stats"] });
    qc.invalidateQueries({ queryKey: ["healing-audit"] });
  };

  useEffect(() => {
    const unlisten = [listen("healing-updated", refresh), listen("healing-incident", refresh)];
    return () => {
      unlisten.forEach((p) => p.then((fn) => fn()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Detection is read-only and cheap; it never calls AI or changes the cluster.
  const scan = useQuery({
    queryKey: ["healing-scan", activeContext],
    queryFn: async () => {
      const r = await scanHealingIncidents(activeContext);
      refresh();
      return r;
    },
    enabled: !!activeContext,
    refetchInterval: scanEvery || false,
    retry: false,
  });

  const { data: incidents = [], isLoading } = useQuery({
    queryKey: ["healing-incidents", activeContext],
    queryFn: () => getHealingIncidents(activeContext),
    enabled: !!activeContext,
    refetchInterval: 5_000,
  });
  const { data: stats } = useQuery({
    queryKey: ["healing-stats", activeContext],
    queryFn: () => getHealingStats(activeContext),
    enabled: !!activeContext,
    refetchInterval: 5_000,
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return incidents.filter((i) => {
      const closed = CLOSED_STATUSES.includes(i.status);
      if (filter === "open" && closed) return false;
      if (filter === "closed" && !closed) return false;
      if (filter === "pending" && i.status !== "PENDING_APPROVAL") return false;
      if (!q) return true;
      return [i.resource.name, i.resource.namespace ?? "", i.problem, ...i.affected.map((a) => a.name)]
        .some((s) => s.toLowerCase().includes(q));
    });
  }, [incidents, filter, search]);

  const selected = incidents.find((i) => i.id === selectedId) ?? null;
  const batchCandidates = incidents.filter((i) => ["DETECTED", "EXPIRED", "STALE"].includes(i.status)).length;
  const pendingCount = incidents.filter((i) => i.status === "PENDING_APPROVAL" || i.status === "APPROVED").length;

  if (!activeContext) {
    return <div className="flex items-center justify-center h-full text-slate-500 text-sm">Select a cluster context</div>;
  }

  return (
    <div className="h-full overflow-auto p-4 space-y-3 bg-slate-50 dark:bg-slate-950">
      <div className="flex items-center gap-3 flex-wrap">
        <HeartPulse size={18} className="text-rose-500" />
        <div>
          <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100">SELF-HEALING</h1>
          <p className="text-[11px] text-slate-500 font-mono">Cluster: {activeContext}</p>
        </div>
        <div className="flex items-center gap-1.5 ml-2 px-2 py-1 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-300 text-[11px]">
          <ShieldCheck size={12} /> Approval required for every change · no autonomous healing
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-slate-500">
            {scan.isFetching ? "scanning…" : scan.data ? `scanned ${ago(scan.data.scannedAt)} · ${scan.data.findings} findings` : ""}
          </span>
          <RefreshSelect value={scanEvery} onChange={setScanEvery} />
          <button
            onClick={() => scan.refetch()}
            disabled={scan.isFetching}
            className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
          >
            {scan.isFetching ? <Loader2 size={12} className="animate-spin" /> : <Radar size={12} />} Scan now
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
            title="Self-Healing settings"
          >
            <Settings size={14} />
          </button>
        </div>
      </div>

      {scan.error && (
        <div className="p-2 rounded border border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300 text-xs">
          Detection failed: {errorText(scan.error)}
        </div>
      )}

      {selected ? (
        <IncidentDetail incident={selected} onBack={() => setSelectedId(null)} onChanged={refresh} />
      ) : (
        <>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-2">
            <StatCard label="Active incidents" value={stats?.active} tone="text-amber-600 dark:text-amber-400" />
            <button className="text-left" onClick={() => setTab("pending")} title="Open the approval queue">
              <StatCard label="Pending approval ›" value={stats?.pendingApproval} tone="text-violet-600 dark:text-violet-400" />
            </button>
            <StatCard label="Healing in progress" value={stats?.inProgress} tone="text-blue-600 dark:text-blue-400" />
            <StatCard label="Healed today" value={stats?.healedToday} tone="text-emerald-600 dark:text-emerald-400" />
            <StatCard label="Failed" value={stats?.failed} tone="text-red-600 dark:text-red-400" />
            <StatCard label="Needs attention" value={stats?.needsAttention} tone="text-rose-600 dark:text-rose-400" />
          </div>

          <div className="flex items-center gap-2 flex-wrap border-b border-slate-200 dark:border-slate-800 pb-2">
            {([["incidents", `Incidents (${incidents.length})`], ["pending", `Pending approval (${pendingCount})`]] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`text-xs px-3 py-1.5 rounded-t font-medium ${tab === k
                  ? "bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 border border-b-0 border-slate-200 dark:border-slate-800"
                  : "text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"}`}
              >
                {label}
              </button>
            ))}
            <div className="ml-auto">
              <BatchAnalyze context={activeContext} candidates={batchCandidates} aiStatus={aiStatus} />
            </div>
          </div>

          {tab === "pending" ? (
            <PendingQueue incidents={incidents} onChanged={refresh} onOpen={(id) => setSelectedId(id)} />
          ) : (
          <>
          <div className="flex items-center gap-2">
            {(["open", "pending", "closed", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`text-[11px] px-2 py-1 rounded capitalize ${filter === f
                  ? "bg-slate-800 text-white dark:bg-slate-200 dark:text-slate-900"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-800"}`}
              >
                {f === "pending" ? "pending approval" : f}
              </button>
            ))}
            <div className="ml-auto relative">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Filter incidents"
                className="pl-6 pr-2 py-1 text-xs rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200"
              />
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-100 dark:bg-slate-900">
                <tr className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  <th className="px-3 py-2">Severity</th>
                  <th className="px-2 py-2">Status</th>
                  <th className="px-2 py-2">Cluster</th>
                  <th className="px-2 py-2">Namespace</th>
                  <th className="px-2 py-2">Resource</th>
                  <th className="px-2 py-2">Problem</th>
                  <th className="px-2 py-2">First detected</th>
                  <th className="px-2 py-2">Last detected</th>
                  <th className="px-2 py-2 text-center">Restarts</th>
                  <th className="px-2 py-2 text-center">AI conf.</th>
                  <th className="px-2 py-2">Risk</th>
                  <th className="px-2 py-2">Approval</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={12} className="px-3 py-6 text-center text-slate-500"><Loader2 size={14} className="inline animate-spin" /></td></tr>
                )}
                {!isLoading && filtered.length === 0 && (
                  <tr>
                    <td colSpan={12} className="px-3 py-6 text-center text-slate-500">
                      {incidents.length === 0 ? "No incidents detected for this cluster." : "No incidents match this filter."}
                    </td>
                  </tr>
                )}
                {filtered.map((i) => {
                  const p = i.proposals.find((x) => x.id === i.activeProposalId);
                  return (
                    <tr
                      key={i.id}
                      onClick={() => setSelectedId(i.id)}
                      className="border-t border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800/40 cursor-pointer"
                    >
                      <td className="px-3 py-2"><SeverityLabel severity={i.severity} /></td>
                      <td className="px-2 py-2"><HealingStatusBadge status={i.status} /></td>
                      <td className="px-2 py-2 font-mono text-slate-500">{i.binding.context}</td>
                      <td className="px-2 py-2 font-mono text-slate-500">{i.resource.namespace ?? "-"}</td>
                      <td className="px-2 py-2 font-mono text-slate-800 dark:text-slate-200 whitespace-nowrap">
                        {i.resource.kind}/{i.resource.name}
                      </td>
                      <td className="px-2 py-2 text-slate-700 dark:text-slate-300 max-w-[260px] truncate" title={i.problem}>
                        {i.problem}
                      </td>
                      <td className="px-2 py-2 text-slate-500 whitespace-nowrap">{ago(i.firstDetected)}</td>
                      <td className="px-2 py-2 text-slate-500 whitespace-nowrap">{ago(i.lastDetected)}</td>
                      <td className="px-2 py-2 text-center font-mono">{i.restartCount ?? "-"}</td>
                      <td className="px-2 py-2 text-center font-mono">
                        {i.diagnosis ? `${Math.round(i.diagnosis.result.confidence * 100)}%` : "-"}
                      </td>
                      <td className="px-2 py-2">{p ? <RiskBadge risk={p.risk} /> : <span className="text-slate-400">-</span>}</td>
                      <td className="px-2 py-2 text-slate-600 dark:text-slate-400 whitespace-nowrap">{approvalLabel(i)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </>
          )}
        </>
      )}

      {settingsOpen && <HealingSettings onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
