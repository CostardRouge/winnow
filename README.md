# 🪶 Winnow — outil de gestion média (ingest / tri / export)

Application web responsive pour **indexer, trier et exporter** les photos/vidéos
brutes du NAS, multi-appareils (Sony A7C II, drone DJI, iPhone, Ray-Ban Meta).

> **Principe directeur** : le filesystem et les RAW ne sont touchés qu'**une seule
> fois** (indexation + génération des dérivés). Tout le reste — navigation, tri,
> requêtes — passe par Postgres et un cache de dérivés. Le tri se fait toujours
> sur des proxies légers, **jamais sur les RAW**.

Ce dépôt implémente le **MVP** (cf. §11 des specs) : indexer + extraction de
l'aperçu RAW + base + marquage « dossier ignoré » + grille de tri (pick/reject/
étoiles) + export « copie RAW pour Capture One ». Photos uniquement.

---

## Architecture

Composants découplés, communiquant via Postgres + une file Redis (BullMQ) :

```
NAS (HDD, RAW/vidéo, RO)  ──►  Indexer  ──►  Postgres (sessions, assets, ratings)
                                  │
                                  └─enqueue──►  Workers dérivés ──► Stockage (disk/MinIO)
                                                   (exiftool + sharp)   thumbs + proxies
Next.js (UI tri + API) ◄── Postgres + Stockage
   └─► Export worker ──► copie RAW pour Capture One  (+ lignage source→export)
```

Tout (Postgres, Redis, dérivés, exports) vit sur l'**Optiplex**. Le NAS est
monté en **lecture seule** : il n'est que source.

### Décisions §12 retenues

| # | Décision | Choix |
|---|----------|-------|
| 1 | Dérivés : MinIO ou disque | **Cache disque**, derrière une interface de type S3 (`src/lib/storage`) → bascule vers **MinIO** via `STORAGE_DRIVER=s3` sans toucher au code. |
| 2 | Montage vs agent NAS | **Montage RO** pour le MVP (tranché par les specs). |
| 3 | Déduplication par hash | **Oui dès le MVP** : `content_hash` partiel (taille + extrémités) + index unique. |
| 4 | Clé de liaison finaux C1 → source | Reportée à la V2 (réconciliation), endpoint `POST /reconcile` réservé. |

---

## Démarrage

### Avec Docker Compose (recommandé)

```bash
cp .env.example .env
# Éditer NAS_MOUNT pour pointer vers le montage RO du NAS, ajuster les chemins.
docker compose run --rm migrate     # applique le schéma
docker compose up -d                 # app (http://localhost:3000) + worker
```

Puis, depuis l'UI, saisir un chemin de dossier du NAS (tel que vu **dans le
conteneur**, p. ex. `/nas/2026/…`) et cliquer **Indexer**.

### En local (dev)

Nécessite un Postgres et un Redis joignables, plus `perl` (pour exiftool) et
les libs de `sharp` (fournies par les binaires prébuild).

```bash
npm install
cp .env.example .env   # adapter DATABASE_URL / REDIS_URL (localhost)
npm run migrate
npm run dev            # UI + API sur http://localhost:3000
npm run worker         # dans un autre terminal : workers BullMQ
# Indexer un dossier en direct (sans Redis) :
npm run scan -- /chemin/vers/dossier --sync
```

---

## Variables d'environnement

Voir `.env.example`. Principales :

- `DATABASE_URL`, `REDIS_URL`
- `STORAGE_DRIVER=disk|s3`, `STORAGE_DISK_PATH`, et les `S3_*` pour MinIO
- `EXPORT_DIR` : dossier où l'export « copie RAW » dépose les originaux
- `*_CONCURRENCY` : concurrence bornée pour ménager le HDD plein du NAS
- `THUMB_SIZE` / `PROXY_SIZE` / qualités

---

## API

