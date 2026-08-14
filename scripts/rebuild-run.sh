#!/usr/bin/env bash
# Пересобрать образ Theia (новый UI product-ext + codex-обёртка) и поднять стек.
# WSL: bash scripts/rebuild-run.sh
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

IMAGE="ghcr.io/constructorfabric/studio-web/cf-studio-theia:edge"
CFG="studio-backend/config/docker.yaml"

echo "==> 1/4  Сборка образа Theia (новый UI product-ext + codex-обёртка, ~10 мин)"
docker build -t "$IMAGE" -f theia/Dockerfile theia

echo "==> 2/4  always_pull=false (гир берёт локальный образ, не тянет ghcr)"
sed -i 's/always_pull: true/always_pull: false/' "$CFG" || true
grep -n 'always_pull:' "$CFG"

echo "==> 3/4  Подъём стека двухшаговым бутом (переживает чистую БД)"
bash scripts/dev-up.sh

echo "==> 4/4  Снести старые сессии, чтобы новая взяла свежий образ"
IDS=$(docker ps -aq --filter name=cf-studio-session || true)
[ -n "$IDS" ] && docker rm -f $IDS || echo "  (активных сессий нет)"

echo
echo "Готово. Портал: http://localhost:8080  (вход: studio-admin-token)"
echo "Открой проект -> Open Studio для сессии с новым UI."
echo "ПЕРЕД пушем верни: sed -i 's/always_pull: false/always_pull: true/' $CFG"
