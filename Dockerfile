# ─────────────────────────────────────────────
# RevIQ Command Bot — Dockerfile
# Deploys the Telegram bot to Railway
# ─────────────────────────────────────────────

FROM node:20-alpine AS base

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Copy bot source only (web dashboard is deployed separately on Vercel)
COPY bot/ ./bot/

# Health check — Railway uses this to confirm the process is alive
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.PORT || 3000) + '/health', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "bot/index.js"]
