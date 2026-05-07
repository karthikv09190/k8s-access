import { useState, useEffect } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useAppStore } from "./store/app";
import { Sidebar } from "./components/layout/Sidebar";
import { TopBar } from "./components/layout/TopBar";
import { TabBar, PAGE_TITLES } from "./components/layout/TabBar";
import type { Tab } from "./components/layout/TabBar";
import { DashboardPage } from "./pages/DashboardPage";
import { PodsPage } from "./pages/PodsPage";
import { ComparePage } from "./pages/ComparePage";
import { EventsPage } from "./pages/EventsPage";
import { GenericResourcePage } from "./pages/GenericResourcePage";
import { ProblemPodsPage } from "./pages/ProblemPodsPage";
import { RbacVisualizerPage } from "./pages/RbacVisualizerPage";
import { HelmPage } from "./pages/HelmPage";
import { ResourceGraphPage } from "./pages/ResourceGraphPage";
import { GitOpsPage } from "./pages/GitOpsPage";
import { NamespaceCostPage } from "./pages/NamespaceCostPage";
import { CrdBrowserPage } from "./pages/CrdBrowserPage";
import { WebhookConfigsPage } from "./pages/WebhookConfigsPage";
import { KubeconfigPage } from "./pages/KubeconfigPage";
import { StatusBadge } from "./components/resources/ResourceTable";
import { GlobalSearch } from "./components/GlobalSearch";
import { checkKubectl, KubectlStatus } from "./lib/tauri";
import { AlertTriangle, X, Terminal } from "lucide-react";

// Apply initial theme before first render to avoid flash
const _t = localStorage.getItem('k8s-theme') ?? 'dark';
if (_t === 'dark') document.documentElement.classList.add('dark');

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
    },
  },
});

