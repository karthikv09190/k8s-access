import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getResourceYaml, applyResourceYaml } from "../../lib/tauri";
import { Save, RotateCcw } from "lucide-react";

interface Props {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}

export function EditYamlPanel({ context, namespace, kind, name }: Props) {
  const [edited, setEdited] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ ok: boolean; msg: string } | null>(null);

  const { data: yaml = "", isLoading } = useQuery({
    queryKey: ["yaml", context, namespace, kind, name],
    queryFn: () => getResourceYaml({ context, namespace, kind, name }),
  });

  // Reset edited content when resource changes
  useEffect(() => {
    setEdited(null);
    setSaveMsg(null);
  }, [context, namespace, kind, name]);

  const displayYaml = edited ?? yaml;
  const isDirty = edited !== null && edited !== yaml;

  const save = async () => {
    if (!displayYaml) return;
    setSaving(true);
    setSaveMsg(null);
    try {
      const result = await applyResourceYaml({ context, yaml: displayYaml });
      setSaveMsg({ ok: true, msg: result || "Applied successfully" });
      setEdited(null); // reset dirty state
    } catch (e: any) {
      setSaveMsg({ ok: false, msg: String(e) });
    } finally {
      setSaving(false);
    }
  };

  const reset = () => {
    setEdited(null);
    setSaveMsg(null);
  };

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900">
        <span className="text-xs text-slate-500 dark:text-slate-400 font-semibold">EDIT</span>
        <span className="text-xs text-slate-500 dark:text-slate-600">
          {kind}/{name}
        </span>
        {isDirty && (
          <span className="text-xs text-amber-600 dark:text-yellow-400 ml-1">● unsaved</span>
        )}
        <div className="ml-auto flex gap-2">
          {isDirty && (
            <button
              onClick={reset}
              className="text-xs px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 flex items-center gap-1"
            >
              <RotateCcw size={10} />
              Reset
            </button>
          )}
          <button
            onClick={save}
            disabled={saving || !isDirty}
            className="text-xs px-2 py-0.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white flex items-center gap-1"
          >
            <Save size={10} />
            {saving ? "Applying..." : "Apply"}
          </button>
        </div>
      </div>

      {saveMsg && (
        <div
          className={`px-3 py-1.5 text-xs border-b ${
            saveMsg.ok
              ? "bg-green-50 dark:bg-green-900/30 border-green-200 dark:border-green-800 text-green-600 dark:text-green-400"
              : "bg-red-50 dark:bg-red-900/30 border-red-200 dark:border-red-800 text-red-600 dark:text-red-400"
          }`}
        >
          {saveMsg.msg}
        </div>
      )}

      <textarea
        value={isLoading ? "Loading..." : displayYaml}
        onChange={(e) => setEdited(e.target.value)}
        disabled={isLoading}
        spellCheck={false}
        className="flex-1 p-3 text-xs font-mono text-slate-700 dark:text-slate-300 bg-white dark:bg-slate-950 resize-none focus:outline-none leading-5"
      />
    </div>
  );
}
