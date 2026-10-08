import { useState } from "react";
import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Activity, ArrowLeft, Brain, ClipboardList, Eye, FileClock, History, Loader2, PlayCircle, RotateCcw,
  ServerCrash, Undo2, XCircle,
} from "lucide-react";
import {
  analyzeHealingIncident, getHealingAiStatus, getHealingAudit, previewHealingAiContext, proposeHealingRollback,
} from "../../lib/tauri";
import type { Incident, IncidentStatus } from "../../types/healing";
import { ApprovalPanel } from "./ApprovalPanel";
import {
  ago, Bullets, btn, describeAction, errorText, fmtTime, HealingStatusBadge, RiskBadge, Section, SeverityLabel,
} from "./shared";

const ANALYZABLE: IncidentStatus[] = [
  "DETECTED", "PENDING_APPROVAL", "PROPOSAL_READY", "EXPIRED", "STALE", "REJECTED",
  "MANUAL_INTERVENTION_REQUIRED", "FAILED",
];

function Pre({ children }: { children: string }) {
  return (
    <pre className="p-2 rounded bg-slate-100 dark:bg-slate-950 font-mono text-[11px] whitespace-pre-wrap break-all max-h-72 overflow-auto">
      {children}
    </pre>
  );
}

function Banner({ tone, children }: { tone: "red" | "amber" | "slate"; children: ReactNode }) {
  const cls = {
    red: "border-red-300 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300",
    amber: "border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300",
    slate: "border-slate-300 bg-slate-50 text-slate-700 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-300",
  }[tone];
  return <div className={`flex gap-2 p-2 rounded border text-xs ${cls}`}>{children}</div>;
}

