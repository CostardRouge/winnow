# Changelog

What each release of Winnow brings to the person culling with it. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html); `.github/workflows/release.yml` turns each section into a
tag and a GitHub Release once it reaches `main` (COMMON-PROJECT-SPEC C13 in `second-brain`). Written in English, like
the code. Codenames are grains, what a winnow sorts from the chaff, in alphabetical order. Versions 0.1.0 to 0.10.0
were given after the fact to the history's turning points.

## [Unreleased]

### Changed

- Atelier's documents (trips, projects, Develop rolls…) are no longer held to 1 MB: a roll of hundreds of edited
  pictures saves whole, up to 96 MB, the tunnel's own limit.

## [1.0.0] - 2026-10-17 — Rye

The first numbered release: Winnow as it runs on the Optiplex today, over the whole NAS library.

### Added

- Screenshots and files saved from other apps are set aside from Unplaced in bulk; a graded export takes its source
  clip's position.
- Each Unplaced frame is placed by the located frames around its own minute, and cards are rated by distance.
- Atelier keeps its flight atlases in Winnow's document bucket.
- The account menu shows the version the instance runs.

## [0.10.0] - 2026-10-15 — Quinoa
<!-- commit: 6251fa54c2dc5f69c0d15a0317c7e72aff749846 -->

### Added

- Frames are filed on their local capture day, and an imported GPS track (Polarsteps, GPX) places frames that have no
  position, with a preview and an undo.
- The gallery map shows every located media, one marker per spot.
- Duplicate triage reworked: a suggested survivor, a plan by rule, folder pairs, a keyboard review and your own
  strategies, in Settings › Pipeline › Duplicates.
- Claude can drive the library through an MCP server: find, look at, rate, trash and name the people in the media.
- A camera body a file got wrong can be corrected by hand, named, or set aside; a DJI clip names its camera from its
  own metadata; each body can be claimed as mine, someone else's or not a camera.
- Unplaced cards carry stops, can follow a track, flag impossible journeys and can be reviewed from the keyboard.

### Fixed

- Screens that showed part of the library as all of it now say what they show; manual positions written west or south
  of Greenwich are no longer mirrored.
- Migrations apply when the worker starts, so a deploy carries them.
- RAW files with no preview and files that lie about their type get derivatives; a GPS write into an original is
  never cut halfway.

## [0.9.0] - 2026-10-05 — Oat
<!-- commit: daf28592e32db1b378b7425d066b7f4359798e06 -->

### Added

- Unplaced: the media with no position, grouped one folder per card, placed in bulk from a suggestion or a map,
  never written into the originals.
- Media whose file never named a camera get one, voted on per folder, from the pipeline page or the grids.
- App tokens, for client apps that cannot hold the session cookie.

### Changed

- The grid scrolls at 60 fps with hundreds of tiles on screen.

### Security

- Six findings of a whole-codebase audit fixed.

## [0.8.0] - 2026-09-17 — Millet
<!-- commit: 5761fc800d7897cba0cd9754a3b962b4e26a6804 -->

### Added

- A Timeline that reads the library as chapters, and a Heatmap of when and where, both behind feature flags.
- A trusted client app (Atelier) can call the API across origins and keep its documents and files in Winnow.
- The Gear page as eight layouts.
- Settings › Instance shows the configuration, read-only, with each value's source.

### Changed

- The sieve replaces the feather as Winnow's mark.
- Duplicate triage stays usable at five thousand entries; originals moved on disk can be repaired from Missing files.

## [0.7.0] - 2026-08-29 — Kamut
<!-- commit: 3380401f45f4bdb5eca97e80cbf002fb17da0e93 -->

### Added

- People: detected faces clustered into named persons, with merges, suggestions and repairs, a People filter in the
  gallery and the faces in the viewer.
- Exposure brackets told apart from action bursts.
- An Incoming / Gallery / All switch on People and Search.
- A shutter count per camera body on the gear shelf.

## [0.6.0] - 2026-08-02 — Fonio
<!-- commit: 3d9398a99f668f8b1fc8323fafdc860c31f483c6 -->

### Added

- Accounts: sign-in, roles (admin, editor, viewer), invitations and a Users page.
- Settings: pipeline, volumes and import, the pipeline's Faces & text and Search index stages, and a Database page
  with backups to download.
- Culled keepers can be exported to Immich.
- The selection in the gallery downloads as a ZIP, one by one or as a folder.

### Changed

- Final and export copies are protected from deduplication.

## [0.5.0] - 2026-07-28 — Einkorn
<!-- commit: 2255bc472cab0da3eab172dff9910c75318ea222 -->

### Added

- Set the capture location of photos and videos by hand, one by one or for a whole session.
- A Gear page: the camera bodies and lenses that shot the library.
- Burst and bracket stacks: collapsed to a cover in the grid, with pile actions, restacking and keep-the-sharpest.
- Richer DJI drone metadata from the video telemetry and the photos.

## [0.4.0] - 2026-07-19 — Durum
<!-- commit: 72a72c91bd657b249ba6db81bc1139f1592cd36a -->

### Added

- Semantic search: find media by describing them.
- File integrity: missing originals detected by a periodic rescan, with their own triage tab.
- DJI telemetry sidecars read end to end.
- A near-duplicates filter in the gallery.
- A dark theme.

## [0.3.0] - 2026-07-12 — Corn
<!-- commit: e0b42763d132e309560270cef724987df240cb5d -->

### Added

- Bursts and brackets detected at scan time.
- Finals paired with the sources they came from.
- Positions turned into place names.
- ML triage: faces, text, a blur score and near-duplicate detection.
- Live Photo motion previews in the grid, in Sift and in the viewer.

### Changed

- The grid loads media faster.

## [0.2.0] - 2026-06-23 — Barley
<!-- commit: a92b77733c1759dcef07cfcb098e750f8a52bcf2 -->

### Added

- The Library: Incoming sessions, the Gallery of finals, Exports and Trash, with filters, a map and a calendar.
- Sift: cull by swiping through a session's media.
- A media viewer with swipe, zoom and an info panel.
- Volumes: the NAS folders to index, picked from a browser of the NAS.
- RAW + JPEG pairs, Live Photos and Sony sidecars treated as one media.
- Duplicate triage, a recycle bin and a confirmed purge of the rejects.
- An installable app on phones and computers.

## [0.1.0] - 2026-06-19 — Amaranth
<!-- commit: eaecb9d60b7d531c568f7e99a4a80d30d97fe195 -->

### Added

- Index the RAW photos and videos on the NAS, read once, cull them on lightweight proxies and export the keepers.
