import { useEffect, useRef, useState } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { Bell, X } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClusterAlert {
  id: string;
  context: string;
  severity: "warning" | "critical";
  message: string;
  timestamp: string; // RFC3339
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STORAGE_KEY = "k8s-alerts";
const MAX_ALERTS = 50;

function loadAlerts(): ClusterAlert[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as ClusterAlert[]) : [];
  } catch {
    return [];
  }
}

function saveAlerts(alerts: ClusterAlert[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(alerts));
}

function relativeTime(isoString: string): string {
  const ts = Date.parse(isoString);
  if (isNaN(ts)) return isoString;
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

// ── Severity dot ──────────────────────────────────────────────────────────────

function SeverityDot({ severity }: { severity: ClusterAlert["severity"] }) {
  const color =
    severity === "critical" ? "bg-red-400" : "bg-amber-400";
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 mt-1 ${color}`} />;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function NotificationCenter() {
  const [alerts, setAlerts] = useState<ClusterAlert[]>(loadAlerts);
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  // Tauri event listener
  useEffect(() => {
    let unlisten: UnlistenFn | undefined;

    listen<ClusterAlert>("cluster-alert", (event) => {
      setAlerts((prev) => {
        const incoming = event.payload;
        // Deduplicate by id — replace if already present, otherwise prepend
        const filtered = prev.filter((a) => a.id !== incoming.id);
        const next = [incoming, ...filtered].slice(0, MAX_ALERTS);
        saveAlerts(next);
        return next;
      });
      setUnread((n) => n + 1);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, []);

  // Reset unread count when panel is opened
  useEffect(() => {
    if (open) setUnread(0);
  }, [open]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  function dismiss(id: string) {
    setAlerts((prev) => {
      const next = prev.filter((a) => a.id !== id);
      saveAlerts(next);
      return next;
    });
  }

  function dismissAll() {
    setAlerts([]);
    saveAlerts([]);
  }

  return (
    <div className="relative" ref={panelRef}>
      {/* Bell button */}
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-1.5 rounded-md text-slate-400 hover:text-slate-100 hover:bg-slate-700 transition-colors"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 flex items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white leading-none">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {/* Dropdown panel */}
      {open && (
        <div className="absolute right-0 mt-2 w-96 max-h-[480px] flex flex-col rounded-lg border border-slate-700 bg-slate-900 shadow-xl z-50">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-700 flex-shrink-0">
            <span className="text-sm font-semibold text-slate-100">
              Alerts
              {alerts.length > 0 && (
                <span className="ml-2 text-xs font-normal text-slate-400">
                  ({alerts.length})
                </span>
              )}
            </span>
            {alerts.length > 0 && (
              <button
                onClick={dismissAll}
                className="text-xs text-slate-400 hover:text-slate-100 transition-colors"
              >
                Dismiss all
              </button>
            )}
          </div>

          {/* Alert list */}
          <div className="overflow-y-auto flex-1">
            {alerts.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 text-slate-500">
                <Bell size={28} className="mb-2 opacity-40" />
                <span className="text-sm">No alerts</span>
              </div>
            ) : (
              <ul className="divide-y divide-slate-800">
                {alerts.map((alert) => (
                  <li
                    key={alert.id}
                    className="flex gap-3 px-4 py-3 hover:bg-slate-800/50 transition-colors"
                  >
                    <SeverityDot severity={alert.severity} />
                    <div className="flex-1 min-w-0">
                      <p className="text-xs text-slate-200 leading-snug break-words">
                        {alert.message}
                      </p>
                      <div className="flex gap-2 mt-1 text-[10px] text-slate-500">
                        <span className="font-mono truncate max-w-[140px]">{alert.context}</span>
                        <span>·</span>
                        <span className="flex-shrink-0">{relativeTime(alert.timestamp)}</span>
                      </div>
                    </div>
                    <button
                      onClick={() => dismiss(alert.id)}
                      className="flex-shrink-0 text-slate-600 hover:text-slate-300 transition-colors mt-0.5"
                      aria-label="Dismiss"
                    >
                      <X size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
