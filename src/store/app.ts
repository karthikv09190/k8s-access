import { create } from "zustand";
import type { KubeContext } from "../types/k8s";

interface AppState {
  contexts: KubeContext[];
  activeContext: string;
  activeNamespace: string;
  namespaces: string[];
  sidebarCollapsed: boolean;

  setContexts: (ctx: KubeContext[]) => void;
  setActiveContext: (ctx: string) => void;
  setActiveNamespace: (ns: string) => void;
  setNamespaces: (ns: string[]) => void;
  toggleSidebar: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  contexts: [],
  activeContext: "",
  activeNamespace: "default",
  namespaces: ["default"],
  sidebarCollapsed: false,

  setContexts: (contexts) => set({ contexts }),
  setActiveContext: (activeContext) => set({ activeContext }),
  setActiveNamespace: (activeNamespace) => set({ activeNamespace }),
  setNamespaces: (namespaces) => set({ namespaces }),
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
}));
