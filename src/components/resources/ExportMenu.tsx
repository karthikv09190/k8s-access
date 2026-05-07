import { useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { invoke } from "@tauri-apps/api/core";
import { ChevronDown, Loader2 } from "lucide-react";
import { exportJSON, exportCSV, exportMarkdown } from "../../utils/export";

interface ExportMenuProps {
  title: string;
  items: any[];
  context: string;
  namespace: string | undefined;
  namespaced: boolean;
}

const DEFAULT_COLUMNS = [
  "metadata.name",
  "metadata.namespace",
  "metadata.creationTimestamp",
];

function triggerTextDownload(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/yaml" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function ExportMenu({
  title,
  items,
  context,
  namespace,
  namespaced,
}: ExportMenuProps) {
  const [yamlLoading, setYamlLoading] = useState(false);
  const base = title.toLowerCase().replace(/\s+/g, "-");
  const showYamlBundle = namespaced && !!namespace;

  const handleJSON = () => {
    exportJSON(`${base}.json`, items);
  };

  const handleCSV = () => {
    exportCSV(`${base}.csv`, items, DEFAULT_COLUMNS);
  };

  const handleYamlBundle = async () => {
    if (!namespace) return;
    setYamlLoading(true);
    try {
      const yaml = await invoke<string>("get_namespace_yaml_bundle", {
        context,
        namespace,
      });
      triggerTextDownload(`${base}-${namespace}.yaml`, yaml);
    } catch (err) {
      console.error("YAML bundle export failed:", err);
    } finally {
      setYamlLoading(false);
    }
  };

  const handleMarkdownCopy = () => {
    const header = ["Name", "Namespace", "Created"];
    const rows = items.map((item) => [
      item.metadata?.name ?? "",
      item.metadata?.namespace ?? "",
      item.metadata?.creationTimestamp ?? "",
    ]);
    const md = exportMarkdown(title, [header, ...rows]);
    navigator.clipboard.writeText(md).catch(console.error);
  };

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button className="flex items-center gap-1 text-xs px-2.5 py-1 rounded bg-slate-700 hover:bg-slate-600 text-slate-200 shrink-0 border border-slate-600">
          Export
          <ChevronDown size={10} />
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="z-50 min-w-[160px] rounded bg-slate-800 border border-slate-700 shadow-xl py-1 text-xs text-slate-200"
          sideOffset={4}
          align="end"
        >
          <DropdownMenu.Item
            className="px-3 py-1.5 cursor-pointer hover:bg-slate-700 focus:bg-slate-700 outline-none"
            onSelect={handleJSON}
          >
            JSON
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className="px-3 py-1.5 cursor-pointer hover:bg-slate-700 focus:bg-slate-700 outline-none"
            onSelect={handleCSV}
          >
            CSV
          </DropdownMenu.Item>

          <DropdownMenu.Item
            className="px-3 py-1.5 cursor-pointer hover:bg-slate-700 focus:bg-slate-700 outline-none"
            onSelect={handleMarkdownCopy}
          >
            Markdown (copy)
          </DropdownMenu.Item>

          {showYamlBundle && (
            <>
              <DropdownMenu.Separator className="my-1 border-t border-slate-700" />
              <DropdownMenu.Item
                className="px-3 py-1.5 cursor-pointer hover:bg-slate-700 focus:bg-slate-700 outline-none flex items-center gap-2"
                onSelect={handleYamlBundle}
                disabled={yamlLoading}
              >
                {yamlLoading && <Loader2 size={10} className="animate-spin" />}
                YAML Bundle
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
