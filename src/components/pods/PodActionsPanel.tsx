import { useState } from "react";
import { X, ScrollText, Terminal, Wifi, FileCode, Pencil, Activity, Copy, Check } from "lucide-react";
import { PodLogsPanel } from "../logs/PodLogsPanel";
import { ExecPanel } from "./ExecPanel";
import { TerminalPanel } from "./TerminalPanel";
import { PortForwardPanel } from "./PortForwardPanel";
import { YamlPanel } from "../resources/YamlPanel";
import { EditYamlPanel } from "../resources/EditYamlPanel";
import { EventsPanel } from "../resources/EventsPanel";

type Tab = "logs" | "terminal" | "exec" | "events" | "portforward" | "yaml" | "edit";

interface Props {
  context: string;
  pod: any;
  onClose: () => void;
}

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: "logs", label: "Logs", icon: ScrollText },
  { id: "terminal", label: "Terminal", icon: Terminal },
  { id: "exec", label: "Exec", icon: Terminal },
  { id: "events", label: "Events", icon: Activity },
  { id: "portforward", label: "Port Fwd", icon: Wifi },
  { id: "yaml", label: "YAML", icon: FileCode },
  { id: "edit", label: "Edit", icon: Pencil },
];

export function PodActionsPanel({ context, pod, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>("logs");
  const [copied, setCopied] = useState(false);

  const namespace = pod.metadata?.namespace ?? "";
  const podName = pod.metadata?.name ?? "";

  const copyName = () => {
    navigator.clipboard.writeText(podName).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="flex flex-col h-full bg-slate-950">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-800 bg-slate-900/50 shrink-0">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-xs text-slate-200 truncate">{podName}</p>
          <p className="text-xs text-slate-500 truncate">{namespace}</p>
        </div>
        <button
          onClick={copyName}
          title="Copy pod name"
          className="shrink-0 text-slate-500 hover:text-slate-300 p-0.5 rounded hover:bg-slate-800"
        >
          {copied ? <Check size={12} className="text-green-400" /> : <Copy size={12} />}
        </button>
        <button
          onClick={onClose}
          className="shrink-0 text-slate-500 hover:text-slate-300 p-0.5 rounded hover:bg-slate-800"
        >
          <X size={14} />
        </button>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-slate-800 shrink-0 bg-slate-900/30">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-xs transition-colors border-b-2 ${
              activeTab === id
                ? "text-blue-400 border-blue-500 bg-blue-500/5"
                : "text-slate-500 border-transparent hover:text-slate-300 hover:border-slate-600"
            }`}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-hidden">
        {activeTab === "logs" && (
          <PodLogsPanel context={context} namespace={namespace} podName={podName} />
        )}
        {activeTab === "terminal" && (
          <TerminalPanel context={context} namespace={namespace} podName={podName} />
        )}
        {activeTab === "exec" && (
          <ExecPanel context={context} namespace={namespace} podName={podName} />
        )}
        {activeTab === "events" && (
          <EventsPanel context={context} namespace={namespace} kind="Pod" name={podName} />
        )}
        {activeTab === "portforward" && (
          <PortForwardPanel
            context={context}
            namespace={namespace}
            resourceType="pod"
            resourceName={podName}
          />
        )}
        {activeTab === "yaml" && (
          <YamlPanel context={context} namespace={namespace} kind="Pod" name={podName} />
        )}
        {activeTab === "edit" && (
          <EditYamlPanel context={context} namespace={namespace} kind="Pod" name={podName} />
        )}
      </div>
    </div>
  );
}
