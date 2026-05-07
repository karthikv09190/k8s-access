import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { getClusterOverview, getNodeMetrics, listPods } from "../lib/tauri";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
} from "recharts";
import {
  Server, Box, Layers, Network, Globe, Clock, AlertTriangle,
  Cpu, MemoryStick, ChevronRight, RefreshCw, Activity, DollarSign,
} from "lucide-react";

// ── Cost helpers (mirrored from NamespaceCostPage) ────────────────────────────

const COST_RATES_KEY = "k8s-cost-rates";
const DEFAULT_CPU_RATE = 0.0464;
const DEFAULT_MEM_RATE = 0.00623;

function getDashboardRates() {
  try {
    const stored = localStorage.getItem(COST_RATES_KEY);
    if (stored) return { ...{ cpu: DEFAULT_CPU_RATE, mem: DEFAULT_MEM_RATE }, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { cpuPerCoreHour: DEFAULT_CPU_RATE, memPerGiBHour: DEFAULT_MEM_RATE };
}

function parseCpuDash(s: string | undefined | null): number {
  if (!s) return 0;
  if (s.endsWith("m")) return parseInt(s) / 1000;
  return parseFloat(s);
}

function parseMemDash(s: string | undefined | null): number {
  if (!s) return 0;
  if (s.endsWith("Ki")) return parseInt(s) / (1024 * 1024);
  if (s.endsWith("Mi")) return parseInt(s) / 1024;
  if (s.endsWith("Gi")) return parseFloat(s);
  if (s.endsWith("Ti")) return parseFloat(s) * 1024;
  return parseInt(s) / (1024 * 1024 * 1024);
}

interface NsCostSummary {
  namespace: string;
  hourlyRate: number;
}

function computeTopNamespaceCosts(rawPods: unknown[]): NsCostSummary[] {
  const rates = getDashboardRates();
  const cpuRate = (rates as { cpuPerCoreHour?: number }).cpuPerCoreHour ?? DEFAULT_CPU_RATE;
  const memRate = (rates as { memPerGiBHour?: number }).memPerGiBHour ?? DEFAULT_MEM_RATE;

  const byNs = new Map<string, { cpu: number; mem: number }>();

  for (const p of rawPods) {
    const pod = p as Record<string, unknown>;
    const meta = (pod.metadata ?? {}) as Record<string, unknown>;
    const spec = (pod.spec ?? {}) as Record<string, unknown>;
    const ns = (meta.namespace as string) ?? "default";
    const containers = (spec.containers as unknown[]) ?? [];

    let cpu = 0; let mem = 0;
    for (const c of containers) {
      const container = c as Record<string, unknown>;
      const resources = (container.resources ?? {}) as Record<string, unknown>;
      const requests = (resources.requests ?? {}) as Record<string, string>;
      cpu += parseCpuDash(requests.cpu);
      mem += parseMemDash(requests.memory);
    }

    const prev = byNs.get(ns) ?? { cpu: 0, mem: 0 };
    byNs.set(ns, { cpu: prev.cpu + cpu, mem: prev.mem + mem });
  }

  const results: NsCostSummary[] = [];
  for (const [namespace, { cpu, mem }] of byNs.entries()) {
    const hourlyRate = cpu * cpuRate + mem * memRate;
    if (hourlyRate > 0) results.push({ namespace, hourlyRate });
  }

  results.sort((a, b) => b.hourlyRate - a.hourlyRate);
  return results.slice(0, 3);
}

// ── Top Namespace Costs Widget ────────────────────────────────────────────────

function TopNamespaceCostsCard({ onNavigate }: { onNavigate: (page: string) => void }) {
  const { activeContext } = useAppStore();

  const { data: rawPods } = useQuery({
    queryKey: ["dashboard-cost-pods", activeContext],
    queryFn: () => listPods({ context: activeContext }),
    enabled: !!activeContext,
    staleTime: 60_000,
  });

  const topNs = useMemo(
    () => (rawPods ? computeTopNamespaceCosts(rawPods) : null),
    [rawPods]
  );

  const maxRate = topNs && topNs.length > 0 ? topNs[0].hourlyRate : 1;

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-4 flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex items-center gap-1.5">
          <DollarSign size={11} className="text-emerald-400" />
          Top Namespace Costs
        </div>
        <button
          onClick={() => onNavigate("namespaceCost")}
          className="ml-auto text-[11px] text-slate-600 hover:text-blue-400 flex items-center gap-1 transition-colors"
        >
          View All <ChevronRight size={11} />
        </button>
      </div>

      {!topNs ? (
        <div className="flex flex-col items-center justify-center h-20 text-slate-700 text-xs gap-1.5">
          <DollarSign size={18} className="opacity-30" />
          <span>No metrics data</span>
        </div>
      ) : topNs.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-20 text-slate-700 text-xs gap-1.5">
          <DollarSign size={18} className="opacity-30" />
          <span>No resource requests found</span>
        </div>
      ) : (
        <div className="space-y-2.5">
          {topNs.map((ns) => (
            <div key={ns.namespace}>
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-xs text-slate-300 truncate flex-1 mr-2">{ns.namespace}</span>
                <span className="font-mono text-xs text-emerald-400 shrink-0">
                  ${ns.hourlyRate.toFixed(2)}/hr
                </span>
              </div>
              <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-500/70 rounded-full"
                  style={{ width: `${Math.min(100, (ns.hourlyRate / maxRate) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function parsePercent(s: string): number {
  return Math.min(100, Math.max(0, parseInt(s.replace("%", ""), 10) || 0));
}

function MiniBar({ value, color }: { value: number; color: string }) {
  return (
    <div className="w-full h-1 bg-slate-800 rounded-full overflow-hidden mt-1">
      <div className={`h-full rounded-full ${color}`} style={{ width: `${value}%` }} />
    </div>
  );
}

// ── Stat Card ──────────────────────────────────────────────────────────────────

interface StatCardProps {
  label: string;
  value: number | string;
  sub?: string;
  color?: string;
  icon: React.ElementType;
  onClick?: () => void;
  accent?: string;
}

function StatCard({ label, value, sub, color = "text-slate-100", icon: Icon, onClick, accent = "bg-slate-800" }: StatCardProps) {
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      className={`group relative flex flex-col gap-3 rounded-xl border border-slate-800 bg-slate-900 p-4 text-left transition-all
        ${onClick ? "hover:border-slate-600 hover:bg-slate-800/80 cursor-pointer" : "cursor-default"}`}
    >
      <div className="flex items-center justify-between">
        <div className={`p-2 rounded-lg ${accent}`}>
          <Icon size={14} className="text-slate-300" />
        </div>
        {onClick && (
          <ChevronRight size={13} className="text-slate-700 group-hover:text-slate-400 transition-colors" />
        )}
      </div>
      <div>
        <div className={`text-2xl font-bold tracking-tight ${color}`}>{value}</div>
        <div className="text-xs text-slate-500 mt-0.5">{label}</div>
        {sub && <div className="text-[11px] text-slate-600 mt-0.5">{sub}</div>}
      </div>
    </button>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

interface Props {
  onNavigate: (page: string) => void;
}

export function DashboardPage({ onNavigate }: Props) {
  const { activeContext } = useAppStore();

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ["overview", activeContext],
    queryFn: () => getClusterOverview(activeContext),
    enabled: !!activeContext,
    refetchInterval: 30_000,
  });

  const { data: nodeMetrics } = useQuery({
    queryKey: ["node-metrics", activeContext],
    queryFn: () => getNodeMetrics(activeContext),
    enabled: !!activeContext,
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <Activity size={16} className="animate-pulse" />
        Loading cluster overview…
      </div>
    );
  }

  const podData = [
    { name: "Running", value: data.runningPods, color: "#22c55e" },
    { name: "Pending", value: data.pendingPods, color: "#eab308" },
    { name: "Failed",  value: data.failedPods,  color: "#ef4444" },
  ];

  return (
    <div className="h-full overflow-auto bg-slate-950">
      <div className="max-w-5xl mx-auto p-6 space-y-6">

        {/* ── Title row ── */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-sm font-semibold text-slate-200">Cluster Overview</h1>
            <p className="text-xs text-slate-500 mt-0.5 font-mono">{activeContext}</p>
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-800 disabled:opacity-40"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* ── Stat cards grid ── */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <StatCard
            label="Nodes"
            value={`${data.readyNodes}/${data.totalNodes}`}
            sub="Ready"
            icon={Server}
            color={data.readyNodes === data.totalNodes ? "text-emerald-400" : "text-amber-400"}
            accent="bg-emerald-900/40"
            onClick={() => onNavigate("nodes")}
          />
          <StatCard
            label="Pods"
            value={data.totalPods}
            sub={`${data.runningPods} running`}
            icon={Box}
            accent="bg-blue-900/40"
            onClick={() => onNavigate("pods")}
          />
          <StatCard
            label="Deployments"
            value={data.totalDeployments}
            icon={Layers}
            accent="bg-violet-900/40"
            onClick={() => onNavigate("deployments")}
          />
          <StatCard
            label="Services"
            value={data.totalServices}
            icon={Network}
            accent="bg-cyan-900/40"
            onClick={() => onNavigate("services")}
          />
          <StatCard
            label="Namespaces"
            value={data.totalNamespaces}
            icon={Globe}
            accent="bg-slate-800"
          />
          <StatCard
            label="Pending Pods"
            value={data.pendingPods}
            icon={Clock}
            color={data.pendingPods > 0 ? "text-amber-400" : "text-slate-200"}
            accent={data.pendingPods > 0 ? "bg-amber-900/40" : "bg-slate-800"}
            onClick={data.pendingPods > 0 ? () => onNavigate("pods") : undefined}
          />
          <StatCard
            label="Failed Pods"
            value={data.failedPods}
            icon={AlertTriangle}
            color={data.failedPods > 0 ? "text-red-400" : "text-slate-200"}
            accent={data.failedPods > 0 ? "bg-red-900/40" : "bg-slate-800"}
            onClick={data.failedPods > 0 ? () => onNavigate("pods") : undefined}
          />
        </div>

        {/* ── Bottom row: chart + node metrics + cost widget ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">

          {/* Pod distribution chart */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-4">
              Pod Status Distribution
            </div>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={podData} barCategoryGap="40%">
                <XAxis
                  dataKey="name"
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  allowDecimals={false}
                />
                <Tooltip
                  contentStyle={{
                    backgroundColor: "#1e293b",
                    border: "1px solid #334155",
                    borderRadius: "8px",
                    color: "#e2e8f0",
                    fontSize: "12px",
                  }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                />
                <Bar dataKey="value" radius={[4, 4, 0, 0]}>
                  {podData.map((entry, i) => (
                    <Cell key={i} fill={entry.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Node metrics */}
          <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center gap-2 mb-4">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Node Metrics
              </div>
              <button
                onClick={() => onNavigate("nodes")}
                className="ml-auto text-[11px] text-slate-600 hover:text-blue-400 flex items-center gap-1 transition-colors"
              >
                View all <ChevronRight size={11} />
              </button>
            </div>

            {!nodeMetrics ? (
              <div className="flex flex-col items-center justify-center h-28 text-slate-700 text-xs gap-2">
                <Cpu size={20} className="opacity-40" />
                <span>metrics-server required</span>
              </div>
            ) : nodeMetrics.length === 0 ? (
              <div className="text-center text-slate-700 text-xs py-8">No metrics available</div>
            ) : (
              <div className="space-y-3">
                {nodeMetrics.map((node) => {
                  const cpuPct = parsePercent(node.cpuPercent);
                  const memPct = parsePercent(node.memoryPercent);
                  return (
                    <div key={node.name}>
                      <div className="flex items-center gap-2 mb-1.5">
                        <span className="font-mono text-xs text-slate-300 truncate flex-1">{node.name}</span>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <div className="flex items-center gap-1 text-[10px] text-slate-600 mb-0.5">
                            <Cpu size={9} />
                            <span>CPU</span>
                            <span className="ml-auto font-mono text-slate-500">{node.cpuCores}</span>
                            <span className="text-slate-600">{node.cpuPercent}</span>
                          </div>
                          <MiniBar
                            value={cpuPct}
                            color={cpuPct >= 80 ? "bg-red-500" : cpuPct >= 60 ? "bg-amber-500" : "bg-emerald-500"}
                          />
                        </div>
                        <div>
                          <div className="flex items-center gap-1 text-[10px] text-slate-600 mb-0.5">
                            <MemoryStick size={9} />
                            <span>Mem</span>
                            <span className="ml-auto font-mono text-slate-500">{node.memoryBytes}</span>
                            <span className="text-slate-600">{node.memoryPercent}</span>
                          </div>
                          <MiniBar
                            value={memPct}
                            color={memPct >= 85 ? "bg-red-500" : memPct >= 65 ? "bg-amber-500" : "bg-blue-500"}
                          />
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Top Namespace Costs */}
          <TopNamespaceCostsCard onNavigate={onNavigate} />
        </div>

        {/* ── Quick navigation ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
            Quick Navigation
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            {[
              { label: "Pods",         page: "pods" },
              { label: "Deployments",  page: "deployments" },
              { label: "Services",     page: "services" },
              { label: "Ingresses",    page: "ingresses" },
              { label: "ConfigMaps",   page: "configmaps" },
              { label: "Secrets",      page: "secrets" },
              { label: "Nodes",        page: "nodes" },
              { label: "StatefulSets", page: "statefulsets" },
              { label: "CronJobs",     page: "cronjobs" },
              { label: "PVCs",         page: "pvcs" },
            ].map(({ label, page }) => (
              <button
                key={page}
                onClick={() => onNavigate(page)}
                className="text-xs text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-slate-600 rounded-lg px-3 py-2 text-center transition-all"
              >
                {label}
              </button>
            ))}
          </div>
        </div>

      </div>
    </div>
  );
}
