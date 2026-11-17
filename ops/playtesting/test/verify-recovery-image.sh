#!/bin/bash
# Explicit, isolated image acceptance. Never point this at a production database or volume.
set -euo pipefail

[[ ${PLAYMAT_RECOVERY_IMAGE_TEST:-} == yes ]] || { echo 'Explicit isolated image-test opt-in required' >&2; exit 1; }
[[ -z ${DATABASE_URL:-} && -z ${PLAYMAT_PROVISION_ONCE:-} ]] || { echo 'Use an isolated test shell without product credentials' >&2; exit 1; }
cd "$(dirname "$0")/../../.."
root=$PWD
prefix=playmat-backup-fixture-$(date +%s)-$$
app=$prefix-app
pg=$prefix-pg
network=$prefix-network
engine_volume=$prefix-engine
pg_volume=$prefix-postgres
image=$prefix:local
stamp=$(git rev-parse HEAD)

# Each invocation owns fresh names. Keep synthetic volumes for local diagnosis; never upload their contents.
app_created=false
pg_created=false
phase=boot
finish() {
    result=$?
    trap - EXIT
    if [[ $result != 0 && $app_created == true ]]; then
        docker inspect --format 'Isolated app state: status={{.State.Status}} exit={{.State.ExitCode}} oom={{.State.OOMKilled}}' "$app" || true
        # Before readiness, no fixture accounts or matches exist. Never dump game-time logs.
        if [[ $phase == boot ]]; then docker logs --tail 35 "$app" 2>&1 || true; fi
    fi
    if [[ $app_created == true ]]; then docker stop "$app" >/dev/null 2>&1 || true; fi
    if [[ $pg_created == true ]]; then docker stop "$pg" >/dev/null 2>&1 || true; fi
    if [[ $result != 0 ]]; then echo 'Isolated recovery acceptance failed; no private fixture contents were exported' >&2; fi
    exit "$result"
}
trap finish EXIT

docker build --build-arg PLAYMAT_COMMIT="$stamp" -t "$image" .
docker run --rm --network none --entrypoint python3 -e PYTHONDONTWRITEBYTECODE=1 \
    -v "$root:/source:ro" -w /source "$image" -m unittest discover -s ops/playtesting/test -v

if [[ -n ${PLAYMAT_RECOVERY_TEST_SUBNET:-} ]]; then
    docker network create --subnet "$PLAYMAT_RECOVERY_TEST_SUBNET" "$network" >/dev/null
else
    docker network create "$network" >/dev/null
fi
docker run -d --name "$pg" --network "$network" --network-alias playmat-recovery-pg --memory 256m \
    -v "$pg_volume:/var/lib/postgresql/data" -e POSTGRES_USER=playmat -e POSTGRES_DB=recovery_fixture \
    -e POSTGRES_PASSWORD=isolated-local-fixture postgres:17-alpine >/dev/null
pg_created=true
for attempt in {1..60}; do
    if docker exec "$pg" pg_isready -h 127.0.0.1 -U playmat -d recovery_fixture >/dev/null 2>&1; then break; fi
    [[ $attempt != 60 ]] || { echo 'Isolated PostgreSQL did not become ready' >&2; exit 1; }
    sleep 1
done
docker run -d --name "$app" --network "$network" --network-alias playmat-recovery-local --memory 4g \
    -v "$engine_volume:/var/lib/playmat" \
    -e DATABASE_URL=postgresql://playmat:isolated-local-fixture@playmat-recovery-pg:5432/recovery_fixture \
    -e PLAYMAT_PUBLIC_URL=http://127.0.0.1:8080 -e PLAYMAT_INSECURE_COOKIE=true \
    -e PLAYMAT_PVP_RECOVERY=on -e PLAYMAT_RECOVERY_LOCAL_TEST=yes \
    -e PLAYMAT_RECOVERY_BACKUP_SECONDS=60 -e PLAYMAT_RECOVERY_BACKUP_KEEP=2 \
    -e XMAGE_MEMORY=1024m -e XMAGE_JAVA_OPTS=-Dh2.bindAddress=127.0.0.1 "$image" >/dev/null
app_created=true

healthy() {
    docker exec "$app" node -e '
const end=Date.now()+55000;
while(Date.now()<end){
  try{const r=await fetch("http://127.0.0.1:8080/healthz");if(r.ok){console.log("Isolated image healthy");process.exit(0)}}catch{}
  await new Promise(r=>setTimeout(r,500));
}
process.exit(1);'
}
fixture() {
    docker exec --user xmage -w /opt/xmage "$app" node /opt/playtesting/product/recovery.local.mjs "$1"
}
restart() {
    docker kill --signal KILL "$app" >/dev/null
    docker start "$app" >/dev/null
    healthy
}

