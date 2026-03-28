FROM node:22-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY server.mjs .

EXPOSE 8080
CMD ["node", "server.mjs"]
