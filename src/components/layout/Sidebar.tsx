import {
  Box,
  ChevronDown,
  ChevronRight,
  Cpu,
  Database,
  FileCode2,
  GitCompare,
  Globe,
  Key,
  Layers,
  LayoutDashboard,
  Lock,
  Network,
  Package,
  Server,
  Shield,
  Timer,
} from "lucide-react";
import { useState } from "react";
import { useAppStore } from "../../store/app";
import { cn } from "../../lib/utils";

interface NavItem {
  label: string;
  icon: React.ReactNode;
  page: string;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", icon: <LayoutDashboard size={14} />, page: "dashboard" },
      { label: "Nodes", icon: <Server size={14} />, page: "nodes" },
    ],
  },
  {
    label: "Workloads",
    items: [
      { label: "Pods", icon: <Box size={14} />, page: "pods" },
      { label: "Deployments", icon: <Layers size={14} />, page: "deployments" },
      { label: "StatefulSets", icon: <Database size={14} />, page: "statefulsets" },
      { label: "DaemonSets", icon: <Cpu size={14} />, page: "daemonsets" },
      { label: "ReplicaSets", icon: <Package size={14} />, page: "replicasets" },
      { label: "Jobs", icon: <Timer size={14} />, page: "jobs" },
      { label: "CronJobs", icon: <Timer size={14} />, page: "cronjobs" },
    ],
  },
  {
    label: "Network",
    items: [
      { label: "Services", icon: <Network size={14} />, page: "services" },
      { label: "Ingresses", icon: <Globe size={14} />, page: "ingresses" },
    ],
  },
  {
    label: "Config & Storage",
    items: [
      { label: "ConfigMaps", icon: <FileCode2 size={14} />, page: "configmaps" },
      { label: "Secrets", icon: <Key size={14} />, page: "secrets" },
      { label: "PersistentVolumeClaims", icon: <Database size={14} />, page: "pvcs" },
      { label: "PersistentVolumes", icon: <Database size={14} />, page: "pvs" },
    ],
  },
  {
    label: "RBAC",
    items: [
      { label: "ServiceAccounts", icon: <Shield size={14} />, page: "serviceaccounts" },
      { label: "Roles", icon: <Lock size={14} />, page: "roles" },
      { label: "RoleBindings", icon: <Lock size={14} />, page: "rolebindings" },
      { label: "ClusterRoles", icon: <Lock size={14} />, page: "clusterroles" },
      { label: "ClusterRoleBindings", icon: <Lock size={14} />, page: "clusterrolebindings" },
    ],
  },
  {
    label: "Tools",
    items: [
      { label: "Compare Clusters", icon: <GitCompare size={14} />, page: "compare" },
    ],
  },
];

interface SidebarProps {
  currentPage: string;
  onNavigate: (page: string) => void;
}

function NavGroupSection({
  group,
  currentPage,
  onNavigate,
}: {
  group: NavGroup;
  currentPage: string;
  onNavigate: (page: string) => void;
}) {
  const [open, setOpen] = useState(true);

  return (
    <div className="mb-1">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 w-full px-3 py-1 text-xs font-semibold text-slate-500 uppercase tracking-wider hover:text-slate-400"
      >
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
        {group.label}
      </button>
      {open && (
        <div className="mt-0.5">
          {group.items.map((item) => (
            <button
              key={item.page}
              onClick={() => onNavigate(item.page)}
              className={cn(
                "flex items-center gap-2 w-full px-4 py-1.5 text-sm rounded-md mx-1 text-left",
                currentPage === item.page
                  ? "bg-blue-600/20 text-blue-400 border-l-2 border-blue-500"
                  : "text-slate-400 hover:text-slate-200 hover:bg-white/5"
              )}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar({ currentPage, onNavigate }: SidebarProps) {
  const collapsed = useAppStore((s) => s.sidebarCollapsed);

  if (collapsed) return null;

  return (
    <aside className="w-56 shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col overflow-y-auto">
      <div className="p-3 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded bg-blue-600 flex items-center justify-center text-white text-xs font-bold">
            K
          </div>
          <span className="text-sm font-semibold text-slate-100">K8s Manager</span>
        </div>
      </div>
      <nav className="flex-1 py-3 px-1">
        {NAV.map((group) => (
          <NavGroupSection
            key={group.label}
            group={group}
            currentPage={currentPage}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
    </aside>
  );
}
