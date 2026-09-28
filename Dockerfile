FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY index.html vite.config.js ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    DOWNLOAD_DIR=/app/storage/downloads \
    ARCHIVE_DIR=/app/storage/archives \
    PIP_BREAK_SYSTEM_PACKAGES=1
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates ffmpeg python3-pip zip \
    && pip3 install --no-cache-dir gallery-dl yt-dlp \
    && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY migrations ./migrations
COPY --from=build /app/dist ./dist
RUN mkdir -p storage/downloads storage/archives \
    && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "server/index.js"]
