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
RAW + lignage `exports`.

**V2/V3 (non inclus)** : notes/couleurs/tags avancés, export web + push Immich,
réconciliation auto des finaux C1, vidéo (proxies FFmpeg), throttling adaptatif,
agent-sur-NAS, automatisations n8n.

---

## 💡 Idées pour la partie **ingest / import** (non couverte par les specs)

Les specs partent du principe que les fichiers sont **déjà rangés sur le NAS** :
Winnow *indexe*, il n'*organise pas*. Reste la question de **comment les octets
arrivent sur le NAS** depuis les cartes SD / appareils. Proposition d'un étage
« import » en amont de l'indexer, cohérent avec le principe « toucher une fois » :

1. **Dossiers `inbox` surveillés + worker d'offload.** Nouveau `roots.kind =
   'inbox'`. Quand une carte SD ou un appareil dépose dans l'inbox, un *import
   worker* copie vers la structure NAS, **vérifie par hash** (write-then-verify :
   on relit ce qu'on a écrit), puis déclenche l'indexation. La copie vérifiée
   est l'unique « toucher » lourd ; l'indexer réutilise ensuite l'aperçu embarqué.

2. **Foldering déterministe et configurable.** Gabarit type
   `/{device}/{YYYY}/{YYYY-MM-DD}_{session}` dérivé de la date de capture EXIF +
   de l'appareil. Regroupement par « trou temporel » (gap > N h ⇒ nouvelle
   session), comme le fait l'import de Lightroom/C1.

3. **Dédup dès l'import.** On réutilise `content_hash` : si le contenu existe
   déjà en base, on **n'importe pas** (réinsérer une carte ne duplique rien).
   C'est le même invariant que l'indexer, appliqué plus tôt.

4. **Adaptateurs par appareil :**
   - *Sony A7C II / drone DJI* : montage de la carte → offload direct.
   - *iPhone* : app type **PhotoSync**/Working Copy poussant en SMB vers l'inbox,
     ou import via l'app Immich ; HEIC/DNG gérés tels quels.
   - *Ray-Ban Meta* : export depuis l'app Meta View → dossier desktop → inbox.

5. **Sécurité d'éjection.** Un import n'est « terminé » qu'une fois **tous** les
   fichiers copiés *et* re-hachés OK ; rapport clair avant de retirer la carte.

6. **Déclenchement mobile.** Bouton « Importer depuis l'inbox » dans l'UI qui
   enfile un job d'import ; idéal depuis le téléphone.

7. **Automatisation (V3).** n8n/watcher : à l'apparition d'un nouveau dossier sur
   le NAS (ou d'une carte montée), enfiler import → index → dérivés.

> Contrat minimal à ajouter : une file `winnow-import` + `roots.kind='inbox'` +
> `POST /api/import { inbox_root_id }`. Le reste (foldering, hash, dédup) réutilise
> les briques existantes. Implémentable en prochaine itération si tu valides
> l'approche « inbox + offload vérifié ».
