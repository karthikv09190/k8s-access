import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Brain, ChevronDown, ChevronRight, Loader2, ShieldCheck, Square, XCircle } from "lucide-react";
import { analyzeAllHealingIncidents, cancelHealingBatch, getHealingBatchStatus } from "../../lib/tauri";
import type { AiStatus, BatchStatus, Incident } from "../../types/healing";
import { ApprovalPanel } from "./ApprovalPanel";
import { actionTarget, btn, describeAction, errorText, RiskBadge, until } from "./shared";

/** Background "Analyze all open" control + progress. Diagnosis only. */
export function BatchAnalyze({ context, candidates, aiStatus }: {
  context: string;
  candidates: number;
  aiStatus: AiStatus | undefined;
}) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [skip, setSkip] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { data: status } = useQuery({
    queryKey: ["healing-batch"],
    queryFn: getHealingBatchStatus,
    refetchInterval: (q) => ((q.state.data as BatchStatus | undefined)?.running ? 2_000 : false),
  });

  useEffect(() => {
    const un = listen<BatchStatus>("healing-batch-progress", (e) => qc.setQueryData(["healing-batch"], e.payload));
    return () => {
      un.then((f) => f());
    };
  }, [qc]);

  async function start() {
    setError(null);
    try {
      const s = await analyzeAllHealingIncidents(context, skip);
      qc.setQueryData(["healing-batch"], s);
      setConfirm(false);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const running = status?.running;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {running ? (
        <>
          <Loader2 size={12} className="animate-spin text-blue-500" />
          <span className="text-[11px] text-slate-600 dark:text-slate-300">
            Analyzing {status!.done}/{status!.total}
            {status!.current ? ` · ${status!.current}` : ""} · {status!.proposals} proposals · {status!.manual} manual · {status!.failed} failed
          </span>
          <div className="w-32 h-1.5 rounded bg-slate-200 dark:bg-slate-800 overflow-hidden">
            <div className="h-full bg-blue-500" style={{ width: `${status!.total ? (100 * status!.done) / status!.total : 0}%` }} />
          </div>
          <button className={`${btn.base} ${btn.neutral} !py-1`} onClick={() => cancelHealingBatch()}>
            <Square size={11} /> Stop
          </button>
        </>
      ) : (
        <>
          {status && status.total > 0 && status.context === context && (
            <span className="text-[11px] text-slate-500">
              Last batch: {status.done}/{status.total} analyzed · {status.proposals} proposals · {status.manual} manual · {status.failed} failed
              {status.stoppedReason ? ` · ${status.stoppedReason}` : ""}
            </span>
          )}
          <button
            className={`${btn.base} ${btn.primary} !py-1`}
            disabled={!aiStatus?.available || candidates === 0}
            title={!aiStatus?.available ? aiStatus?.message : "AI diagnosis for every open incident not yet analyzed"}
            onClick={() => setConfirm(true)}
          >
            <Brain size={12} /> Analyze all open ({candidates})
          </button>
        </>
      )}
      {error && <span className="text-[11px] text-red-600 dark:text-red-400">{error}</span>}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[480px] max-w-[92vw] rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl p-4 space-y-3 text-xs text-slate-700 dark:text-slate-300">
            <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">Analyze all open incidents on {context}?</div>
            <ul className="list-disc pl-4 space-y-1">
              <li>Runs AI diagnosis one incident at a time in the background (redacted context is sent to Claude).</li>
              <li>Each incident is one AI call against your Claude plan; the batch stops automatically if a usage limit is hit.</li>
              <li><b>Nothing is executed.</b> Results appear in the Pending approval queue for you to approve one by one.</li>
            </ul>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
              Skip kinds that can never be auto-healed (Node, Job, HelmRelease, ReplicaSet) — saves AI calls
            </label>
            <div className="flex justify-end gap-2">
              <button className={`${btn.base} ${btn.neutral}`} onClick={() => setConfirm(false)}>Cancel</button>
              <button className={`${btn.base} ${btn.primary}`} onClick={start}><Brain size={12} /> Start analysis</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** Pending-approval queue: one row per proposal; approve/reject one at a time. */
export function PendingQueue({ incidents, onChanged, onOpen }: {
  incidents: Incident[];
  onChanged: () => void;
  onOpen: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const pending = incidents
    .filter((i) => (i.status === "PENDING_APPROVAL" || i.status === "APPROVED") && i.activeProposalId)
    .map((i) => ({ inc: i, p: i.proposals.find((x) => x.id === i.activeProposalId)! }))
    .filter((x) => x.p)
    .sort((a, b) => a.p.expiresAt - b.p.expiresAt);

  if (pending.length === 0) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 px-4 py-8 text-center text-xs text-slate-500">
        No recommendations are waiting for approval. Analyze incidents (one by one or "Analyze all open") — any fix the
        AI can safely propose will appear here.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
        <ShieldCheck size={12} className="text-emerald-500" />
        {pending.length} recommendation{pending.length > 1 ? "s" : ""} waiting. Each needs its own explicit approval; expand a row to review
        the exact change.
      </p>
      {pending.map(({ inc, p }) => {
        const open = expanded === p.id;
        const expired = Date.now() > p.expiresAt;
        return (
          <div key={p.id} className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
            <button
              className="w-full flex items-center gap-3 px-3 py-2 text-left text-xs hover:bg-slate-50 dark:hover:bg-slate-800/40"
              onClick={() => setExpanded(open ? null : p.id)}
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-mono font-semibold text-slate-800 dark:text-slate-200">{actionTarget(p.action)}</span>
                  <span className="text-slate-500 font-mono">{p.action.namespace} · {p.binding.context}</span>
                  <RiskBadge risk={p.risk} />
                  {inc.status === "APPROVED" && <span className="text-[10px] text-blue-600 dark:text-blue-400">approved · not executed</span>}
                  {p.dryRun && !p.dryRun.ok && (
                    <span className="inline-flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400"><XCircle size={10} /> dry-run rejected</span>
                  )}
                  {p.gitopsOwner && <span className="text-[10px] text-amber-600 dark:text-amber-400">GitOps-managed</span>}
                </div>
                <div className="text-slate-600 dark:text-slate-400 truncate" title={describeAction(p.action)}>{describeAction(p.action)}</div>
                <div className="text-[10px] text-slate-500 truncate">Problem: {inc.problem}</div>
              </div>
              <div className="text-right shrink-0">
                <div className="font-mono text-slate-700 dark:text-slate-300">{p.confidence !== null ? `${Math.round(p.confidence * 100)}%` : "-"}</div>
                <div className={`text-[10px] font-mono ${expired ? "text-red-500" : "text-slate-500"}`}>
                  {expired ? "expired" : `expires ${until(p.expiresAt)}`}
                </div>
              </div>
            </button>
            {open && (
              <div className="border-t border-slate-200 dark:border-slate-800 p-2 space-y-2">
                <ApprovalPanel incident={inc} proposal={p} onChanged={onChanged} />
                <button className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline" onClick={() => onOpen(inc.id)}>
                  Open full incident (evidence, chat, audit) →
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
