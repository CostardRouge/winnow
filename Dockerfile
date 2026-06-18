# Image unique partagée par l'app Next.js et les workers BullMQ.
FROM node:22-slim AS base

# exiftool-vendored a besoin de perl sur Linux ; ffmpeg réservé à la vidéo (V3).
RUN apt-get update \
  && apt-get install -y --no-install-recommends perl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances (installées une fois, cache Docker).
COPY package.json package-lock.json* ./
RUN npm install

# Code + build Next.
COPY . .
RUN npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Commande par défaut : l'app web. Le service worker surcharge `command`.
CMD ["npm", "run", "start"]
