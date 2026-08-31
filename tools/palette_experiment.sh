#!/usr/bin/env bash
# Free experiment: does moving topdown-flat from 4 palette sets to 8 reduce the
# median quantisation error, now that the library holds 59 assets instead of 5?
# Both --build-palette and --regenerate-all cost nothing.
AG=c:/claude_project/asset_generator
PY=$AG/.venv/Scripts/python.exe
MK=$AG/make_asset.py
OUT=c:/claude_project/claudeHack/tools/palette_experiment.log
: > "$OUT"

measure () {
  local sets="$1"
  echo "=== $sets sets ===" >> "$OUT"
  "$PY" "$MK" --style topdown-flat --build-palette --sets "$sets" >> "$OUT" 2>&1
  "$PY" "$MK" --style topdown-flat --regenerate-all  >> "$OUT" 2>&1
  "$PY" "$MK" --style topdown-flat --status > "c:/claude_project/claudeHack/tools/status_$sets.txt" 2>&1
  echo "--- summary for $sets sets ---" >> "$OUT"
  awk '/fit /{ n=split($0,a," "); for(i=1;i<=n;i++) if(a[i]=="fit") print a[i+1] }' \
      "c:/claude_project/claudeHack/tools/status_$sets.txt" \
    | sort -g | awk '{v[NR]=$1} END {
        printf "  assets=%d  median=%.3f  mean=%.3f  worst=%.3f\n", NR, (NR%2? v[(NR+1)/2] : (v[NR/2]+v[NR/2+1])/2), (function(){}) ,v[NR]
      }' 2>/dev/null >> "$OUT" || true
}

for s in 4 8 12; do measure "$s"; done
echo "=== EXPERIMENT DONE ===" >> "$OUT"
