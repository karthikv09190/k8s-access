import { useEffect, useRef, useState } from "react";
import { Check, Copy, GitBranch, Loader2, MessageSquare, Send, Wand2 } from "lucide-react";
import { proposeHealingFromChat, sendHealingChat } from "../../lib/tauri";
import type { AiStatus, ChatMessage, Incident } from "../../types/healing";
import { btn, describeAction, errorText, RiskBadge, Section } from "./shared";

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="p-1 rounded text-slate-500 hover:bg-slate-200 dark:hover:bg-slate-800"
      title="Copy"
      onClick={() =>
        navigator.clipboard.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        })
      }
    >
      {done ? <Check size={12} className="text-emerald-500" /> : <Copy size={12} />}
    </button>
  );
}

function AssistantMessage({ m, incident, onChanged }: { m: ChatMessage; incident: Incident; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function propose() {
    setBusy(true);
    setError(null);
    try {
      await proposeHealingFromChat(incident.id, m.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap">{m.text}</p>
      {m.evidence.length > 0 && (
        <details className="text-[11px] text-slate-500">
          <summary className="cursor-pointer">Evidence ({m.evidence.length})</summary>
          <ul className="list-disc pl-4 mt-1">{m.evidence.map((e, i) => <li key={i}>{e}</li>)}</ul>
        </details>
      )}
      {m.suggestedAction && (
        <div className="rounded border border-violet-300 bg-violet-50 dark:border-violet-500/30 dark:bg-violet-500/10 p-2 space-y-1.5">
          <div className="flex items-center gap-2">
            <Wand2 size={12} className="text-violet-600 dark:text-violet-300" />
            <span className="text-[11px] font-semibold text-violet-800 dark:text-violet-200">Suggested fix</span>
            {m.riskLevel && <RiskBadge risk={m.riskLevel} />}
            {m.confidence !== null && <span className="text-[10px] text-slate-500">{Math.round(m.confidence * 100)}% confidence</span>}
          </div>
          <p className="font-mono text-[11px] break-all">{describeAction(m.suggestedAction)}</p>
          {m.proposalId ? (
            <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
              Proposal created — review it above and approve or reject it.
            </p>
          ) : (
            <button className={`${btn.base} ${btn.primary}`} disabled={busy} onClick={propose}
              title="Validates the change, runs a server-side dry run and creates a proposal. Nothing is applied until you approve.">
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Wand2 size={12} />} Create proposal for approval
            </button>
          )}
          {error && <p className="text-[11px] text-red-600 dark:text-red-400">{error}</p>}
        </div>
      )}
      {m.suggestionError && (
        <p className="text-[11px] text-amber-700 dark:text-amber-300">
          The AI suggested something self-healing cannot execute ({m.suggestionError}). Apply it manually or via GitOps.
        </p>
      )}
      {m.gitopsSuggestion && (
        <div className="rounded border border-amber-300 bg-amber-50 dark:border-amber-500/30 dark:bg-amber-500/10 p-2">
          <div className="flex items-center gap-2 mb-1">
            <GitBranch size={12} className="text-amber-700 dark:text-amber-300" />
            <span className="text-[11px] font-semibold text-amber-800 dark:text-amber-200">GitOps fix (commit it yourself)</span>
            <span className="ml-auto"><CopyButton text={m.gitopsSuggestion} /></span>
          </div>
          <pre className="font-mono text-[11px] whitespace-pre-wrap break-all">{m.gitopsSuggestion}</pre>
        </div>
      )}
    </div>
  );
}

export function ChatPanel({ incident, aiStatus, onChanged }: {
  incident: Incident;
  aiStatus: AiStatus | undefined;
  onChanged: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const messages = incident.conversation ?? [];
  const available = !!aiStatus?.available;

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "nearest" });
  }, [messages.length]);

  async function send() {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    setError(null);
    try {
      await sendHealingChat(incident.id, msg);
      setText("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
      onChanged();
    }
  }

  return (
    <Section
      title="Discuss with AI"
      icon={<MessageSquare size={13} className="text-indigo-500" />}
      right={<span className="text-[10px] text-slate-500">AI cannot change the cluster · fixes become proposals you approve</span>}
    >
      <div className="space-y-3">
        {messages.length === 0 && (
          <p className="text-slate-500">
            Ask about this incident — e.g. "why is it restarting?", "would a startupProbe fix it?", "what should the memory
            limit be?". The AI sees the same redacted evidence as Analyze. If you agree on a fix it can turn into a
            proposal that you then approve.
          </p>
        )}
        <div className="space-y-3 max-h-[520px] overflow-auto pr-1">
          {messages.map((m) =>
            m.role === "OPERATOR" ? (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[80%] rounded-lg px-3 py-2 bg-blue-600 text-white whitespace-pre-wrap">{m.text}</div>
              </div>
            ) : (
              <div key={m.id} className="max-w-[92%] rounded-lg px-3 py-2 bg-slate-100 dark:bg-slate-800/70">
                <AssistantMessage m={m} incident={incident} onChanged={onChanged} />
                <p className="mt-1 text-[10px] text-slate-500">{m.model ?? "claude"}</p>
              </div>
            ),
          )}
          {busy && (
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 size={12} className="animate-spin" /> AI is thinking…
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && <p className="text-red-600 dark:text-red-400">{error}</p>}
        <div className="flex gap-2 items-end">
          <textarea
            rows={2}
            value={text}
            disabled={!available || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={available ? "Ask about this incident… (Enter to send, Shift+Enter for a new line)" : aiStatus?.message ?? "AI unavailable"}
            className="flex-1 text-xs px-2 py-1.5 rounded border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 resize-y"
          />
          <button className={`${btn.base} ${btn.primary}`} disabled={!available || busy || !text.trim()} onClick={send}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Send
          </button>
        </div>
      </div>
    </Section>
  );
}
