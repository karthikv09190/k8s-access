# K8s Manager — Full Improvement Spec
**Date:** 2026-05-05  
**Scope:** All 22 improvement items across 4 phases  
**Author:** Karthik Vellingiri

---

## Existing State (already implemented)

- Events viewer — full page + inline panel (untracked, working)
- Age column — in GenericResourcePage and PodsPage
- Restart count — in PodsPage
- Ready column — in PodsPage
- `@xterm/xterm` v6, `addon-fit`, `addon-web-links` — installed, unused
- `@monaco-editor/react` — installed (includes DiffEditor)
- `recharts` — installed
- `kube` crate with `ws` feature — streaming-ready
- `@tanstack/react-router` — installed but unused (string routing in use)

---

## Phase 1 — Quick Wins + Core Debugging

### Q1. Copy Name / Copy YAML Buttons

**Where:** ResourceActionsPanel header, PodActionsPanel header  
**What:** Two icon buttons — "Copy name" (copies `metadata.name`) and "Copy YAML" (copies raw YAML already fetched in YamlPanel). Use `navigator.clipboard.writeText()`. Show a brief "Copied!" tooltip state (500ms).  
**Files:** `ResourceActionsPanel.tsx`, `PodActionsPanel.tsx`

---

### Q2. Container Status Icons

**Where:** PodsPage — replace or augment the Status column  
**What:** Per-container state icons inline in a row. Read `pod.status.containerStatuses[].state`:
- `running` → green circle
- `waiting` → amber circle + reason tooltip (e.g., "CrashLoopBackOff")
- `terminated` → red circle + exit code

Show icons as a compact row, e.g. `● ● ○` next to the Ready count.  
**Files:** `PodsPage.tsx`, new `ContainerStatusIcons` component in `src/components/pods/`

---

### Q3. Auto-Refresh Toggle Per Page

**Where:** GenericResourcePage header, PodsPage header, EventsPage (already has it)  
**What:** Small dropdown: Off / 10s / 30s / 60s. Default 30s (current hardcoded). Wire to `refetchInterval`. Persist selection in component state only (no global store needed).  
**Files:** `GenericResourcePage.tsx`, `PodsPage.tsx`

---

### Q4. Keyboard Shortcuts

**Global (useEffect on document):**
- `Cmd+K` — open global search (Phase 2, register handler now, no-op until implemented)
- `Escape` — close side panel / close modal
- `/` — focus search input on current page

**In resource tables (when no panel open):**
- `j` / `k` — move selection down/up
- `Enter` — open selected resource panel
- `Delete` / `Backspace` — trigger delete if `supportsDelete`

**Implementation:** Custom `useKeyboardNav` hook that accepts the filtered list and callbacks. Applied in `ResourceTable` or the page level.  
**Files:** `src/hooks/useKeyboardNav.ts` (new), `ResourceTable.tsx`, `GenericResourcePage.tsx`, `PodsPage.tsx`

---

### Q5. Events Enhancement

Add **time-range filter** to EventsPage:
- Dropdown: Last 1h / 6h / 24h / All time
- Client-side filter on `lastTimestamp` (data already returned)
- Add to filter row in EventsPage header

Also add **"Copy as kubectl"** button in EventsPanel footer: `kubectl get events -n <ns> --field-selector involvedObject.name=<name>`  
**Files:** `EventsPage.tsx`, `EventsPanel.tsx`

---

### Q6. Streaming / Real-Time Logs

**Architecture:** Tauri event streaming, not polling.

**Rust side (`src-tauri/src/commands/logs.rs`):**
- New command `start_log_stream(context, namespace, pod_name, container, tail_lines, follow)` → spawns async task using `kube` log stream (`Api::log_stream`) → emits `log-line-<stream-id>` Tauri events per line
- New command `stop_log_stream(stream_id)` → cancels the task via `CancellationToken`
- Returns `stream_id: String` (UUID)
- State: `LogStreamState` (DashMap of stream_id → cancel token), added to `lib.rs`

