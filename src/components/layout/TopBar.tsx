import { Menu, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../../store/app";
import { listContexts, listNamespaces } from "../../lib/tauri";

export function TopBar({ onRefresh }: { onRefresh: () => void }) {
  const {
    contexts,
    setContexts,
    activeContext,
    setActiveContext,
    activeNamespace,
    setActiveNamespace,
    namespaces,
    setNamespaces,
    toggleSidebar,
  } = useAppStore();

  const { data: ctxList } = useQuery({
    queryKey: ["contexts"],
    queryFn: listContexts,
  });

  const { data: nsList } = useQuery({
    queryKey: ["namespaces", activeContext],
    queryFn: () => listNamespaces(activeContext),
    enabled: !!activeContext,
  });

  useEffect(() => {
    if (ctxList) {
      setContexts(ctxList);
      const current = ctxList.find((c) => c.current);
      if (current && !activeContext) setActiveContext(current.name);
    }
  }, [ctxList]);

  useEffect(() => {
    if (nsList) {
      setNamespaces(nsList);
      if (!nsList.includes(activeNamespace)) setActiveNamespace("default");
    }
  }, [nsList]);

  return (
    <header className="h-11 bg-slate-900 border-b border-slate-800 flex items-center gap-3 px-3 shrink-0">
      <button
        onClick={toggleSidebar}
        className="text-slate-400 hover:text-slate-200 p-1 rounded"
      >
        <Menu size={16} />
      </button>

      {/* Context selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500">Context:</span>
        <select
          value={activeContext}
          onChange={(e) => setActiveContext(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          {contexts.map((c) => (
            <option key={c.name} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Namespace selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-500">NS:</span>
        <select
          value={activeNamespace}
          onChange={(e) => setActiveNamespace(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          <option value="">All Namespaces</option>
          {namespaces.map((ns) => (
            <option key={ns} value={ns}>
              {ns}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1" />

      <button
        onClick={onRefresh}
        className="text-slate-400 hover:text-slate-200 p-1 rounded"
        title="Refresh"
      >
        <RefreshCw size={14} />
      </button>
    </header>
  );
}
