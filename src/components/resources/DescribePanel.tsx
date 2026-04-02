import { useQuery } from "@tanstack/react-query";
import { describeResource } from "../../lib/tauri";
import { RefreshCw } from "lucide-react";

interface Props {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}

export function DescribePanel({ context, namespace, kind, name }: Props) {
  const { data = "", isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["describe", context, namespace, kind, name],
    queryFn: () => describeResource({ context, namespace, kind, name }),
  });

  return (
    <div className="flex flex-col h-full bg-slate-950">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-slate-800 bg-slate-900 shrink-0">
        <span className="text-xs text-slate-400 font-semibold">DESCRIBE</span>
        <span className="text-xs text-slate-600">{kind}/{name}</span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="ml-auto text-slate-500 hover:text-slate-300 disabled:opacity-50"
        >
          <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
        </button>
      </div>
      <pre className="flex-1 overflow-auto p-3 text-xs font-mono text-slate-300 leading-5 whitespace-pre">
        {isLoading && "Loading..."}
        {error && <span className="text-red-400">{String(error)}</span>}
        {!isLoading && !error && (data || "No output.")}
      </pre>
    </div>
  );
}
