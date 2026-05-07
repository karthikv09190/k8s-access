import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getNodeMetrics, getPodMetrics } from "../../lib/tauri";
import { RefreshCw, Cpu, MemoryStick, AlertCircle } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const CHART_COLORS = ["#34d399", "#60a5fa", "#f59e0b", "#f87171", "#a78bfa"];
const HISTORY_LIMIT = 20;

// ── Helpers ────────────────────────────────────────────────────────────────────

function parsePercent(s: string): number {
  return Math.min(100, Math.max(0, parseInt(s.replace("%", ""), 10) || 0));
}

function cpuColor(pct: number) {
  if (pct >= 80) return "bg-red-500";
  if (pct >= 60) return "bg-amber-500";
  return "bg-emerald-500";
}

function memColor(pct: number) {
  if (pct >= 85) return "bg-red-500";
  if (pct >= 65) return "bg-amber-500";
  return "bg-blue-500";
}

function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${value}%` }}
        />
      </div>
      <span className="text-[11px] text-slate-400 w-8 text-right shrink-0">{value}%</span>
    </div>
  );
}

// ── Node Metrics ────────────────────────────────────────────────────────────────

interface NodeMetricsPanelProps {
  context: string;
}

export function NodeMetricsPanel({ context }: NodeMetricsPanelProps) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["node-metrics", context],
    queryFn: () => getNodeMetrics(context),
    refetchInterval: 30_000,
  });

  type HistoryPoint = Record<string, number | string>;
  const historyRef = useRef<HistoryPoint[]>([]);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!data || data.length === 0) return;
    const point: HistoryPoint = {
      time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
    };
    data.forEach((n) => {
      point[n.name + "_cpu"] = parseInt(n.cpuPercent) || 0;
      point[n.name + "_mem"] = parseInt(n.memoryPercent) || 0;
    });
    const next = [...historyRef.current, point].slice(-HISTORY_LIMIT);
    historyRef.current = next;
    setHistory([...next]);
  }, [data]);

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900 shrink-0">
        <Cpu size={13} className="text-slate-500" />
        <span className="text-xs font-semibold text-slate-200">Node Metrics</span>
        <span className="text-[11px] text-slate-600 ml-1">(kubectl top nodes)</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-40 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-3">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-slate-600 text-xs">
            Loading metrics…
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center gap-3 py-10 text-center px-4">
            <AlertCircle size={28} className="text-amber-500 opacity-60" />
            <p className="text-xs text-slate-400 font-medium">Metrics unavailable</p>
            <p className="text-[11px] text-slate-600 max-w-xs leading-relaxed">
              {String(error).includes("metrics") || String(error).includes("server")
                ? "The metrics-server may not be installed in this cluster. Run: kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml"
                : String(error)}
            </p>
          </div>
        )}
        {data && data.length === 0 && (
          <div className="text-center text-slate-600 text-xs py-10">No node metrics available.</div>
        )}
        {data && data.length > 0 && (
          <div className="space-y-3">
            {data.map((node, i) => {
              const cpuPct = parsePercent(node.cpuPercent);
              const memPct = parsePercent(node.memoryPercent);
              const color = CHART_COLORS[i % CHART_COLORS.length];
              return (
                <div key={node.name} className="bg-slate-900 border border-slate-800 rounded-lg p-3 hover:border-slate-700 transition-colors">
                  <div className="flex items-center gap-2 mb-3">
                    <div className="w-2 h-2 rounded-full shrink-0" style={{ background: color }} />
                    <span className="font-mono text-xs text-slate-200 font-medium">{node.name}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <div className="flex items-center gap-1 mb-1.5">
                        <Cpu size={10} className="text-slate-500" />
                        <span className="text-[10px] text-slate-500 uppercase tracking-wide">CPU</span>
                        <span className="ml-auto text-[11px] text-slate-400 font-mono">{node.cpuCores}</span>
                      </div>
                      <Bar value={cpuPct} color={cpuColor(cpuPct)} />
                    </div>
                    <div>
                      <div className="flex items-center gap-1 mb-1.5">
                        <MemoryStick size={10} className="text-slate-500" />
                        <span className="text-[10px] text-slate-500 uppercase tracking-wide">Memory</span>
                        <span className="ml-auto text-[11px] text-slate-400 font-mono">{node.memoryBytes}</span>
                      </div>
                      <Bar value={memPct} color={memColor(memPct)} />
                    </div>
                  </div>
                </div>
              );
            })}

            {history.length >= 2 && data && (
              <div className="bg-slate-900 border border-slate-800 rounded-lg p-3">
                <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mb-2">
                  CPU % History
                </p>
                <ResponsiveContainer width="100%" height={80}>
                  <LineChart data={history} margin={{ top: 2, right: 4, left: -28, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#475569" }} />
                    <Tooltip
                      contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    {data.map((n, i) => (
                      <Line
                        key={n.name + "_cpu"}
                        type="monotone"
                        dataKey={n.name + "_cpu"}
                        name={n.name + " CPU%"}
                        stroke={CHART_COLORS[i % CHART_COLORS.length]}
                        dot={false}
                        strokeWidth={1.5}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>

                <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mt-3 mb-2">
                  Memory % History
                </p>
                <ResponsiveContainer width="100%" height={80}>
                  <LineChart data={history} margin={{ top: 2, right: 4, left: -28, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" />
                    <XAxis dataKey="time" hide />
                    <YAxis domain={[0, 100]} tick={{ fontSize: 9, fill: "#475569" }} />
                    <Tooltip
                      contentStyle={{ background: "#0f172a", border: "1px solid #334155", fontSize: 11 }}
                      labelStyle={{ color: "#94a3b8" }}
                    />
                    {data.map((n, i) => (
                      <Line
                        key={n.name + "_mem"}
                        type="monotone"
                        dataKey={n.name + "_mem"}
                        name={n.name + " Mem%"}
                        stroke={CHART_COLORS[i % CHART_COLORS.length]}
                        dot={false}
                        strokeWidth={1.5}
                        strokeDasharray="4 2"
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Pod Metrics ─────────────────────────────────────────────────────────────────

interface PodMetricsPanelProps {
  context: string;
  namespace?: string;
}

export function PodMetricsPanel({ context, namespace }: PodMetricsPanelProps) {
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["pod-metrics", context, namespace],
    queryFn: () => getPodMetrics({ context, namespace }),
    refetchInterval: 30_000,
  });

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900 shrink-0">
        <MemoryStick size={13} className="text-slate-500" />
        <span className="text-xs font-semibold text-slate-200">Pod Metrics</span>
        <span className="text-[11px] text-slate-600 ml-1">(kubectl top pods)</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto p-1.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-800 disabled:opacity-40 transition-colors"
          title="Refresh"
        >
          <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {isLoading && (
          <div className="flex items-center justify-center h-32 text-slate-600 text-xs">
            Loading metrics…
          </div>
        )}
        {error && (
          <div className="flex flex-col items-center gap-3 py-10 text-center px-4">
            <AlertCircle size={28} className="text-amber-500 opacity-60" />
            <p className="text-xs text-slate-400 font-medium">Metrics unavailable</p>
            <p className="text-[11px] text-slate-600 max-w-xs leading-relaxed">
              {String(error).includes("metrics") || String(error).includes("server")
                ? "metrics-server is not installed in this cluster."
                : String(error)}
            </p>
          </div>
        )}
        {data && data.length === 0 && (
          <div className="text-center text-slate-600 text-xs py-10">No pod metrics available.</div>
        )}
        {data && data.length > 0 && (
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="bg-slate-900 border-b border-slate-800 sticky top-0">
                {!namespace && (
                  <th className="text-left px-3 py-2 text-slate-500 font-medium text-[11px] uppercase tracking-wide">
                    Namespace
                  </th>
                )}
                <th className="text-left px-3 py-2 text-slate-500 font-medium text-[11px] uppercase tracking-wide">
                  Pod
                </th>
                <th className="text-left px-3 py-2 text-slate-500 font-medium text-[11px] uppercase tracking-wide w-24">
                  CPU
                </th>
                <th className="text-left px-3 py-2 text-slate-500 font-medium text-[11px] uppercase tracking-wide w-24">
                  Memory
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((pod, i) => (
                <tr
                  key={i}
                  className="border-b border-slate-800/50 hover:bg-slate-900/50 transition-colors"
                >
                  {!namespace && (
                    <td className="px-3 py-2 text-slate-500 font-mono truncate max-w-[120px]">
                      {pod.namespace}
                    </td>
                  )}
                  <td className="px-3 py-2 font-mono text-slate-300 truncate max-w-[200px]">
                    {pod.name}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 shrink-0" />
                      <span className="font-mono text-slate-300">{pod.cpuCores}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <div className="w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                      <span className="font-mono text-slate-300">{pod.memoryBytes}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
