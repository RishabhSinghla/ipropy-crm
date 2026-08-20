#!/bin/sh
# One property video in, every shape a broker posts out.
#
# Same rule as the photos: keep the native shape where it fits the platform, and
# pad onto a blurred copy of itself where it does not. Cropping a landscape
# walkthrough to 9:16 would throw away two thirds of every room.
set -eu
# The service hands every job a FOLDER, so take the videos out of it rather than
# expecting a file. A property normally has one walkthrough; more is fine.
IN="$1"; OUT="$2"
mkdir -p "$OUT"
FOUND=0
for SRC in "$IN"/*.mov "$IN"/*.MOV "$IN"/*.mp4 "$IN"/*.MP4 "$IN"/*.m4v; do
  [ -f "$SRC" ] || continue
  FOUND=1
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$SRC")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$SRC")
echo "source ${W}x${H}"

# 9:16 for Reels, Shorts, TikTok, WhatsApp Status.
if [ "$H" -gt "$W" ]; then
  ffmpeg -v error -y -i "$SRC" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
    -c:v libx264 -crf 26 -preset veryfast -c:a aac -b:a 96k "$OUT/$(basename "${SRC%.*}")-9x16.mp4"
else
  ffmpeg -v error -y -i "$SRC" -filter_complex \
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.12[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" \
    -c:v libx264 -crf 26 -preset veryfast -c:a aac -b:a 96k "$OUT/$(basename "${SRC%.*}")-9x16.mp4"
fi

# 16:9 for YouTube and the website.
if [ "$W" -ge "$H" ]; then
  ffmpeg -v error -y -i "$SRC" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" \
    -c:v libx264 -crf 24 -preset veryfast -c:a aac -b:a 128k "$OUT/$(basename "${SRC%.*}")-16x9.mp4"
else
  ffmpeg -v error -y -i "$SRC" -filter_complex \
    "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:2,eq=brightness=-0.12[bg];[0:v]scale=-2:1080[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" \
    -c:v libx264 -crf 24 -preset veryfast -c:a aac -b:a 128k "$OUT/$(basename "${SRC%.*}")-16x9.mp4"
fi

# A cover frame, taken a second in so it is never the lens cap or a blur.
ffmpeg -v error -y -ss 1 -i "$SRC" -frames:v 1 -q:v 3 "$OUT/$(basename "${SRC%.*}")-cover.jpg"

done

# A property with no walkthrough is an ordinary state, not a failure, so say so
# and exit clean rather than making the whole run look broken.
[ "$FOUND" = 1 ] || { echo "no video in $IN"; exit 0; }

for f in "$OUT"/*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.mp4) echo "  $(basename "$f") $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:nk=1 "$f") $(du -h "$f" | cut -f1)";;
    *) echo "  $(basename "$f") $(du -h "$f" | cut -f1)";;
  esac
done
