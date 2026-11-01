#!/bin/bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

unexpected=()
reviewed_count=0
while IFS= read -r match; do
  reviewed_count=$((reviewed_count + 1))
  case "$match" in
    *"apps/electron/src/preload/bootstrap.ts:"*"ipcRenderer.send('__transport:status'"*)
      ;;
    *"apps/electron/src/main/browser-pane-manager/theme.ts:"*"webContents.send(TOOLBAR_CHANNELS.THEME_COLOR,"*|\
    *"apps/electron/src/main/browser-pane-manager/layout.ts:"*"webContents.send(TOOLBAR_CHANNELS.FORCE_CLOSE_MENU,"*|\
    *"apps/electron/src/main/browser-pane-manager/toolbar-state.ts:"*"webContents.send(TOOLBAR_CHANNELS.STATE_UPDATE,"*)
      ;;
    *"apps/electron/src/main/main-embedded-handlers.ts:"*"sender.send('transfer:progress'"*)
      ;;
    *"apps/electron/src/main/window-manager.ts:"*"window.webContents.send(channel, ...args)"*)
      ;;
    *)
      unexpected+=("$match")
      ;;
  esac
done < <(
  rg --line-number \
    --glob '!**/__tests__/**' \
    --glob '!**/*.test.*' \
    --glob '!**/*.spec.*' \
    '(ipcRenderer|webContents|sender)\.send\(' \
    apps/electron/src \
    || true
)

if ((${#unexpected[@]} > 0)); then
  echo "Raw Electron IPC sends detected outside the reviewed transport boundaries:"
  printf '  %s\n' "${unexpected[@]}"
  exit 1
fi

echo "Electron IPC send boundary check passed (${reviewed_count} reviewed sends)."
