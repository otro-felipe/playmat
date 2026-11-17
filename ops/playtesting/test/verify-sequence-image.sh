#!/bin/bash
# Independent real-engine sequence acceptance; fresh synthetic accounts/data only, no published host ports.
set -euo pipefail
[[ ${PLAYMAT_SEQUENCE_IMAGE_TEST:-} == yes ]] || { echo 'Explicit isolated sequence-test opt-in required' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${PLAYMAT_PROVISION_ONCE:-} ]] || { echo 'Use an isolated shell without product credentials' >&2; exit 1; }
cd "$(dirname "$0")/../../.."
prefix=playmat-sequence-fixture-$(date +%s)-$$
app=$prefix-app
pg=$prefix-pg
image=$prefix:local
network=$prefix-network
stamp=$(git rev-parse HEAD)
app_created=false
pg_created=false
finish() {
 result=$?
 trap - EXIT
 if [[ $app_created == true ]]; then docker stop "$app" >/dev/null 2>&1 || true; fi
 if [[ $pg_created == true ]]; then docker stop "$pg" >/dev/null 2>&1 || true; fi
 [[ $result == 0 ]] || echo 'Isolated real-engine sequence acceptance failed; no private state exported' >&2
 exit "$result"
}
trap finish EXIT
docker build --build-arg PLAYMAT_COMMIT="$stamp" -t "$image" .
docker network create "$network" >/dev/null
docker run -d --name "$pg" --network "$network" --network-alias playmat-sequence-pg --memory 256m \
 -v "$prefix-postgres:/var/lib/postgresql/data" -e POSTGRES_USER=playmat -e POSTGRES_DB=sequence_fixture \
 -e POSTGRES_PASSWORD=isolated-sequence-fixture postgres:17-alpine >/dev/null
pg_created=true
for attempt in {1..60}; do
 if docker exec "$pg" pg_isready -h 127.0.0.1 -U playmat -d sequence_fixture >/dev/null 2>&1; then break; fi
 [[ $attempt != 60 ]] || { echo 'Isolated PostgreSQL did not become ready' >&2; exit 1; }
 sleep 1
done
docker run -d --name "$app" --network "$network" --memory 4g -v "$prefix-engine:/var/lib/playmat" \
 -e DATABASE_URL=postgresql://playmat:isolated-sequence-fixture@playmat-sequence-pg:5432/sequence_fixture \
 -e PLAYMAT_PUBLIC_URL=http://127.0.0.1:8080 -e PLAYMAT_INSECURE_COOKIE=true -e PLAYMAT_PVP_RECOVERY=on \
 -e PLAYMAT_SEQUENCE_LOCAL_TEST=yes -e XMAGE_MEMORY=1024m "$image" >/dev/null
app_created=true
docker exec "$app" node -e '
const end=Date.now()+60000;
while(Date.now()<end){try{const r=await fetch("http://127.0.0.1:8080/healthz");if(r.ok){const h=await r.json();if(h.status==="ok")process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,500));}process.exit(1);'
docker exec --user xmage -w /opt/xmage "$app" node /opt/playtesting/product/sequence.local.mjs
echo 'Complete isolated real-engine causal sequence acceptance passed'
