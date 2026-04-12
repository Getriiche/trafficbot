# Stage 1: Build
FROM node:18-slim AS builder

WORKDIR /app

# Copy all files first (needed for postinstall scripts)
COPY . .

# Install dependencies for build
# Tell puppeteer to skip browser download during npm install
RUN PUPPETEER_SKIP_DOWNLOAD=true npm install

# Build TypeScript
RUN npm run build

# Stage 2: Runtime
FROM ghcr.io/puppeteer/puppeteer:latest AS runtime

WORKDIR /app

# Copy built assets
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/useragent ./useragent
COPY --from=builder /app/pbn-sites.json ./
# Note: Proxy files removed - using IPRoyal Web Unblocker (API-based)

# Copy node_modules from builder (already installed)
COPY --from=builder /app/node_modules ./node_modules

# Environment setup
ENV NODE_ENV=production
ENV LOG_LEVEL=info

# Healthcheck (Simplified)
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "require('fs').existsSync('./dist/main.js') || process.exit(1)"

# Entrypoint
ENTRYPOINT ["node", "dist/main.js"]
