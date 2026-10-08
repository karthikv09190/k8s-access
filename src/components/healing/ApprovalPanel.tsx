import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, GitBranch, Loader2, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { useAppStore } from "../../store/app";
import { approveHealing, executeApprovedHealing, getHealingCommandPreview, rejectHealing } from "../../lib/tauri";
import type { DryRunResult, HealingProposal, Incident, StateSnapshot } from "../../types/healing";
import { actionTarget, Bullets, btn, describeAction, errorText, fmtTime, RiskBadge, Section, until } from "./shared";

function StateCompare({ current, proposed }: { current: StateSnapshot; proposed: StateSnapshot }) {
  const rows: [string, string, string][] = [
    ["Replicas", String(current.replicas ?? "-"), String(proposed.replicas ?? "-")],
    ["Revision", String(current.revision ?? "-"), String(proposed.revision ?? "-")],
    ["Ready", current.ready ?? "-", proposed.ready ?? "-"],
    ["Images", current.images.join(", ") || "-", proposed.images.join(", ") || "-"],
  ];
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="text-[10px] uppercase tracking-wide text-slate-500">
          <th className="py-1 pr-2 w-24"></th>
          <th className="py-1 pr-2">Current state</th>
          <th className="py-1">Proposed state</th>
        </tr>
      </thead>
      <tbody className="font-mono">
        {rows.map(([k, a, b]) => (
          <tr key={k} className="border-t border-slate-200 dark:border-slate-800">
            <td className="py-1 pr-2 font-sans text-slate-500">{k}</td>
            <td className="py-1 pr-2 break-all">{a}</td>
            <td className={`py-1 break-all ${a !== b ? "text-blue-700 dark:text-blue-300 font-semibold" : ""}`}>{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function PatchDiff({ dryRun }: { dryRun: DryRunResult }) {
  return (
    <div className="space-y-1">
      <p className={dryRun.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
        {dryRun.ok
          ? "Server dry-run accepted the patch (validated by the API server and admission webhooks; nothing was saved)."
          : `Server dry-run rejected the patch: ${dryRun.error}`}
      </p>
      {dryRun.changes.map((c) => (
        <div key={c.path} className="rounded border border-slate-200 dark:border-slate-800 overflow-hidden">
          <div className="px-2 py-1 bg-slate-100 dark:bg-slate-900 font-mono text-[11px] font-semibold">{c.path}</div>
          <pre className="px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all bg-red-50 text-red-800 dark:bg-red-500/10 dark:text-red-300">- {c.before}</pre>
          <pre className="px-2 py-1 font-mono text-[11px] whitespace-pre-wrap break-all bg-emerald-50 text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">+ {c.after}</pre>
        </div>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}

export function ApprovalPanel({ incident, proposal, onChanged }: {
  incident: Incident;
  proposal: HealingProposal;
  onChanged: () => void;
}) {
  const activeContext = useAppStore((s) => s.activeContext);
  const [confirming, setConfirming] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<null | "approve" | "execute" | "reject">(null);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const { data: command } = useQuery({
    queryKey: ["healing-command", incident.id, proposal.id],
    queryFn: () => getHealingCommandPreview(incident.id, proposal.id),
  });

  const status = incident.status;
  const expired = Date.now() > proposal.expiresAt;
  const highRisk = proposal.risk === "HIGH" || proposal.risk === "CRITICAL";
  const blocked = proposal.blockedReason !== null || proposal.risk === "CRITICAL";
  const wrongCluster = activeContext !== proposal.binding.context;
  const approval = incident.approvals.filter((a) => a.proposalId === proposal.id).reverse()[0];
  const target = actionTarget(proposal.action);

  // The backend re-verifies everything; `context` is the cluster the operator
  // is looking at, so approving while viewing another cluster is refused.
  async function approveAndExecute() {
    setBusy("approve");
    setError(null);
    try {
      await approveHealing({
        incidentId: incident.id,
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        context: activeContext,
        highRiskConfirmed: highRisk,
      });
      setBusy("execute");
      await executeApprovedHealing({
        incidentId: incident.id,
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        context: activeContext,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      setConfirming(false);
      onChanged();
    }
  }

  async function executeOnly() {
    setBusy("execute");
    setError(null);
    try {
      await executeApprovedHealing({
        incidentId: incident.id,
        proposalId: proposal.id,
        proposalHash: proposal.hash,
        context: activeContext,
      });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function reject() {
    setBusy("reject");
    setError(null);
    try {
      await rejectHealing({ incidentId: incident.id, proposalId: proposal.id, reason: reason.trim() || null });
      setRejecting(false);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <Section
      title={proposal.kind === "ROLLBACK" ? "Rollback proposal" : "Recommended healing"}
      icon={<ShieldCheck size={13} className="text-violet-500" />}
      right={
        <div className="flex items-center gap-2">
          <RiskBadge risk={proposal.risk} />
          {status === "PENDING_APPROVAL" && (
            <span className={`text-[10px] font-mono ${expired ? "text-red-500" : "text-slate-500"}`}>
              {expired ? "expired" : `expires in ${until(proposal.expiresAt)}`}
            </span>
          )}
        </div>
      }
    >
      <div className="space-y-3">
        {blocked && (
          <div className="flex gap-2 p-2 rounded border border-rose-300 bg-rose-50 text-rose-800 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300">
            <ShieldAlert size={14} className="shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold">Manual intervention required.</div>
              <div>{proposal.blockedReason ?? "CRITICAL actions are never executed by self-healing."}</div>
            </div>
          </div>
        )}
        {proposal.gitopsOwner && (
          <div className="flex gap-2 p-2 rounded border border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <GitBranch size={14} className="shrink-0 mt-0.5" />
            <div>
              This resource appears to be GitOps-managed ({proposal.gitopsOwner}). Direct Kubernetes changes may be
              reverted by the GitOps controller — prefer fixing it in Git.
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Field label="What will change">
            <p className="font-medium">{describeAction(proposal.action)}</p>
            {command && (
              <pre className="mt-1 p-2 rounded bg-slate-100 dark:bg-slate-950 font-mono text-[11px] whitespace-pre-wrap break-all">
                {command.join(" ")}
              </pre>
            )}
          </Field>
          <Field label="Exact resource(s) affected">
            <div className="font-mono space-y-0.5">
              <div>{target}</div>
              <div className="text-slate-500">namespace: {proposal.action.namespace}</div>
              <div className="text-slate-500">context: {proposal.binding.context}</div>
              <div className="text-slate-500 break-all">server: {proposal.binding.server}</div>
              <div className="text-slate-500">uid: {proposal.baseline.uid || "-"}</div>
              <div className="text-slate-500">
                verify: {proposal.verificationTarget.kind}/{proposal.verificationTarget.name}
              </div>
            </div>
          </Field>
          <Field label="Why it will change">
            <p className="whitespace-pre-wrap">{proposal.rationale}</p>
          </Field>
          <Field label="Current vs proposed state">
            <StateCompare current={proposal.currentState} proposed={proposal.proposedState} />
          </Field>
          {proposal.dryRun && (
            <div className="lg:col-span-2">
              <Field label="Exact field changes (before → after)">
                <PatchDiff dryRun={proposal.dryRun} />
              </Field>
            </div>
          )}
          <Field label="Expected impact">
            <p>{proposal.expectedImpact}</p>
          </Field>
          <Field label="AI confidence (informational only — never permission)">
            <p>
              {proposal.confidence !== null ? `${Math.round(proposal.confidence * 100)}%` : "n/a"}
              <span className="text-slate-500">
                {" "}· source: {proposal.source.type === "ai"
                  ? `${proposal.source.provider}${proposal.source.model ? ` (${proposal.source.model})` : ""}`
                  : `rollback of execution ${proposal.source.execution_id.slice(0, 8)}`}
              </span>
            </p>
          </Field>
          <Field label="Evidence">
            <Bullets items={proposal.evidence} />
          </Field>
          <Field label="Verification plan">
            <Bullets items={proposal.verificationSteps} />
          </Field>
          <Field label="Rollback plan">
            <p>{proposal.rollbackPlan || "—"}</p>
          </Field>
          <Field label="Proposal integrity">
            <p className="font-mono text-[11px] break-all text-slate-500">
              sha256 {proposal.hash}
              <br />
              created {fmtTime(proposal.createdAt)}
            </p>
          </Field>
        </div>

        {approval && (
          <p className="text-[11px] text-slate-500">
            Approved by {approval.operator.osUser}
            {approval.operator.kubernetesUser ? ` (${approval.operator.kubernetesUser})` : ""} at{" "}
            {fmtTime(approval.approvedAt)} — local operator, not an authenticated identity.
          </p>
        )}

        {wrongCluster && !blocked && (status === "PENDING_APPROVAL" || status === "APPROVED") && (
          <div className="flex gap-2 p-2 rounded border border-orange-300 bg-orange-50 text-orange-800 dark:border-orange-500/30 dark:bg-orange-500/10 dark:text-orange-300">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              This proposal is bound to context <b>{proposal.binding.context}</b> but you are viewing{" "}
              <b>{activeContext || "no context"}</b>. Switch to {proposal.binding.context} to approve or execute.
            </span>
          </div>
        )}

        {error && (
          <div className="flex gap-2 p-2 rounded border border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <XCircle size={14} className="shrink-0 mt-0.5" />
            {error}
          </div>
        )}

        {status === "PENDING_APPROVAL" && !blocked && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {rejecting ? (
              <>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Reason (optional)"
                  className="flex-1 min-w-[200px] text-xs px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800"
                />
                <button className={`${btn.base} ${btn.neutral}`} onClick={() => setRejecting(false)}>Cancel</button>
                <button className={`${btn.base} ${btn.danger}`} disabled={busy !== null} onClick={reject}>
                  {busy === "reject" && <Loader2 size={12} className="animate-spin" />} Confirm reject
                </button>
              </>
            ) : (
              <>
                <button className={`${btn.base} ${btn.neutral}`} disabled={busy !== null} onClick={() => setRejecting(true)}>
                  <XCircle size={12} /> REJECT
                </button>
                <button
                  className={`${btn.base} ${btn.approve}`}
                  disabled={busy !== null || expired || wrongCluster}
                  onClick={() => (highRisk ? setConfirming(true) : approveAndExecute())}
                >
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <CheckCircle2 size={12} />}
                  {busy === "execute" ? "EXECUTING…" : busy === "approve" ? "APPROVING…" : "APPROVE HEALING"}
                </button>
              </>
            )}
          </div>
        )}

        {status === "APPROVED" && !blocked && (
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] text-slate-500">Approved but not yet executed.</span>
            <button className={`${btn.base} ${btn.primary}`} disabled={busy !== null || expired || wrongCluster} onClick={executeOnly}>
              {busy === "execute" && <Loader2 size={12} className="animate-spin" />} Execute approved healing
            </button>
          </div>
        )}
      </div>

      {confirming && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-[520px] max-w-[92vw] rounded-lg border border-orange-400/50 bg-white dark:bg-slate-900 shadow-xl p-4 space-y-3 text-xs text-slate-700 dark:text-slate-300">
            <div className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-300">
              <AlertTriangle size={15} /> Approve remediation for {target}?
            </div>
            <p>
              This is a <b>{proposal.risk}</b> risk action on context <b>{proposal.binding.context}</b>, namespace{" "}
              <b>{proposal.action.namespace}</b>.
            </p>
            <pre className="p-2 rounded bg-slate-100 dark:bg-slate-950 font-mono text-[11px] whitespace-pre-wrap break-all">
              {command?.join(" ") ?? describeAction(proposal.action)}
            </pre>
            {proposal.dryRun ? (
              <div className="max-h-64 overflow-auto"><PatchDiff dryRun={proposal.dryRun} /></div>
            ) : (
              <StateCompare current={proposal.currentState} proposed={proposal.proposedState} />
            )}
            <div className="flex justify-end gap-2 pt-1">
              <button className={`${btn.base} ${btn.neutral}`} disabled={busy !== null} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className={`${btn.base} ${btn.warn}`} disabled={busy !== null} onClick={approveAndExecute}>
                {busy && <Loader2 size={12} className="animate-spin" />} Approve Healing
              </button>
            </div>
          </div>
        </div>
      )}
    </Section>
  );
}
