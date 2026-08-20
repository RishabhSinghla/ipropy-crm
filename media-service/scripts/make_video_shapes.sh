#!/bin/sh
# One property video in, every shape a broker posts out.
#
# Same rule as the photos: keep the native shape where it fits the platform, and
# pad onto a blurred copy of itself where it does not. Cropping a landscape
# walkthrough to 9:16 would throw away two thirds of every room.
set -eu
SRC="$1"; OUT="$2"
mkdir -p "$OUT"
W=$(ffprobe -v error -select_streams v:0 -show_entries stream=width -of default=nw=1:nk=1 "$SRC")
H=$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of default=nw=1:nk=1 "$SRC")
echo "source ${W}x${H}"

# 9:16 for Reels, Shorts, TikTok, WhatsApp Status.
if [ "$H" -gt "$W" ]; then
  ffmpeg -v error -y -i "$SRC" -vf "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" \
    -c:v libx264 -crf 26 -preset veryfast -c:a aac -b:a 96k "$OUT/vertical-9x16.mp4"
else
  ffmpeg -v error -y -i "$SRC" -filter_complex \
    "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.12[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" \
    -c:v libx264 -crf 26 -preset veryfast -c:a aac -b:a 96k "$OUT/vertical-9x16.mp4"
fi

# 16:9 for YouTube and the website.
if [ "$W" -ge "$H" ]; then
  ffmpeg -v error -y -i "$SRC" -vf "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080" \
    -c:v libx264 -crf 24 -preset veryfast -c:a aac -b:a 128k "$OUT/horizontal-16x9.mp4"
else
  ffmpeg -v error -y -i "$SRC" -filter_complex \
    "[0:v]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,boxblur=24:2,eq=brightness=-0.12[bg];[0:v]scale=-2:1080[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2" \
    -c:v libx264 -crf 24 -preset veryfast -c:a aac -b:a 128k "$OUT/horizontal-16x9.mp4"
fi

# A cover frame, taken a second in so it is never the lens cap or a blur.
ffmpeg -v error -y -ss 1 -i "$SRC" -frames:v 1 -q:v 3 "$OUT/cover.jpg"

for f in "$OUT"/*; do
  case "$f" in
    *.mp4) echo "  $(basename "$f") $(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0:nk=1 "$f") $(du -h "$f" | cut -f1)";;
    *) echo "  $(basename "$f") $(du -h "$f" | cut -f1)";;
  esac
done
