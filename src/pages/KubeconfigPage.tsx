import { useState, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import {
  listContexts,
  renameContext,
  deleteContext,
  setCurrentContext,
  testContextConnection,
  importKubeconfig,
} from "../lib/tauri";
import type { KubeContext } from "../types/k8s";
import {
  Settings,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ChevronDown,
  ChevronRight,
  Wifi,
  WifiOff,
  Pencil,
  Trash2,
  Upload,
  Check,
  X,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

type TestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "ok"; message: string }
  | { status: "err"; message: string };

// ── Helpers ────────────────────────────────────────────────────────────────────

function Badge({
  children,
  variant = "default",
}: {
  children: React.ReactNode;
  variant?: "default" | "blue" | "green" | "red";
}) {
  const colors = {
    default: "bg-slate-700 text-slate-300 border-slate-600",
    blue: "bg-blue-500/15 text-blue-400 border-blue-500/30",
    green: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
    red: "bg-red-500/15 text-red-400 border-red-500/30",
  };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium border ${colors[variant]}`}
    >
      {children}
    </span>
  );
}

// ── Context Row ────────────────────────────────────────────────────────────────

function ContextRow({
  ctx,
  onRefresh,
}: {
  ctx: KubeContext;
  onRefresh: () => void;
}) {
  const { activeContext, setActiveContext, setContexts, contexts } = useAppStore();
  const isCurrent = ctx.name === activeContext;

  const [testState, setTestState] = useState<TestState>({ status: "idle" });
  const [showTest, setShowTest] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [newName, setNewName] = useState(ctx.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const handleUse = async () => {
    setBusy(true);
    try {
      await setCurrentContext(ctx.name);
      setActiveContext(ctx.name);
      // Update current flag in contexts store
      setContexts(
        contexts.map((c) => ({ ...c, current: c.name === ctx.name }))
      );
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleTest = async () => {
    setShowTest(true);
    setTestState({ status: "testing" });
    try {
      const result = await testContextConnection(ctx.name);
      // Take first meaningful line
      const firstLine =
        result
          .split("\n")
          .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim())
          .find((l) => l.length > 0) ?? result.trim();
      setTestState({ status: "ok", message: firstLine });
    } catch (e) {
      setTestState({ status: "err", message: String(e) });
    }
  };

  const handleRename = async () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === ctx.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      await renameContext({ oldName: ctx.name, newName: trimmed });
      onRefresh();
      setRenaming(false);
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async () => {
    setBusy(true);
    try {
      await deleteContext(ctx.name);
      onRefresh();
    } catch (e) {
      console.error(e);
    } finally {
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <tr
        className={`group border-b border-slate-800/50 transition-colors
          ${isCurrent ? "bg-blue-950/20 hover:bg-blue-950/30" : "hover:bg-slate-800/30"}`}
      >
        {/* Current indicator */}
        <td className="pl-3 pr-2 py-2.5 w-6">
          {isCurrent && (
            <span className="block w-2 h-2 rounded-full bg-blue-400 shadow-[0_0_6px_rgba(96,165,250,0.6)]" />
          )}
        </td>

        {/* Name */}
        <td className="px-2 py-2.5">
          <div className="flex items-center gap-2">
            {renaming ? (
              <div className="flex items-center gap-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                    if (e.key === "Escape") {
                      setRenaming(false);
                      setNewName(ctx.name);
                    }
                  }}
                  className="bg-slate-800 border border-blue-500 text-slate-200 text-xs rounded px-2 py-1 w-48 focus:outline-none"
                />
                <button
                  onClick={handleRename}
                  disabled={busy}
                  className="text-emerald-400 hover:text-emerald-300 p-1"
                >
                  <Check size={12} />
                </button>
                <button
                  onClick={() => {
                    setRenaming(false);
                    setNewName(ctx.name);
                  }}
                  className="text-slate-500 hover:text-slate-300 p-1"
                >
                  <X size={12} />
                </button>
              </div>
            ) : (
              <span className="text-xs font-mono text-slate-200">{ctx.name}</span>
            )}
            {isCurrent && <Badge variant="blue">current</Badge>}
          </div>
        </td>

        {/* Cluster */}
        <td className="px-2 py-2.5">
          <span className="text-xs text-slate-400 font-mono">{ctx.cluster}</span>
        </td>

        {/* User — not in KubeContext type, show namespace instead */}
        <td className="px-2 py-2.5">
          <span className="text-xs text-slate-500">
            {ctx.namespace ?? <span className="text-slate-700">—</span>}
          </span>
        </td>

        {/* Actions */}
        <td className="px-2 py-2.5 text-right pr-4">
          <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
            {/* Use */}
            <button
              onClick={handleUse}
              disabled={isCurrent || busy}
              title="Switch to this context"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium
                bg-blue-100 dark:bg-blue-600/20 text-blue-400 hover:bg-blue-600/30 border border-blue-600/30
                disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? <Loader2 size={10} className="animate-spin" /> : <Wifi size={10} />}
              Use
            </button>

            {/* Test */}
            <button
              onClick={handleTest}
              title="Test connection"
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium
                bg-slate-700/50 text-slate-400 hover:bg-slate-700 border border-slate-700
                transition-colors"
            >
              <WifiOff size={10} />
              Test
            </button>

            {/* Rename */}
            <button
              onClick={() => {
                setRenaming(true);
                setNewName(ctx.name);
              }}
              title="Rename"
              className="p-1.5 rounded text-slate-500 hover:text-slate-300 hover:bg-slate-700/50 transition-colors"
            >
              <Pencil size={12} />
            </button>

            {/* Delete */}
            {confirmDelete ? (
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-red-400">Sure?</span>
                <button
                  onClick={handleDelete}
                  disabled={busy}
                  className="px-1.5 py-0.5 rounded text-[11px] bg-red-600/20 text-red-400 hover:bg-red-600/30 border border-red-600/30 transition-colors"
                >
                  {busy ? <Loader2 size={10} className="animate-spin" /> : "Yes"}
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="p-1 rounded text-slate-500 hover:text-slate-300"
                >
                  <X size={10} />
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                title="Delete context"
                className="p-1.5 rounded text-slate-600 hover:text-red-400 hover:bg-red-50 dark:bg-red-500/10 transition-colors"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </td>
      </tr>

      {/* Test result panel */}
      {showTest && testState.status !== "idle" && (
        <tr className="border-b border-slate-800/30">
          <td colSpan={5} className="px-4 py-2">
            <div
              className={`flex items-start gap-2 text-xs rounded-md px-3 py-2 border
                ${testState.status === "testing"
                  ? "bg-slate-800/50 text-slate-400 border-slate-700"
                  : testState.status === "ok"
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                  : "bg-red-50 dark:bg-red-500/10 text-red-300 border-red-500/20"
                }`}
            >
              {testState.status === "testing" && (
                <Loader2 size={12} className="animate-spin mt-0.5 shrink-0" />
              )}
              {testState.status === "ok" && (
                <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
              )}
              {testState.status === "err" && (
                <XCircle size={12} className="mt-0.5 shrink-0" />
              )}
              <span className="font-mono break-all leading-relaxed">
                {testState.status === "testing"
                  ? `Testing ${ctx.name}…`
                  : testState.status === "ok"
                  ? `Connected: ${testState.message}`
                  : testState.message}
              </span>
              <button
                onClick={() => setShowTest(false)}
                className="ml-auto shrink-0 text-current opacity-50 hover:opacity-100"
              >
                <X size={11} />
              </button>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Import Section ─────────────────────────────────────────────────────────────

function ImportSection({ onRefresh }: { onRefresh: () => void }) {
  const [open, setOpen] = useState(false);
  const [yaml, setYaml] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    { ok: true; names: string[] } | { ok: false; error: string } | null
  >(null);

  const handleImport = async () => {
    if (!yaml.trim()) return;
    setBusy(true);
    setResult(null);
    try {
      const names = await importKubeconfig(yaml);
      setResult({ ok: true, names });
      setYaml("");
      onRefresh();
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="border border-slate-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-4 py-3 bg-slate-900 hover:bg-slate-800/60 transition-colors"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Upload size={14} className="text-blue-400" />
          Add Cluster — Import Kubeconfig
        </div>
        {open ? (
          <ChevronDown size={14} className="text-slate-500" />
        ) : (
          <ChevronRight size={14} className="text-slate-500" />
        )}
      </button>

      {open && (
        <div className="px-4 py-3 space-y-3 bg-white dark:bg-slate-950 border-t border-slate-800">
          <p className="text-xs text-slate-500">
            Paste a kubeconfig YAML below. It will be merged into{" "}
            <code className="text-slate-400 font-mono">~/.kube/config</code>.
          </p>

          <textarea
            value={yaml}
            onChange={(e) => setYaml(e.target.value)}
            placeholder="apiVersion: v1&#10;kind: Config&#10;clusters:&#10;  - ..."
            rows={10}
            className="w-full bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono
              rounded-md p-3 focus:outline-none focus:border-blue-500 resize-y
              placeholder:text-slate-600"
          />

          <div className="flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={busy || !yaml.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium
                bg-blue-600 hover:bg-blue-500 text-white border border-blue-500
                disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Upload size={12} />
              )}
              Import
            </button>

            {yaml && (
              <button
                onClick={() => {
                  setYaml("");
                  setResult(null);
                }}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear
              </button>
            )}
          </div>

          {result && (
            <div
              className={`flex items-start gap-2 text-xs rounded-md px-3 py-2 border
                ${result.ok
                  ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                  : "bg-red-50 dark:bg-red-500/10 text-red-300 border-red-500/20"
                }`}
            >
              {result.ok ? (
                <>
                  <CheckCircle2 size={12} className="mt-0.5 shrink-0" />
                  <span>
                    Imported {result.names.length} context
                    {result.names.length !== 1 ? "s" : ""}
                    {result.names.length > 0 && (
                      <span className="text-emerald-400 font-mono">
                        {" "}
                        ({result.names.join(", ")})
                      </span>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <XCircle size={12} className="mt-0.5 shrink-0" />
                  <span className="font-mono break-all">{result.error}</span>
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export function KubeconfigPage() {
  const { activeContext } = useAppStore();
  const queryClient = useQueryClient();

  const {
    data: contexts = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery<KubeContext[]>({
    queryKey: ["kubeconfig-contexts"],
    queryFn: () => listContexts(),
    staleTime: 0,
  });

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["kubeconfig-contexts"] });
  }, [queryClient]);

  return (
    <div className="h-full flex flex-col overflow-hidden bg-white dark:bg-slate-950">
      {/* ── Header ── */}
      <div className="shrink-0 px-4 py-3 border-b border-slate-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings size={15} className="text-blue-400" />
            <h1 className="text-sm font-semibold text-slate-200">
              Kubeconfig Contexts
            </h1>
            {isFetching && (
              <RefreshCw size={11} className="animate-spin text-slate-600" />
            )}
            {contexts.length > 0 && (
              <Badge>{contexts.length}</Badge>
            )}
          </div>
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-300
              transition-colors p-1.5 rounded hover:bg-slate-800 disabled:opacity-40"
          >
            <RefreshCw size={12} className={isFetching ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>
      </div>

      {/* ── Body ── */}
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Context table */}
        <div className="border border-slate-800 rounded-lg overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-slate-500 text-sm gap-2">
              <Loader2 size={16} className="animate-spin" />
              Loading contexts…
            </div>
          ) : contexts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-600 gap-2">
              <Settings size={28} className="opacity-30" />
              <span className="text-sm">No kubeconfig contexts found</span>
            </div>
          ) : (
            <table className="w-full text-left">
              <thead className="bg-slate-900 border-b border-slate-800">
                <tr className="text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="pl-3 pr-2 py-2.5 w-6" />
                  <th className="px-2 py-2.5">Name</th>
                  <th className="px-2 py-2.5">Cluster</th>
                  <th className="px-2 py-2.5">Namespace</th>
                  <th className="px-2 py-2.5 text-right pr-4">Actions</th>
                </tr>
              </thead>
              <tbody>
                {contexts.map((ctx) => (
                  <ContextRow
                    key={ctx.name}
                    ctx={ctx}
                    onRefresh={handleRefresh}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Import section */}
        <ImportSection onRefresh={handleRefresh} />
      </div>

      {/* ── Footer ── */}
      <div className="shrink-0 px-4 py-1.5 border-t border-slate-800 flex items-center justify-between text-[11px] text-slate-600">
        <span>
          {contexts.length} context{contexts.length !== 1 ? "s" : ""}
        </span>
        <span className="font-mono">{activeContext || "—"}</span>
      </div>
    </div>
  );
}
