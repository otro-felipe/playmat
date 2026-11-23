#!/bin/sh
# The pinned card jar was compiled against the old Function constructor. Lambda
# serialization is determined at the card's call site, so rebuild every caller.
set -eu
lib_dir=${1:?expected assembled XMage lib directory}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
grep -rlF --include='*.java' 'CreateXXTokenExiledEffectManaValueEffect' Mage.Sets/src > "$work/sources"
LC_ALL=C sort -o "$work/sources" "$work/sources"
mkdir "$work/classes"
javac --release 8 -proc:none -encoding UTF-8 -cp "$lib_dir/*" -d "$work/classes" @"$work/sources"
jar uf "$lib_dir/mage-sets-1.4.62.jar" -C "$work/classes" .
