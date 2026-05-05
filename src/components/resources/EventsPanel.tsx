import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listEvents, type K8sEvent } from "../../lib/tauri";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  RefreshCw,
  Search,
  X,
  Activity,
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

// ── Inline Event Row ───────────────────────────────────────────────────────────

function EventRow({ event }: { event: K8sEvent }) {
  const [expanded, setExpanded] = useState(false);
  const isWarning = event.eventType === "Warning";

  return (
    <>
      <div
        onClick={() => setExpanded(!expanded)}
        className={`group flex items-start gap-2 px-3 py-2 cursor-pointer border-b border-slate-800/50 transition-colors
          ${isWarning ? "hover:bg-amber-950/20" : "hover:bg-slate-800/40"}
          ${expanded ? (isWarning ? "bg-amber-950/15" : "bg-slate-800/30") : ""}`}
      >
        {/* Expand chevron */}
        <div className="shrink-0 mt-0.5">
          {expanded ? (
            <ChevronDown size={11} className="text-slate-600" />
          ) : (
            <ChevronRight size={11} className="text-slate-700" />
          )}
        </div>

        {/* Type icon */}
        <div className="shrink-0 mt-0.5">
          {isWarning ? (
            <AlertTriangle size={11} className="text-amber-400" />
          ) : (
            <CheckCircle2 size={11} className="text-emerald-500" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span
              className={`text-xs font-medium ${isWarning ? "text-amber-300" : "text-slate-400"}`}
            >
              {event.reason}
            </span>
            {event.count > 1 && (
              <span className="text-[10px] font-mono text-amber-500 bg-amber-500/10 px-1 rounded">
                ×{event.count}
              </span>
            )}
            <span className="ml-auto text-[10px] text-slate-600 whitespace-nowrap shrink-0">
              {timeAgo(event.lastTimestamp)}
            </span>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 line-clamp-2 break-words">
            {event.message}
          </p>
        </div>
      </div>

      {/* Expanded detail */}
      {expanded && (
        <div
          className={`px-4 py-3 border-b border-slate-800/50 ${
            isWarning ? "bg-amber-950/10" : "bg-slate-800/20"
          }`}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div className="col-span-2">
              <span className="text-slate-600 block mb-0.5">Full Message</span>
              <span className="text-slate-300 break-words whitespace-pre-wrap">
                {event.message || "-"}
              </span>
            </div>
            <div>
              <span className="text-slate-600 block mb-0.5">Source</span>
              <span className="text-slate-400 font-mono text-[11px]">
                {event.sourceComponent || "-"}
                {event.sourceHost && (
                  <span className="text-slate-600"> on {event.sourceHost}</span>
                )}
              </span>
            </div>
            <div>
              <span className="text-slate-600 block mb-0.5">Object</span>
              <span className="text-slate-400 font-mono text-[11px]">
                {event.objectKind}/{event.objectName}
              </span>
            </div>
            <div>
              <span className="text-slate-600 block mb-0.5">First Seen</span>
              <span className="text-slate-400">{timeAgo(event.firstTimestamp)}</span>
            </div>
            <div>
              <span className="text-slate-600 block mb-0.5">Last Seen</span>
              <span className="text-slate-400">{timeAgo(event.lastTimestamp)}</span>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

// ── Main Panel ─────────────────────────────────────────────────────────────────

interface EventsPanelProps {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}

export function EventsPanel({ context, namespace, kind, name }: EventsPanelProps) {
  const [typeFilter, setTypeFilter] = useState<TypeFilter>("all");
  const [search, setSearch] = useState("");

  const {
    data: events = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["resource-events", context, namespace, kind, name],
    queryFn: () =>
      listEvents({
        context,
        namespace: namespace || undefined,
        involvedObjectKind: kind,
        involvedObjectName: name,
      }),
    enabled: !!context && !!name,
    refetchInterval: 10_000,
  });

  // Client-side filters
  let filtered = events;
  if (typeFilter !== "all") {
    filtered = filtered.filter((e) => e.eventType === typeFilter);
  }
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter(
      (e) =>
        e.message.toLowerCase().includes(q) ||
        e.reason.toLowerCase().includes(q)
    );
  }

  const warnings = events.filter((e) => e.eventType === "Warning").length;
  const normals = events.filter((e) => e.eventType === "Normal").length;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Header */}
      <div className="shrink-0 px-3 py-2 border-b border-slate-800 bg-slate-900/30 space-y-2">
        {/* Top row: title + refresh */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity size={12} className="text-blue-400" />
            <span className="text-xs font-medium text-slate-300">
              Events for {kind}/{name}
            </span>
            {isFetching && (
              <RefreshCw size={10} className="animate-spin text-slate-600" />
            )}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800 disabled:opacity-40 transition-colors"
          >
            <RefreshCw size={11} />
          </button>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-2">
          {/* Type filter pills */}
          <div className="flex items-center gap-1">
            {(
              [
                { label: "All", value: "all" as TypeFilter, count: events.length },
                { label: "Warn", value: "Warning" as TypeFilter, count: warnings },
                { label: "OK", value: "Normal" as TypeFilter, count: normals },
              ] as const
            ).map((pill) => (
              <button
                key={pill.value}
                onClick={() => setTypeFilter(pill.value)}
                className={`px-2 py-0.5 rounded text-[10px] font-medium transition-all border ${
                  typeFilter === pill.value
                    ? pill.value === "Warning"
                      ? "bg-amber-500/20 text-amber-300 border-amber-500/30"
                      : pill.value === "Normal"
                        ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/30"
                        : "bg-slate-700 text-slate-200 border-slate-600"
                    : "text-slate-500 border-slate-800 hover:border-slate-700"
                }`}
              >
                {pill.label}{" "}
                <span className="font-mono">{pill.count}</span>
              </button>
            ))}
          </div>

          {/* Search */}
          <div className="relative flex-1">
            <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-600" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter…"
              className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-[11px] rounded pl-5 pr-5 py-1 focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-400"
              >
                <X size={10} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-slate-600 text-xs gap-2">
            <Activity size={14} className="animate-pulse" />
            Loading events…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-slate-600 gap-2">
            <Activity size={20} className="opacity-30" />
            <span className="text-xs">
              {events.length === 0
                ? "No events for this resource"
                : "No events match filters"}
            </span>
            {events.length > 0 && (
              <button
                onClick={() => {
                  setTypeFilter("all");
                  setSearch("");
                }}
                className="text-[11px] text-blue-500 hover:text-blue-400 transition-colors"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          filtered.map((event) => (
            <EventRow key={event.name} event={event} />
          ))
        )}
      </div>

      {/* Footer */}
      <div className="shrink-0 px-3 py-1 border-t border-slate-800 text-[10px] text-slate-600 flex items-center justify-between">
        <span>
          {filtered.length} event{filtered.length !== 1 ? "s" : ""}
          {filtered.length !== events.length && ` (${events.length} total)`}
        </span>
        <span className="flex items-center gap-1">
          <Clock size={9} />
          Auto-refresh 10s
        </span>
      </div>
    </div>
  );
}
