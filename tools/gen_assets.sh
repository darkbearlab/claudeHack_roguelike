#!/usr/bin/env bash
# Batch-generate every sprite claudeHack needs, via the shared asset library.
# Each line is:  <library asset name>|<plain-words description>
# Run:  bash tools/gen_assets.sh
AG=c:/claude_project/asset_generator
PY=$AG/.venv/Scripts/python.exe
MK=$AG/make_asset.py
LOG=c:/claude_project/claudeHack/tools/gen_assets.log

gen () {
  local name="$1" desc="$2"
  if [ -f "$AG/library/topdown-flat/$name.png" ]; then
    echo "SKIP  $name (already in library)" | tee -a "$LOG"; return 0
  fi
  echo "GEN   $name -- $desc" | tee -a "$LOG"
  "$PY" "$MK" --style topdown-flat --kind unit-topdown --name "$name" --desc "$desc" >>"$LOG" 2>&1 \
    && echo "OK    $name" | tee -a "$LOG" \
    || echo "FAIL  $name" | tee -a "$LOG"
}

: > "$LOG"
while IFS='|' read -r name desc; do
  [ -z "$name" ] && continue
  case "$name" in \#*) continue;; esac
  gen "$name" "$desc"
done <<'LIST'
hero_fighter|an armoured knight with a steel sword and a round shield
hero_wizard|a wizard in a blue robe holding a gnarled wooden staff
hero_rogue|a rogue in a dark green hooded cloak holding two daggers
hero_ranger|a ranger in brown leather holding a wooden longbow
mon_rat|a giant brown rat
mon_jackal|a yellow jackal
mon_kobold|a small green kobold holding a wooden club
mon_orc|a green orc warrior with an iron axe
mon_floating_eye|a large blue floating eyeball
mon_gnome|a gnome with a red hat and a pickaxe
mon_spider|a large black spider
mon_skeleton|a white bone skeleton warrior with a rusty sword
mon_zombie|a green rotting zombie
mon_ant|a giant black ant
mon_dragon|a red dragon with spread wings
mon_newt|a small yellow newt lizard
mon_mold|a lumpy green mould blob
mon_cockatrice|a yellow cockatrice, a chicken with a lizard tail
mon_mindflayer|a purple mind flayer with face tentacles
mon_minotaur|a brown minotaur with a great axe
mon_wraith|a black hooded wraith
mon_troll|a big green troll with claws
mon_snake|a coiled green snake
mon_bat|a brown giant bat with spread wings
mon_lich|a pale blue lich in a black robe
mon_soldier|a human soldier in a red uniform with a spear
mon_wolf|a grey wolf
mon_beholder|a floating purple sphere covered in eyes
item_potion|a glass potion bottle full of red liquid
item_scroll|a rolled parchment scroll tied with a red ribbon
item_wand|a short wooden wand with a blue gem at the tip
item_ring|a gold ring set with a green gem
item_amulet|a gold amulet on a chain with a blue stone
item_sword|a steel long sword with a leather grip
item_dagger|a small steel dagger
item_axe|an iron battle axe with a wooden haft
item_bow|a wooden longbow with a taut string
item_armor|a grey chain mail shirt
item_shield|a round wooden shield with an iron boss
item_helmet|a steel helmet
item_food|a loaf of brown bread
item_gold|a pile of gold coins
item_gem|a cut blue gemstone
item_book|a thick spellbook with a purple cover
item_key|an iron skeleton key
item_bones|a pile of white bones
feat_stairs_down|a stone staircase going down into the floor
feat_stairs_up|a stone staircase going up out of the floor
feat_door|a wooden door with iron bands
feat_chest|a wooden treasure chest with iron bands
feat_altar|a grey stone altar
feat_fountain|a round stone fountain full of blue water
feat_trap|an iron spike trap set in the floor
feat_boulder|a large grey boulder
LIST
echo "=== BATCH DONE ===" | tee -a "$LOG"
