import { useState } from "react";
import { restartResource } from "../../lib/tauri";
import { RotateCcw, AlertTriangle } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}

export function RestartPanel({ context, namespace, kind, name }: Props) {
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const restart = async () => {
    setConfirming(false);
    setRunning(true);
    setMsg(null);
    try {
      const result = await restartResource({ context, namespace, kind, name });
      setMsg({ ok: true, text: result.trim() || "Rollout restart triggered" });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950 p-4 gap-4">
      <div>
        <p className="text-xs text-slate-400 mb-1 font-semibold">Rollout Restart</p>
        <p className="text-xs text-slate-500 leading-5">
          Triggers a rolling restart of{" "}
          <span className="font-mono text-slate-300">
            {kind}/{name}
          </span>
          . Pods will be replaced one by one with zero downtime.
        </p>
      </div>

      {!confirming ? (
        <button
          onClick={() => setConfirming(true)}
          disabled={running}
          className="w-fit text-xs px-4 py-1.5 rounded bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white flex items-center gap-2"
        >
          <RotateCcw size={12} className={running ? "animate-spin" : ""} />
          {running ? "Restarting..." : "Rollout Restart"}
        </button>
      ) : (
        <div className="flex flex-col gap-2 p-3 rounded border border-orange-500/40 bg-orange-500/5 w-fit">
          <div className="flex items-center gap-2 text-xs text-orange-300">
            <AlertTriangle size={12} />
            Restart <span className="font-mono">{kind}/{name}</span>?
          </div>
          <div className="flex gap-2">
            <button
              onClick={restart}
              className="text-xs px-3 py-1 rounded bg-orange-600 hover:bg-orange-500 text-white"
            >
              Confirm
            </button>
            <button
              onClick={() => setConfirming(false)}
              className="text-xs px-3 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-300"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className={`text-xs ${msg.ok ? "text-green-400" : "text-red-400"}`}>{msg.text}</p>
      )}
    </div>
  );
}