function PageRouter({
  page,
  onRefreshKey,
  onNavigate,
}: {
  page: string;
  onRefreshKey: number;
  onNavigate: (p: string) => void;
}) {
  switch (page) {
    case "dashboard":
      return <DashboardPage key={onRefreshKey} onNavigate={onNavigate} />;
    case "pods":
      return <PodsPage key={onRefreshKey} />;
    case "compare":
      return <ComparePage key={onRefreshKey} />;
    case "events":
      return <EventsPage key={onRefreshKey} />;
    case "problemPods":
      return <ProblemPodsPage key={onRefreshKey} />;
    case "deployments":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Deployments"
          kind="Deployment"
          invokeCmd="list_deployments"
          actionTabs={["yaml", "edit", "describe", "events", "scale", "restart", "rollout"]}
          extraColumns={[
            {
              header: "Replicas",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.status?.readyReplicas ?? 0}/{r.spec?.replicas ?? 0}
                </span>
              ),
              width: "80px",
            },
            {
              header: "Image",
              accessor: (r) => (
                <span className="font-mono text-xs text-slate-500 truncate max-w-xs block">
                  {r.spec?.template?.spec?.containers?.[0]?.image ?? "-"}
                </span>
              ),
            },
          ]}
          supportsDelete
        />
      );
    case "statefulsets":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="StatefulSets"
          kind="StatefulSet"
          invokeCmd="list_statefulsets"
          actionTabs={["yaml", "edit", "describe", "events", "scale", "restart", "rollout"]}
          extraColumns={[
            {
              header: "Replicas",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.status?.readyReplicas ?? 0}/{r.spec?.replicas ?? 0}
                </span>
              ),
              width: "80px",
            },
          ]}
        />
      );
    case "daemonsets":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="DaemonSets"
          kind="DaemonSet"
          invokeCmd="list_daemonsets"
          actionTabs={["yaml", "edit", "describe", "events", "restart"]}
          extraColumns={[
            {
              header: "Desired/Ready",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.status?.desiredNumberScheduled ?? 0}/{r.status?.numberReady ?? 0}
                </span>
              ),
              width: "100px",
            },
          ]}
        />
      );
    case "replicasets":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ReplicaSets"
          kind="ReplicaSet"
          invokeCmd="list_replicasets"
          actionTabs={["yaml", "edit", "describe", "events", "scale"]}
        />
      );
    case "jobs":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Jobs"
          kind="Job"
          invokeCmd="list_jobs"
          actionTabs={["yaml", "edit", "describe", "events"]}
          extraColumns={[
            {
              header: "Status",
              accessor: (r) => {
                const conds = r.status?.conditions ?? [];
                const complete = conds.find((c: any) => c.type === "Complete");
                const failed = conds.find((c: any) => c.type === "Failed");
                const status = failed ? "Failed" : complete ? "Succeeded" : "Running";
                return <StatusBadge status={status} />;
              },
              width: "90px",
            },
          ]}
        />
      );
    case "cronjobs":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="CronJobs"
          kind="CronJob"
          invokeCmd="list_cronjobs"
          actionTabs={["trigger", "yaml", "edit", "describe", "events"]}
          extraColumns={[
            {
              header: "Schedule",
              accessor: (r) => (
                <span className="font-mono text-xs text-slate-400">
                  {r.spec?.schedule ?? "-"}
                </span>
              ),
            },
            {
              header: "Last Run",
              accessor: (r) => (
                <span className="text-xs text-slate-500">
                  {r.status?.lastScheduleTime
                    ? new Date(r.status.lastScheduleTime).toLocaleString()
                    : "-"}
                </span>
              ),
            },
            {
              header: "Active",
              accessor: (r) => (
                <span className={`text-xs ${(r.status?.active?.length ?? 0) > 0 ? "text-green-400" : "text-slate-500"}`}>
                  {r.status?.active?.length ?? 0}
                </span>
              ),
              width: "60px",
            },
          ]}
        />
      );
    case "services":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Services"
          kind="Service"
          invokeCmd="list_services"
          supportsDelete
          actionTabs={["yaml", "edit", "describe", "events", "portforward"]}
          extraColumns={[
            {
              header: "Type",
              accessor: (r) => (
                <span className="text-xs text-slate-400">{r.spec?.type ?? "-"}</span>
              ),
              width: "100px",
            },
            {
              header: "Cluster IP",
              accessor: (r) => (
                <span className="font-mono text-xs text-slate-500">{r.spec?.clusterIP ?? "-"}</span>
              ),
              width: "120px",
            },
          ]}
        />
      );
    case "ingresses":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Ingresses"
          kind="Ingress"
          invokeCmd="list_ingresses"
          actionTabs={["rules", "yaml", "edit", "describe", "events"]}
          extraColumns={[
            {
              header: "Hosts",
              accessor: (r) => {
                const rules = r.spec?.rules ?? [];
                const hosts = rules
                  .map((rule: any) => rule.host ?? "*")
                  .filter(Boolean)
                  .join(", ");
                return (
                  <span className="font-mono text-xs text-slate-300 truncate max-w-[160px] block">
                    {hosts || "-"}
                  </span>
                );
              },
            },
            {
              header: "Rules",
              accessor: (r) => {
                const rules = r.spec?.rules ?? [];
                const paths = rules.flatMap((rule: any) =>
                  (rule.http?.paths ?? []).map((p: any) => {
                    const svc = p.backend?.service?.name ?? p.backend?.serviceName ?? "?";
                    const port =
                      p.backend?.service?.port?.number ??
                      p.backend?.service?.port?.name ??
                      p.backend?.servicePort ??
                      "?";
                    return `${p.path ?? "/"} → ${svc}:${port}`;
                  })
                );
                return (
                  <div className="flex flex-col gap-0.5">
                    {paths.length === 0 ? (
                      <span className="text-xs text-slate-500">-</span>
                    ) : (
                      paths.slice(0, 2).map((p: string, i: number) => (
                        <span key={i} className="font-mono text-xs text-slate-400 truncate max-w-[200px] block">
                          {p}
                        </span>
                      ))
                    )}
                    {paths.length > 2 && (
                      <span className="text-xs text-slate-600">+{paths.length - 2} more</span>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      );
    case "configmaps":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ConfigMaps"
          kind="ConfigMap"
          invokeCmd="list_configmaps"
          extraColumns={[
            {
              header: "Keys",
              accessor: (r) => (
                <span className="text-xs text-slate-500">
                  {Object.keys(r.data ?? {}).length} keys
                </span>
              ),
              width: "70px",
            },
          ]}
        />
      );
    case "secrets":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Secrets"
          kind="Secret"
          invokeCmd="list_secrets"
          actionTabs={["values", "yaml", "describe", "events"]}
          extraColumns={[
            {
              header: "Type",
              accessor: (r) => (
                <span className="text-xs text-slate-500">{r.type ?? "-"}</span>
              ),
            },
            {
              header: "Keys",
              accessor: (r) => (
                <span className="text-xs text-slate-500">
                  {Object.keys(r.data ?? {}).length}
                </span>
              ),
              width: "50px",
            },
          ]}
        />
      );
    case "pvcs":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="PersistentVolumeClaims"
          kind="PersistentVolumeClaim"
          invokeCmd="list_pvcs"
          extraColumns={[
            {
              header: "Status",
              accessor: (r) => <StatusBadge status={r.status?.phase} />,
              width: "90px",
            },
            {
              header: "Capacity",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.spec?.resources?.requests?.storage ?? "-"}
                </span>
              ),
              width: "80px",
            },
          ]}
        />
      );
    case "pvs":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="PersistentVolumes"
          kind="PersistentVolume"
          invokeCmd="list_pvs"
          namespaced={false}
          extraColumns={[
            {
              header: "Status",
              accessor: (r) => <StatusBadge status={r.status?.phase} />,
              width: "90px",
            },
            {
              header: "Capacity",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.spec?.capacity?.storage ?? "-"}
                </span>
              ),
              width: "80px",
            },
          ]}
        />
      );
    case "nodes":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Nodes"
          kind="Node"
          invokeCmd="list_nodes"
          namespaced={false}
          actionTabs={["nodeops", "nodemetrics", "yaml", "describe", "events"]}
          extraColumns={[
            {
              header: "Status",
              accessor: (r) => {
                const ready = r.status?.conditions?.find(
                  (c: any) => c.type === "Ready"
                );
                return <StatusBadge status={ready?.status === "True" ? "Running" : "Unknown"} />;
              },
              width: "90px",
            },
            {
              header: "Version",
              accessor: (r) => (
                <span className="font-mono text-xs text-slate-500">
                  {r.status?.nodeInfo?.kubeletVersion ?? "-"}
                </span>
              ),
            },
          ]}
        />
      );
    case "serviceaccounts":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ServiceAccounts"
          kind="ServiceAccount"
          invokeCmd="list_serviceaccounts"
        />
      );
    case "roles":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Roles"
          kind="Role"
          invokeCmd="list_roles"
        />
      );
    case "rolebindings":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="RoleBindings"
          kind="RoleBinding"
          invokeCmd="list_rolebindings"
        />
      );
    case "clusterroles":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ClusterRoles"
          kind="ClusterRole"
          invokeCmd="list_clusterroles"
          namespaced={false}
        />
      );
    case "clusterrolebindings":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ClusterRoleBindings"
          kind="ClusterRoleBinding"
          invokeCmd="list_clusterrolebindings"
          namespaced={false}
        />
      );
    case "rbac":
      return <RbacVisualizerPage key={onRefreshKey} />;
    case "hpas":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="HorizontalPodAutoscalers"
          kind="HorizontalPodAutoscaler"
          invokeCmd="list_hpas"
          actionTabs={["yaml", "edit", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Target",
              accessor: (r) => (
                <span className="text-xs text-slate-400 truncate max-w-[140px] block">
                  {r.spec?.scaleTargetRef?.kind}/{r.spec?.scaleTargetRef?.name}
                </span>
              ),
            },
            {
              header: "Min/Max",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.spec?.minReplicas ?? 1}/{r.spec?.maxReplicas ?? "?"}
                </span>
              ),
              width: "70px",
            },
            {
              header: "Current",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {r.status?.currentReplicas ?? "?"}/{r.status?.desiredReplicas ?? "?"}
                </span>
              ),
              width: "70px",
            },
          ]}
        />
      );
    case "pdbs":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="PodDisruptionBudgets"
          kind="PodDisruptionBudget"
          invokeCmd="list_pdbs"
          actionTabs={["yaml", "edit", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Min Available",
              accessor: (r) => (
                <span className="text-xs text-slate-400">{r.spec?.minAvailable ?? "-"}</span>
              ),
              width: "100px",
            },
            {
              header: "Max Unavailable",
              accessor: (r) => (
                <span className="text-xs text-slate-400">{r.spec?.maxUnavailable ?? "-"}</span>
              ),
              width: "120px",
            },
            {
              header: "Disruptions",
              accessor: (r) => (
                <span
                  className={`text-xs font-medium ${
                    (r.status?.disruptionsAllowed ?? 0) > 0 ? "text-green-400" : "text-amber-400"
                  }`}
                >
                  {r.status?.disruptionsAllowed ?? 0} allowed
                </span>
              ),
              width: "110px",
            },
          ]}
        />
      );
    case "networkpolicies":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="NetworkPolicies"
          kind="NetworkPolicy"
          invokeCmd="list_networkpolicies"
          actionTabs={["yaml", "edit", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Pod Selector",
              accessor: (r) => {
                const sel = r.spec?.podSelector?.matchLabels ?? {};
                const entries = Object.entries(sel);
                return (
                  <span className="font-mono text-xs text-slate-400 truncate max-w-[160px] block">
                    {entries.length === 0 ? "all pods" : entries.map(([k, v]) => `${k}=${v}`).join(", ")}
                  </span>
                );
              },
            },
            {
              header: "Policy Types",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {(r.spec?.policyTypes ?? []).join(", ") || "-"}
                </span>
              ),
              width: "130px",
            },
          ]}
        />
      );
    case "resourcequotas":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="ResourceQuotas"
          kind="ResourceQuota"
          invokeCmd="list_resourcequotas"
          actionTabs={["yaml", "edit", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Used / Hard",
              accessor: (r) => {
                const hard = r.status?.hard ?? {};
                const used = r.status?.used ?? {};
                const keys = Object.keys(hard).slice(0, 2);
                return (
                  <div className="flex flex-col gap-0.5">
                    {keys.map((k) => (
                      <span key={k} className="font-mono text-xs text-slate-400 truncate">
                        {k}: {used[k] ?? "0"}/{hard[k]}
                      </span>
                    ))}
                    {Object.keys(hard).length > 2 && (
                      <span className="text-xs text-slate-600">+{Object.keys(hard).length - 2} more</span>
                    )}
                  </div>
                );
              },
            },
          ]}
        />
      );
    case "limitranges":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="LimitRanges"
          kind="LimitRange"
          invokeCmd="list_limitranges"
          actionTabs={["yaml", "edit", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Limit Types",
              accessor: (r) => (
                <span className="text-xs text-slate-400">
                  {(r.spec?.limits ?? []).map((l: any) => l.type).join(", ") || "-"}
                </span>
              ),
            },
          ]}
        />
      );
    case "storageclasses":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="StorageClasses"
          kind="StorageClass"
          invokeCmd="list_storageclasses"
          namespaced={false}
          actionTabs={["yaml", "describe", "events"]}
          supportsDelete
          extraColumns={[
            {
              header: "Provisioner",
              accessor: (r) => (
                <span className="font-mono text-xs text-slate-400 truncate max-w-[180px] block">
                  {r.provisioner ?? "-"}
                </span>
              ),
            },
            {
              header: "Reclaim",
              accessor: (r) => (
                <span className="text-xs text-slate-400">{r.reclaimPolicy ?? "-"}</span>
              ),
              width: "90px",
            },
            {
              header: "Default",
              accessor: (r) => {
                const isDefault =
                  r.metadata?.annotations?.["storageclass.kubernetes.io/is-default-class"] === "true";
                return isDefault ? (
                  <span className="text-xs text-green-400 font-medium">default</span>
                ) : (
                  <span className="text-xs text-slate-600">-</span>
                );
              },
              width: "65px",
            },
          ]}
        />
      );
    case "endpoints":
      return (
        <GenericResourcePage
          key={onRefreshKey}
          title="Endpoints"
          kind="Endpoints"
          invokeCmd="list_endpoints"
          actionTabs={["yaml", "describe", "events"]}
          extraColumns={[
            {
              header: "Addresses",
              accessor: (r) => {
                const subsets = r.subsets ?? [];
                const addrs = subsets.flatMap((s: any) =>
                  (s.addresses ?? []).map((a: any) => a.ip)
                );
                return (
                  <span className="font-mono text-xs text-slate-400 truncate max-w-[200px] block">
                    {addrs.length === 0
                      ? "none"
                      : addrs.slice(0, 3).join(", ") + (addrs.length > 3 ? ` +${addrs.length - 3}` : "")}
                  </span>
                );
              },
            },
            {
              header: "Ports",
              accessor: (r) => {
                const subsets = r.subsets ?? [];
                const ports = subsets.flatMap((s: any) =>
                  (s.ports ?? []).map((p: any) => p.port)
                );
                return (
                  <span className="text-xs text-slate-400">
                    {ports.length === 0 ? "-" : ports.join(", ")}
                  </span>
                );
              },
              width: "100px",
            },
          ]}
        />
      );
    case "helm":
      return <HelmPage key={onRefreshKey} />;
    case "resourceGraph":
      return <ResourceGraphPage key={onRefreshKey} />;
    case "gitops":
      return <GitOpsPage key={onRefreshKey} />;
    case "namespaceCost":
      return <NamespaceCostPage key={onRefreshKey} />;
    case "crdBrowser":
      return <CrdBrowserPage key={onRefreshKey} />;
    case "webhooks":
      return <WebhookConfigsPage key={onRefreshKey} />;
    case "kubeconfig":
      return <KubeconfigPage key={onRefreshKey} />;
    default:
      return (
        <div className="flex items-center justify-center h-full text-slate-500 text-sm">
          Select a resource from the sidebar
        </div>
      );
  }
}

