# Winnow — image unique partagée par l'app Next.js et les workers BullMQ.
# Le worker exécute le TypeScript via tsx (dépendance runtime), l'app sert le
# build Next. On reste en root : les volumes nommés et les montages NAS
# (NFS/SMB, mapping d'uid propre) sont ainsi accessibles en écriture sans friction.
FROM node:22-slim

# exiftool-vendored a besoin de perl sur Linux. (ffmpeg : réservé à la vidéo, V3.)
RUN apt-get update \
  && apt-get install -y --no-install-recommends perl \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 1) Dépendances — couche cachée tant que les manifestes ne changent pas.
#    npm ci = installation reproductible à partir du lockfile.
COPY package.json package-lock.json ./
RUN npm ci

# 2) Code + build de l'app Next.
COPY . .
RUN npm run build

ENV NODE_ENV=production \
    PORT=3000
EXPOSE 3000

# Sonde de vivacité (fetch natif Node 22, pas de binaire externe requis).
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Commande par défaut : l'app web. Les services worker/migrate surchargent `command`.
CMD ["npm", "run", "start"]
