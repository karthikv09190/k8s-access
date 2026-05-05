import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listEvents, type K8sEvent } from "../lib/tauri";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronRight,
  Server,
  X,
} from "lucide-react";

// ── Helpers ────────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string | null): string {
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

type TypeFilter = "all" | "Warning" | "Normal";
type TimeRange = "1h" | "6h" | "24h" | "all";

const TIME_RANGE_OPTIONS: { label: string; value: TimeRange; ms: number | null }[] = [
  { label: "Last 1h", value: "1h", ms: 60 * 60 * 1000 },
  { label: "Last 6h", value: "6h", ms: 6 * 60 * 60 * 1000 },
  { label: "Last 24h", value: "24h", ms: 24 * 60 * 60 * 1000 },
  { label: "All time", value: "all", ms: null },
];

const REFRESH_OPTIONS = [
  { label: "Off", value: 0 },
  { label: "5s", value: 5_000 },
  { label: "10s", value: 10_000 },
  { label: "30s", value: 30_000 },
  { label: "60s", value: 60_000 },
];

// ── Type Badge ─────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: string }) {
  if (type === "Warning") {
    return (
      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-amber-500/15 text-amber-400 border border-amber-500/20">
        <AlertTriangle size={10} />
        Warning
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
      <CheckCircle2 size={10} />
      Normal
    </span>
  );
}

// ── Expandable Row ─────────────────────────────────────────────────────────────

