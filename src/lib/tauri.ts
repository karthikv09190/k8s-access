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

// ── Compare ───────────────────────────────────────────────────────────────────
export const compareClusters = (args: {
  leftContext: string;
  rightContext: string;
  namespace: string;
  resourceKinds: string[];
}) => invoke<CompareResult>("compare_clusters", args);

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
}) => invoke<string>("apply_resource_yaml", args);

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
