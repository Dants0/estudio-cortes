FROM node:22-bookworm-slim

# Bibliotecas que o Chrome Headless Shell do Remotion precisa
RUN apt-get update && apt-get install -y --no-install-recommends \
      libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 libxkbcommon-dev \
      libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 libpango-1.0-0 libcairo2 libcups2 \
      fonts-noto-color-emoji fonts-liberation ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npx prisma generate && npm run build && npx remotion browser ensure

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3100 \
    DATA_DIR=/data \
    CONFIG_DIR=/config
VOLUME ["/data", "/config"]
EXPOSE 3100
# aplica as migrations pendentes do banco e sobe o painel
CMD ["sh", "-c", "npx prisma migrate deploy && exec node server/index.mjs"]
