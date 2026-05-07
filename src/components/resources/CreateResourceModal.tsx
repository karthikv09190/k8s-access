import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import Editor from "@monaco-editor/react";
import { applyResourceYaml } from "../../lib/tauri";
import { AlertCircle, CheckCircle2, Play, X } from "lucide-react";

const TEMPLATES: Record<string, string> = {
  Deployment: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: my-app
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels:
      app: my-app
  template:
    metadata:
      labels:
        app: my-app
    spec:
      containers:
      - name: my-app
        image: nginx:latest
        ports:
        - containerPort: 80`,

  Service: `apiVersion: v1
kind: Service
metadata:
  name: my-service
  namespace: default
spec:
  selector:
    app: my-app
  ports:
  - port: 80
    targetPort: 80`,

  ConfigMap: `apiVersion: v1
kind: ConfigMap
metadata:
  name: my-config
  namespace: default
data:
  key: value`,

  Secret: `apiVersion: v1
kind: Secret
metadata:
  name: my-secret
  namespace: default
type: Opaque
stringData:
  key: value`,

  Job: `apiVersion: batch/v1
kind: Job
metadata:
  name: my-job
  namespace: default
spec:
  template:
    spec:
      containers:
      - name: my-job
        image: busybox
        command: ["sh", "-c", "echo Hello"]
      restartPolicy: Never`,

  Namespace: `apiVersion: v1
kind: Namespace
metadata:
  name: my-namespace`,
};

interface Props {
  context: string;
  namespace: string;
  onClose: () => void;
  invalidateKey?: string;
}

export function CreateResourceModal({
  context,
  namespace: _namespace,
  onClose,
  invalidateKey,
}: Props) {
  const qc = useQueryClient();
  const [yaml, setYaml] = useState(TEMPLATES.Deployment);
  const [activeTemplate, setActiveTemplate] = useState("Deployment");
  const [dryRun, setDryRun] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; msg: string } | null>(null);
  const [running, setRunning] = useState(false);

  const apply = async () => {
    setRunning(true);
    setResult(null);
    try {
      const msg = await applyResourceYaml({ context, yaml, dryRun });
      setResult({
        ok: true,
        msg: msg || (dryRun ? "Dry run passed." : "Applied successfully."),
      });
      if (!dryRun) {
        if (invalidateKey) qc.invalidateQueries({ queryKey: [invalidateKey] });
        setTimeout(onClose, 1200);
      }
    } catch (e: unknown) {
      setResult({ ok: false, msg: String(e) });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-[820px] max-h-[90vh] bg-slate-50 dark:bg-slate-900 border border-slate-300 dark:border-slate-700 rounded-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-300 dark:border-slate-700 shrink-0">
          <h2 className="text-sm font-semibold text-slate-800 dark:text-slate-200">Create Resource</h2>
          <button
            onClick={onClose}
            className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Template sidebar */}
          <div className="w-36 shrink-0 border-r border-slate-300 dark:border-slate-700 py-2 overflow-y-auto">
            <p className="px-3 py-1 text-[10px] font-semibold text-slate-500 uppercase tracking-wider">
              Templates
            </p>
            {Object.keys(TEMPLATES).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setActiveTemplate(t);
                  setYaml(TEMPLATES[t]);
                  setResult(null);
                }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                  activeTemplate === t
                    ? "text-blue-600 dark:text-blue-400 bg-blue-100 dark:bg-blue-500/10"
                    : "text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5"
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Monaco editor */}
          <div className="flex-1 overflow-hidden">
            <Editor
              height="100%"
              language="yaml"
              theme="vs-dark"
              value={yaml}
              onChange={(v) => setYaml(v ?? "")}
              options={{
                minimap: { enabled: false },
                fontSize: 12,
                lineNumbers: "on",
                scrollBeyondLastLine: false,
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-t border-slate-300 dark:border-slate-700">
          {result && (
            <div
              className={`flex items-center gap-1.5 text-xs flex-1 min-w-0 ${
                result.ok ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
              }`}
            >
              {result.ok ? (
                <CheckCircle2 size={12} className="shrink-0" />
              ) : (
                <AlertCircle size={12} className="shrink-0" />
              )}
              <span className="truncate">{result.msg}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <label className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={dryRun}
                onChange={(e) => setDryRun(e.target.checked)}
                className="rounded"
              />
              Dry run
            </label>
            <button
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded border border-slate-300 dark:border-slate-700 text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-slate-200 dark:hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              onClick={apply}
              disabled={running || !yaml.trim()}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white"
            >
              <Play size={11} />
              {running ? "Applying…" : dryRun ? "Dry Run" : "Apply"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
