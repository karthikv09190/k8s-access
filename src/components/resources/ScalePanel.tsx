import { useState } from "react";
import { scaleResource } from "../../lib/tauri";
import { Minus, Plus, Check } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  kind: string;
  name: string;
  currentReplicas: number;
}

export function ScalePanel({ context, namespace, kind, name, currentReplicas }: Props) {
  const [replicas, setReplicas] = useState(currentReplicas);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const isDirty = replicas !== currentReplicas;

  const apply = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const result = await scaleResource({ context, namespace, kind, name, replicas });
      setMsg({ ok: true, text: result.trim() || `Scaled to ${replicas} replicas` });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 p-4 gap-4">
      <div>
        <p className="text-xs text-slate-500 dark:text-slate-400 mb-1 font-semibold">
          {kind}: <span className="font-mono text-slate-800 dark:text-slate-200">{name}</span>
        </p>
        <p className="text-xs text-slate-500">Current replicas: {currentReplicas}</p>
      </div>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-slate-500 dark:text-slate-400">Desired replicas</label>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setReplicas((r) => Math.max(0, r - 1))}
            className="w-7 h-7 rounded bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center"
          >
            <Minus size={12} />
          </button>
          <input
            type="number"
            min={0}
            value={replicas}
            onChange={(e) => setReplicas(Math.max(0, parseInt(e.target.value, 10) || 0))}
            className="w-20 text-center bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-sm font-mono rounded px-2 py-1 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={() => setReplicas((r) => r + 1)}
            className="w-7 h-7 rounded bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 flex items-center justify-center"
          >
            <Plus size={12} />
          </button>
        </div>
      </div>

      <button
        onClick={apply}
        disabled={saving || !isDirty}
        className="w-fit text-xs px-4 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white flex items-center gap-2"
      >
        <Check size={12} />
        {saving ? "Scaling..." : "Apply"}
      </button>

      {msg && (
        <p className={`text-xs ${msg.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>{msg.text}</p>
      )}

      {replicas === 0 && isDirty && (
        <p className="text-xs text-yellow-400">
          Warning: scaling to 0 will stop all pods.
        </p>
      )}
    </div>
  );
}
