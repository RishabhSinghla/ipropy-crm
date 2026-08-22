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

for f in "$SRC"/*.jpg "$SRC"/*.JPG "$SRC"/*.jpeg "$SRC"/*.heic "$SRC"/*.HEIC; do
  [ -f "$f" ] || continue
  n=$(basename "$f"); n="${n%.*}"

  # Skip a photo whose work is already done.
  #
  # Finish gets pressed again every time a photo is added, and every press was
  # re-cutting all twenty from scratch. The outputs are the record: if the
  # portal copy exists and is not older than the original, nothing about this
  # photo has changed and there is nothing to redo. Deleting an output folder
  # is how you force a rebuild.
  done_marker="$ROOT/05_PORTALS/$n.jpg"
  if [ -f "$done_marker" ] && [ ! "$f" -nt "$done_marker" ]; then
    echo "$n (already done, skipped)"
    continue
  fi
  echo "$n"
  mkdir -p "$ROOT/05_PORTALS" "$ROOT/07_WEBSITE" "$ROOT/04_SOCIAL/INSTAGRAM/FEED" \
           "$ROOT/04_SOCIAL/INSTAGRAM/STORIES" "$ROOT/04_SOCIAL/FACEBOOK" \
           "$ROOT/04_SOCIAL/WHATSAPP" "$ROOT/04_SOCIAL/GOOGLE_BUSINESS" \
           "$ROOT/03_EDITED_MEDIA/THUMBNAILS"
  # Portals want landscape and are where a buyer actually searches.
  shape "$f" "$ROOT/05_PORTALS/$n.jpg"                    1600 1200 88
  shape "$f" "$ROOT/07_WEBSITE/$n.jpg"                    1920 1080 84
  shape "$f" "$ROOT/04_SOCIAL/INSTAGRAM/FEED/$n.jpg"      1080 1350 86
  shape "$f" "$ROOT/04_SOCIAL/INSTAGRAM/STORIES/$n.jpg"   1080 1920 86
  shape "$f" "$ROOT/04_SOCIAL/GOOGLE_BUSINESS/$n.jpg"     1080 1080 86
  shape "$f" "$ROOT/03_EDITED_MEDIA/THUMBNAILS/$n.jpg"     480  480 78
  # Facebook and WhatsApp both want the 4:5 that already exists. Copy rather
  # than re-encode: same pixels, and the folder stops looking like a failure.
  cp "$ROOT/04_SOCIAL/INSTAGRAM/FEED/$n.jpg" "$ROOT/04_SOCIAL/FACEBOOK/$n.jpg"
  cp "$ROOT/04_SOCIAL/INSTAGRAM/FEED/$n.jpg" "$ROOT/04_SOCIAL/WHATSAPP/$n.jpg"
done
