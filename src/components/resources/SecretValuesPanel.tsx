import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { patchSecret } from "../../lib/tauri";
import {
  Eye, EyeOff, Pencil, X, Plus, Save, Copy, Check,
  Lock, KeyRound, ChevronDown, ChevronRight,
} from "lucide-react";

function decode(b64: string): string {
  try { return atob(b64); } catch { return b64; }
}

interface Props {
  context: string;
  namespace: string;
  name: string;
  resource: any;
}

export function SecretValuesView({ context, namespace, name, resource }: Props) {
  const qc = useQueryClient();
  const rawData: Record<string, string> = resource?.data ?? {};
  const keys = Object.keys(rawData);

  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Record<string, string>>({});
  const [newPairs, setNewPairs] = useState<Array<{ key: string; val: string }>>([]);
  const [copied, setCopied] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const hasChanges =
    Object.keys(editing).length > 0 ||
    newPairs.some((p) => p.key.trim() !== "");

  const toggleReveal = (key: string) =>
    setRevealed((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });

  const startEdit = (key: string) => {
    if (key in editing) return;
    setEditing((e) => ({ ...e, [key]: decode(rawData[key] ?? "") }));
    setRevealed((prev) => new Set([...prev, key]));
  };

  const cancelEdit = (key: string) =>
    setEditing((e) => {
      const n = { ...e };
      delete n[key];
      return n;
    });

  const copyValue = async (key: string) => {
    const val = decode(rawData[key] ?? "");
    await navigator.clipboard.writeText(val);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const save = async () => {
    const payload: Record<string, string> = { ...editing };
    for (const p of newPairs) {
      if (p.key.trim()) payload[p.key.trim()] = p.val;
    }
    if (Object.keys(payload).length === 0) return;
    setSaving(true);
    setMsg(null);
    try {
      await patchSecret({ context, namespace, name, data: payload });
      setMsg({ ok: true, text: "Secret updated successfully" });
      setEditing({});
      setNewPairs([]);
      setShowAdd(false);
      qc.invalidateQueries({ queryKey: ["secrets"] });
    } catch (e: any) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* ── Header ── */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-slate-800 bg-slate-900 shrink-0">
        <Lock size={13} className="text-slate-500" />
        <span className="text-xs font-semibold text-slate-200">Secret Values</span>
        <span className="text-[11px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded-full">
          {keys.length} keys
        </span>
        {resource?.type && (
          <span className="text-[11px] font-mono text-slate-600 ml-0.5">{resource.type}</span>
        )}
        {hasChanges && (
          <span className="flex items-center gap-1 text-[11px] text-amber-400 ml-1">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            unsaved
          </span>
        )}
        <button
          onClick={save}
          disabled={saving || !hasChanges}
          className="ml-auto flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium transition-colors"
        >
          <Save size={11} />
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {/* ── Status message ── */}
      {msg && (
        <div
          className={`px-4 py-2 text-xs border-b flex items-center gap-2 shrink-0 ${
            msg.ok
              ? "bg-emerald-900/20 border-emerald-800/40 text-emerald-400"
              : "bg-red-900/20 border-red-800/40 text-red-400"
          }`}
        >
          {msg.ok ? <Check size={12} /> : <X size={12} />}
          {msg.text}
        </div>
      )}

      {/* ── Key cards ── */}
      <div className="flex-1 overflow-auto p-3 space-y-2">
        {keys.length === 0 && (
          <div className="text-center text-slate-600 text-sm py-12">
            No data keys in this secret.
          </div>
        )}

        {keys.map((key) => {
          const isEditing = key in editing;
          const isRevealed = revealed.has(key);
          const decodedVal = decode(rawData[key] ?? "");
          const lineCount = decodedVal.split("\n").length;

          return (
            <div
              key={key}
              className={`rounded-lg border transition-all ${
                isEditing
                  ? "border-amber-600/50 bg-amber-900/10"
                  : "border-slate-800 bg-slate-900 hover:border-slate-700"
              }`}
            >
              {/* Key name row */}
              <div className="flex items-center gap-2 px-3 py-2">
                <KeyRound size={11} className="text-slate-600 shrink-0" />
                <span className="font-mono text-xs text-slate-200 font-medium flex-1 truncate">
                  {key}
                </span>
                {isEditing && (
                  <span className="text-[10px] text-amber-500 font-medium px-1.5 py-0.5 bg-amber-900/30 rounded">
                    editing
                  </span>
                )}

                {/* Action buttons */}
                <div className="flex items-center gap-0.5 ml-1">
                  {!isEditing && (
                    <button
                      onClick={() => copyValue(key)}
                      className="p-1.5 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                      title="Copy decoded value"
                    >
                      {copied === key ? (
                        <Check size={11} className="text-emerald-400" />
                      ) : (
                        <Copy size={11} />
                      )}
                    </button>
                  )}
                  {!isEditing && (
                    <button
                      onClick={() => toggleReveal(key)}
                      className="p-1.5 rounded text-slate-600 hover:text-slate-300 hover:bg-slate-800 transition-colors"
                      title={isRevealed ? "Hide value" : "Reveal value"}
                    >
                      {isRevealed ? <EyeOff size={11} /> : <Eye size={11} />}
                    </button>
                  )}
                  {isEditing ? (
                    <button
                      onClick={() => cancelEdit(key)}
                      className="p-1.5 rounded text-slate-600 hover:text-red-400 hover:bg-slate-800 transition-colors"
                      title="Cancel edit"
                    >
                      <X size={11} />
                    </button>
                  ) : (
                    <button
                      onClick={() => startEdit(key)}
                      className="p-1.5 rounded text-slate-600 hover:text-blue-400 hover:bg-slate-800 transition-colors"
                      title="Edit value"
                    >
                      <Pencil size={11} />
                    </button>
                  )}
                </div>
              </div>

              {/* Value area */}
              <div className="px-3 pb-2.5">
                {isEditing ? (
                  <textarea
                    value={editing[key]}
                    onChange={(e) =>
                      setEditing((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    rows={Math.max(3, Math.min(10, lineCount + 1))}
                    spellCheck={false}
                    autoFocus
                    className="w-full bg-slate-800 border border-slate-600 focus:border-blue-500 text-slate-100 font-mono text-xs rounded-md px-3 py-2 resize-y outline-none leading-relaxed"
                    placeholder="Enter value (plain text, will be base64-encoded on save)"
                  />
                ) : isRevealed ? (
                  <pre className="font-mono text-xs text-slate-300 whitespace-pre-wrap break-all bg-slate-800/50 rounded-md px-3 py-2 leading-relaxed max-h-48 overflow-auto">
                    {decodedVal}
                  </pre>
                ) : (
                  <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-800/30 rounded-md">
                    <span className="font-mono text-slate-600 text-sm tracking-[0.15em] select-none">
                      {"•".repeat(Math.min(32, Math.max(8, decodedVal.length)))}
                    </span>
                    <span className="text-[10px] text-slate-700 ml-auto">
                      {decodedVal.length} chars
                    </span>
                  </div>
                )}
              </div>
            </div>
          );
        })}

        {/* ── Add new keys section ── */}
        <div className="mt-2 rounded-lg border border-dashed border-slate-700 bg-slate-900/40">
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex items-center gap-2 w-full px-3 py-2.5 text-xs text-slate-500 hover:text-slate-300 transition-colors"
          >
            {showAdd ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <Plus size={11} />
            Add new key-value pairs
          </button>

          {showAdd && (
            <div className="px-3 pb-3 space-y-2 border-t border-slate-800/60 pt-2">
              {newPairs.map((pair, i) => (
                <div key={i} className="flex gap-2 items-center">
                  <input
                    value={pair.key}
                    onChange={(e) =>
                      setNewPairs((p) =>
                        p.map((x, j) => (j === i ? { ...x, key: e.target.value } : x))
                      )
                    }
                    placeholder="Key name"
                    className="w-36 shrink-0 bg-slate-800 border border-slate-700 focus:border-blue-500 text-slate-200 text-xs font-mono rounded-md px-2.5 py-1.5 outline-none"
                  />
                  <input
                    value={pair.val}
                    onChange={(e) =>
                      setNewPairs((p) =>
                        p.map((x, j) => (j === i ? { ...x, val: e.target.value } : x))
                      )
                    }
                    placeholder="Value (plain text)"
                    className="flex-1 bg-slate-800 border border-slate-700 focus:border-blue-500 text-slate-200 text-xs font-mono rounded-md px-2.5 py-1.5 outline-none"
                  />
                  <button
                    onClick={() => setNewPairs((p) => p.filter((_, j) => j !== i))}
                    className="p-1.5 text-slate-600 hover:text-red-400 transition-colors"
                  >
                    <X size={11} />
                  </button>
                </div>
              ))}
              <button
                onClick={() => setNewPairs((p) => [...p, { key: "", val: "" }])}
                className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors mt-1"
              >
                <Plus size={11} />
                Add pair
              </button>
              <p className="text-[11px] text-slate-700 mt-2">
                Plain text is base64-encoded automatically on save.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
