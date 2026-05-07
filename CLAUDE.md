# K8s-manager

Desktop Kubernetes management UI built with Tauri + React + TypeScript + Vite.

## Stack
- Frontend: React, TypeScript, Tailwind CSS, Radix UI, TanStack, Redux
- Desktop: Tauri (Rust backend)
- Editor: Monaco editor embedded
- Terminal: xterm.js

## Dev
```bash
npm install
npm run dev        # Vite dev server
npm run tauri dev  # Full Tauri app
npm run build      # Production build → dist/
```

## IDE
VS Code + Tauri extension + rust-analyzer recommended.

## Key Dirs
- `src/` — React frontend
- `src-tauri/` — Rust/Tauri backend
- `dist/` — built frontend assets

## Context
Managing APAC EKS cluster: cluster-eks-apac (vpc-0a0b771709d9f491e, ap-northeast-1).
AWS profile: `apac` (account 008714537254).

## Recommended Skills
| Task | Skill |
|------|-------|
| React/TS UI work | `frontend-design` |
| Rust backend (src-tauri/) | `pensive:rust-review` |
| Code review / refactor | `pensive:unified-review`, `pensive:code-refinement` |
| K8s troubleshooting | `k8s-troubleshooter` |
| EKS cluster ops | `aws-dev-toolkit:eks` |
| Architecture diagram | `cartograph:architecture-diagram` |
| Parallel agent tasks | `superpowers:dispatching-parallel-agents` |
| Git / PR | `sanctum:commit-messages`, `sanctum:pr-prep` |
