# ── Build stage ───────────────────────────────────────────────────────────────
# Builds frontend (Vite) and prepares node_modules with native bindings
# (better-sqlite3 needs python3/make/g++ to compile).
FROM node:22-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package*.json ./
# Install ALL deps (including devDeps needed for vite build).
# Do NOT use --ignore-scripts — better-sqlite3 needs its postinstall to compile.
RUN npm ci

COPY . .
RUN npm run build


# ── Production stage ──────────────────────────────────────────────────────────
FROM node:22-alpine AS production

WORKDIR /app

# Cloud backup uploads use rclone. Secrets/config come from environment
# variables, not from the image.
RUN apk add --no-cache rclone cups-client

# Copy compiled native modules and runtime deps from builder.
# This avoids needing python3/make/g++ in the final image.
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist          ./dist

# Backend source — tsx (now a runtime dep) executes TS on the fly.
COPY --chown=node:node package*.json ./
COPY --chown=node:node server.ts ./
COPY --chown=node:node server/ ./server/
COPY --chown=node:node shared/ ./shared/
COPY --chown=node:node scripts/ ./scripts/
COPY --chown=node:node tsconfig.json ./

# Trim devDeps (keeps tsx since it's now in dependencies).
# --ignore-scripts is safe here because native modules are already built in builder.
RUN npm prune --omit=dev --ignore-scripts

# Data directories — mount as Docker volumes in production.
RUN mkdir -p /data /app/uploads/products /backups && chown -R node:node /data /app/uploads /backups

ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/dsdst_panel.db
ENV BACKUP_DIR=/backups

EXPOSE 3000

USER node

# /api/public/health requires no auth and always responds with 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3000/api/public/health || exit 1

CMD ["node", "node_modules/tsx/dist/cli.mjs", "server.ts"]
