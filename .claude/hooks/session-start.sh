#!/bin/bash
# Облачные сессии Claude Code: ставит graphify (карта кода), чтобы хуки .claude/settings.json
# и правило «сначала graphify query» работали в новом контейнере. Только для облака.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-.}"

GRAPHIFY_VERSION="0.9.119"

# Файл-метка лежит рядом с пакетами системного Python: пропадёт вместе с ними.
pyhashes="$(python3 -I -c 'import sysconfig; print(sysconfig.get_path("purelib"))')/.session-start.sha256"
if ! command -v graphify >/dev/null 2>&1 || ! sha256sum --check --status "$pyhashes" 2>/dev/null; then
  rm -f "$pyhashes"
  python3 -m pip install -q "graphifyy==${GRAPHIFY_VERSION}"
  sha256sum .claude/hooks/session-start.sh > "$pyhashes" || rm -f "$pyhashes"
fi
