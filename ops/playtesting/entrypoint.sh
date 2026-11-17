#!/bin/bash
set -euo pipefail

data_dir=/var/lib/playmat
mkdir -p "$data_dir"/{db,saved/replays,logs,caddy} /opt/xmage/cards-db
if [[ "$(id -u)" == 0 ]]; then
    chown xmage "$data_dir" "$data_dir"/{db,saved,saved/replays,logs,caddy} /opt/xmage/cards-db
    for dir in db saved logs; do
        if [[ -d "/opt/xmage/$dir" && ! -L "/opt/xmage/$dir" ]]; then
            rmdir "/opt/xmage/$dir"
        fi
        ln -sfn "$data_dir/$dir" "/opt/xmage/$dir"
    done
    exec runuser -u xmage -- "$0"
fi

children=()
stop_children() {
    trap - TERM INT EXIT
    for pid in "${children[@]}"; do kill -TERM "$pid" 2>/dev/null || true; done
    wait || true
}
trap stop_children TERM INT EXIT

node /opt/playtesting/product/main.mjs & children+=("$!")
/usr/local/bin/xmage-server & children+=("$!")
node /opt/playtesting/mcp/src/main.mjs & children+=("$!")
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile & children+=("$!")
wait -n "${children[@]}"
