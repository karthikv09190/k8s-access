#!/bin/bash
export NVM_DIR="$HOME/.nvm"
source "$NVM_DIR/nvm.sh"
cd /Users/karthikvellingiri/claude/k8s-access/k8s-manager
exec npm run dev -- --port 1420
