import { invoke } from "@tauri-apps/api/core";
import type {
  ClusterOverview,
  CompareResult,
  KubeContext,
} from "../types/k8s";

// ── Clusters ──────────────────────────────────────────────────────────────────
export interface KubectlStatus {
  found: boolean;
  version: string | null;
  path: string | null;
  kubeconfigFound: boolean;
  contextCount: number;
}

export const checkKubectl = () => invoke<KubectlStatus>("check_kubectl");

export const listContexts = () => invoke<KubeContext[]>("list_contexts");

export const listNamespaces = (context: string) =>
  invoke<string[]>("list_namespaces", { context });

// ── Resources ─────────────────────────────────────────────────────────────────
type ResourceArgs = { context: string; namespace?: string };

export const listPods = (args: ResourceArgs) =>
  invoke<unknown[]>("list_pods", args);

export const listDeployments = (args: ResourceArgs) =>
  invoke<unknown[]>("list_deployments", args);

export const listStatefulsets = (args: ResourceArgs) =>
  invoke<unknown[]>("list_statefulsets", args);

export const listDaemonsets = (args: ResourceArgs) =>
  invoke<unknown[]>("list_daemonsets", args);

export const listReplicasets = (args: ResourceArgs) =>
  invoke<unknown[]>("list_replicasets", args);

export const listJobs = (args: ResourceArgs) =>
  invoke<unknown[]>("list_jobs", args);

export const listCronjobs = (args: ResourceArgs) =>
  invoke<unknown[]>("list_cronjobs", args);

export const listServices = (args: ResourceArgs) =>
  invoke<unknown[]>("list_services", args);

export const listIngresses = (args: ResourceArgs) =>
  invoke<unknown[]>("list_ingresses", args);

export const listConfigmaps = (args: ResourceArgs) =>
  invoke<unknown[]>("list_configmaps", args);

export const listSecrets = (args: ResourceArgs) =>
  invoke<unknown[]>("list_secrets", args);

export const listPvcs = (args: ResourceArgs) =>
  invoke<unknown[]>("list_pvcs", args);

export const listPvs = (args: ResourceArgs) =>
  invoke<unknown[]>("list_pvs", args);

export const listNodes = (args: ResourceArgs) =>
  invoke<unknown[]>("list_nodes", args);

export const listServiceaccounts = (args: ResourceArgs) =>
  invoke<unknown[]>("list_serviceaccounts", args);

export const listRoles = (args: ResourceArgs) =>
  invoke<unknown[]>("list_roles", args);

export const listRolebindings = (args: ResourceArgs) =>
  invoke<unknown[]>("list_rolebindings", args);

export const listClusterroles = (args: ResourceArgs) =>
  invoke<unknown[]>("list_clusterroles", args);

export const listClusterrolebindings = (args: ResourceArgs) =>
  invoke<unknown[]>("list_clusterrolebindings", args);

export const listHpas = (args: ResourceArgs) =>
  invoke<unknown[]>("list_hpas", args);

export const listPdbs = (args: ResourceArgs) =>
  invoke<unknown[]>("list_pdbs", args);

export const listNetworkpolicies = (args: ResourceArgs) =>
  invoke<unknown[]>("list_networkpolicies", args);

export const listResourcequotas = (args: ResourceArgs) =>
  invoke<unknown[]>("list_resourcequotas", args);

export const listLimitranges = (args: ResourceArgs) =>
  invoke<unknown[]>("list_limitranges", args);

export const listStorageclasses = (args: ResourceArgs) =>
  invoke<unknown[]>("list_storageclasses", args);

export const listEndpoints = (args: ResourceArgs) =>
  invoke<unknown[]>("list_endpoints", args);

export const getResourceYaml = (args: {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}) => invoke<string>("get_resource_yaml", args);

export const deleteResource = (args: {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}) => invoke<void>("delete_resource", args);

// ── Logs ──────────────────────────────────────────────────────────────────────
// Tauri v2 auto-converts camelCase JS keys → snake_case Rust params
export const getPodLogs = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
}) => invoke<string>("get_pod_logs", args);

export const getPodContainers = (args: {
  context: string;
  namespace: string;
  podName: string;
}) => invoke<string[]>("get_pod_containers", args);

export const startLogStream = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  tailLines?: number;
}) => invoke<string>("start_log_stream", args);

export const stopLogStream = (streamId: string) =>
  invoke<void>("stop_log_stream", { streamId });

// ── Terminal ──────────────────────────────────────────────────────────────────
export const startTerminal = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  shell?: string;
}) => invoke<string>("start_terminal", args);

export const writeTerminal = (args: { terminalId: string; data: string }) =>
  invoke<void>("write_terminal", args);

export const resizeTerminal = (args: {
  terminalId: string;
  cols: number;
  rows: number;
}) => invoke<void>("resize_terminal", args);

export const closeTerminal = (terminalId: string) =>
  invoke<void>("close_terminal", { terminalId });

// ── Compare ───────────────────────────────────────────────────────────────────
export const compareClusters = (args: {
  leftContext: string;
  rightContext: string;
  namespace: string;
  resourceKinds: string[];
}) => invoke<CompareResult>("compare_clusters", args);