**Frontend (`PodLogsPanel.tsx` — full rewrite):**
- Follow toggle (default on)
- When follow=on: call `start_log_stream`, listen on `log-line-<id>`, append to buffer
- When follow=off: fallback to existing `get_pod_logs` polling
- Auto-scroll toggle (default on, stops on manual scroll up, resumes on scroll-to-bottom)
- Pause button (stops listening, keeps buffer)
- Search-within-logs: highlight matching lines (simple string match)
- Download button: `Blob` + `URL.createObjectURL` → save as `<pod>-<container>.log`
- Line count cap: keep last 5000 lines in state to prevent memory blow-up

**New Tauri wrappers in `tauri.ts`:**
```ts
startLogStream(args): Promise<string>  // returns stream_id
stopLogStream(streamId: string): Promise<void>
```

**New Cargo deps:** `uuid` (for stream IDs), `dashmap` (concurrent state map)

---

### Q7. Interactive Pod Terminal

**Architecture:** `portable-pty` (Rust) ↔ Tauri events ↔ `xterm.js` (frontend)

**Rust side (`src-tauri/src/commands/terminal.rs` — new):**
- `start_terminal(context, namespace, pod_name, container, shell)` → spawns `kubectl exec -it <pod> -c <container> -- <shell>` under a PTY via `portable-pty::native_pty_system()` → returns `terminal_id: String`
- Spawns two async tasks:
  - Reader: reads PTY output → emits `terminal-output-<id>` events (base64-encoded bytes)
  - Writer: listens for `terminal-input-<id>` events → writes to PTY stdin
- `resize_terminal(terminal_id, cols, rows)` → calls `pty.resize()`
- `close_terminal(terminal_id)` → kills PTY process, cleanup

**Frontend — replaces `ExecPanel.tsx`:**
- Full `xterm.js` terminal with `FitAddon`
- On mount: call `start_terminal`, listen `terminal-output-<id>`, attach to xterm
- On xterm `onData`: emit `terminal-input-<id>` Tauri event
- ResizeObserver → `resize_terminal` on dimension change
- Shell selector dropdown: `bash`, `sh`, `/bin/ash` (tries each, shows error if none)
- Keep old one-shot exec as fallback tab ("Quick Exec") alongside new "Terminal" tab

**New tab structure in `PodActionsPanel.tsx`:**
`logs | terminal | exec | events | portforward | yaml | edit`

**New Cargo deps:** `portable-pty = "0.8"`, `base64 = "0.22"`

**New TS deps:** none (xterm already installed)

---

### Q8. Deployment Rollout History & Rollback

**Rust side (`src-tauri/src/commands/exec.rs` — additions):**
- `get_rollout_history(context, namespace, kind, name)` → runs `kubectl rollout history <kind>/<name> -n <ns> --context <ctx>` → parse output into `Vec<RolloutRevision>` (revision number, change-cause, image)
- `rollback_rollout(context, namespace, kind, name, revision)` → runs `kubectl rollout undo <kind>/<name> -n <ns> --to-revision=<n>`
- `get_rollout_status(context, namespace, kind, name)` → runs `kubectl rollout status <kind>/<name> --timeout=0s`

**Frontend (`src/components/resources/RolloutPanel.tsx` — new):**
- Table of revisions: Revision # | Change Cause | Image | Actions
- "Rollback to this revision" button per row → confirm dialog → execute
- Current revision highlighted
- Rollout status badge (Progressing / Complete / Failed) at top
- Added as `"rollout"` tab in `ResourceActionsPanel` for Deployments and StatefulSets

**New `ResourceTab` value:** `"rollout"`  
**Updated `App.tsx`:** Add `"rollout"` to `actionTabs` for deployments and statefulsets

**New Tauri wrappers in `tauri.ts`:**
```ts
getRolloutHistory(args): Promise<RolloutRevision[]>
rollbackRollout(args): Promise<string>
getRolloutStatus(args): Promise<string>
```

---

### Q9. Resource Creation (Apply New YAML)

