# Medusa v2 backend — productie-image (Railway).
# Build-context = apps/backend (Railway rootDirectory). Self-contained, geen monorepo-root nodig.
FROM node:20-slim AS build
WORKDIR /app

# OS-deps voor native modules (pg etc.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install

COPY . .
# medusa build -> .medusa/server (server + admin dashboard)
RUN npm run build

# --- Productie-runtime ---
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/.medusa/server ./
RUN npm install --omit=dev

EXPOSE 9000
# Migraties draaien bij elke deploy (idempotent), daarna de server starten.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