// ── Events ────────────────────────────────────────────────────────────────────
export interface K8sEvent {
  namespace: string;
  name: string;
  eventType: string;
  reason: string;
  message: string;
  objectKind: string;
  objectName: string;
  count: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  sourceComponent: string;
  sourceHost: string;
}

export const listEvents = (args: {
  context: string;
  namespace?: string;
  involvedObjectKind?: string;
  involvedObjectName?: string;
}) => invoke<K8sEvent[]>("list_events", args);

// ── Exec ──────────────────────────────────────────────────────────────────────
export const execPodCommand = (args: {
  context: string;
  namespace: string;
  podName: string;
  container?: string;
  command: string[];
}) => invoke<string>("exec_pod_command", args);

export const applyResourceYaml = (args: {
  context: string;
  yaml: string;
  dryRun?: boolean;
}) => invoke<string>("apply_resource_yaml", args);

// ── Rollout ───────────────────────────────────────────────────────────────────
export interface RolloutRevision {
  revision: number;
  changeCause: string;
}

export const getRolloutHistory = (args: {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}) => invoke<RolloutRevision[]>("get_rollout_history", args);

export const rollbackRollout = (args: {
  context: string;
  namespace: string;
  kind: string;
  name: string;
  revision: number;
}) => invoke<string>("rollback_rollout", args);

export const getRolloutStatus = (args: {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}) => invoke<string>("get_rollout_status", args);

export const describeResource = (args: {
  context: string;
  namespace?: string;
  kind: string;
  name: string;
}) => invoke<string>("describe_resource", args);

export const scaleResource = (args: {
  context: string;
  namespace: string;
  kind: string;
  name: string;
  replicas: number;
}) => invoke<string>("scale_resource", args);

export const restartResource = (args: {
  context: string;
  namespace: string;
  kind: string;
  name: string;
}) => invoke<string>("restart_resource", args);

export const triggerCronjob = (args: {
  context: string;
  namespace: string;
  name: string;
  jobName?: string;
}) => invoke<string>("trigger_cronjob", args);

export const patchSecret = (args: {
  context: string;
  namespace: string;
  name: string;
  data: Record<string, string>;
}) => invoke<string>("patch_secret", args);

// ── Port Forward ──────────────────────────────────────────────────────────────
export interface PortForwardInfo {
  id: string;
  context: string;
  namespace: string;
  resourceType: string;
  resourceName: string;
  localPort: number;
  remotePort: number;
}

export const startPortForward = (args: {
  context: string;
  namespace: string;
  resourceType: string;
  resourceName: string;
  localPort: number;
  remotePort: number;
}) => invoke<string>("start_port_forward", args);

export const stopPortForward = (id: string) =>
  invoke<void>("stop_port_forward", { id });

export const listPortForwards = () =>
  invoke<PortForwardInfo[]>("list_port_forwards");

// ── Metrics ───────────────────────────────────────────────────────────────────
export const getClusterOverview = (context: string) =>
  invoke<ClusterOverview>("get_cluster_overview", { context });

export interface NodeMetrics {
  name: string;
  cpuCores: string;
  cpuPercent: string;
  memoryBytes: string;
  memoryPercent: string;
}

export interface PodMetrics {
  name: string;
  namespace: string;
  cpuCores: string;
  memoryBytes: string;
}

export const getNodeMetrics = (context: string) =>
  invoke<NodeMetrics[]>("get_node_metrics", { context });

export const getPodMetrics = (args: { context: string; namespace?: string }) =>
  invoke<PodMetrics[]>("get_pod_metrics", args);

// ── Node Operations ────────────────────────────────────────────────────────────
export const cordonNode = (args: { context: string; name: string }) =>
  invoke<string>("cordon_node", args);

export const uncordonNode = (args: { context: string; name: string }) =>
  invoke<string>("uncordon_node", args);

export const drainNode = (args: { context: string; name: string }) =>
  invoke<string>("drain_node", args);

// ── Helm ───────────────────────────────────────────────────────────────────────
export interface HelmRelease {
  name: string;
  namespace: string;
  revision: string;
  updated: string;
  status: string;
  chart: string;
  appVersion: string;
}

export const listHelmReleases = (context: string) =>
  invoke<HelmRelease[]>("list_helm_releases", { context });

export const uninstallHelmRelease = (args: {
  context: string;
  namespace: string;
  name: string;
}) => invoke<string>("uninstall_helm_release", args);

// ── GitOps ────────────────────────────────────────────────────────────────────
export interface ArgoApp {
  name: string; namespace: string; project: string;
  repoUrl: string; path: string; targetRevision: string;
  destNamespace: string; syncStatus: string; healthStatus: string;
  lastSyncedAt: string; images: string[]; message: string;
}
export const listArgoApps = (context: string) =>
  invoke<ArgoApp[]>("list_argo_apps", { context });
export const syncArgoApp = (args: { context: string; namespace: string; name: string }) =>
  invoke<string>("sync_argo_app", args);
