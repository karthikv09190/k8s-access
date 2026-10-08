import { Menu, RefreshCw, Terminal, Sun, Moon } from "lucide-react";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppStore } from "../../store/app";
import { listContexts, listNamespaces } from "../../lib/tauri";
import { NotificationCenter } from "./NotificationCenter";
import { KubectlPalette } from "../KubectlPalette";

export function TopBar({ onRefresh }: { onRefresh: () => void }) {
  const [kubectlOpen, setKubectlOpen] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "P") {
        e.preventDefault();
        setKubectlOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
    theme,
    toggleTheme,
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
    <header className="h-11 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center gap-3 px-3 shrink-0">
      <button
        onClick={toggleSidebar}
        className="text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 p-1 rounded"
      >
        <Menu size={16} />
      </button>

      {/* Context selector */}
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-slate-400 dark:text-slate-500">Context:</span>
        <select
          value={activeContext}
          onChange={(e) => setActiveContext(e.target.value)}
          className="bg-white border border-slate-300 text-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500"
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
        <span className="text-xs text-slate-400 dark:text-slate-500">NS:</span>
        <select
          value={activeNamespace}
          onChange={(e) => setActiveNamespace(e.target.value)}
          className="bg-white border border-slate-300 text-slate-800 dark:bg-slate-800 dark:border-slate-700 dark:text-slate-200 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500"
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
        onClick={toggleTheme}
        className="text-slate-400 hover:text-slate-200 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded"
        title="Toggle theme"
      >
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>
      <button
        onClick={() => setKubectlOpen(true)}
        className="text-slate-400 hover:text-slate-200 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded"
        title="kubectl Palette (⌘⇧P)"
      >
        <Terminal size={14} />
      </button>
      <NotificationCenter />
      <button
        onClick={onRefresh}
        className="text-slate-400 hover:text-slate-200 dark:text-slate-400 dark:hover:text-slate-200 p-1 rounded"
        title="Refresh"
      >
        <RefreshCw size={14} />
      </button>
      <KubectlPalette open={kubectlOpen} onClose={() => setKubectlOpen(false)} />
    </header>
  );
}
