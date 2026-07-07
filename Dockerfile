# BRIGHT OS — one image, three commands (app / workers / watcher).
FROM node:22-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

# pg_dump 17 to match the Supabase Postgres major (bookworm ships 15 → too old)
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates gnupg lsb-release \
  && sh -c 'echo "deb https://apt.postgresql.org/pub/repos/apt $(lsb_release -cs)-pgdg main" > /etc/apt/sources.list.d/pgdg.list' \
  && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc | gpg --dearmor -o /etc/apt/trusted.gpg.d/pgdg.gpg \
  && apt-get update && apt-get install -y --no-install-recommends postgresql-client-17 rclone \
  && rm -rf /var/lib/apt/lists/*

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# env is provided at runtime; build with placeholders so `next build` passes
ENV NEXT_PUBLIC_SUPABASE_URL=https://placeholder.supabase.co \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=placeholder
RUN npm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY . .
EXPOSE 3100
# default command = web app; compose overrides for workers/watcher
CMD ["npm", "run", "start"]
