import type { ReactNode } from "react";
import type { HealingAction, IncidentStatus, RiskLevel, Severity } from "../../types/healing";

const STATUS_STYLE: Record<IncidentStatus, string> = {
  DETECTED: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  ANALYZING: "bg-sky-100 text-sky-800 border-sky-300 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30",
  PROPOSAL_READY: "bg-indigo-100 text-indigo-800 border-indigo-300 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30",
  PENDING_APPROVAL: "bg-violet-100 text-violet-800 border-violet-300 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30",
  APPROVED: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30",
  EXECUTING: "bg-blue-100 text-blue-800 border-blue-300 dark:bg-blue-500/15 dark:text-blue-300 dark:border-blue-500/30",
  VERIFYING: "bg-cyan-100 text-cyan-800 border-cyan-300 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/30",
  HEALED: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30",
  ROLLED_BACK: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30",
  FAILED: "bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30",
  REJECTED: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30",
  EXPIRED: "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-500/15 dark:text-slate-300 dark:border-slate-500/30",
  STALE: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30",
  ROLLBACK_PROPOSED: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30",
  RESOLVED: "bg-slate-100 text-slate-600 border-slate-300 dark:bg-slate-500/10 dark:text-slate-400 dark:border-slate-600/40",
  MANUAL_INTERVENTION_REQUIRED: "bg-rose-100 text-rose-800 border-rose-300 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30",
};

const RISK_STYLE: Record<RiskLevel, string> = {
  LOW: "bg-emerald-100 text-emerald-800 border-emerald-300 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30",
  MEDIUM: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30",
  HIGH: "bg-orange-100 text-orange-800 border-orange-300 dark:bg-orange-500/15 dark:text-orange-300 dark:border-orange-500/30",
  CRITICAL: "bg-red-100 text-red-800 border-red-300 dark:bg-red-500/15 dark:text-red-300 dark:border-red-500/30",
};

const SEVERITY_STYLE: Record<Severity, string> = {
  INFO: "text-slate-500",
  WARNING: "text-amber-600 dark:text-amber-400",
  CRITICAL: "text-red-600 dark:text-red-400",
};

const pill = "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold border whitespace-nowrap";

export function HealingStatusBadge({ status }: { status: IncidentStatus }) {
  return <span className={`${pill} ${STATUS_STYLE[status]}`}>{status.replace(/_/g, " ")}</span>;
}

export function RiskBadge({ risk }: { risk: RiskLevel }) {
  return <span className={`${pill} ${RISK_STYLE[risk]}`}>{risk} RISK</span>;
}

export function SeverityLabel({ severity }: { severity: Severity }) {
  return <span className={`text-[11px] font-semibold ${SEVERITY_STYLE[severity]}`}>{severity}</span>;
}

export function fmtTime(ms: number | null | undefined): string {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return "-";
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 0) return "in " + until(ms);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function until(ms: number): string {
  const s = Math.max(0, Math.floor((ms - Date.now()) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function actionTarget(a: HealingAction): string {
  switch (a.type) {
    case "RESTART_POD":
      return `Pod/${a.pod}`;
    case "ROLLOUT_RESTART":
      return `${a.kind}/${a.name}`;
    case "ROLLBACK_DEPLOYMENT":
    case "SCALE_DEPLOYMENT":
      return `Deployment/${a.name}`;
    case "SCALE_STATEFULSET":
      return `StatefulSet/${a.name}`;
    case "PATCH_WORKLOAD":
      return `${a.kind}/${a.name}`;
  }
}

function patchSummary(c: import("../../types/healing").WorkloadPatch): string {
  const parts: string[] = [];
  const probe = (n: string, p?: Record<string, number | undefined>) => {
    if (!p) return;
    const kv = Object.entries(p).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v}`);
    parts.push(`${n} (${kv.join(", ")})`);
  };
  probe("livenessProbe", c.liveness_probe as Record<string, number | undefined> | undefined);
  probe("readinessProbe", c.readiness_probe as Record<string, number | undefined> | undefined);
  probe("startupProbe", c.startup_probe as Record<string, number | undefined> | undefined);
  if (c.resources) {
    const r = Object.entries(c.resources).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`);
    parts.push(`resources (${r.join(", ")})`);
  }
  if (c.termination_grace_period_seconds != null) parts.push(`terminationGracePeriodSeconds=${c.termination_grace_period_seconds}`);
  if (c.pre_stop_sleep_seconds != null) parts.push(`preStop sleep=${c.pre_stop_sleep_seconds}s`);
  if (c.image_tag) parts.push(`image tag=${c.image_tag}`);
  return parts.join("; ");
}

export function describeAction(a: HealingAction): string {
  switch (a.type) {
    case "RESTART_POD":
      return `Delete pod ${a.namespace}/${a.pod} so its controller recreates it`;
    case "ROLLOUT_RESTART":
      return `Rollout restart ${a.kind}/${a.name} in ${a.namespace}`;
    case "ROLLBACK_DEPLOYMENT":
      return `Roll back Deployment/${a.name} in ${a.namespace} to revision ${a.to_revision}`;
    case "SCALE_DEPLOYMENT":
      return `Scale Deployment/${a.name} in ${a.namespace} to ${a.replicas} replicas`;
    case "SCALE_STATEFULSET":
      return `Scale StatefulSet/${a.name} in ${a.namespace} to ${a.replicas} replicas`;
    case "PATCH_WORKLOAD":
      return `Patch ${a.kind}/${a.name} in ${a.namespace}, container ${a.container}: ${patchSummary(a.changes)}`;
  }
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return JSON.stringify(e);
}

export function Section({
  title,
  icon,
  right,
  children,
}: {
  title: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
        {icon}
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{title}</h3>
        <div className="ml-auto">{right}</div>
      </header>
      <div className="p-3 text-xs text-slate-700 dark:text-slate-300">{children}</div>
    </section>
  );
}

export function Bullets({ items, empty = "—" }: { items: string[]; empty?: string }) {
  if (!items.length) return <p className="text-slate-500">{empty}</p>;
  return (
    <ul className="list-disc pl-4 space-y-0.5">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}

export const btn = {
  base: "inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
  neutral: "bg-slate-200 hover:bg-slate-300 text-slate-700 dark:bg-slate-700 dark:hover:bg-slate-600 dark:text-slate-200",
  primary: "bg-blue-600 hover:bg-blue-500 text-white",
  approve: "bg-emerald-600 hover:bg-emerald-500 text-white",
  danger: "bg-red-600 hover:bg-red-500 text-white",
  warn: "bg-orange-600 hover:bg-orange-500 text-white",
};
