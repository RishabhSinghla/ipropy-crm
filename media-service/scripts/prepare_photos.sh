#!/bin/sh
# Everything that has to happen to a photograph before anything else can read it.
#
# Two jobs, and both exist because of one file format.
#
# 1. **HEIC becomes JPEG.** Every iPhone writes HEIC. Pillow cannot open it, so
#    both Python scripts fall back to macOS `sips`, which does not exist on a
#    server; and the watermark script does not list .heic as a supported type at
#    all, so an iPhone photo silently came out of the pipeline with no logo on
#    it. GraphicsMagick with libde265 reads it, and doing the conversion once
#    here means nothing downstream has to know the format ever existed.
#
# 2. **The professional finish runs.** Straighten, white balance, exposure,
#    shadows, a little detail. Before the shapes are cut, so all five shapes and
#    the watermarked copy come off the corrected photograph rather than five
#    copies each needing their own correction.
#
# Originals are never touched. This only ever writes into EDITED/FINISHED.
#
#   prepare_photos.sh <property-root> [unit]
set -eu
ROOT="$1"
UNIT="${2:-$(basename "$ROOT" | cut -d- -f1 | tr "[:lower:]" "[:upper:]")}"
SRC="$ROOT/$UNIT-RAW-UPLOADS/PHOTOS"
OUT="$ROOT/$UNIT-EDITED/FINISHED"
HERE="$(dirname "$0")"

[ -d "$SRC" ] || { echo "no photo folder at $SRC"; exit 0; }
mkdir -p "$OUT"

TMP="${TMPDIR:-/tmp}/prepare-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

count=0
for f in "$SRC"/*.jpg "$SRC"/*.JPG "$SRC"/*.jpeg "$SRC"/*.JPEG \
         "$SRC"/*.heic "$SRC"/*.HEIC "$SRC"/*.heif "$SRC"/*.HEIF \
         "$SRC"/*.png "$SRC"/*.PNG; do
  [ -f "$f" ] || continue
  base=$(basename "$f"); stem="${base%.*}"
  out="$OUT/$stem.jpg"

  # The output is the record. Newer than its source means nothing has changed.
  if [ -f "$out" ] && [ ! "$f" -nt "$out" ]; then
    continue
  fi

  case "$base" in
    *.heic|*.HEIC|*.heif|*.HEIF)
      # -auto-orient because the rotation lives in a tag, and a portrait room
      # that arrives sideways is corrected by every viewer except a script.
      work="$TMP/$stem.jpg"
      if ! gm convert "$f" -auto-orient -quality 96 "$work" 2>/dev/null; then
        echo "  could not read $base"
        continue
      fi
      ;;
    *)
      work="$f"
      ;;
  esac

  if python3 "$HERE/professional_photo_finish.py" "$work" "$out" --quality 95 --overwrite >/dev/null 2>&1; then
    echo "  finished $stem.jpg"
  else
    # A photograph the finish could not read still has to reach the shapes, or
    # one awkward file removes a room from the listing.
    cp "$work" "$out"
    echo "  copied $stem.jpg (finish skipped)"
  fi
  count=$((count + 1))
done

echo "prepared $count photo(s) into $UNIT-EDITED/FINISHED"
