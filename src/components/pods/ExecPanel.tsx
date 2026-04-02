import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { getPodContainers, execPodCommand } from "../../lib/tauri";
import { Play, Terminal } from "lucide-react";

interface Props {
  context: string;
  namespace: string;
  podName: string;
}

export function ExecPanel({ context, namespace, podName }: Props) {
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [command, setCommand] = useState("ls -la");
  const [output, setOutput] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: containers = [] } = useQuery({
    queryKey: ["containers", context, namespace, podName],
    queryFn: () => getPodContainers({ context, namespace, podName }),
  });

  useEffect(() => {
    const list = containers as string[];
    if (list.length && !container) setContainer(list[0]);
  }, [containers]);

  const run = async () => {
    if (!command.trim()) return;
    setRunning(true);
    setError(null);
    setOutput(null);
    try {
      const parts = command.trim().split(/\s+/);
      const result = await execPodCommand({
        context,
        namespace,
        podName,
        container,
        command: parts,
      });
      setOutput(result || "(no output)");
    } catch (e: any) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  };

  const openShell = async () => {
    setCommand("/bin/sh");
    setRunning(true);
    setError(null);
    setOutput(null);
    try {
      const result = await execPodCommand({
        context,
        namespace,
        podName,
        container,
        command: ["/bin/sh", "-c", "echo 'Shell session not supported in non-interactive mode. Use kubectl exec -it instead.'"],
      });
      setOutput(result);
    } catch {
      // try bash
      try {
        const result = await execPodCommand({
          context,
          namespace,
          podName,
          container,
          command: ["/bin/bash", "-c", "echo 'Shell session not supported in non-interactive mode. Use kubectl exec -it instead.'"],
        });
        setOutput(result);
      } catch (e2: any) {
        setError(String(e2));
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-900">
        <Terminal size={12} className="text-slate-400" />
        <span className="text-xs text-slate-400 font-semibold">EXEC</span>
        {containers.length > 1 && (
          <select
            value={container}
            onChange={(e) => setContainer(e.target.value)}
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-1 py-0.5"
          >
            {(containers as string[]).map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={openShell}
          className="ml-auto text-xs px-2 py-0.5 rounded bg-slate-700 text-slate-300 hover:bg-slate-600 flex items-center gap-1"
        >
          <Terminal size={10} />
          Shell info
        </button>
      </div>

      {/* Command input */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800">
        <span className="text-xs text-slate-500 font-mono shrink-0">$</span>
        <input
          type="text"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && run()}
          placeholder="Command to run..."
          className="flex-1 bg-slate-800 border border-slate-700 text-slate-200 text-xs font-mono rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        />
        <button
          onClick={run}
          disabled={running}
          className="shrink-0 text-xs px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white flex items-center gap-1"
        >
          <Play size={10} />
          {running ? "Running..." : "Run"}
        </button>
      </div>

      {/* Output */}
      <pre className="flex-1 overflow-auto p-3 text-xs font-mono leading-5 whitespace-pre-wrap break-all">
        {error && <span className="text-red-400">{error}</span>}
        {output && <span className="text-green-400">{output}</span>}
        {!output && !error && !running && (
          <span className="text-slate-600">
            Type a command above and press Run or Enter.{"\n"}
            Examples: ls -la | cat /etc/hosts | env | ps aux
          </span>
        )}
        {running && <span className="text-slate-500">Running...</span>}
      </pre>
    </div>
  );
}
