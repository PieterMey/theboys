#!/bin/sh
# usage: step.sh <name> <<'JS' ... JS   (body of async (P, h) => ...)
D=/c/Users/Pieter/repos/theboys/tests/playtest/first-run/cmd
N="$1"; T="${2:-240}"
cat > "$D/$N.tmp"
mv "$D/$N.tmp" "$D/$N.js"
i=0
while [ ! -f "$D/$N.out.txt" ]; do
  sleep 0.5; i=$((i+1))
  if [ $i -gt $((T*2)) ]; then echo "timeout waiting for $N"; exit 1; fi
done
cat "$D/$N.out.txt"