**New page/modal (`src/components/resources/CreateResourceModal.tsx`):**
- Triggered by "Create" button in each resource page header
- Monaco editor (full-height, yaml language)
- Template gallery sidebar: Deployment, Service, ConfigMap, Secret, Job, CronJob, Namespace presets
- Dry-run toggle: calls `apply_resource_yaml` with `--dry-run=client` flag (update Rust command to accept `dry_run: bool`)
- Apply button → `apply_resource_yaml` → success toast → close modal + invalidate query
- Namespace selector (pulls from store `namespaces`)

**Update `exec.rs`:** `apply_resource_yaml` gains `dry_run: Option<bool>` parameter; appends `--dry-run=client` when true.

**New button:** Each resource page header gets a `+ Create` button.

---

## Phase 2 — Operations

### P2.1. HPA Support

**Rust side (`src-tauri/src/commands/resources.rs`):**
- `list_hpas(context, namespace)` → returns HPA objects

**Frontend:**
- New page `"hpas"` in `App.tsx` via `GenericResourcePage` with extra columns: Min/Max replicas, Current replicas, CPU target %, Memory target %
- Action tabs: `["yaml", "edit", "describe", "events", "scale"]`
- Scale tab for HPA: edit `minReplicas`/`maxReplicas`
- Add to Sidebar under Workloads group

---

### P2.2. Global Search (Cmd+K)

**Architecture:** Client-side only — search across React Query cache. No new backend command.

**`src/components/ui/GlobalSearch.tsx` (new):**
- Triggered by `Cmd+K` (or `Ctrl+K`) from `useKeyboardNav` global handler
- Full-screen modal overlay with centered input
- Searches across all cached query data (pods, deployments, services, etc.) by name/namespace/labels
- Results grouped by resource type, shows name + namespace + age
- Arrow keys to navigate, Enter to jump to that resource page + select it
- Fuzzy match (simple `includes` first iteration)
- Store needs `setCurrentPage` callback accessible globally

**`App.tsx` changes:** Render `<GlobalSearch>` at root, pass `onNavigate`

---

### P2.3. Namespace Management

**New page `"namespaces"` in `App.tsx`:**
- `GenericResourcePage` with `namespaced=false`, `invokeCmd="list_namespaces_full"` (returns full Namespace objects, not just strings)
- Extra columns: Status (Active/Terminating), Age, Resource Count
- Actions: Create namespace (simple name input modal), Delete namespace (confirm with resource count warning)
- Resource quota summary inline

**New Rust commands:** `list_namespaces_full`, `create_namespace`, `delete_namespace`

**Add to Sidebar:** Under Overview group

---

### P2.4. Resource Quotas & LimitRanges

**New pages:** `"resourcequotas"` and `"limitranges"` via `GenericResourcePage`  
**Extra columns for quotas:** hard limits, used amounts, utilization %  
**New Rust commands:** `list_resourcequotas`, `list_limitranges`  
**Add to Sidebar:** Under Config & Storage group

---

### P2.5. Annotations & Labels Bulk Editor

**New tab `"labels"` in `ResourceActionsPanel` and `PodActionsPanel`:**
- Shows current labels and annotations in editable key-value table
- Add/remove/edit rows
- Save via `kubectl label` / `kubectl annotate` commands (new Rust commands)
- Bulk mode: select multiple resources → apply label to all (future enhancement, single resource first)

**New Rust commands:** `label_resource`, `annotate_resource`  
**New tab type:** `"labels"` in `ResourceTab`

---

### P2.6. Network Policies Viewer

**New page `"networkpolicies"` via `GenericResourcePage`**  
**New Rust command:** `list_networkpolicies`  
**Extra columns:** Pod selector, policy types (Ingress/Egress)  
**Detail panel:** YAML + describe + a text summary of ingress/egress rules  
**Add to Sidebar:** Under Network group

---

### P2.7. Favorites & Bookmarks