function EvidenceSection({ incidentId }: { incidentId: string }) {
  const [load, setLoad] = useState(false);
  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ["healing-ai-preview", incidentId],
    queryFn: () => previewHealingAiContext(incidentId),
    enabled: load,
  });
  return (
    <Section
      title="Cluster evidence (sanitized)"
      icon={<Eye size={13} className="text-sky-500" />}
      right={
        <button className={`${btn.base} ${btn.neutral} !py-1`} onClick={() => (load ? refetch() : setLoad(true))}>
          {isFetching ? <Loader2 size={12} className="animate-spin" /> : <Eye size={12} />} {load ? "Refresh" : "Load evidence"}
        </button>
      }
    >
      {!load && (
        <p className="text-slate-500">
          Read-only: loads events, logs, pod/container status, rollout history, nodes, services and config references
          for this incident. This is exactly what is sent to the AI provider when you click Analyze — secret values are
          redacted and Secret objects are never read.
        </p>
      )}
      {error && <Banner tone="red">{errorText(error)}</Banner>}
      {data && (
        <div className="space-y-3">
          <p className="text-[11px] text-slate-500">
            {data.meta.chars.toLocaleString()} chars · {data.meta.redactions} redactions · sections:{" "}
            {data.meta.sections.join(", ")}
            {data.meta.truncated && " · truncated to size limit"} · AI {data.enabled ? `enabled (${data.provider})` : "disabled — nothing is sent"}
          </p>
          {data.context.events.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Kubernetes events</div>
              <table className="w-full text-left">
                <tbody>
                  {data.context.events.map((e, i) => (
                    <tr key={i} className="border-t border-slate-200 dark:border-slate-800 align-top">
                      <td className="py-1 pr-2 whitespace-nowrap text-amber-700 dark:text-amber-300">{e.reason}</td>
                      <td className="py-1 pr-2 font-mono whitespace-nowrap">{e.object}</td>
                      <td className="py-1 pr-2">{e.message}</td>
                      <td className="py-1 font-mono text-slate-500">x{e.count ?? 1}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data.context.logs.map((l, i) => (
            <div key={i}>
              <div className="font-semibold mb-1">
                Logs {l.pod}/{l.container} {l.previous && <span className="text-orange-600 dark:text-orange-400">(previous container)</span>}
              </div>
              <Pre>{l.text}</Pre>
            </div>
          ))}
          {data.context.pods.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Pod / container status, requests & limits</div>
              <Pre>{JSON.stringify(data.context.pods.map((p) => {
                const pod = p as { metadata?: { name?: string }; spec?: { nodeName?: string; containers?: { name: string; image: string; resources?: unknown }[] }; status?: unknown };
                return {
                  name: pod.metadata?.name,
                  node: pod.spec?.nodeName,
                  containers: pod.spec?.containers?.map((c) => ({ name: c.name, image: c.image, resources: c.resources })),
                  status: pod.status,
                };
              }), null, 2)}</Pre>
            </div>
          )}
          {data.context.resource !== null && data.context.resource !== undefined && (
            <div>
              <div className="font-semibold mb-1">{data.context.resourceKind} status</div>
              <Pre>{JSON.stringify((data.context.resource as { status?: unknown }).status ?? {}, null, 2)}</Pre>
            </div>
          )}
          {data.context.rolloutHistory && (
            <div>
              <div className="font-semibold mb-1">Rollout history</div>
              <Pre>{data.context.rolloutHistory}</Pre>
            </div>
          )}
          {data.context.nodes.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Nodes</div>
              <Pre>{JSON.stringify(data.context.nodes, null, 2)}</Pre>
            </div>
          )}
          {data.context.services.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Services</div>
              <Pre>{JSON.stringify(data.context.services, null, 2)}</Pre>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="font-semibold mb-1">ConfigMap / Secret references</div>
              <Bullets items={data.context.configReferences} empty="none" />
            </div>
            <div>
              <div className="font-semibold mb-1">Metrics</div>
              {data.context.metrics ? <Pre>{data.context.metrics}</Pre> : <p className="text-slate-500">metrics unavailable</p>}
            </div>
          </div>
          {data.context.collectionNotes.length > 0 && (
            <div>
              <div className="font-semibold mb-1">Collection notes</div>
              <Bullets items={data.context.collectionNotes} />
            </div>
          )}
        </div>
      )}
    </Section>
  );
}

function AuditSection({ incidentId }: { incidentId: string }) {
  const { data } = useQuery({
    queryKey: ["healing-audit", incidentId],
    queryFn: () => getHealingAudit(incidentId),
  });
  return (
    <Section title="Audit trail" icon={<ClipboardList size={13} className="text-slate-500" />}>
      {!data?.length ? (
        <p className="text-slate-500">No audit records.</p>
      ) : (
        <table className="w-full text-left">
          <tbody>
            {data.map((r) => (
              <tr key={r.id} className="border-t border-slate-200 dark:border-slate-800 align-top">
                <td className="py-1 pr-2 whitespace-nowrap text-slate-500">{fmtTime(r.at)}</td>
                <td className="py-1 pr-2 font-mono font-semibold whitespace-nowrap">{r.event}</td>
                <td className="py-1 pr-2 whitespace-nowrap">{r.operator?.osUser ?? "system"}</td>
                <td className="py-1 pr-2 font-mono whitespace-nowrap">{r.resource}</td>
                <td className="py-1 break-all text-slate-500">
                  {r.detail}
                  {r.proposalHash && <span className="font-mono"> · {r.proposalHash.slice(0, 12)}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

export function IncidentDetail({ incident, onBack, onChanged }: {
  incident: Incident;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState<null | "analyze" | "rollback">(null);
  const [error, setError] = useState<string | null>(null);
  const { data: aiStatus } = useQuery({ queryKey: ["healing-ai-status"], queryFn: getHealingAiStatus });

  const proposal = incident.proposals.find((p) => p.id === incident.activeProposalId) ?? null;
  const diag = incident.diagnosis;
  const s = incident.status;

  async function analyze(force: boolean) {
    setBusy("analyze");
    setError(null);
    try {
      await analyzeHealingIncident(incident.id, force);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  async function rollback() {
    setBusy("rollback");
    setError(null);
    try {
      await proposeHealingRollback(incident.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      onChanged();
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3">
        <button className={`${btn.base} ${btn.neutral} !px-2`} onClick={onBack} title="All incidents">
          <ArrowLeft size={13} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 font-mono">
              {incident.resource.kind}/{incident.resource.name}
            </h2>
            <HealingStatusBadge status={s} />
            <SeverityLabel severity={incident.severity} />
            {proposal && <RiskBadge risk={proposal.risk} />}
          </div>
          <p className="text-xs text-slate-600 dark:text-slate-400 mt-0.5">{incident.problem}</p>
          <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
            context {incident.binding.context} · cluster {incident.binding.clusterName} · ns{" "}
            {incident.resource.namespace ?? "(cluster)"} · uid {incident.resource.uid ?? "-"}
          </p>
          <p className="text-[11px] text-slate-500">
            first detected {fmtTime(incident.firstDetected)} · last detected {ago(incident.lastDetected)}
            {incident.restartCount !== null && ` · restarts ${incident.restartCount}`}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          {ANALYZABLE.includes(s) && (
            <button
              className={`${btn.base} ${btn.primary}`}
              disabled={busy !== null || !aiStatus?.available}
              title={aiStatus?.message}
              onClick={() => analyze(!!diag)}
            >
              {busy === "analyze" ? <Loader2 size={12} className="animate-spin" /> : <Brain size={12} />}
              {busy === "analyze" ? "Analyzing…" : diag ? "Re-analyze" : "Analyze with AI"}
            </button>
          )}
          {s === "FAILED" && (
            <button className={`${btn.base} ${btn.warn}`} disabled={busy !== null} onClick={rollback}>
              {busy === "rollback" ? <Loader2 size={12} className="animate-spin" /> : <Undo2 size={12} />} Propose rollback
            </button>
          )}
        </div>
      </div>

      {aiStatus && !aiStatus.available && ANALYZABLE.includes(s) && (
        <Banner tone="slate">
          <Brain size={14} className="shrink-0" />
          <span>
            AI diagnosis unavailable — {aiStatus.message} You can still inspect evidence below and use the existing
            resource actions (Restart, Scale, Rollback) from the resource pages.
          </span>
        </Banner>
      )}
      {s === "FAILED" && (
        <Banner tone="red">
          <ServerCrash size={14} className="shrink-0" />
          <span>
            <b>Healing failed.</b> {incident.lastError} — Review the execution and verification below. Nothing is rolled
            back automatically; "Propose rollback" creates a new proposal that needs its own approval.
          </span>
        </Banner>
      )}
      {(s === "STALE" || s === "EXPIRED") && (
        <Banner tone="amber">
          <RotateCcw size={14} className="shrink-0" />
          <span>{incident.lastError ?? "The proposal expired."} Re-analyze to get a fresh proposal and approve again.</span>
        </Banner>
      )}
      {s === "MANUAL_INTERVENTION_REQUIRED" && incident.lastError && (
        <Banner tone="amber">
          <XCircle size={14} className="shrink-0" />
          <span><b>Manual intervention required.</b> {incident.lastError}</span>
        </Banner>
      )}
      {(s === "EXECUTING" || s === "VERIFYING") && (
        <Banner tone="slate">
          <Loader2 size={14} className="shrink-0 animate-spin" />
          <span>{s === "EXECUTING" ? "Executing approved action…" : "Verifying the workload becomes healthy (read-only checks)…"}</span>
        </Banner>
      )}
      {incident.diagnosisError && <Banner tone="red"><Brain size={14} className="shrink-0" />{incident.diagnosisError}</Banner>}
      {incident.gitopsOwner && !proposal && (
        <Banner tone="amber">
          This resource appears to be GitOps-managed ({incident.gitopsOwner}). Direct Kubernetes changes may be reverted
          by the GitOps controller.
        </Banner>
      )}
      {error && <Banner tone="red"><XCircle size={14} className="shrink-0" />{error}</Banner>}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Section title="Detected symptoms" icon={<Activity size={13} className="text-amber-500" />}>
          <table className="w-full text-left">
            <tbody>
              {incident.symptoms.map((sym, i) => (
                <tr key={i} className="border-t first:border-t-0 border-slate-200 dark:border-slate-800 align-top">
                  <td className="py-1 pr-2 font-semibold whitespace-nowrap">{sym.code}</td>
                  <td className="py-1 pr-2 font-mono whitespace-nowrap">{sym.resource.kind}/{sym.resource.name}</td>
                  <td className="py-1">{sym.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="Affected resources" icon={<Activity size={13} className="text-slate-500" />}>
          <Bullets
            items={[
              `${incident.resource.kind}/${incident.resource.name} (root)`,
              ...incident.affected.map((a) => `${a.kind}/${a.name}`),
            ]}
          />
        </Section>
      </div>

      {diag && (
        <Section
          title="AI diagnosis"
          icon={<Brain size={13} className="text-indigo-500" />}
          right={
            <span className="text-[10px] text-slate-500">
              {diag.provider}{diag.model ? ` · ${diag.model}` : ""} · {ago(diag.at)} · confidence{" "}
              {Math.round(diag.result.confidence * 100)}%
            </span>
          }
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="space-y-2">
              <p className="whitespace-pre-wrap">{diag.result.summary}</p>
              <p><b>Probable root cause:</b> {diag.result.probable_root_cause}</p>
              <p><b>Uncertainty:</b> {diag.result.uncertainty}</p>
            </div>
            <div className="space-y-2">
              <div><b>Evidence</b><Bullets items={diag.result.evidence} /></div>
              <div><b>Contributing factors</b><Bullets items={diag.result.contributing_factors} /></div>
              <div><b>Limitations</b><Bullets items={diag.result.limitations} /></div>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            Sent {diag.context.chars.toLocaleString()} chars ({diag.context.sections.join(", ")}), {diag.context.redactions}{" "}
            values redacted. AI output is untrusted: only typed, allow-listed actions can become proposals.
          </p>
        </Section>
      )}

      {proposal && <ApprovalPanel incident={incident} proposal={proposal} onChanged={onChanged} />}

      <EvidenceSection incidentId={incident.id} />

      {incident.executions.length > 0 && (
        <Section title="Execution history" icon={<PlayCircle size={13} className="text-blue-500" />}>
          <div className="space-y-2">
            {incident.executions.map((e) => (
              <div key={e.id} className="border-t first:border-t-0 border-slate-200 dark:border-slate-800 pt-2 first:pt-0">
                <p>
                  <b className={e.success ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                    {e.success ? "Applied" : "Failed"}
                  </b>{" "}
                  {describeAction(e.action)} · by {e.operator.osUser} · {fmtTime(e.startedAt)}
                </p>
                <Pre>{`$ ${e.command.join(" ")}\n${e.output || e.error || ""}`}</Pre>
                <p className="text-[11px] text-slate-500 font-mono">
                  before: replicas={e.preState?.replicas ?? "-"} revision={e.preState?.revision ?? "-"} ready={e.preState?.ready ?? "-"}
                  {"  "}after: replicas={e.postState?.replicas ?? "-"} revision={e.postState?.revision ?? "-"} ready={e.postState?.ready ?? "-"}
                </p>
              </div>
            ))}
          </div>
        </Section>
      )}

      {incident.verifications.length > 0 && (
        <Section title="Verification" icon={<FileClock size={13} className="text-cyan-500" />}>
          {incident.verifications.map((v, i) => (
            <div key={i} className="mb-2">
              <p>
                <b className={v.outcome === "HEALTHY" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>
                  {v.outcome}
                </b>{" "}
                · {fmtTime(v.startedAt)} → {fmtTime(v.finishedAt)}
              </p>
              <Pre>{v.checks.join("\n")}</Pre>
            </div>
          ))}
        </Section>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Section title="Timeline" icon={<History size={13} className="text-slate-500" />}>
          <table className="w-full text-left">
            <tbody>
              {[...incident.history].reverse().map((h, i) => (
                <tr key={i} className="border-t first:border-t-0 border-slate-200 dark:border-slate-800 align-top">
                  <td className="py-1 pr-2 whitespace-nowrap text-slate-500">{fmtTime(h.at)}</td>
                  <td className="py-1 pr-2 whitespace-nowrap"><HealingStatusBadge status={h.to} /></td>
                  <td className="py-1">{h.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
        <Section title="Approval history" icon={<ClipboardList size={13} className="text-slate-500" />}>
          {incident.approvals.length === 0 && incident.rejections.length === 0 ? (
            <p className="text-slate-500">No approvals or rejections yet.</p>
          ) : (
            <Bullets
              items={[
                ...incident.approvals.map(
                  (a) => `${fmtTime(a.approvedAt)} APPROVED by ${a.operator.osUser}${a.operator.kubernetesUser ? ` (${a.operator.kubernetesUser})` : ""} · proposal ${a.proposalId.slice(0, 8)} · hash ${a.proposalHash.slice(0, 12)}${a.highRiskConfirmed ? " · high-risk confirmed" : ""}`,
                ),
                ...incident.rejections.map(
                  (r) => `${fmtTime(r.rejectedAt)} REJECTED by ${r.operator.osUser} · proposal ${r.proposalId.slice(0, 8)}${r.reason ? ` · ${r.reason}` : ""}`,
                ),
              ]}
            />
          )}
          {incident.proposals.length > 1 && (
            <p className="mt-2 text-[11px] text-slate-500">
              {incident.proposals.length} proposals generated; only the latest can be approved.
            </p>
          )}
        </Section>
      </div>

      <AuditSection incidentId={incident.id} />
    </div>
  );
}