function EventRow({
  event,
  showNamespace,
}: {
  event: K8sEvent;
  showNamespace: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <>
      <tr
        onClick={() => setExpanded(!expanded)}
        className={`group cursor-pointer border-b border-slate-800/50 transition-colors
          ${event.eventType === "Warning" ? "hover:bg-amber-950/20" : "hover:bg-slate-800/40"}
          ${expanded ? (event.eventType === "Warning" ? "bg-amber-950/15" : "bg-slate-800/30") : ""}`}
      >
        {/* Expand icon */}
        <td className="pl-3 pr-1 py-2 w-6">
          {expanded ? (
            <ChevronDown size={12} className="text-slate-600" />
          ) : (
            <ChevronRight size={12} className="text-slate-700" />
          )}
        </td>

        {/* Type */}
        <td className="px-2 py-2 w-24">
          <TypeBadge type={event.eventType} />
        </td>

        {/* Namespace */}
        {showNamespace && (
          <td className="px-2 py-2">
            <span className="text-xs text-slate-500 font-mono">
              {event.namespace}
            </span>
          </td>
        )}

        {/* Object */}
        <td className="px-2 py-2">
          <span className="text-xs text-slate-300">
            <span className="text-slate-500">{event.objectKind}/</span>
            {event.objectName}
          </span>
        </td>

        {/* Reason */}
        <td className="px-2 py-2">
          <span className={`text-xs font-medium ${event.eventType === "Warning" ? "text-amber-300" : "text-slate-400"}`}>
            {event.reason}
          </span>
        </td>

        {/* Message (truncated) */}
        <td className="px-2 py-2 max-w-xs">
          <span className="text-xs text-slate-500 truncate block">
            {event.message}
          </span>
        </td>

        {/* Count */}
        <td className="px-2 py-2 text-center w-16">
          <span
            className={`text-xs font-mono ${event.count > 1 ? "text-amber-400 font-semibold" : "text-slate-600"}`}
          >
            {event.count}
          </span>
        </td>

        {/* Last Seen */}
        <td className="px-2 py-2 text-right pr-4 w-24">
          <span className="text-xs text-slate-500 whitespace-nowrap">
            {timeAgo(event.lastTimestamp)}
          </span>
        </td>
      </tr>

      {/* Expanded detail */}
      {expanded && (
        <tr className={event.eventType === "Warning" ? "bg-amber-950/10" : "bg-slate-800/20"}>
          <td colSpan={showNamespace ? 8 : 7} className="px-4 py-3">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs">
              <div>
                <span className="text-slate-600 block mb-0.5">Full Message</span>
                <span className="text-slate-300 break-words whitespace-pre-wrap">
                  {event.message || "-"}
                </span>
              </div>
              <div className="space-y-2">
                <div>
                  <span className="text-slate-600 block mb-0.5">Source</span>
                  <span className="text-slate-400 font-mono">
                    {event.sourceComponent || "-"}
                    {event.sourceHost && (
                      <span className="text-slate-600"> on {event.sourceHost}</span>
                    )}
                  </span>
                </div>
                <div className="flex gap-6">
                  <div>
                    <span className="text-slate-600 block mb-0.5">First Seen</span>
                    <span className="text-slate-400">{timeAgo(event.firstTimestamp)}</span>
                  </div>
                  <div>
                    <span className="text-slate-600 block mb-0.5">Last Seen</span>
                    <span className="text-slate-400">{timeAgo(event.lastTimestamp)}</span>
                  </div>
                  <div>
                    <span className="text-slate-600 block mb-0.5">Count</span>
                    <span className="text-slate-400">{event.count}</span>
                  </div>
                </div>
                <div>
                  <span className="text-slate-600 block mb-0.5">Event Name</span>
                  <span className="text-slate-500 font-mono text-[11px] break-all">
                    {event.name}
                  </span>
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Stats Bar ──────────────────────────────────────────────────────────────────

function StatsBar({
  events,
  typeFilter,
  setTypeFilter,
}: {
  events: K8sEvent[];
  typeFilter: TypeFilter;
  setTypeFilter: (f: TypeFilter) => void;
}) {
  const warnings = events.filter((e) => e.eventType === "Warning").length;
  const normals = events.filter((e) => e.eventType === "Normal").length;

  const pills: { label: string; value: TypeFilter; count: number; color: string; activeColor: string }[] = [
    { label: "All", value: "all", count: events.length, color: "text-slate-400", activeColor: "bg-slate-700 text-slate-200" },
    { label: "Warning", value: "Warning", count: warnings, color: "text-amber-400", activeColor: "bg-amber-500/20 text-amber-300 border-amber-500/30" },
    { label: "Normal", value: "Normal", count: normals, color: "text-emerald-400", activeColor: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30" },
  ];

  return (
    <div className="flex items-center gap-1.5">
      {pills.map((pill) => (
        <button
          key={pill.value}
          onClick={() => setTypeFilter(pill.value)}
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs border transition-all
            ${typeFilter === pill.value
              ? pill.activeColor + " border-current/20"
              : "text-slate-500 border-slate-800 hover:border-slate-700 hover:text-slate-400"
            }`}
        >
          {pill.label}
          <span className={`font-mono font-semibold ${typeFilter === pill.value ? "" : pill.color}`}>
            {pill.count}
          </span>
        </button>
      ))}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function EventsPage() {
  const { activeContext, activeNamespace } = useAppStore();

  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRange>("all");
  const [search, setSearch] = useState("");
  const [refreshInterval, setRefreshInterval] = useState(10_000);

  const namespace = activeNamespace || undefined; // "" → all namespaces
  const showNamespace = !activeNamespace;

  const { data: events = [], isLoading, isFetching, refetch } = useQuery({
    queryKey: ["events", activeContext, namespace],
    queryFn: () => listEvents({ context: activeContext, namespace }),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  // Apply client-side filters
  const filtered = useMemo(() => {
    let result = events;
    if (typeFilter !== "all") {
      result = result.filter((e) => e.eventType === typeFilter);
    }
    if (timeRange !== "all") {
      const opt = TIME_RANGE_OPTIONS.find((o) => o.value === timeRange)!;
      const cutoff = Date.now() - opt.ms!;
      result = result.filter((e) => {
        if (!e.lastTimestamp) return false;
        return new Date(e.lastTimestamp).getTime() >= cutoff;
      });
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.message.toLowerCase().includes(q) ||
          e.reason.toLowerCase().includes(q) ||
          e.objectName.toLowerCase().includes(q) ||
          e.objectKind.toLowerCase().includes(q) ||
          e.namespace.toLowerCase().includes(q)
      );
    }
    return result;
  }, [events, typeFilter, timeRange, search]);

  // ── Loading state ──────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full text-slate-500 text-sm gap-2">
        <Activity size={16} className="animate-pulse" />
        Loading events…
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-800 space-y-3">
        {/* Title row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={15} className="text-blue-400" />
            <h1 className="text-sm font-semibold text-slate-200">Events</h1>
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
                className="bg-slate-800 border border-slate-700 text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
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
              className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300 transition-colors p-1.5 rounded hover:bg-slate-800 disabled:opacity-40"
            >
              <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
              Refresh
            </button>
          </div>
        </div>

        {/* Filters row */}
        <div className="flex items-center gap-3">
          <StatsBar events={events} typeFilter={typeFilter} setTypeFilter={setTypeFilter} />

          <div className="flex-1" />

          {/* Time range filter */}
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(e.target.value as TimeRange)}
            className="bg-slate-800 border border-slate-700 text-slate-400 text-[11px] rounded px-1.5 py-0.5 focus:outline-none focus:border-blue-500"
          >
            {TIME_RANGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>

          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-600" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search events…"
              className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded-md pl-7 pr-7 py-1.5 w-56 focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
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
        </div>
      </div>

      {/* ── Table ── */}
      <div className="flex-1 overflow-auto">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-slate-600 gap-3">
            <Server size={28} className="opacity-30" />
            <div className="text-sm">
              {events.length === 0
                ? "No events in this namespace"
                : "No events match your filters"}
            </div>
            {events.length > 0 && (
              <button
                onClick={() => { setTypeFilter("all"); setSearch(""); }}
                className="text-xs text-blue-500 hover:text-blue-400 transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <table className="w-full text-left">
            <thead className="sticky top-0 z-10 bg-slate-900 border-b border-slate-800">
              <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="pl-3 pr-1 py-2 w-6" />
                <th className="px-2 py-2 w-24">Type</th>
                {showNamespace && <th className="px-2 py-2">Namespace</th>}
                <th className="px-2 py-2">Object</th>
                <th className="px-2 py-2">Reason</th>
                <th className="px-2 py-2">Message</th>
                <th className="px-2 py-2 text-center w-16">Count</th>
                <th className="px-2 py-2 text-right pr-4 w-24">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((event) => (
                <EventRow
                  key={event.name}
                  event={event}
                  showNamespace={showNamespace}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-600">
        <span>
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          {filtered.length !== events.length && ` (${events.length} total)`}
        </span>
        <span className="font-mono">{activeContext}</span>
      </div>
    </div>
  );
}
