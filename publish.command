#!/bin/zsh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_HTML="${SCRIPT_DIR}/../ozprops.html"
DEST_HTML="${SCRIPT_DIR}/index.html"

if [ ! -f "${SRC_HTML}" ]; then
  echo "Missing source file: ${SRC_HTML}"
  exit 1
fi

cp "${SRC_HTML}" "${DEST_HTML}"
echo "Synced ${SRC_HTML} -> ${DEST_HTML}"

cd "${SCRIPT_DIR}"

if [ ! -d ".git" ]; then
  git init
  git branch -M main
fi

git add index.html CNAME .github/workflows/deploy-pages.yml

if git diff --cached --quiet; then
  echo "No changes to publish."
  exit 0
fi

git commit -m "Publish latest OzProps site"
git push -u origin main
echo "Published. GitHub Pages workflow will deploy automatically."
