import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listPods, listNodes } from "../lib/tauri";
import {
  DollarSign,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Server,
  Cpu,
  MemoryStick,
  Layers,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

// ── Cost constants ────────────────────────────────────────────────────────────

const CPU_COST_PER_HOUR = 0.0464; // $ per vCPU/hour (EKS ap-northeast-1, m5.xlarge equivalent)
const MEM_COST_PER_HOUR = 0.00623; // $ per GiB/hour
const HOURS_PER_MONTH = 730;

// ── Parsing helpers ───────────────────────────────────────────────────────────

function parseCpu(s: string | undefined | null): number {
  if (!s) return 0;
  if (s.endsWith("m")) return parseInt(s) / 1000;
  return parseFloat(s);
}

function parseMemory(s: string | undefined | null): number {
  if (!s) return 0;
  if (s.endsWith("Ki")) return parseInt(s) / (1024 * 1024);
  if (s.endsWith("Mi")) return parseInt(s) / 1024;
  if (s.endsWith("Gi")) return parseFloat(s);
  if (s.endsWith("Ti")) return parseFloat(s) * 1024;
  return parseInt(s) / (1024 * 1024 * 1024);
}

function monthlyCost(cpu: number, mem: number): number {
  return (cpu * CPU_COST_PER_HOUR + mem * MEM_COST_PER_HOUR) * HOURS_PER_MONTH;
}

function formatCost(dollars: number): string {
  if (dollars < 1) return `$${(dollars * 100).toFixed(1)}¢/mo`;
  return `$${dollars.toFixed(2)}/mo`;
}

function formatCpu(cores: number): string {
  if (cores === 0) return "-";
  if (cores < 1) return `${(cores * 1000).toFixed(0)}m`;
  return cores.toFixed(3);
}

function formatMem(gib: number): string {
  if (gib === 0) return "-";
  if (gib < 1) return `${(gib * 1024).toFixed(0)} Mi`;
  return `${gib.toFixed(2)} Gi`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface PodCost {
  name: string;
  namespace: string;
  cpu: number;
  mem: number;
  cost: number;
  hasRequests: boolean;
}

interface NsCost {
  namespace: string;
  pods: PodCost[];
  cpu: number;
  mem: number;
  cost: number;
  hasAnyRequests: boolean;
}

// ── Pod parsing ───────────────────────────────────────────────────────────────

function parsePods(raw: unknown[]): PodCost[] {
  return raw.map((p) => {
    const pod = p as Record<string, unknown>;
    const meta = (pod.metadata ?? {}) as Record<string, unknown>;
    const spec = (pod.spec ?? {}) as Record<string, unknown>;
    const name = (meta.name as string) ?? "unknown";
    const namespace = (meta.namespace as string) ?? "default";

    const containers = (spec.containers as unknown[]) ?? [];
    let totalCpu = 0;
    let totalMem = 0;
    let hasRequests = false;

    for (const c of containers) {
      const container = c as Record<string, unknown>;
      const resources = (container.resources ?? {}) as Record<string, unknown>;
      const requests = (resources.requests ?? {}) as Record<string, string>;
      if (requests.cpu || requests.memory) {
        hasRequests = true;
      }
      totalCpu += parseCpu(requests.cpu);
      totalMem += parseMemory(requests.memory);
    }

    return {
      name,
      namespace,
      cpu: totalCpu,
      mem: totalMem,
      cost: monthlyCost(totalCpu, totalMem),
      hasRequests,
    };
  });
}

// ── Summary Card ──────────────────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  icon,
  sub,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-lg p-4 flex flex-col gap-1.5 min-w-0">
      <div className="flex items-center gap-2 text-slate-500 text-xs font-medium uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="text-slate-100 text-xl font-semibold font-mono truncate">
        {value}
      </div>
      {sub && <div className="text-slate-600 text-[11px]">{sub}</div>}
    </div>
  );
}

// ── Pod breakdown row ─────────────────────────────────────────────────────────

function PodRow({ pod }: { pod: PodCost }) {
  return (
    <tr className="border-b border-slate-800/30 hover:bg-slate-800/20">
      <td className="pl-10 pr-2 py-1.5 text-xs text-slate-400 font-mono">
        {pod.name}
      </td>
      <td className="px-2 py-1.5 text-xs text-slate-500 font-mono text-right">
        {formatCpu(pod.cpu)}
      </td>
      <td className="px-2 py-1.5 text-xs text-slate-500 font-mono text-right">
        {formatMem(pod.mem)}
      </td>
      <td className="px-4 py-1.5 text-xs text-slate-400 font-mono text-right">
        {pod.hasRequests ? formatCost(pod.cost) : (
          <span className="text-slate-600 italic">no requests</span>
        )}
      </td>
    </tr>
  );
}

