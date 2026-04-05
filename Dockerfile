# Multi-stage build for Stream2Graph Platform
FROM node:20-alpine AS web-builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY packages ./packages

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy web app source
COPY apps/web ./apps/web

# Build web app
RUN pnpm --filter @stream2graph/web build

# Python API stage
FROM python:3.11-slim AS api-builder

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    gcc \
    postgresql-client \
    && rm -rf /var/lib/apt/lists/*

# Copy API requirements
COPY apps/api/pyproject.toml ./apps/api/
RUN pip install --no-cache-dir -e ./apps/api

# Final stage
FROM python:3.11-slim

WORKDIR /app

# Install runtime dependencies
RUN apt-get update && apt-get install -y \
    postgresql-client \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js for Next.js
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && npm install -g pnpm@10.30.3

# Copy Python dependencies
COPY --from=api-builder /usr/local/lib/python3.11/site-packages /usr/local/lib/python3.11/site-packages

# Copy built web app
COPY --from=web-builder /app/apps/web/.next ./apps/web/.next
COPY --from=web-builder /app/apps/web/public ./apps/web/public
COPY --from=web-builder /app/apps/web/package.json ./apps/web/
COPY --from=web-builder /app/node_modules ./node_modules

# Copy API source
COPY apps/api ./apps/api

# Copy startup script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000 8000

ENTRYPOINT ["docker-entrypoint.sh"]
