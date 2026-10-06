#!/bin/sh
# usage: sh run.sh <name> [timeoutSec] < body.js   -> drops cmd/<name>.js, waits for out/<name>.json, prints it
D=$(dirname "$0")
N="$1"; T="${2:-120}"
rm -f "$D/out/$N.json"
cat > "$D/cmd/$N.tmp"
mv "$D/cmd/$N.tmp" "$D/cmd/$N.js"
i=0
while [ ! -f "$D/out/$N.json" ]; do
  sleep 0.3; i=$((i+1))
  if [ $i -gt $((T*10/3)) ]; then echo "TIMEOUT waiting for $N"; exit 1; fi
done
cat "$D/out/$N.json"