| Méthode & route | Rôle |
|---|---|
| `POST /api/index/scan` `{ path }` | Enregistre le root et enfile une indexation |
| `GET /api/sessions` | Liste des sessions + compteurs (prêts/en attente/picks) |
| `PATCH /api/sessions/:id` `{ ignored }` | Marque le dossier traité (cascade, stoppe les dérivés) |
| `GET /api/sessions/:id/assets?cursor&verdict&…` | Grille paginée (cursor-based) |
| `GET /api/assets/:id` | Détail + EXIF |
| `GET /api/assets/:id/thumb` \| `/proxy` | Sert le dérivé (octets, ou redirection signée en S3) |
| `GET /api/assets/:id/exports` | Lignage (finaux liés à cet original) |
| `PATCH /api/assets/:id/rating` `{ verdict, star, color }` | État de tri |
| `POST /api/ratings/bulk` `{ ids[], verdict, star }` | Tri rapide en lot |
| `POST /api/export` `{ name, target, filter }` | Crée + enfile un export |
| `GET /api/export/:id` | Statut + résultat |
| `POST /api/upload` (multipart `files`) | Upload depuis le téléphone → inbox → import |
| `POST /api/import/offload` `{ path }` | Offload d'une carte montée (source conservée) |
| `POST /api/import/inbox` | Relance manuelle de l'import de l'inbox |
| `GET /api/import/:id` | Statut d'un lot d'import |
| `GET /api/roots` · `POST /api/roots` | Dossiers enregistrés (sources + finaux) |
| `POST /api/reconcile` | Réconciliation finaux→sources (**V2**, 501) |

Pagination **cursor-based** sur `(captured_at, id)` — jamais d'`OFFSET`. La
grille front charge en infinite-scroll les vignettes au fil de l'eau.

### Raccourcis de tri (visionneuse)

- **Clavier** : `P` pick · `X` rejet · `U` annuler · `1`-`5` étoiles · `←`/`→` naviguer · `Échap` fermer
- **Tactile** : swipe ↑ = pick, swipe ↓ = rejet, swipe ←/→ = naviguer

---

## Périmètre & suites

**Implémenté (MVP)** : indexation incrémentale (mtime+taille), EXIF + hash +
dédup, extraction de l'aperçu RAW (ARW/DNG…) sans dématriçage, dérivés
thumb/proxy en WebP, grille de tri mobile-first, ignore-cascade, export copie
RAW + lignage `exports`, **ingest multi-feeders** (voir ci-dessous).

**V2/V3 (non inclus)** : notes/couleurs/tags avancés, export web + push Immich,
réconciliation auto des finaux C1, vidéo (proxies FFmpeg), throttling adaptatif,
agent-sur-NAS, automatisations n8n.

---

## Ingest / import (implémenté)

Les specs supposent les fichiers **déjà rangés sur le NAS**. Winnow ajoute en
amont un étage d'import : **tous les feeders convergent vers une `inbox`**, puis
un *import worker* **vérifie** (write-then-verify par hash), **déduplique**
(même `content_hash` que l'indexer → réinsérer une carte ne duplique rien),
**range** dans l'`incoming` (archive NAS) selon le gabarit
`{device}/{YYYY}/{YYYY-MM-DD}/`, puis enfile l'indexation habituelle.

```
 iPhone / Ray-Ban ─┐
 SD card (Sony/DJI)─┼─►  INBOX  ──►  Import worker  ──►  INCOMING (NAS, RW)  ──► index → dérivés
 caméra Wi-Fi/FTP ──┘     (watch)    verify+dedup+file     {device}/{date}/
```

**Trois feeders, tous branchés sur l'inbox :**

1. **Upload web (téléphone)** — page **Import** dans l'UI : sélecteur de
   fichiers natif, les médias sont streamés vers `POST /api/upload`, déposés dans
   l'inbox, puis importés. Aucune app tierce, fonctionne depuis le téléphone sur
   le LAN. (HEIC/JPEG/vidéo gérés.)

2. **Offload de carte montée sur l'Optiplex** — `POST /api/import/offload
   { path }` (ou le champ dédié de la page Import). La carte est **laissée
   intacte** (`removeAfter=false`).

3. **Dépôt SMB / FTP** — un partage Samba et/ou un endpoint FTP (services
   optionnels dans `docker-compose.yml`) écrivent dans l'inbox ; un **watcher**
   (chokidar, `awaitWriteFinish` pour ne pas importer un transfert en cours)
   enfile l'import automatiquement. Idéal pour le transfert FTP du Sony A7C II.

**Garanties** : intégrité vérifiée (taille + hash de la copie), dédup globale,
foldering déterministe, suivi par lot dans `import_batches` (importés / doublons
/ échecs). Le tout réutilise l'indexer, les dérivés et la dédup existants.

**Pistes V2/V3** : regroupement par « trou temporel » (gap > N h ⇒ session),
gabarit de foldering configurable, déclenchement n8n à l'insertion d'une carte,
hash complet (plutôt que partiel) en option pour l'intégrité forte.
