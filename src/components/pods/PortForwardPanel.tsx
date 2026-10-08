import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listPortForwards,
  startPortForward,
  stopPortForward,
  type PortForwardInfo,
} from "../../lib/tauri";
import { Plus, Square, Wifi } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  resourceType: "pod" | "svc";
  resourceName: string;
}

export function PortForwardPanel({ context, namespace, resourceType, resourceName }: Props) {
  const qc = useQueryClient();
  const [localPort, setLocalPort] = useState("8080");
  const [remotePort, setRemotePort] = useState("8080");
  const [starting, setStarting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const { data: forwards = [] } = useQuery({
    queryKey: ["portforwards"],
    queryFn: listPortForwards,
    refetchInterval: 3000,
  });

  const resourceForwards = (forwards as PortForwardInfo[]).filter(
    (f) =>
      f.resourceName === resourceName &&
      f.namespace === namespace &&
      f.resourceType === resourceType
  );

  const start = async () => {
    const lp = parseInt(localPort, 10);
    const rp = parseInt(remotePort, 10);
    if (!lp || !rp) {
      setErr("Invalid ports");
      return;
    }
    setStarting(true);
    setErr(null);
    try {
      await startPortForward({
        context,
        namespace,
        resourceType,
        resourceName,
        localPort: lp,
        remotePort: rp,
      });
      qc.invalidateQueries({ queryKey: ["portforwards"] });
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setStarting(false);
    }
  };

  const stop = async (id: string) => {
    await stopPortForward(id);
    qc.invalidateQueries({ queryKey: ["portforwards"] });
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 shrink-0">
        <Wifi size={12} className="text-slate-500 dark:text-slate-400" />
        <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold">PORT FORWARD</span>
        <span className="text-xs text-slate-500 dark:text-slate-600 font-mono ml-1">
          {resourceType}/{resourceName}
        </span>
      </div>

      {/* Add new forward */}
      <div className="px-3 py-3 border-b border-slate-200 dark:border-slate-800 space-y-2">
        <p className="text-xs text-slate-500">Forward a port to localhost</p>
        <div className="flex items-center gap-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">Local port</label>
            <input
              type="number"
              value={localPort}
              onChange={(e) => setLocalPort(e.target.value)}
              className="w-20 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            />
          </div>
          <span className="text-slate-500 mt-4">→</span>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-slate-500">
              {resourceType === "svc" ? "Service" : "Pod"} port
            </label>
            <input
              type="number"
              value={remotePort}
              onChange={(e) => setRemotePort(e.target.value)}
              className="w-20 bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-blue-500"
            />
          </div>
          <button
            onClick={start}
            disabled={starting}
            className="mt-4 shrink-0 text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white flex items-center gap-1"
          >
            <Plus size={10} />
            {starting ? "Starting..." : "Start"}
          </button>
        </div>
        {err && <p className="text-xs text-red-600 dark:text-red-400">{err}</p>}
      </div>

      {/* Active forwards */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        <p className="text-xs text-slate-500 mb-2">
          Active forwards ({resourceForwards.length})
        </p>
        {resourceForwards.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-600">No active port forwards.</p>
        ) : (
          resourceForwards.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between bg-white dark:bg-slate-800/50 border border-slate-300 dark:border-slate-700 rounded px-3 py-2"
            >
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                <span className="font-mono text-xs text-slate-800 dark:text-slate-200">
                  localhost:{f.localPort} → :{f.remotePort}
                </span>
              </div>
              <button
                onClick={() => stop(f.id)}
                className="text-xs px-2 py-0.5 rounded bg-red-50 dark:bg-red-900/50 border border-red-300 dark:border-red-800 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-800/50 flex items-center gap-1"
              >
                <Square size={10} />
                Stop
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
