# The media worker's own image.
#
# Debian rather than Alpine on purpose: GraphicsMagick needs libheif to read the
# HEIC that every iPhone produces, and Debian ships that combination already
# built. On Alpine it is a compile, and a compile in an image is a thing that
# breaks six months later on a machine nobody is watching.
#
# ffmpeg is here for video, imageio for the walkthrough builder — the one
# dependency the scripts needed that was missing on the Mac.
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      graphicsmagick \
      ffmpeg \
      libheif1 \
      libde265-0 \
    && rm -rf /var/lib/apt/lists/*

# Pillow reads the ordinary formats; GraphicsMagick is the fallback for HEIC,
# standing in for the macOS `sips` the scripts originally shelled out to.
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir "Pillow>=11" "imageio[ffmpeg]>=2.34"

WORKDIR /app
COPY scripts/ /app/scripts/
COPY iPropy-Logo-1.jpeg /app/iPropy-Logo-1.jpeg
COPY app.py /app/app.py

# Never root. This process takes a path from the network and hands it to a
# subprocess, so the blast radius of getting that wrong should be one
# unprivileged account with access to one mounted folder.
RUN useradd --create-home --uid 10001 media && chown -R media:media /app
USER media

ENV MEDIA_ROOT=/data/properties \
    PORT=8080 \
    PYTHONUNBUFFERED=1

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8080/health',timeout=3).status==200 else 1)"

CMD ["python3", "/app/app.py"]
