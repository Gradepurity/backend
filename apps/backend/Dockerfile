# Medusa v2 backend — productie-image (Railway), gebouwd via GitHub Actions.
# Build-context = apps/backend.
FROM node:20-slim
WORKDIR /app

# OS-deps voor native modules (pg etc.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install MET devDependencies (nodig voor `medusa build`).
COPY package.json ./
RUN npm install

COPY . .
# medusa build -> .medusa/server (server + admin dashboard in .medusa/server/public/admin)
RUN npm run build && test -f .medusa/server/public/admin/index.html

# De server draait VANUIT .medusa/server (anders wordt de admin-build niet gevonden).
WORKDIR /app/.medusa/server
RUN npm install

ENV NODE_ENV=production
EXPOSE 9000
# Migraties bij elke deploy (idempotent), daarna server starten.
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
