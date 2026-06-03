# Medusa v2 backend — productie-image (Railway).
# Build-context = apps/backend (Railway rootDirectory). Self-contained, één stage = robuust.
FROM node:20-slim
WORKDIR /app

# OS-deps voor native modules (pg etc.)
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

# Install MET devDependencies (nodig voor `medusa build`). NODE_ENV pas op production ná de build.
COPY package.json ./
RUN npm install

COPY . .
# medusa build -> .medusa/server (server + admin dashboard)
RUN npm run build && test -d .medusa/server

ENV NODE_ENV=production
EXPOSE 9000
# Migraties bij elke deploy (idempotent), daarna server starten (medusa start vindt .medusa/server vanuit de root).
CMD ["sh", "-c", "npx medusa db:migrate && npm run start"]
