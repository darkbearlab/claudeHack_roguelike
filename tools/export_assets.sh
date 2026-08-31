#!/usr/bin/env bash
# Copy every sprite this game uses out of the shared library into ./assets/.
# The library keeps the original; this is a snapshot, and it is meant to go
# stale independently -- a game build must not change its art because someone
# rebuilt a palette elsewhere.
AG=c:/claude_project/asset_generator
PY=$AG/.venv/Scripts/python.exe
MK=$AG/make_asset.py
DEST=c:/claude_project/claudeHack/assets

for f in "$AG"/library/topdown-flat/*.png; do
  base=$(basename "$f" .png)
  case "$base" in
    *_preview|*.src|_contact) continue;;
  esac
  case "$base" in
    hero_*|mon_*|item_*|feat_*|unit-topdown_grey-stone-wall_64|unit-topdown_wooden-crate-iron_64|unit-topdown_wooden-barrel-iron_64)
      "$PY" "$MK" --export "$base" "$DEST" >/dev/null 2>&1 && echo "exported $base" ;;
  esac
done
