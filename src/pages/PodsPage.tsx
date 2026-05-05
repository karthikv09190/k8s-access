import { useState, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../store/app";
import { listPods, deleteResource } from "../lib/tauri";
import { ResourceTable, StatusBadge, type Column } from "../components/resources/ResourceTable";
import { ConfirmDialog } from "../components/ui/ConfirmDialog";
import { RefreshSelect } from "../components/ui/RefreshSelect";
import { ContainerStatusIcons } from "../components/pods/ContainerStatusIcons";
import { useKeyboardNav } from "../hooks/useKeyboardNav";
import { age } from "../lib/utils";
import { PodActionsPanel } from "../components/pods/PodActionsPanel";
import { Search, X } from "lucide-react";

export function PodsPage() {
  const { activeContext, activeNamespace } = useAppStore();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [pendingDelete, setPendingDelete] = useState<any | null>(null);
  const [refreshInterval, setRefreshInterval] = useState(15_000);
  const searchRef = useRef<HTMLInputElement>(null);

  const { data = [], isLoading } = useQuery({
    queryKey: ["pods", activeContext, activeNamespace],
    queryFn: () =>
      listPods({ context: activeContext, namespace: activeNamespace || undefined }),
    enabled: !!activeContext,
    refetchInterval: refreshInterval || false,
  });

  const pods = data as any[];

  const filtered = useMemo(() => {
    return pods.filter((p) => {
      const nameMatch =
        !search.trim() ||
        p.metadata?.name?.toLowerCase().includes(search.toLowerCase()) ||
        p.metadata?.namespace?.toLowerCase().includes(search.toLowerCase()) ||
        p.spec?.nodeName?.toLowerCase().includes(search.toLowerCase());
      const statusMatch =
        statusFilter === "all" || p.status?.phase === statusFilter;
      return nameMatch && statusMatch;
    });
  }, [pods, search, statusFilter]);

  const columns: Column<any>[] = [
    {
      header: "Name",
      accessor: (p) => (
        <span className="font-mono text-xs text-slate-200">{p.metadata?.name}</span>
      ),
    },
    {
      header: "Namespace",
      accessor: (p) => (
        <span className="text-xs text-slate-400">{p.metadata?.namespace}</span>
      ),
      width: "100px",
    },
    {
      header: "Status",
      accessor: (p) => <StatusBadge status={p.status?.phase} />,
      width: "100px",
    },
    {
      header: "Ready",
      accessor: (p) => {
        const cs = p.status?.containerStatuses ?? [];
        const ready = cs.filter((c: any) => c.ready).length;
        return (
          <span className="text-xs text-slate-400">
            {ready}/{cs.length || p.spec?.containers?.length || 0}
          </span>
        );
      },
      width: "60px",
    },
    {
      header: "Restarts",
      accessor: (p) => {
        const total = (p.status?.containerStatuses ?? []).reduce(
          (sum: number, c: any) => sum + (c.restartCount ?? 0),
          0
        );
        return (
          <span className={`text-xs ${total > 0 ? "text-yellow-400" : "text-slate-400"}`}>
            {total}
          </span>
        );
      },
      width: "70px",
    },
    {
      header: "Containers",
      accessor: (p) => (
        <ContainerStatusIcons containerStatuses={p.status?.containerStatuses ?? []} />
      ),
      width: "80px",
    },
    {
      header: "Node",
      accessor: (p) => (
        <span className="text-xs text-slate-500 font-mono">{p.spec?.nodeName ?? "-"}</span>
      ),
    },
    {
      header: "Age",
      accessor: (p) => (
        <span className="text-xs text-slate-500">{age(p.metadata?.creationTimestamp)}</span>
      ),
      width: "60px",
    },
  ];

  const handleDelete = (pod: any) => setPendingDelete(pod);

  useKeyboardNav({
    items: filtered,
    selectedKey: selected,
    getKey: (p) => p.metadata?.uid ?? p.metadata?.name,
    onSelect: (p) => setSelected(p.metadata?.name),
    onClose: () => setSelected(null),
    onDelete: handleDelete,
    searchRef,
  });

  const selectedPod = pods.find((p) => p.metadata?.name === selected);

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    await deleteResource({
      context: activeContext,
      namespace: pendingDelete.metadata?.namespace,
      kind: "Pod",
      name: pendingDelete.metadata?.name,
    });
    qc.invalidateQueries({ queryKey: ["pods"] });
    setPendingDelete(null);
  };

  return (
    <div className="flex flex-col h-full">
      {pendingDelete && (
        <ConfirmDialog
          message={`Delete pod "${pendingDelete.metadata?.name}"?`}
          confirmLabel="Delete"
          onConfirm={confirmDelete}
          onCancel={() => setPendingDelete(null)}
        />
      )}
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-slate-800 flex-wrap shrink-0">
        <h2 className="text-sm font-semibold text-slate-200 shrink-0">
          Pods{" "}
          <span className="text-slate-500 font-normal">
            ({search || statusFilter !== "all" ? `${filtered.length}/` : ""}{pods.length})
          </span>
        </h2>

        {/* Search */}
        <div className="relative">
          <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, namespace, node..."
            className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded pl-6 pr-6 py-1 w-52 focus:outline-none focus:border-blue-500"
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

        {/* Status filter */}
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="bg-slate-800 border border-slate-700 text-slate-300 text-xs rounded px-2 py-1 focus:outline-none focus:border-blue-500"
        >
          <option value="all">All statuses</option>
          <option value="Running">Running</option>
          <option value="Pending">Pending</option>
          <option value="Failed">Failed</option>
          <option value="Succeeded">Succeeded</option>
        </select>

        <div className="ml-auto">
          <RefreshSelect value={refreshInterval} onChange={setRefreshInterval} />
        </div>
      </div>

      {/* Content: table + side panel */}
      <div className="flex-1 overflow-hidden flex flex-row">
        {/* Pod list — always full height */}
        <div className="flex-1 overflow-auto min-w-0">
          <ResourceTable
            columns={columns}
            data={filtered}
            getKey={(p) => p.metadata?.uid ?? p.metadata?.name}
            onSelect={(p) => setSelected(p.metadata?.name)}
            onDelete={handleDelete}
            selected={selected ?? undefined}
            loading={isLoading}
            emptyMessage={
              search || statusFilter !== "all"
                ? `No pods match the current filters`
                : undefined
            }
          />
        </div>

        {/* Right side panel */}
        {selected && selectedPod && (
          <div className="w-[440px] shrink-0 border-l border-slate-800 overflow-hidden flex flex-col">
            <PodActionsPanel
              context={activeContext}
              pod={selectedPod}
              onClose={() => setSelected(null)}
            />
          </div>
        )}
      </div>
    </div>
  );
}
