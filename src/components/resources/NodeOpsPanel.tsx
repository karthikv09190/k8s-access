import { useState } from "react";
import { AlertTriangle, CheckCircle, MinusCircle, XCircle } from "lucide-react";
import { cordonNode, drainNode, uncordonNode } from "../../lib/tauri";

interface Props {
  context: string;
  name: string;
  resource: any;
}

export function NodeOpsPanel({ context, name, resource }: Props) {
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDrain, setConfirmDrain] = useState(false);

  const isUnschedulable = resource.spec?.unschedulable === true;
  const readyCond = resource.status?.conditions?.find((c: any) => c.type === "Ready");
  const isReady = readyCond?.status === "True";

  async function run(fn: () => Promise<string>, label: string) {
    setBusy(true);
    setOutput(null);
    setError(null);
    try {
      const result = await fn();
      setOutput(`${label} succeeded:\n${result.trim()}`);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 p-4 gap-4 overflow-auto">
      <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mb-2">
          Node Status
        </p>
        <div className="flex flex-wrap gap-4">
          <div className="flex items-center gap-1.5">
            {isReady ? (
              <CheckCircle size={13} className="text-green-600 dark:text-green-400" />
            ) : (
              <XCircle size={13} className="text-red-600 dark:text-red-400" />
            )}
            <span className="text-xs text-slate-700 dark:text-slate-300">{isReady ? "Ready" : "NotReady"}</span>
          </div>
          <div className="flex items-center gap-1.5">
            {isUnschedulable ? (
              <MinusCircle size={13} className="text-amber-600 dark:text-amber-400" />
            ) : (
              <CheckCircle size={13} className="text-green-600 dark:text-green-400" />
            )}
            <span className="text-xs text-slate-700 dark:text-slate-300">
              {isUnschedulable ? "Unschedulable (cordoned)" : "Schedulable"}
            </span>
          </div>
        </div>
      </div>

      <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-3">
        <p className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold mb-3">
          Operations
        </p>
        <div className="flex flex-col gap-2">
          <button
            disabled={busy || isUnschedulable}
            onClick={() => run(() => cordonNode({ context, name }), "Cordon")}
            className="px-3 py-2 rounded text-xs bg-amber-50 dark:bg-amber-600/20 text-amber-700 dark:text-amber-300 border border-amber-300 dark:border-amber-700/50 hover:bg-amber-100 dark:hover:bg-amber-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
          >
            <span className="font-medium">Cordon</span>
            <span className="text-amber-600/70 dark:text-amber-500/70 ml-2">— prevent new pods from scheduling</span>
          </button>

          <button
            disabled={busy || !isUnschedulable}
            onClick={() => run(() => uncordonNode({ context, name }), "Uncordon")}
            className="px-3 py-2 rounded text-xs bg-green-50 dark:bg-green-600/20 text-green-700 dark:text-green-300 border border-green-300 dark:border-green-700/50 hover:bg-green-100 dark:hover:bg-green-600/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors text-left"
          >
            <span className="font-medium">Uncordon</span>
            <span className="text-green-600/70 dark:text-green-500/70 ml-2">— re-enable pod scheduling</span>
          </button>

          {!confirmDrain ? (
            <button
              disabled={busy}
              onClick={() => setConfirmDrain(true)}
              className="px-3 py-2 rounded text-xs bg-red-50 dark:bg-red-600/20 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700/50 hover:bg-red-100 dark:hover:bg-red-600/30 disabled:opacity-40 transition-colors text-left"
            >
              <span className="font-medium">Drain</span>
              <span className="text-red-600/70 dark:text-red-500/70 ml-2">
                — evict all pods (--ignore-daemonsets --delete-emptydir-data)
              </span>
            </button>
          ) : (
            <div className="border border-red-300 dark:border-red-700/50 rounded-lg p-3 bg-red-50 dark:bg-red-950/20">
              <div className="flex items-start gap-2 mb-3">
                <AlertTriangle size={13} className="text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                <p className="text-xs text-red-700 dark:text-red-300 leading-relaxed">
                  Evicts ALL pods from{" "}
                  <span className="font-mono font-bold">{name}</span>. Local storage deleted.
                  PodDisruptionBudgets may block eviction.
                </p>
              </div>
              <div className="flex gap-2">
                <button
                  disabled={busy}
                  onClick={() => {
                    setConfirmDrain(false);
                    run(() => drainNode({ context, name }), "Drain");
                  }}
                  className="px-3 py-1.5 rounded text-xs bg-red-600 text-white hover:bg-red-500 disabled:opacity-40 transition-colors font-medium"
                >
                  {busy ? "Draining…" : "Confirm Drain"}
                </button>
                <button
                  onClick={() => setConfirmDrain(false)}
                  className="px-3 py-1.5 rounded text-xs text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {output && (
        <div className="bg-slate-50 dark:bg-slate-900 border border-green-300 dark:border-green-900/50 rounded-lg p-3">
          <p className="text-[10px] text-green-600 dark:text-green-400 uppercase tracking-wide font-semibold mb-1.5">
            Output
          </p>
          <pre className="font-mono text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap">{output}</pre>
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-800/50 rounded-lg p-3">
          <p className="text-[10px] text-red-600 dark:text-red-400 uppercase tracking-wide font-semibold mb-1.5">
            Error
          </p>
          <pre className="font-mono text-xs text-red-700 dark:text-red-300 whitespace-pre-wrap">{error}</pre>
        </div>
      )}
    </div>
  );
}