// ── Namespace row ─────────────────────────────────────────────────────────────

function NsRow({
  ns,
  dimmed,
}: {
  ns: NsCost;
  dimmed?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        onClick={() => setExpanded(!expanded)}
        className={`group cursor-pointer border-b border-slate-800/50 transition-colors hover:bg-slate-800/40
          ${expanded ? "bg-slate-800/30" : ""}
          ${dimmed ? "opacity-40" : ""}`}
      >
        <td className="pl-3 pr-1 py-2.5 w-6">
          {expanded ? (
            <ChevronDown size={12} className="text-slate-500" />
          ) : (
            <ChevronRight size={12} className="text-slate-600" />
          )}
        </td>
        <td className="px-2 py-2.5">
          <span className="text-xs font-mono text-slate-300">{ns.namespace}</span>
        </td>
        <td className="px-2 py-2.5 text-right">
          <span className="text-xs text-slate-500">{ns.pods.length}</span>
        </td>
        <td className="px-2 py-2.5 text-right">
          <span className="text-xs font-mono text-slate-400">{formatCpu(ns.cpu)}</span>
        </td>
        <td className="px-2 py-2.5 text-right">
          <span className="text-xs font-mono text-slate-400">{formatMem(ns.mem)}</span>
        </td>
        <td className="px-4 py-2.5 text-right">
          {ns.hasAnyRequests ? (
            <span className="text-xs font-mono font-semibold text-emerald-400">
              {formatCost(ns.cost)}
            </span>
          ) : (
            <span className="text-xs text-slate-600 italic">—</span>
          )}
        </td>
      </tr>
      {expanded &&
        ns.pods.map((pod) => <PodRow key={pod.name} pod={pod} />)}
    </>
  );
}

// ── Custom Tooltip ────────────────────────────────────────────────────────────

function ChartTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-slate-800 border border-slate-700 rounded px-3 py-2 text-xs shadow-lg">
      <div className="text-slate-300 font-mono mb-1">{label}</div>
      <div className="text-emerald-400 font-semibold">{formatCost(payload[0].value)}</div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function NamespaceCostPage() {
  const { activeContext } = useAppStore();

  const {
    data: rawPods = [],
    isLoading: podsLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["cost-pods", activeContext],
    queryFn: () => listPods({ context: activeContext }),
    enabled: !!activeContext,
    staleTime: 60_000,
  });

  const { data: rawNodes = [] } = useQuery({
    queryKey: ["cost-nodes", activeContext],
    queryFn: () => listNodes({ context: activeContext }),
    enabled: !!activeContext,
    staleTime: 60_000,
  });

  const nodeCount = rawNodes.length;

  // Compute per-namespace cost data
  const { nsData, totalCost, totalCpu, totalMem, podsWithoutRequests } =
    useMemo(() => {
      const pods = parsePods(rawPods);

      const byNs = new Map<string, PodCost[]>();
      for (const pod of pods) {
        const arr = byNs.get(pod.namespace) ?? [];
        arr.push(pod);
        byNs.set(pod.namespace, arr);
      }

      const nsData: NsCost[] = [];
      for (const [namespace, nsPods] of byNs.entries()) {
        const cpu = nsPods.reduce((s, p) => s + p.cpu, 0);
        const mem = nsPods.reduce((s, p) => s + p.mem, 0);
        const cost = monthlyCost(cpu, mem);
        const hasAnyRequests = nsPods.some((p) => p.hasRequests);
        nsData.push({ namespace, pods: nsPods, cpu, mem, cost, hasAnyRequests });
      }

      nsData.sort((a, b) => b.cost - a.cost);

      const totalCpu = nsData.reduce((s, n) => s + n.cpu, 0);
      const totalMem = nsData.reduce((s, n) => s + n.mem, 0);
      const totalCost = monthlyCost(totalCpu, totalMem);
      const podsWithoutRequests = parsePods(rawPods).filter(
        (p) => !p.hasRequests
      ).length;

      return { nsData, totalCost, totalCpu, totalMem, podsWithoutRequests };
    }, [rawPods]);

  const withCost = nsData.filter((n) => n.hasAnyRequests);
  const zeroCost = nsData.filter((n) => !n.hasAnyRequests);

  const chartData = withCost.slice(0, 10).map((n) => ({
    name: n.namespace,
    cost: parseFloat(n.cost.toFixed(2)),
  }));

  if (podsLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <DollarSign size={16} className="animate-pulse" />
        Computing cost estimates…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign size={15} className="text-emerald-400" />
            <h1 className="text-sm font-semibold text-slate-200">
              Cost Estimation
            </h1>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
            <span className="ml-1 px-1.5 py-0.5 rounded text-[11px] font-mono bg-slate-800 text-slate-400 border border-slate-700">
              {activeContext}
            </span>
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
        <p className="mt-1.5 text-[11px] text-slate-600">
          Estimates based on resource requests × EKS on-demand pricing
          (ap-northeast-1). Actual costs vary.
        </p>
      </div>

      {/* ── Scrollable body ── */}
      <div className="flex-1 overflow-auto px-4 py-4 space-y-4">
        {/* ── Summary cards ── */}
        <div className="grid grid-cols-4 gap-3">
          <SummaryCard
            label="Est. Monthly Total"
            value={formatCost(totalCost)}
            icon={<DollarSign size={12} />}
            sub={`${nodeCount} node${nodeCount !== 1 ? "s" : ""} in cluster`}
          />
          <SummaryCard
            label="Total CPU Requests"
            value={formatCpu(totalCpu)}
            icon={<Cpu size={12} />}
            sub="vCores requested"
          />
          <SummaryCard
            label="Total Memory Requests"
            value={formatMem(totalMem)}
            icon={<MemoryStick size={12} />}
            sub="GiB requested"
          />
          <SummaryCard
            label="Namespaces"
            value={String(nsData.length)}
            icon={<Layers size={12} />}
            sub={`${withCost.length} with requests`}
          />
        </div>

        {/* ── Warning banner ── */}
        {podsWithoutRequests > 0 && (
          <div className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400 text-xs">
            <AlertTriangle size={13} className="shrink-0" />
            <span>
              <strong>{podsWithoutRequests}</strong> pod
              {podsWithoutRequests !== 1 ? "s have" : " has"} no resource
              requests set — costs may be underestimated.
            </span>
          </div>
        )}

        {/* ── Bar chart ── */}
        {chartData.length > 0 && (
          <div className="bg-slate-900 border border-slate-800 rounded-lg p-4">
            <div className="text-xs font-semibold text-slate-400 mb-3 uppercase tracking-wide">
              Top {chartData.length} Namespaces by Monthly Cost
            </div>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart
                data={chartData}
                layout="vertical"
                margin={{ top: 0, right: 60, left: 0, bottom: 0 }}
              >
                <XAxis
                  type="number"
                  tick={{ fontSize: 10, fill: "#64748b" }}
                  tickFormatter={(v: number) =>
                    v >= 1 ? `$${v.toFixed(0)}` : `${(v * 100).toFixed(0)}¢`
                  }
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  tick={{ fontSize: 10, fill: "#94a3b8", fontFamily: "monospace" }}
                  width={130}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(100,116,139,0.08)" }} />
                <Bar dataKey="cost" fill="#34d399" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* ── Namespace table ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-lg overflow-hidden">
          {nsData.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-600 gap-3">
              <Server size={28} className="opacity-30" />
              <div className="text-sm">No pods found</div>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="pl-3 pr-1 py-2.5 w-6" />
                  <th className="px-2 py-2.5">Namespace</th>
                  <th className="px-2 py-2.5 text-right">Pods</th>
                  <th className="px-2 py-2.5 text-right">CPU Req (cores)</th>
                  <th className="px-2 py-2.5 text-right">Memory Req</th>
                  <th className="px-4 py-2.5 text-right">Est. Monthly Cost</th>
                </tr>
              </thead>
              <tbody>
                {withCost.map((ns) => (
                  <NsRow key={ns.namespace} ns={ns} />
                ))}
                {zeroCost.map((ns) => (
                  <NsRow key={ns.namespace} ns={ns} dimmed />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-600">
        <span>
          {nsData.length} namespace{nsData.length !== 1 ? "s" : ""} ·{" "}
          {rawPods.length} pod{rawPods.length !== 1 ? "s" : ""}
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
