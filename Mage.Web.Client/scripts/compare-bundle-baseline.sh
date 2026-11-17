#!/bin/bash
# Measurement only: the original size gate remains failed; never raises or suppresses its budget.
set -euo pipefail
baseline=${1:?Pass the deployed baseline commit}
[[ $baseline =~ ^[0-9a-f]{40}$ ]] || exit 2
frontend=$PWD
[[ -f scripts/check-bundle-size.mjs && -d node_modules ]] || exit 2
comparison=$(mktemp -d "${RUNNER_TEMP:-/tmp}/playmat-bundle-comparison.XXXXXX")
measure() {
    local result=0
    node scripts/check-bundle-size.mjs --json > "$1" || result=$?
    # An exceeded budget is data; missing manifests or other errors still fail the measurement.
    [[ $result == 0 || $result == 1 ]] || return "$result"
}
measure "$comparison/current.json"
git fetch --no-tags --depth=1 origin "$baseline"
git archive "$baseline" Mage.Web.Client | tar -x -C "$comparison"
cmp package-lock.json "$comparison/Mage.Web.Client/package-lock.json"
ln -s "$frontend/node_modules" "$comparison/Mage.Web.Client/node_modules"
(
    cd "$comparison/Mage.Web.Client"
    npm run build > "$comparison/baseline-build.log" 2>&1
    measure "$comparison/baseline.json"
)
node --input-type=module - "$comparison/baseline.json" "$comparison/current.json" <<'JS'
import { readFileSync } from 'node:fs';
const [base, current] = process.argv.slice(2).map((p) => JSON.parse(readFileSync(p, 'utf8')));
const result = Object.fromEntries(Object.entries(current.measuredKb).map(([name, value]) => [name, {
  baselineKb: base.measuredKb[name], currentKb: value, deltaKb: value - base.measuredKb[name], budgetKb: current.budgetKb[name],
}]));
console.log(JSON.stringify({ measurementOnly: true, originalBudgetGateUnchanged: true, result }, null, 2));
JS