function StartupBanner() {
  const [status, setStatus] = useState<KubectlStatus | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    checkKubectl().then(setStatus).catch(() => {});
  }, []);

  if (dismissed || !status) return null;

  // All good — show a brief success that auto-dismisses
  if (status.found && status.kubeconfigFound) {
    return null; // silent — no banner needed when everything works
  }

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 bg-amber-900/30 border-b border-amber-800/50 text-amber-300 text-xs shrink-0">
      <AlertTriangle size={13} className="shrink-0 text-amber-400" />
      <div className="flex-1 space-y-0.5">
        {!status.found && (
          <p className="font-medium">
            <Terminal size={11} className="inline mr-1" />
            kubectl not found on PATH. Install kubectl to use this app.{" "}
            <span className="text-amber-500 font-mono">brew install kubectl</span>
          </p>
        )}
        {status.found && !status.kubeconfigFound && (
          <p className="font-medium">
            No kubeconfig found. Copy your cluster config to{" "}
            <span className="font-mono text-amber-500">~/.kube/config</span>
          </p>
        )}
        {status.found && status.version && (
          <p className="text-amber-600 text-[11px]">kubectl {status.version} · {status.path}</p>
        )}
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 hover:text-white transition-colors"
      >
        <X size={12} />
      </button>
    </div>
  );
}