healthy
phase=fixture
docker exec -w /opt/playtesting/mcp "$app" sh -c 'node --test test/*.test.mjs'
fixture prepare
docker exec --user xmage "$app" python3 /opt/playtesting/recovery-backup.py once

# Select a closed backup, independently check its fingerprint against the engine's own stored value,
# and prove a restore is rejected while the actual game process owns CheckpointStore's Java lock.
docker exec --user xmage -i "$app" python3 - <<'PY'
from pathlib import Path
import importlib.util, json, sqlite3, stat, subprocess
p=Path('/opt/playtesting/recovery-backup.py')
spec=importlib.util.spec_from_file_location('recovery_backup',p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
root=Path('/var/lib/playmat/backups/pvp-recovery')
saved=sorted(p for p in root.iterdir() if m.BACKUP_NAME.fullmatch(p.name))[-1]
manifest=json.loads((saved/'manifest.json').read_text())
with sqlite3.connect('file:/var/lib/playmat/db/pvp-recovery.db?mode=ro',uri=True) as db:
    assert db.execute('SELECT DISTINCT engine FROM checkpoints').fetchall()==[(manifest['engine'],)]
assert stat.S_IMODE(root.stat().st_mode)==0o700
assert stat.S_IMODE(saved.stat().st_mode)==0o700
for file in saved.iterdir(): assert stat.S_IMODE(file.stat().st_mode)==0o600
result=subprocess.run(['python3',str(p),'restore','--saved',str(saved)],capture_output=True,text=True)
assert result.returncode==1 and result.stdout==''
assert result.stderr=='Recovery private backup operation failed\n'
try:
    m.restore(Path('/opt/xmage'),saved)
    raise AssertionError('Running Java engine lock was ignored')
except BlockingIOError:
    pass
selection=Path('/var/lib/playmat/saved/backup-selection')
selection.write_text(str(saved));selection.chmod(0o600)
print('Actual Java engine rejected restore; private modes and assembled fingerprint verified')
PY

# Only this newly created synthetic container is killed. A maintenance container has no network,
# runs no normal app entrypoint, and reuses the exact same image and private fixture volume.
docker kill --signal KILL "$app" >/dev/null
docker run --rm --network none --user xmage -i --entrypoint python3 \
    -v "$engine_volume:/var/lib/playmat" "$image" - <<'PY'
from pathlib import Path
from contextlib import closing
import importlib.util, sqlite3, stat
engine=Path('/opt/xmage')
(engine/'db').symlink_to('/var/lib/playmat/db')
saved=Path(Path('/var/lib/playmat/saved/backup-selection').read_text())
p=Path('/opt/playtesting/recovery-backup.py')
spec=importlib.util.spec_from_file_location('recovery_backup',p)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
tables=('checkpoints','recovery_participants','recovery_claims','recovery_mappings')
def rows(file):
    with closing(sqlite3.connect(file)) as db:
        return {t:sorted(db.execute('SELECT * FROM '+t).fetchall(),key=repr) for t in tables}
expected=rows(saved/'pvp-recovery.db')
with sqlite3.connect(engine/'db/pvp-recovery.db') as db:
    db.execute("UPDATE checkpoints SET snapshot=X'00'")
assert rows(engine/'db/pvp-recovery.db')!=expected
m.restore(engine,saved)
assert rows(engine/'db/pvp-recovery.db')==expected
prior=list((engine/'db').glob('before-recovery-restore-*'))
assert len(prior)==1 and stat.S_IMODE(prior[0].stat().st_mode)==0o700
assert rows(prior[0]/'pvp-recovery.db')!=expected
m.check_database(engine/'db/pvp-recovery.db')
assert stat.S_IMODE((engine/'db/pvp-recovery.db').stat().st_mode)==0o600
print('All four recovery tables restored exactly from backup; prior database preserved privately')
PY
docker start "$app" >/dev/null
healthy
fixture recover
restart
fixture recover-sideboard
restart
fixture recover

# Verify the daemon actually ran in this image. Only generic operational metadata reaches logs.
docker exec --user xmage -i "$app" python3 - <<'PY'
from pathlib import Path
import json,stat,time
p=Path('/var/lib/playmat/backups/pvp-recovery/status.json')
end=time.monotonic()+10
while time.monotonic()<end:
    status=json.loads(p.read_text()) if p.exists() else {}
    if status.get('state')=='ok' and status.get('lastSuccessAt'): break
    time.sleep(.2)
assert status['state']=='ok' and status['lastSuccessAt']>0
assert status['intervalSeconds']==60 and status['keep']==2
assert stat.S_IMODE(p.stat().st_mode)==0o600
print('Private backup daemon effective: healthy, owner-only, interval 60 seconds, retention 2')
PY
echo 'Complete isolated image backup/restore/recovery acceptance passed'
