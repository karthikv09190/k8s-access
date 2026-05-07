import { useState } from "react";
import { triggerCronjob } from "../../lib/tauri";
import { Play, ExternalLink } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  name: string;
  resource: any;
}

export function TriggerJobPanel({ context, namespace, name, resource }: Props) {
  const [jobName, setJobName] = useState("");
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; jobName?: string } | null>(null);

  const schedule: string = resource.spec?.schedule ?? "-";
  const lastSchedule: string = resource.status?.lastScheduleTime
    ? new Date(resource.status.lastScheduleTime).toLocaleString()
    : "Never";
  const active: number = resource.status?.active?.length ?? 0;

  const trigger = async () => {
    setRunning(true);
    setMsg(null);
    try {
      const result = await triggerCronjob({
        context,
        namespace,
        name,
        jobName: jobName.trim() || undefined,
      });
      const created = result.match(/job\.batch\/(\S+)/)?.[1] ?? result.trim();
      setMsg({ ok: true, text: result.trim() || "Job created", jobName: created });
      setJobName("");
    } catch (e: any) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950 p-4 gap-4">
      {/* CronJob info */}
      <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded p-3 space-y-1.5">
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Schedule</span>
          <span className="font-mono text-xs text-slate-800 dark:text-slate-200">{schedule}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Last scheduled</span>
          <span className="text-xs text-slate-700 dark:text-slate-300">{lastSchedule}</span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Active jobs</span>
          <span className={`text-xs font-mono ${active > 0 ? "text-green-600 dark:text-green-400" : "text-slate-500 dark:text-slate-400"}`}>
            {active}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-slate-500">Suspend</span>
          <span className="text-xs text-slate-700 dark:text-slate-300">
            {resource.spec?.suspend ? "Yes" : "No"}
          </span>
        </div>
      </div>

      {/* Trigger form */}
      <div className="space-y-2">
        <label className="text-xs text-slate-500 dark:text-slate-400 font-semibold">Trigger job manually</label>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-slate-500">Job name (optional)</label>
          <input
            type="text"
            value={jobName}
            onChange={(e) => setJobName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && trigger()}
            placeholder={`${name}-manual-...`}
            className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-800 dark:text-slate-200 text-xs font-mono rounded px-2 py-1.5 focus:outline-none focus:border-blue-500"
          />
          <p className="text-xs text-slate-500 dark:text-slate-600">Leave empty to auto-generate a name</p>
        </div>
      </div>

      <button
        onClick={trigger}
        disabled={running}
        className="w-fit text-xs px-4 py-1.5 rounded bg-green-700 hover:bg-green-600 disabled:opacity-50 text-white flex items-center gap-2"
      >
        <Play size={12} className={running ? "animate-pulse" : ""} />
        {running ? "Triggering..." : "Trigger Job Now"}
      </button>

      {msg && (
        <div
          className={`rounded p-3 border text-xs space-y-1 ${
            msg.ok
              ? "bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-800 text-green-600 dark:text-green-400"
              : "bg-red-50 dark:bg-red-900/20 border-red-300 dark:border-red-800 text-red-600 dark:text-red-400"
          }`}
        >
          {msg.ok && msg.jobName && (
            <div className="flex items-center gap-1 font-semibold">
              <ExternalLink size={11} />
              Job created: <span className="font-mono">{msg.jobName}</span>
            </div>
          )}
          <p className="text-xs opacity-75">{msg.text}</p>
        </div>
      )}
    </div>
  );
}
