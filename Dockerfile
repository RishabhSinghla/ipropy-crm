# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/package.json
COPY packages/server/package.json packages/server/package.json
COPY packages/web/package.json packages/web/package.json
RUN npm ci --ignore-scripts

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV SERVE_WEB=true
# ffmpeg is not optional. Video transcoding degrades gracefully without it
# (clips serve unprocessed), but HEIC decoding does not have a fallback:
# sharp's libvips ships with no HEVC decoder, so without ffmpeg every photo
# from an iPhone gets no thumbnail and no web-sized copies, and the website
# serves visitors a multi-megabyte original. See core/media/transcode.ts.
RUN apk add --no-cache ffmpeg
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/scripts ./scripts
RUN chmod +x ./scripts/docker-entrypoint.sh
EXPOSE 4000
# Migrate + seed + start. docker-compose overrides this for the `worker`
# service (which runs the scheduler instead) and relies on the `app` service
# having already migrated — see docker-compose.yml.
CMD ["./scripts/docker-entrypoint.sh"]
