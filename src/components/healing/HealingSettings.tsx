import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Settings, X } from "lucide-react";
import { getHealingAiStatus, getHealingPolicy, setHealingAiConfig, setHealingPolicy } from "../../lib/tauri";
import type { AiConfig, HealingPolicy, RiskLevel } from "../../types/healing";
import { btn, errorText } from "./shared";

const ACTIONS = ["RESTART_POD", "ROLLOUT_RESTART", "ROLLBACK_DEPLOYMENT", "SCALE_DEPLOYMENT", "SCALE_STATEFULSET"];

const input =
  "w-full text-xs px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200";

const splitList = (s: string) => s.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

function Label({ text, hint }: { text: string; hint?: string }) {
  return (
    <div className="mb-1">
      <span className="text-[11px] font-semibold text-slate-600 dark:text-slate-300">{text}</span>
      {hint && <span className="ml-1 text-[10px] text-slate-500">{hint}</span>}
    </div>
  );
}

export function HealingSettings({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: ["healing-ai-status"], queryFn: getHealingAiStatus });
  const { data: policy } = useQuery({ queryKey: ["healing-policy"], queryFn: getHealingPolicy });
  const [ai, setAi] = useState<AiConfig | null>(null);
  const [pol, setPol] = useState<HealingPolicy | null>(null);
  const [protectedResources, setProtectedResources] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (status && !ai) setAi(status.config);
  }, [status, ai]);
  useEffect(() => {
    if (policy && !pol) {
      setPol(policy);
      setProtectedResources(policy.protectedResources.map((r) => `${r.namespace}/${r.kind}/${r.name}`).join("\n"));
    }
  }, [policy, pol]);

  async function save() {
    if (!ai || !pol) return;
    setBusy(true);
    setMsg(null);
    try {
      const resources = splitList(protectedResources).map((line) => {
        const [namespace, kind, name] = line.split("/");
        if (!namespace || !kind || !name) throw new Error(`Protected resource must be namespace/Kind/name: "${line}"`);
        return { namespace, kind, name };
      });
      await setHealingAiConfig({ ...ai, model: ai.model?.trim() || null });
      await setHealingPolicy({ ...pol, protectedResources: resources });
      await qc.invalidateQueries({ queryKey: ["healing-ai-status"] });
      await qc.invalidateQueries({ queryKey: ["healing-policy"] });
      setMsg({ ok: true, text: "Saved." });
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[680px] max-w-[94vw] max-h-[90vh] overflow-auto rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-xl text-xs text-slate-700 dark:text-slate-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-200 dark:border-slate-800">
          <Settings size={14} />
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Self-Healing settings</h2>
          <button className="ml-auto p-1 text-slate-500 hover:text-slate-800 dark:hover:text-slate-200" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        {!ai || !pol ? (
          <div className="p-6 flex justify-center"><Loader2 size={16} className="animate-spin" /></div>
        ) : (
          <div className="p-4 space-y-5">
            <section className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">AI diagnosis</h3>
              <p className="text-[11px] text-slate-500">
                Provider: local <code>claude</code> CLI, run with all tools disabled using your existing Claude Code login
                {status?.cliPath ? ` (${status.cliPath})` : " — not found"}. When enabled, the sanitized incident context
                (events, logs, pod/workload status; secret values redacted) is sent to Anthropic only when you click
                Analyze. AI can never execute anything.
              </p>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={ai.enabled} onChange={(e) => setAi({ ...ai, enabled: e.target.checked })} />
                <span>Enable AI diagnosis</span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label text="Model" hint="blank = CLI default (e.g. sonnet, opus)" />
                  <input className={input} value={ai.model ?? ""} onChange={(e) => setAi({ ...ai, model: e.target.value })} />
                </div>
                <div>
                  <Label text="Timeout (s)" />
                  <input type="number" min={10} max={900} className={input} value={ai.timeoutSecs}
                    onChange={(e) => setAi({ ...ai, timeoutSecs: Number(e.target.value) })} />
                </div>
                <div>
                  <Label text="Max context size (chars)" />
                  <input type="number" min={5000} className={input} value={ai.maxContextChars}
                    onChange={(e) => setAi({ ...ai, maxContextChars: Number(e.target.value) })} />
                </div>
                <div>
                  <Label text="Max spend per diagnosis (USD)" />
                  <input type="number" step={0.1} min={0.05} max={20} className={input} value={ai.maxBudgetUsd}
                    onChange={(e) => setAi({ ...ai, maxBudgetUsd: Number(e.target.value) })} />
                </div>
              </div>
              <p className="text-[10px] text-slate-500">Temperature is not exposed by the claude CLI provider.</p>
            </section>

            <section className="space-y-3">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Policy</h3>
              <p className="text-[11px] text-slate-500">
                Policy only restricts healing. It never approves or executes anything; every change still needs your
                explicit approval, and CRITICAL actions are always blocked.
              </p>
              <div>
                <Label text="Protected namespaces" hint="comma separated — never modified" />
                <input className={input} value={pol.protectedNamespaces.join(", ")}
                  onChange={(e) => setPol({ ...pol, protectedNamespaces: splitList(e.target.value) })} />
              </div>
              <div>
                <Label text="Protected resources" hint="one per line: namespace/Kind/name" />
                <textarea rows={3} className={`${input} font-mono`} value={protectedResources}
                  onChange={(e) => setProtectedResources(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label text="Allowed contexts" hint="empty = any" />
                  <input className={input} value={pol.allowedContexts.join(", ")}
                    onChange={(e) => setPol({ ...pol, allowedContexts: splitList(e.target.value) })} />
                </div>
                <div>
                  <Label text="Allowed namespaces" hint="empty = any non-protected" />
                  <input className={input} value={pol.allowedNamespaces.join(", ")}
                    onChange={(e) => setPol({ ...pol, allowedNamespaces: splitList(e.target.value) })} />
                </div>
                <div>
                  <Label text="Max executable risk" />
                  <select className={input} value={pol.maxRisk}
                    onChange={(e) => setPol({ ...pol, maxRisk: e.target.value as RiskLevel })}>
                    <option value="LOW">LOW</option>
                    <option value="MEDIUM">MEDIUM</option>
                    <option value="HIGH">HIGH</option>
                  </select>
                </div>
                <div>
                  <Label text="Max replicas for scaling" />
                  <input type="number" min={1} className={input} value={pol.maxReplicas}
                    onChange={(e) => setPol({ ...pol, maxReplicas: Number(e.target.value) })} />
                </div>
                <div>
                  <Label text="Proposal expiry (minutes)" />
                  <input type="number" min={1} max={1440} className={input} value={pol.proposalTtlMinutes}
                    onChange={(e) => setPol({ ...pol, proposalTtlMinutes: Number(e.target.value) })} />
                </div>
              </div>
              <div>
                <Label text="Allowed actions" />
                <div className="flex flex-wrap gap-3">
                  {ACTIONS.map((a) => (
                    <label key={a} className="flex items-center gap-1.5 font-mono text-[11px]">
                      <input
                        type="checkbox"
                        checked={pol.allowedActions.includes(a)}
                        onChange={(e) =>
                          setPol({
                            ...pol,
                            allowedActions: e.target.checked
                              ? [...pol.allowedActions, a]
                              : pol.allowedActions.filter((x) => x !== a),
                          })
                        }
                      />
                      {a}
                    </label>
                  ))}
                </div>
              </div>
            </section>

            {msg && <p className={msg.ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}>{msg.text}</p>}
            <div className="flex justify-end gap-2">
              <button className={`${btn.base} ${btn.neutral}`} onClick={onClose}>Close</button>
              <button className={`${btn.base} ${btn.primary}`} disabled={busy} onClick={save}>
                {busy && <Loader2 size={12} className="animate-spin" />} Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
