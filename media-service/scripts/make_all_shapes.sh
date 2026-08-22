#!/bin/sh
# One horizontal photo in, every shape a broker needs out.
#
# The rule that matters: crop when the target is a similar shape to the source,
# fit-on-a-blurred-backdrop when it is not. Cropping a landscape room photo to
# 9:16 keeps 31% of the width, which is a sliver of wall nobody can identify.
# Fitting keeps the whole room and still fills the frame.
#
#   make_all_shapes.sh <property-root>
set -eu
ROOT="$1"
# Supplied by the CRM, which is the only thing that knows what this property is
# called. Empty is fine: the camera's own name is used and nothing breaks.
PREFIX="${2:-}"
SEQ=0
SRC="$ROOT/01_RAW_UPLOADS/PHOTOS"
KEEP_MIN=60          # below this % of the image surviving a crop, fit instead

shape() {  # file out W H quality
  f="$1"; out="$2"; W="$3"; H="$4"; Q="$5"
  read w h <<EOF
$(gm identify -format "%w %h" "$f")
EOF
  keep=$(awk -v w="$w" -v h="$h" -v W="$W" -v H="$H" 'BEGIN{
    s=(W/w > H/h) ? W/w : H/h; nw=w*s; nh=h*s; printf "%d", (W/nw)*(H/nh)*100 }')
  if [ "$keep" -ge "$KEEP_MIN" ]; then
    gm convert "$f" -resize "${W}x${H}^" -gravity center -crop "${W}x${H}+0+0" +repage -quality "$Q" "$out"
  else
    gm convert "$f" -resize "${W}x${H}^" -gravity center -crop "${W}x${H}+0+0" +repage \
       -blur 0x28 -modulate 70 "/tmp/_bg.jpg"
    gm convert "$f" -resize "${W}x${H}" "/tmp/_fg.jpg"
    gm composite -gravity center "/tmp/_fg.jpg" "/tmp/_bg.jpg" -quality "$Q" "$out"
  fi
  echo "  $(basename "$out") ${W}x${H} $([ "$keep" -ge "$KEEP_MIN" ] && echo crop || echo fit)"
}

for f in "$SRC"/*.jpg "$SRC"/*.JPG "$SRC"/*.jpeg "$SRC"/*.JPEG "$SRC"/*.heic "$SRC"/*.HEIC; do
  [ -f "$f" ] || continue
  n=$(basename "$f"); n="${n%.*}"
  SEQ=$((SEQ+1))
  # Two digits so a folder of twenty sorts the way a person expects.
  [ -n "$PREFIX" ] && n=$(printf "%s-%02d" "$PREFIX" "$SEQ")

  # Skip a photo whose work is already done. The outputs are the record: if the
  # 4x3 exists and is not older than the original, nothing has changed. Deleting
  # an output folder is how you force a rebuild.
  done_marker="$ROOT/02_SHAPES/4x3/$n.jpg"
  if [ -f "$done_marker" ] && [ ! "$f" -nt "$done_marker" ]; then
    echo "$n (already done, skipped)"
    continue
  fi
  echo "$n"

  mkdir -p "$ROOT/02_SHAPES/4x5" "$ROOT/02_SHAPES/9x16" "$ROOT/02_SHAPES/1x1" \
           "$ROOT/02_SHAPES/4x3" "$ROOT/02_SHAPES/16x9" "$ROOT/02_SHAPES/2x3" \
           "$ROOT/02_SHAPES/1.91x1" "$ROOT/03_EDITED_MEDIA/THUMBNAILS"

  # One file per shape. Five platforms want 4:5 and they all read the same one.
  shape "$f" "$ROOT/02_SHAPES/4x3/$n.jpg"     1600 1200 88
  shape "$f" "$ROOT/02_SHAPES/16x9/$n.jpg"    1920 1080 84
  shape "$f" "$ROOT/02_SHAPES/4x5/$n.jpg"     1080 1350 86
  shape "$f" "$ROOT/02_SHAPES/9x16/$n.jpg"    1080 1920 86
  shape "$f" "$ROOT/02_SHAPES/1x1/$n.jpg"     1080 1080 86
  shape "$f" "$ROOT/02_SHAPES/2x3/$n.jpg"     1000 1500 86
  shape "$f" "$ROOT/02_SHAPES/1.91x1/$n.jpg"  1200  627 84
  shape "$f" "$ROOT/03_EDITED_MEDIA/THUMBNAILS/$n.jpg" 480 480 78
done
