import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import {
  getPodContainers,
  startTerminal,
  writeTerminal,
  resizeTerminal,
  closeTerminal,
} from "../../lib/tauri";

const SHELLS = ["sh", "bash", "/bin/bash", "/bin/sh"];

interface Props {
  context: string;
  namespace: string;
  podName: string;
}

export function TerminalPanel({ context, namespace, podName }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const tidRef = useRef<string | null>(null);
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [shell, setShell] = useState("sh");
  const [error, setError] = useState<string | null>(null);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers", context, namespace, podName],
    queryFn: () => getPodContainers({ context, namespace, podName }),
  });

  useEffect(() => {
    if (containers.length && container === undefined) setContainer(containers[0]);
  }, [containers]);

  // Init xterm once
  useEffect(() => {
    if (!termRef.current) return;

    const term = new XTerm({
      theme: { background: "#020617", foreground: "#e2e8f0", cursor: "#60a5fa" },
      fontSize: 12,
      fontFamily: "JetBrains Mono, Menlo, monospace",
      cursorBlink: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(termRef.current);
    fit.fit();

    xtermRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      fit.fit();
      if (tidRef.current) {
        resizeTerminal({ terminalId: tidRef.current, cols: term.cols, rows: term.rows });
      }
    });
    observer.observe(termRef.current);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

  const connect = async () => {
    setError(null);
    if (tidRef.current) {
      await closeTerminal(tidRef.current);
      tidRef.current = null;
    }
    xtermRef.current?.clear();
    xtermRef.current?.write("\r\n\x1b[32mConnecting…\x1b[0m\r\n");

    try {
      const tid = await startTerminal({ context, namespace, podName, container, shell });
      tidRef.current = tid;

      const unlisten = await listen<string>(`terminal-output-${tid}`, (event) => {
        const bytes = Uint8Array.from(atob(event.payload), (c) => c.charCodeAt(0));
        xtermRef.current?.write(bytes);
      });

      const disposeInput = xtermRef.current?.onData((data) => {
        const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(data)));
        writeTerminal({ terminalId: tid, data: encoded });
      });

      return () => {
        unlisten();
        disposeInput?.dispose();
        closeTerminal(tid);
        tidRef.current = null;
      };
    } catch (e: unknown) {
      const msg = String(e);
      setError(msg);
      xtermRef.current?.write(`\r\n\x1b[31mError: ${msg}\x1b[0m\r\n`);
    }
  };

  useEffect(() => {
    if (container === undefined) return;
    let cleanup: (() => void) | undefined;
    connect().then((fn) => { cleanup = fn; });
    return () => { cleanup?.(); };
  }, [context, namespace, podName, container, shell]);

  return (
    <div className="flex flex-col h-full bg-[#020617]">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 shrink-0">
        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded px-1 py-0.5"
          >
            {(containers as string[]).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}
        <select
          value={shell}
          onChange={(e) => setShell(e.target.value)}
          className="bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-700 text-slate-700 dark:text-slate-300 text-xs rounded px-1 py-0.5"
        >
          {SHELLS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {error && (
          <span className="text-xs text-red-600 dark:text-red-400 truncate flex-1">{error}</span>
        )}
        <button
          onClick={() => connect()}
          className="ml-auto text-xs px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-600 shrink-0"
        >
          Reconnect
        </button>
      </div>
      <div ref={termRef} className="flex-1 overflow-hidden p-1" />
    </div>
  );
}
