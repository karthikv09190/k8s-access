import { create } from "zustand";
import type { KubeContext } from "../types/k8s";

type Theme = 'dark' | 'light';

interface AppState {
  contexts: KubeContext[];
  activeContext: string;
  activeNamespace: string;
  namespaces: string[];
  sidebarCollapsed: boolean;
  theme: Theme;
  /** Incident to open when navigating to the Self-Healing page. */
  focusedIncidentId: string | null;
  /** Page another component asked App to open (consumed by App). */
  requestedPage: string | null;

  setFocusedIncidentId: (id: string | null) => void;
  requestPage: (page: string | null) => void;
  setContexts: (ctx: KubeContext[]) => void;
  setActiveContext: (ctx: string) => void;
  setActiveNamespace: (ns: string) => void;
  setNamespaces: (ns: string[]) => void;
  toggleSidebar: () => void;
  toggleTheme: () => void;
  setTheme: (t: Theme) => void;
}

export const useAppStore = create<AppState>((set) => ({
  contexts: [],
  activeContext: "",
  activeNamespace: "default",
  namespaces: ["default"],
  sidebarCollapsed: false,
  theme: (localStorage.getItem('k8s-theme') as Theme) ?? 'dark',
  focusedIncidentId: null,
  requestedPage: null,

  setFocusedIncidentId: (focusedIncidentId) => set({ focusedIncidentId }),
  requestPage: (requestedPage) => set({ requestedPage }),
  setContexts: (contexts) => set({ contexts }),
  setActiveContext: (activeContext) => set({ activeContext }),
  setActiveNamespace: (activeNamespace) => set({ activeNamespace }),
  setNamespaces: (namespaces) => set({ namespaces }),
  toggleSidebar: () =>
    set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  toggleTheme: () =>
    set((s) => {
      const newTheme: Theme = s.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('k8s-theme', newTheme);
      return { theme: newTheme };
    }),
  setTheme: (theme) => {
    localStorage.setItem('k8s-theme', theme);
    set({ theme });
  },
}));
