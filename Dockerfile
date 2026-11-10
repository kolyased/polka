FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json lib.mjs storage.mjs server.mjs ./
COPY public ./public
COPY scripts/import.mjs ./scripts/import.mjs
COPY scripts/continuous.mjs ./scripts/continuous.mjs
RUN mkdir /data && chown node:node /data
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
EXPOSE 8787
CMD ["node", "server.mjs"]