**Store addition in `store/app.ts`:**
```ts
favorites: FavoriteItem[]  // { kind, name, namespace, context, page }
addFavorite(item): void
removeFavorite(key): void
```
Persisted via `localStorage` (Tauri's `@tauri-apps/plugin-store` or just `localStorage` in WebView).

**Sidebar:** New "Favorites" group at top, lists pinned items with quick-navigate  
**Resource rows:** Star icon on hover in resource tables → add/remove favorite  
**Favorites page:** List view with quick-jump buttons

---

## Phase 3 — Ecosystem

### P3.1. Helm Releases Integration

**Rust side (`src-tauri/src/commands/helm.rs` — new):**
- `list_helm_releases(context, namespace)` → runs `helm list -o json -n <ns> --kube-context <ctx>` → parse JSON
- `get_helm_release_values(context, namespace, name)` → `helm get values <name> -n <ns>`
- `get_helm_release_history(context, namespace, name)` → `helm history <name> -n <ns> -o json`
- `helm_rollback(context, namespace, name, revision)` → `helm rollback <name> <rev> -n <ns>`

**Frontend:**
- New page `"helm"` in `App.tsx`
- Table: Release name, Chart, App version, Status, Namespace, Updated
- Detail panel: Values tab (Monaco read-only), History tab, Rollback button
- Add to Sidebar under new "Tools" group alongside Compare

---

### P3.2. Topology / Dependency View

**New page `"topology"` in `App.tsx`**  
**Frontend-only** (uses cached query data, no new backend):
- Install `reactflow` + `dagre` for auto-layout
- Build graph: Deployment → ReplicaSet → Pods; Service → Pods (via selector match); Ingress → Service
- Node styles by kind (color-coded)
- Click node → highlight connected + show mini-detail sidebar
- Zoom/pan via react-flow built-ins
- Namespace-scoped (uses activeNamespace)

**New deps:** `reactflow`, `dagre`, `@types/dagre`

---

### P3.3. CRD Browser

**Rust side:**
- `list_crds(context)` → list CustomResourceDefinitions (cluster-scoped)
- `list_custom_resources(context, namespace, group, version, plural)` → generic list

**Frontend:**
- Two-level page: CRD list → select → custom resource instances list
- YAML view/edit for any instance (reuse existing YamlPanel/EditYamlPanel)
- Add to Sidebar under new "Custom Resources" group

---

### P3.4. Multi-Window & Split Pane

**Tauri windows:** Use `tauri::WebviewWindowBuilder` to open a new window with a URL param (e.g., `?pod=<name>&ns=<ns>`).  
**Split pane:** Two-panel layout option on PodsPage — show logs on left, YAML on right simultaneously.  
This is the most complex UI feature; implement split pane first (simpler), then multi-window.

---

### P3.5. YAML Diff View

**New tab `"diff"` in `ResourceActionsPanel`:**
- Fetches live YAML (already done in YamlPanel)
- User edits in left pane of Monaco DiffEditor
- Right pane shows current live state
- "Apply" button runs `apply_resource_yaml`
- Replaces current separate `edit` + `yaml` tabs with unified diff-edit flow

**`@monaco-editor/react` already includes `DiffEditor`** — no new deps.

---

## Phase 4 — Polish

### P4.1. Notifications & Alerts

**Background watcher (`src-tauri/src/commands/watch.rs` — new):**
- `start_cluster_watch(context)` → uses `kube` watch API on pods + events
- Emits `cluster-alert` Tauri events when: pod enters CrashLoopBackOff, deployment has unavailable replicas > 0, Warning event with count > threshold

**Frontend:**
- `NotificationCenter` component (bell icon in TopBar)
- In-app notification list with dismiss
- System notifications via `tauri-plugin-notification` (add to Cargo)
- Configurable rules stored in localStorage (threshold values)

---

### P4.2. kubectl Command Palette

**New panel accessible from TopBar:**
- Input field: raw kubectl command (without `kubectl`)
- Prepends `kubectl --context <activeContext> -n <activeNamespace>`
- Runs via existing `execPodCommand`-style mechanism (new `run_kubectl_command` Rust cmd)
- History stored in localStorage (last 50 commands)
- Auto-complete for resource names from cached query data
- "Copy as kubectl" in all action panels → copies equivalent kubectl command

---

### P4.3. Export & Reporting

**Export options per resource page:**
- CSV: JS-side, build CSV from current filtered data
- JSON: `JSON.stringify(resources, null, 2)` → download
- YAML bundle: `get_namespace_yaml_bundle(context, namespace)` Rust command → runs `kubectl get all -n <ns> -o yaml`

**Cluster comparison report:** Export existing `CompareResult` as Markdown table (JS-side, no backend)

---

### P4.4. Cost Visibility

**Frontend-only estimation** (no cloud API required for v1):
- CPU cost: `cpuRequests * $0.048/core-hour` (configurable rate)
- Memory cost: `memRequests * $0.006/GB-hour` (configurable rate)
- Reads from existing pod metrics data (already fetched in MetricsPanel)
- Shows estimated hourly/monthly cost per namespace on DashboardPage
- "Cost Settings" modal to set custom rates

---

### P4.5. Light Theme & Theme Customization

**Implementation:** Tailwind CSS v4 with CSS variables + `data-theme` attribute.
- CSS variables in `index.css`: `--bg-primary`, `--text-primary`, etc.
- `dark` and `light` themes defined
- Theme stored in localStorage + `useAppStore`
- Toggle button in TopBar
- All Tailwind classes updated to use semantic variables

This is a large find-and-replace across all components — do last.

---

## Implementation Order

```
Phase 1:
  1. Q1 Copy buttons
  2. Q2 Container status icons
  3. Q3 Auto-refresh toggle
  4. Q4 Keyboard shortcuts + useKeyboardNav hook
  5. Q5 Events enhancement (time-range filter)
  6. Q6 Streaming logs (Rust + frontend)
  7. Q7 Interactive terminal (Rust + xterm.js)
  8. Q8 Rollout history & rollback
  9. Q9 Resource creation modal

Phase 2:
  10. HPA support
  11. Global search (Cmd+K)
  12. Namespace management
  13. Resource quotas & LimitRanges
  14. Labels & annotations editor
  15. Network policies
  16. Favorites & bookmarks

Phase 3:
  17. Helm releases
  18. Topology view
  19. CRD browser
  20. Split pane / multi-window
  21. YAML diff view

Phase 4:
  22. Notifications & alerts
  23. kubectl command palette
  24. Export & reporting
  25. Cost visibility
  26. Light theme (last — touches all files)
```

---

## New Files Summary

### Rust
- `src-tauri/src/commands/terminal.rs` — PTY terminal
- `src-tauri/src/commands/helm.rs` — Helm integration
- `src-tauri/src/commands/watch.rs` — background watcher

### Frontend
- `src/hooks/useKeyboardNav.ts`
- `src/components/pods/ContainerStatusIcons.tsx`
- `src/components/resources/RolloutPanel.tsx`
- `src/components/resources/CreateResourceModal.tsx`
- `src/components/resources/LabelsEditor.tsx`
- `src/components/ui/GlobalSearch.tsx`
- `src/components/ui/NotificationCenter.tsx`
- `src/pages/HpaPage.tsx` (or GenericResourcePage config)
- `src/pages/TopologyPage.tsx`
- `src/pages/HelmPage.tsx`
- `src/pages/CrdBrowserPage.tsx`

### New Cargo deps
```toml
portable-pty = "0.8"
base64 = "0.22"
uuid = { version = "1", features = ["v4"] }
dashmap = "6"
tauri-plugin-notification = "2"
```

### New npm deps
```
reactflow
dagre
@types/dagre
```

---

## Constraints & Notes

- **Token budget:** If session hits 90% token usage, stop after completing current feature, resume next session.
- **No react-router migration** — keep string routing; `@tanstack/react-router` stays unused.
- **Light theme is last** — touches every component; doing it earlier would cause constant conflicts.
- **Helm requires `helm` CLI** on PATH — same pattern as kubectl PATH fix already in `lib.rs`.
- **Cost visibility v1** — no cloud API calls; purely estimation from existing metrics data.
- **Split pane** before multi-window — simpler, same value.