export default function App() {
  const theme = useAppStore((s) => s.theme);

  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const [tabs, setTabs] = useState<Tab[]>([
    { id: "tab-1", page: "dashboard", title: "Dashboard" },
  ]);
  const [activeTabId, setActiveTabId] = useState("tab-1");

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];
  const currentPage = activeTab.page;
  const [refreshKey, setRefreshKey] = useState(0);
  const [searchOpen, setSearchOpen] = useState(false);

  function navigateTo(page: string) {
    const title = PAGE_TITLES[page] ?? page;
    setTabs((prev) =>
      prev.map((t) => (t.id === activeTabId ? { ...t, page, title } : t))
    );
  }

  function openNewTab(page = "dashboard") {
    const id = `tab-${Date.now()}`;
    const title = PAGE_TITLES[page] ?? page;
    setTabs((prev) => [...prev.slice(0, 7), { id, page, title }]);
    setActiveTabId(id);
  }

  function closeTab(id: string) {
    setTabs((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (id === activeTabId) {
        setActiveTabId(next[next.length - 1].id);
      }
      return next;
    });
  }

  // Global Cmd+K — opens GlobalSearch
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden">
        <Sidebar currentPage={currentPage} onNavigate={navigateTo} />
        <div className="flex-1 flex flex-col min-w-0">
          <TopBar onRefresh={() => setRefreshKey((k) => k + 1)} />
          <TabBar
            tabs={tabs}
            activeTabId={activeTabId}
            onSelectTab={setActiveTabId}
            onCloseTab={closeTab}
            onNewTab={() => openNewTab()}
          />
          <StartupBanner />
          <main className="flex-1 overflow-hidden">
            <PageRouter page={currentPage} onRefreshKey={refreshKey} onNavigate={navigateTo} />
          </main>
        </div>
      </div>
      {searchOpen && (
        <GlobalSearch
          onClose={() => setSearchOpen(false)}
          onNavigate={(page) => {
            navigateTo(page);
            setSearchOpen(false);
          }}
        />
      )}
    </QueryClientProvider>
  );
}
