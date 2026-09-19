# ─────────────────────────────────────────────────────────────
#  CineCast — Telegram watch-together bot
#  .env НЕ копируется в образ: конфиг задаётся переменными
#  окружения на хостинге (см. .env.example).
# ─────────────────────────────────────────────────────────────

# ── Сборка зависимостей ──────────────────────────────────────
FROM node:22-bookworm-slim AS deps

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# ── Рантайм ──────────────────────────────────────────────────
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    TZ=Europe/Moscow \
    DB_PATH=/app/data/cinecast.db

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg ca-certificates curl tzdata \
    && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
         -o /usr/local/bin/yt-dlp \
    && chmod +x /usr/local/bin/yt-dlp \
    && yt-dlp --version \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY bot.js ./

RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]

USER node

# Мягкая остановка: ffmpeg получает SIGTERM, сессии закрываются
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=60s --timeout=10s --start-period=20s --retries=3 \
  CMD node -e "process.exit(require('fs').existsSync(process.env.DB_PATH)?0:1)"

CMD ["node", "bot.js"]
