import { ChevronRight, Trash2 } from "lucide-react";
import { cn } from "../../lib/utils";

export interface Column<T> {
  header: string;
  accessor: (row: T) => React.ReactNode;
  width?: string;
}

interface ResourceTableProps<T> {
  columns: Column<T>[];
  data: T[];
  getKey: (row: T) => string;
  onSelect?: (row: T) => void;
  onDelete?: (row: T) => void;
  selected?: string;
  loading?: boolean;
  emptyMessage?: string;
}

export function ResourceTable<T>({
  columns,
  data,
  getKey,
  onSelect,
  onDelete,
  selected,
  loading,
  emptyMessage = "No resources found",
}: ResourceTableProps<T>) {
  if (loading) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        Loading...
      </div>
    );
  }

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-40 text-slate-500 text-sm">
        {emptyMessage}
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b border-slate-200 dark:border-slate-800">
            {columns.map((col) => (
              <th
                key={col.header}
                className="px-3 py-2 text-left text-xs font-medium text-slate-500 dark:text-slate-500 uppercase tracking-wider"
                style={{ width: col.width }}
              >
                {col.header}
              </th>
            ))}
            {(onSelect || onDelete) && <th className="w-16" />}
          </tr>
        </thead>
        <tbody>
          {data.map((row) => {
            const key = getKey(row);
            const isSelected = selected === key;
            return (
              <tr
                key={key}
                onClick={() => onSelect?.(row)}
                className={cn(
                  "border-b border-slate-200/50 dark:border-slate-800/50 transition-colors group",
                  onSelect && "cursor-pointer",
                  isSelected
                    ? "bg-blue-100 dark:bg-blue-600/10"
                    : "hover:bg-black/5 dark:hover:bg-white/5"
                )}
              >
                {columns.map((col) => (
                  <td
                    key={col.header}
                    className="px-3 py-2 text-slate-700 dark:text-slate-300"
                  >
                    {col.accessor(row)}
                  </td>
                ))}
                {(onSelect || onDelete) && (
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100">
                      {onSelect && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelect(row);
                          }}
                          className="p-1 text-slate-500 dark:text-slate-400 hover:text-blue-600 dark:hover:text-blue-400 rounded"
                        >
                          <ChevronRight size={14} />
                        </button>
                      )}
                      {onDelete && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(row);
                          }}
                          className="p-1 text-slate-500 dark:text-slate-400 hover:text-red-600 dark:hover:text-red-400 rounded"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status?: string }) {
  const color = {
    Running: "text-green-400 bg-green-400/10",
    Succeeded: "text-green-400 bg-green-400/10",
    Pending: "text-yellow-400 bg-yellow-400/10",
    Failed: "text-red-400 bg-red-400/10",
    CrashLoopBackOff: "text-red-400 bg-red-400/10",
    Unknown: "text-slate-400 bg-slate-400/10",
    Terminating: "text-orange-400 bg-orange-400/10",
    Active: "text-green-400 bg-green-400/10",
  }[status ?? ""] ?? "text-slate-400 bg-slate-400/10";

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium",
        color
      )}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-current" />
      {status ?? "Unknown"}
    </span>
  );
}
