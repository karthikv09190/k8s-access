import { useState } from "react";
import { X, FileCode, Pencil, Info, Layers, RotateCcw, Wifi, Play, Network, KeyRound, BarChart2, Activity, Copy, Check } from "lucide-react";
import { YamlPanel } from "./YamlPanel";
import { EditYamlPanel } from "./EditYamlPanel";
import { DescribePanel } from "./DescribePanel";
import { ScalePanel } from "./ScalePanel";
import { RestartPanel } from "./RestartPanel";
import { TriggerJobPanel } from "./TriggerJobPanel";
import { IngressRulesPanel } from "./IngressRulesPanel";
import { SecretValuesView } from "./SecretValuesPanel";
import { NodeMetricsPanel, PodMetricsPanel } from "./MetricsPanel";
import { EventsPanel } from "./EventsPanel";
import { HealingIncidentLink } from "../healing/HealingLink";
import { PortForwardPanel } from "../pods/PortForwardPanel";
import { RolloutPanel } from "./RolloutPanel";
import { NodeOpsPanel } from "./NodeOpsPanel";

export type ResourceTab =
  | "yaml"
  | "edit"
  | "describe"
  | "events"
  | "scale"
  | "restart"
  | "rollout"
  | "portforward"
  | "trigger"
  | "rules"
  | "values"
  | "nodemetrics"
  | "podmetrics"
  | "nodeops";

const TAB_CONFIG: Record<ResourceTab, { label: string; icon: React.ElementType }> = {
  yaml:        { label: "YAML",        icon: FileCode },
  edit:        { label: "Edit",        icon: Pencil },
  events:      { label: "Events",      icon: Activity },
  describe:    { label: "Describe",    icon: Info },
  scale:       { label: "Scale",       icon: Layers },
  restart:     { label: "Restart",     icon: RotateCcw },
  rollout:     { label: "Rollout",     icon: RotateCcw },
  portforward: { label: "Port Fwd",   icon: Wifi },
  trigger:     { label: "Trigger",     icon: Play },
  rules:       { label: "Rules",       icon: Network },
  values:      { label: "Values",      icon: KeyRound },
  nodemetrics: { label: "Metrics",     icon: BarChart2 },
  podmetrics:  { label: "Pod Metrics", icon: BarChart2 },
  nodeops:     { label: "Node Ops",    icon: Activity },
};

interface Props {
  context: string;
  namespace?: string;
  kind: string;
  resource: any;
  tabs: ResourceTab[];
  onClose: () => void;
}

export function ResourceActionsPanel({
  context,
  namespace,
  kind,
  resource,
  tabs,
  onClose,
}: Props) {
  const [activeTab, setActiveTab] = useState<ResourceTab>(tabs[0] ?? "yaml");
  const [copied, setCopied] = useState(false);

  const name: string = resource.metadata?.name ?? "";
  const ns: string = namespace ?? resource.metadata?.namespace ?? "";

  const copyName = () => {
    navigator.clipboard.writeText(name).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  const effectiveTab = tabs.includes(activeTab) ? activeTab : tabs[0];

  const currentReplicas: number =
    resource.spec?.replicas ?? resource.status?.replicas ?? 0;

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-900/50 shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs text-slate-800 dark:text-slate-200 truncate">{name}</p>
          {ns && <p className="text-xs text-slate-500 truncate">{ns}</p>}
        </div>
        <HealingIncidentLink kind={kind} namespace={ns || null} name={name} showStatus={false} />
        <button
          onClick={copyName}
          title="Copy name"
          className="shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
        >
          {copied ? <Check size={12} className="text-green-600 dark:text-green-400" /> : <Copy size={12} />}
        </button>
        <button
          onClick={onClose}
          className="shrink-0 text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 p-0.5 rounded hover:bg-slate-200 dark:hover:bg-slate-800"
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-200 dark:border-slate-800 shrink-0 bg-slate-50/30 dark:bg-slate-900/30 overflow-x-auto">
        {tabs.map((id) => {
          const { label, icon: Icon } = TAB_CONFIG[id];
          return (
            <button
              key={id}
              onClick={() => setActiveTab(id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors border-b-2 shrink-0 ${
                effectiveTab === id
                  ? "text-blue-600 dark:text-blue-400 border-blue-500 bg-blue-500/5"
                  : "text-slate-500 border-transparent hover:text-slate-700 dark:hover:text-slate-300 hover:border-slate-400 dark:hover:border-slate-600"
              }`}
            >
              <Icon size={11} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {effectiveTab === "yaml" && (
          <YamlPanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "edit" && (
          <EditYamlPanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "describe" && (
          <DescribePanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "events" && (
          <EventsPanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "scale" && (
          <ScalePanel
            context={context}
            namespace={ns}
            kind={kind}
            name={name}
            currentReplicas={currentReplicas}
          />
        )}
        {effectiveTab === "restart" && (
          <RestartPanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "rollout" && (
          <RolloutPanel context={context} namespace={ns} kind={kind} name={name} />
        )}
        {effectiveTab === "portforward" && (
          <PortForwardPanel
            context={context}
            namespace={ns}
            resourceType="svc"
            resourceName={name}
          />
        )}
        {effectiveTab === "trigger" && (
          <TriggerJobPanel
            context={context}
            namespace={ns}
            name={name}
            resource={resource}
          />
        )}
        {effectiveTab === "rules" && (
          <IngressRulesPanel resource={resource} />
        )}
        {effectiveTab === "values" && (
          <SecretValuesView
            context={context}
            namespace={ns}
            name={name}
            resource={resource}
          />
        )}
        {effectiveTab === "nodemetrics" && (
          <NodeMetricsPanel context={context} />
        )}
        {effectiveTab === "podmetrics" && (
          <PodMetricsPanel context={context} namespace={ns || undefined} />
        )}
        {effectiveTab === "nodeops" && (
          <NodeOpsPanel context={context} name={name} resource={resource} />
        )}
      </div>
    </div>
  );
}
