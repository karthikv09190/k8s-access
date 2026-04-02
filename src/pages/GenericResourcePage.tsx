import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { ResourceTable, type Column } from "../components/resources/ResourceTable";
import { ResourceActionsPanel, type ResourceTab } from "../components/resources/ResourceActionsPanel";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { age } from "../lib/utils";
import type { InvokeArgs } from "@tauri-apps/api/core";
import { invoke } from "@tauri-apps/api/core";
import { deleteResource } from "../lib/tauri";
import { Search, X } from "lucide-react";

interface GenericResourcePageProps {
  title: string;
  kind: string;
  invokeCmd: string;
  namespaced?: boolean;
  extraColumns?: Column<any>[];
  supportsDelete?: boolean;
  actionTabs?: ResourceTab[];
}

export function GenericResourcePage({
  title,
  kind,
  invokeCmd,
  namespaced = true,
  extraColumns = [],
  supportsDelete = false,
  actionTabs = ["yaml", "edit", "describe"],
}: GenericResourcePageProps) {
  const { activeContext, activeNamespace } = useAppStore();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);

  const queryArgs: Record<string, string | undefined> = {
    context: activeContext,
    ...(namespaced ? { namespace: activeNamespace || undefined } : {}),
  };

  const { data = [], isLoading } = useQuery({
    queryKey: [invokeCmd, activeContext, activeNamespace],
    queryFn: () => invoke<unknown[]>(invokeCmd, queryArgs as InvokeArgs),
    enabled: !!activeContext,
    refetchInterval: 30000,
  });

  const resources = data as any[];

  const filtered = useMemo(() => {
    if (!search.trim()) return resources;
    const q = search.toLowerCase();
    return resources.filter(
      (r) =>
        r.metadata?.name?.toLowerCase().includes(q) ||
        r.metadata?.namespace?.toLowerCase().includes(q)
    );
  }, [resources, search]);

  const baseColumns: Column<any>[] = [
    {
      header: "Name",
      accessor: (r) => (
        <span className="font-mono text-xs text-slate-200">{r.metadata?.name}</span>
      ),
    },
    ...(namespaced
      ? [
          {
            header: "Namespace",
            accessor: (r: any) => (
              <span className="text-xs text-slate-400">{r.metadata?.namespace}</span>
            ),
            width: "120px",
          },
        ]
      : []),
    ...extraColumns,
    {
      header: "Age",
      accessor: (r) => (
        <span className="text-xs text-slate-500">{age(r.metadata?.creationTimestamp)}</span>
      ),
      width: "60px",
    },
  ];

  const handleDelete = (r: any) => setPendingDelete(r);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteResource({
      context: activeContext,
      namespace: pendingDelete.metadata?.namespace,
      kind,
      name: pendingDelete.metadata?.name,
    });
    qc.invalidateQueries({ queryKey: [invokeCmd] });
    setPendingDelete(null);
  };

  const selectedResource = resources.find((r) => r.metadata?.name === selected);

  return (
    <div className="flex flex-col h-full">
      {pendingDelete && (
        <ConfirmDialog
          message={`Delete ${kind} "${pendingDelete.metadata?.name}"?`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 shrink-0">
        <h2 className="text-sm font-semibold text-slate-200 shrink-0">
          {title}{" "}
          <span className="text-slate-500 font-normal">
            ({search ? `${filtered.length}/` : ""}{resources.length})
          </span>
        </h2>

        <div className="flex-1 relative max-w-xs">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name..."
            className="w-full bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded pl-6 pr-6 py-1 focus:outline-none focus:border-blue-500"
          />
          {search && (
            <button
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* Content: table + side panel */}
      <div className="flex-1 overflow-hidden flex flex-row">
        {/* Resource list — always full height */}
        <div className="flex-1 overflow-auto min-w-0">
          <ResourceTable
            columns={baseColumns}
            data={filtered}
            getKey={(r) => r.metadata?.uid ?? r.metadata?.name}
            onSelect={(r) => setSelected(r.metadata?.name)}
            onDelete={supportsDelete ? handleDelete : undefined}
            selected={selected ?? undefined}
            loading={isLoading}
            emptyMessage={search ? `No ${title.toLowerCase()} match "${search}"` : undefined}
          />
        </div>

        {/* Right side panel */}
        {selected && selectedResource && (
          <div className="w-[440px] shrink-0 border-l border-slate-800 overflow-hidden flex flex-col">
            <ResourceActionsPanel
              context={activeContext}
              namespace={selectedResource.metadata?.namespace}
              kind={kind}
              resource={selectedResource}
              tabs={actionTabs}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
