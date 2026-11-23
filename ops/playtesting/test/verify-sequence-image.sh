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
network_created=false
finish() {
 result=$?
 trap - EXIT
 if [[ $app_created == true ]]; then docker rm -f "$app" >/dev/null 2>&1 || true; fi
 if [[ $pg_created == true ]]; then docker rm -f "$pg" >/dev/null 2>&1 || true; fi
 if [[ $network_created == true ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
 [[ $result == 0 ]] || echo 'Isolated real-engine sequence acceptance failed; no private state exported' >&2
 exit "$result"
}
trap finish EXIT
if [[ -n ${PLAYMAT_SEQUENCE_TEST_IMAGE:-} ]]; then
 image=$PLAYMAT_SEQUENCE_TEST_IMAGE
 docker image inspect "$image" >/dev/null
else
 docker build --build-arg PLAYMAT_COMMIT="$stamp" -t "$image" .
fi

# Each family owns its accounts, request budgets, engine and deadline. Reuse the
# exact built image. A slow setup in one match cannot consume the next family's
# decision budget, and every family still passes through the real product limits.
selection=${PLAYMAT_SEQUENCE_SCENARIOS:-all}
review=(review discard-capture review-prepared)
pioneer_costs=(mulligan line-waits card-to-step casting labeled-questions order activation visible-response)
pioneer_combat=(combat saga-entry impulse-exile exile ward)
modal=(whole-turn date-night improvised-yes low-level-control)
# Three independent CI workers build this revision. The default local run uses
# exactly the same families, and the groupings keep partial retries bounded.
capture_group=("${review[@]}" date-night typed human-matches human-sideboarding player-identities)
priority_group=("${pioneer_costs[@]}" improvised-yes)
combat_group=("${pioneer_combat[@]}" whole-turn low-level-control causal)
case "$selection" in
 all) families=("${capture_group[@]}" "${priority_group[@]}" "${combat_group[@]}") ;;
 capture-group) families=("${capture_group[@]}") ;;
 priority-group) families=("${priority_group[@]}") ;;
 combat-group) families=("${combat_group[@]}") ;;
 pioneer) families=("${pioneer_costs[@]}" "${pioneer_combat[@]}") ;;
 turn-lines) families=("${modal[@]}" typed causal) ;;
 modal) families=("${modal[@]}") ;;
 spectator-visibility|player-identities|human-sideboarding|human-matches|review|discard-capture|review-prepared|mulligan|line-waits|card-to-step|casting|labeled-questions|order|activation|visible-response|combat|saga-entry|impulse-exile|exile|ward|whole-turn|date-night|improvised-yes|low-level-control|typed|causal) families=("$selection") ;;
 *) echo 'Unknown isolated real-engine scenario' >&2; exit 2 ;;
esac
if (( ${#families[@]} > 1 )); then
 for scenario in "${families[@]}"; do
  echo "Running isolated real-engine family: $scenario"
  PLAYMAT_SEQUENCE_TEST_IMAGE="$image" PLAYMAT_SEQUENCE_SCENARIOS="$scenario" bash ops/playtesting/test/verify-sequence-image.sh
 done
 echo "All requested real-engine families passed: $selection"
 exit 0
fi
if [[ -n ${PLAYMAT_SEQUENCE_TEST_SUBNET:-} ]]; then
 docker network create --subnet "$PLAYMAT_SEQUENCE_TEST_SUBNET" "$network" >/dev/null
else
 docker network create "$network" >/dev/null
fi
network_created=true
docker run -d --name "$pg" --network "$network" --network-alias playmat-sequence-pg --memory 256m \
 --tmpfs /var/lib/postgresql/data:size=128m -e POSTGRES_USER=playmat -e POSTGRES_DB=sequence_fixture \
 -e POSTGRES_PASSWORD=isolated-sequence-fixture postgres:17-alpine >/dev/null
pg_created=true
for attempt in {1..60}; do
 if docker exec "$pg" pg_isready -h 127.0.0.1 -U playmat -d sequence_fixture >/dev/null 2>&1; then break; fi
 [[ $attempt != 60 ]] || { echo 'Isolated PostgreSQL did not become ready' >&2; exit 1; }
 sleep 1
done
public_url=http://127.0.0.1:8080
runner=sequence.local.mjs
fixture_clients='[]'
if [[ $selection == human-matches || $selection == human-sideboarding || $selection == player-identities || $selection == spectator-visibility ]]; then
 public_url=https://127.0.0.1:8080
 runner=human-match.local.mjs
 fixture_clients='[{"clientId":"https://fixture.invalid/client","redirectUri":"https://fixture.invalid/callback","name":"Local match test"}]'
fi
docker run -d --name "$app" --network "$network" --memory 4g --tmpfs /var/lib/playmat:size=512m --tmpfs /opt/xmage/cards-db:size=1024m --tmpfs /opt/xmage/gamesHistory:size=32m,mode=1777 \
 -e DATABASE_URL=postgresql://playmat:isolated-sequence-fixture@playmat-sequence-pg:5432/sequence_fixture \
 -e PLAYMAT_PUBLIC_URL="$public_url" -e PLAYMAT_OAUTH_CLIENTS="$fixture_clients" -e PLAYMAT_INSECURE_COOKIE=true -e PLAYMAT_PVP_RECOVERY=on \
 -e PLAYMAT_SEQUENCE_LOCAL_TEST=yes -e XMAGE_MEMORY=1024m "$image" >/dev/null
app_created=true
docker exec "$app" node -e '
// A cold card catalog can take several minutes on a shared CI runner.
const end=Date.now()+360000;
while(Date.now()<end){try{const r=await fetch("http://127.0.0.1:8080/healthz");if(r.ok){const h=await r.json();if(h.status==="ok")process.exit(0)}}catch{}await new Promise(r=>setTimeout(r,500));}console.error("Isolated XMage health did not become ready");process.exit(1);'
docker exec --user xmage -w /opt/xmage -e PLAYMAT_SEQUENCE_SCENARIOS="${PLAYMAT_SEQUENCE_SCENARIOS:-all}" \
 "$app" node "/opt/playtesting/product/$runner"
echo "Isolated real-engine family passed: $selection"
