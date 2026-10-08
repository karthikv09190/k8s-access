import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRolloutHistory,
  getRolloutStatus,
  rollbackRollout,
} from "../../lib/tauri";
import { AlertCircle, CheckCircle2, Loader2, RotateCcw } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}

export function RolloutPanel({ context, namespace, kind, name }: Props) {
  const qc = useQueryClient();
  const [rolling, setRolling] = useState<number | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: history = [], isLoading } = useQuery({
    queryKey: ["rollout-history", context, namespace, kind, name],
    queryFn: () => getRolloutHistory({ context, namespace, kind, name }),
  });

  const { data: status = "" } = useQuery({
    queryKey: ["rollout-status", context, namespace, kind, name],
    queryFn: () => getRolloutStatus({ context, namespace, kind, name }),
    refetchInterval: 10_000,
  });

  const handleRollback = async (revision: number) => {
    setRolling(revision);
    setError(null);
    setResult(null);
    try {
      const msg = await rollbackRollout({ context, namespace, kind, name, revision });
      setResult(msg || "Rollback initiated.");
      qc.invalidateQueries({ queryKey: ["rollout-history"] });
      qc.invalidateQueries({ queryKey: ["rollout-status"] });
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setRolling(null);
    }
  };

  const statusOk =
    status.toLowerCase().includes("successfully") ||
    status.toLowerCase().includes("complete");

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Status bar */}
      <div className="shrink-0 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/30">
        <div className="flex items-center gap-2 text-xs">
          {statusOk ? (
            <CheckCircle2 size={12} className="text-green-600 dark:text-green-400 shrink-0" />
          ) : (
            <AlertCircle size={12} className="text-amber-400 shrink-0" />
          )}
          <span className="text-slate-500 dark:text-slate-400 font-mono truncate">
            {status || "Fetching status…"}
          </span>
        </div>
      </div>

      {result && (
        <div className="shrink-0 px-3 py-2 text-xs text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-400/10 border-b border-green-400/20">
          {result}
        </div>
      )}
      {error && (
        <div className="shrink-0 px-3 py-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-400/10 border-b border-red-400/20">
          {error}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-32 text-slate-500 text-xs gap-2">
            <Loader2 size={14} className="animate-spin" />
            Loading history…
          </div>
        ) : history.length === 0 ? (
          <div className="flex items-center justify-center h-32 text-slate-500 dark:text-slate-600 text-xs text-center px-4">
            No rollout history available.
            <br />
            Requires kubernetes.io/change-cause annotations.
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
              <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                <th className="px-3 py-2 text-left w-24">Revision</th>
                <th className="px-3 py-2 text-left">Change Cause</th>
                <th className="px-3 py-2 w-28" />
              </tr>
            </thead>
            <tbody>
              {history.map((rev, i) => (
                <tr
                  key={rev.revision}
                  className={`border-b border-slate-200/50 dark:border-slate-800/50 ${
                    i === 0 ? "bg-blue-100 dark:bg-blue-600/5" : "hover:bg-black/5 dark:hover:bg-white/5"
                  }`}
                >
                  <td className="px-3 py-2">
                    <span className="font-mono text-slate-800 dark:text-slate-200">#{rev.revision}</span>
                    {i === 0 && (
                      <span className="ml-1.5 text-[10px] text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-400/10 px-1 rounded">
                        current
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400 font-mono">
                    {rev.changeCause || "<none>"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {i !== 0 && (
                      <button
                        onClick={() => handleRollback(rev.revision)}
                        disabled={rolling === rev.revision}
                        className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 disabled:opacity-50 ml-auto"
                      >
                        {rolling === rev.revision ? (
                          <Loader2 size={9} className="animate-spin" />
                        ) : (
                          <RotateCcw size={9} />
                        )}
                        Rollback
                      </button>
                    )}
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
