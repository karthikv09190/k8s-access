import { X, Plus } from "lucide-react";

export interface Tab {
  id: string;
  page: string;
  title: string;
}

export const PAGE_TITLES: Record<string, string> = {
  dashboard: "Dashboard",
  pods: "Pods",
  deployments: "Deployments",
  statefulsets: "StatefulSets",
  daemonsets: "DaemonSets",
  replicasets: "ReplicaSets",
  jobs: "Jobs",
  cronjobs: "CronJobs",
  services: "Services",
  ingresses: "Ingresses",
  configmaps: "ConfigMaps",
  secrets: "Secrets",
  pvcs: "PVCs",
  pvs: "PVs",
  nodes: "Nodes",
  events: "Events",
  hpas: "HPAs",
  pdbs: "PDBs",
  networkpolicies: "NetworkPolicies",
  resourcequotas: "ResourceQuotas",
  limitranges: "LimitRanges",
  storageclasses: "StorageClasses",
  endpoints: "Endpoints",
  serviceaccounts: "ServiceAccounts",
  roles: "Roles",
  rolebindings: "RoleBindings",
  clusterroles: "ClusterRoles",
  clusterrolebindings: "ClusterRoleBindings",
  compare: "Compare",
  helm: "Helm",
  rbac: "RBAC Viz",
  problemPods: "Problems",
  selfHealing: "Self-Healing",
  resourceGraph: "Res. Graph",
  gitops: "GitOps",
  namespaceCost: "Cost",
  crdBrowser: "CRDs",
  webhooks: "Webhooks",
  kubeconfig: "Kubeconfig",
};

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onNewTab: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
}: TabBarProps) {
  const canClose = tabs.length > 1;
  const canAdd = tabs.length < 8;

  return (
    <div
      className="flex items-center bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 shrink-0"
      style={{ height: "36px" }}
    >
      <div className="flex items-center flex-1 overflow-x-auto min-w-0 [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className={`group flex items-center gap-1.5 px-3 py-1.5 text-xs whitespace-nowrap cursor-pointer select-none shrink-0 border-b-2 transition-colors ${
                isActive
                  ? "bg-blue-100 dark:bg-blue-600/20 text-blue-600 dark:text-blue-400 border-blue-500"
                  : "text-slate-500 dark:text-slate-400 border-transparent hover:text-slate-900 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5"
              }`}
              onClick={() => onSelectTab(tab.id)}
            >
              <span className="max-w-[120px] truncate">{tab.title}</span>
              {canClose && (
                <button
                  className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 rounded hover:text-red-400 p-0.5"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  aria-label={`Close ${tab.title}`}
                >
                  <X size={10} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {canAdd && (
        <button
          className="flex items-center justify-center w-8 h-full text-slate-500 hover:text-slate-900 dark:hover:text-slate-200 hover:bg-black/5 dark:hover:bg-white/5 transition-colors shrink-0"
          onClick={onNewTab}
          aria-label="New tab"
        >
          <Plus size={13} />
        </button>
      )}
    </div>
  );
}
