import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { getPodContainers, startLogStream, stopLogStream } from "../../lib/tauri";
import { Download, Loader2, Pause, Play, Search, X } from "lucide-react";

const MAX_LINES = 5000;

interface Props {
  context: string;
  namespace: string;
  podName: string;
}

export function PodLogsPanel({ context, namespace, podName }: Props) {
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [tailLines, setTailLines] = useState(200);
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [paused, setPaused] = useState(false);
  const [search, setSearch] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);
  const logRef = useRef<HTMLPreElement>(null);
  const pausedRef = useRef(false);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers", context, namespace, podName],
    queryFn: () => getPodContainers({ context, namespace, podName }),
  });

  useEffect(() => {
    if (containers.length && !container) setContainer(containers[0]);
  }, [containers]);

  // Sync paused state to ref so stream handler sees current value
  useEffect(() => {
    pausedRef.current = paused;
  }, [paused]);

  // Start/stop stream when container, tailLines, or follow changes
  useEffect(() => {
    if (container === undefined && containers.length > 0) return;
    if (!follow) return;

    let streamId: string | null = null;
    let unlisten: (() => void) | null = null;
    let active = true;

    const start = async () => {
      setLines([]);

      try {
        streamId = await startLogStream({
          context,
          namespace,
          podName,
          container,
          tailLines,
        });

        unlisten = await listen<string>(`log-line-${streamId}`, (event) => {
          if (!active || pausedRef.current) return;
          setLines((prev) => {
            const next = [...prev, event.payload];
            return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
          });
        });
      } catch (e) {
        if (active) setLines([`Error starting log stream: ${e}`]);
      }
    };

    start();

    return () => {
      active = false;
      unlisten?.();
      if (streamId) stopLogStream(streamId);
    };
  }, [context, namespace, podName, container, tailLines, follow]);

  // Auto-scroll
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [lines, autoScroll]);

  const handleScroll = () => {
    if (!logRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = logRef.current;
    setAutoScroll(scrollTop + clientHeight >= scrollHeight - 20);
  };

  const download = () => {
    const blob = new Blob([lines.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${podName}-${container ?? "default"}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const displayed = search.trim()
    ? lines.filter((l) => l.toLowerCase().includes(search.toLowerCase()))
    : lines;

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900 flex-wrap">
        <span className="text-xs text-slate-400 font-semibold shrink-0">LOGS</span>

        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
          >
            {(containers as string[]).map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        )}

        <select
          value={tailLines}
          onChange={(e) => setTailLines(Number(e.target.value))}
          className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
        >
          {[50, 100, 200, 500, 1000].map((n) => (
            <option key={n} value={n}>Last {n}</option>
          ))}
        </select>

        <button
          onClick={() => setFollow((f) => !f)}
          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
            follow
              ? "bg-green-500/15 border-green-500/30 text-green-400"
              : "bg-slate-800 border-slate-700 text-slate-400 hover:text-slate-300"
          }`}
        >
          {follow && <Loader2 size={10} className="animate-spin" />}
          {follow ? "Live" : "Static"}
        </button>

        {follow && (
          <button
            onClick={() => setPaused((p) => !p)}
            className="flex items-center gap-1 text-xs px-2 py-0.5 rounded border border-slate-700 text-slate-400 hover:text-slate-300 bg-slate-800"
          >
            {paused ? <Play size={10} /> : <Pause size={10} />}
            {paused ? "Resume" : "Pause"}
          </button>
        )}

        <span className="text-xs text-slate-600">{lines.length} lines</span>

        <div className="relative ml-auto">
          <Search size={10} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-slate-600" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search…"
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded pl-5 pr-5 py-0.5 w-32 focus:outline-none focus:border-blue-500"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-600"
            >
              <X size={10} />
            </button>
          )}
        </div>

        <button
          onClick={download}
          title="Download log"
          className="text-slate-500 hover:text-slate-300 p-1 rounded hover:bg-slate-800"
        >
          <Download size={12} />
        </button>
      </div>

      {/* Log output */}
      <div className="relative flex-1 overflow-hidden">
        <pre
          ref={logRef}
          onScroll={handleScroll}
          className="h-full overflow-auto p-3 text-xs font-mono text-green-400 leading-5 whitespace-pre-wrap break-all"
        >
          {displayed.length === 0 ? (
            <span className="text-slate-600">Waiting for logs…</span>
          ) : (
            displayed.map((line, i) => {
              const isMatch =
                search && line.toLowerCase().includes(search.toLowerCase());
              return (
                <span key={i} className={isMatch ? "bg-yellow-500/20" : ""}>
                  {line}{"\n"}
                </span>
              );
            })
          )}
        </pre>

        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true);
              if (logRef.current)
                logRef.current.scrollTop = logRef.current.scrollHeight;
            }}
            className="absolute bottom-3 right-4 text-xs bg-blue-600 text-white px-2 py-1 rounded shadow"
          >
            ↓ Jump to bottom
          </button>
        )}
      </div>
    </div>
  );
}
