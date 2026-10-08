import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Brain, HeartPulse, Loader2, Radar } from "lucide-react";
import { useAppStore } from "../../store/app";
import { analyzeHealingIncident, getHealingIncidents, scanHealingIncidents } from "../../lib/tauri";
import { CLOSED_STATUSES, type Incident } from "../../types/healing";
import { errorText, HealingStatusBadge } from "./shared";

/** Incidents for the active context, shared by every screen that links to them. */
export function useHealingIncidents() {
  const activeContext = useAppStore((s) => s.activeContext);
  return useQuery({
    queryKey: ["healing-incidents", activeContext],
    queryFn: () => getHealingIncidents(activeContext),
    enabled: !!activeContext,
    staleTime: 10_000,
    refetchInterval: 15_000,
  });
}

/** Most relevant open incident touching a resource (root, affected or symptom). */
export function findIncident(
  incidents: Incident[] | undefined,
  kind: string,
  namespace: string | null | undefined,
  name: string,
): Incident | undefined {
  if (!incidents || !name) return undefined;
  const ns = namespace || null;
  const matches = (r: { kind: string; namespace: string | null; name: string }) =>
    r.kind.toLowerCase() === kind.toLowerCase() && r.name === name && (r.namespace ?? null) === ns;
  const hits = incidents.filter(
    (i) => matches(i.resource) || i.affected.some(matches) || i.symptoms.some((s) => matches(s.resource)),
  );
  return hits.find((i) => !CLOSED_STATUSES.includes(i.status)) ?? hits[0];
}

export function useOpenIncident() {
  const setFocusedIncidentId = useAppStore((s) => s.setFocusedIncidentId);
  const requestPage = useAppStore((s) => s.requestPage);
  return useCallback(
    (id: string) => {
      setFocusedIncidentId(id);
      requestPage("selfHealing");
    },
    [setFocusedIncidentId, requestPage],
  );
}

/**
 * "View Healing Incident" / "Review Healing Proposal" link. Renders nothing
 * when the resource has no incident. Navigation only — never acts on the cluster.
 */
export function HealingIncidentLink({
  kind,
  namespace,
  name,
  showStatus = true,
}: {
  kind: string;
  namespace?: string | null;
  name: string;
  showStatus?: boolean;
}) {
  const { data } = useHealingIncidents();
  const open = useOpenIncident();
  const inc = findIncident(data, kind, namespace, name);
  if (!inc) return null;
  const label = inc.status === "PENDING_APPROVAL" ? "Review Healing Proposal" : "View Healing Incident";
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        open(inc.id);
      }}
      title={`${inc.resource.kind}/${inc.resource.name}: ${inc.problem}`}
      className="inline-flex items-center gap-1 shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-300 dark:hover:bg-rose-500/20"
    >
      <HeartPulse size={10} />
      {label}
      {showStatus && <HealingStatusBadge status={inc.status} />}
    </button>
  );
}

const linkBtn =
  "inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-50";

/**
 * Problem Pods integration: incident / AI diagnosis / proposal status with
 * Analyze, View Incident and Review Proposal. Analyze only produces a
 * proposal; approval happens on the Self-Healing page.
 */
export function ProblemPodHealingCell({ namespace, pod }: { namespace: string; pod: string }) {
  const activeContext = useAppStore((s) => s.activeContext);
  const { data, refetch } = useHealingIncidents();
  const open = useOpenIncident();
  const [busy, setBusy] = useState<null | "scan" | "analyze">(null);
  const [error, setError] = useState<string | null>(null);
  const inc = findIncident(data, "Pod", namespace, pod);

  async function run(kind: "scan" | "analyze", fn: () => Promise<unknown>) {
    setBusy(kind);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      refetch();
    }
  }

  if (!inc) {
    return (
      <button className={linkBtn} disabled={busy !== null} title={error ?? "Run Self-Healing detection"}
        onClick={() => run("scan", () => scanHealingIncidents(activeContext))}>
        {busy ? <Loader2 size={10} className="animate-spin" /> : <Radar size={10} />} Not tracked · Scan
      </button>
    );
  }

  const proposal = inc.proposals.find((p) => p.id === inc.activeProposalId);
  const ai = inc.diagnosis
    ? `AI ${Math.round(inc.diagnosis.result.confidence * 100)}%`
    : inc.diagnosisError
      ? "AI unavailable"
      : "Not analyzed";
  const canAnalyze = !inc.diagnosis && ["DETECTED", "EXPIRED", "STALE", "REJECTED", "FAILED"].includes(inc.status);

  return (
    <div className="flex flex-col gap-1 items-start">
      <div className="flex items-center gap-1.5">
        <HealingStatusBadge status={inc.status} />
        <span className="text-[10px] text-slate-500">{ai}</span>
        {proposal && <span className="text-[10px] text-slate-500">· proposal {proposal.risk.toLowerCase()} risk</span>}
      </div>
      <div className="flex gap-1">
        {canAnalyze && (
          <button className={linkBtn} disabled={busy !== null} title={error ?? "AI diagnosis (no changes are made)"}
            onClick={() => run("analyze", async () => {
              await analyzeHealingIncident(inc.id);
              open(inc.id);
            })}>
            {busy === "analyze" ? <Loader2 size={10} className="animate-spin" /> : <Brain size={10} />} Analyze
          </button>
        )}
        {inc.status === "PENDING_APPROVAL" ? (
          <button className={linkBtn} onClick={() => open(inc.id)}>Review Proposal</button>
        ) : (
          <button className={linkBtn} onClick={() => open(inc.id)}>View Incident</button>
        )}
      </div>
      {error && <span className="text-[10px] text-red-600 dark:text-red-400 max-w-[220px]">{error}</span>}
    </div>
  );
}
