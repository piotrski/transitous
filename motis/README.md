<!--
SPDX-FileCopyrightText: 2024 Jonah Brüchert <jbb@kaidan.im>

SPDX-License-Identifier: AGPL-3.0-or-later
-->

# MOTIS Docker/Coolify deployment

This repository ships a Dockerfile and Compose setup aimed at running MOTIS inside Coolify.
The container expects a generated MOTIS config plus imported data mounted at `/var/lib/motis`.
An optional updater service can fetch GTFS feeds, refresh config, and re-import on a schedule.
The updater is implemented in Bun/TypeScript and calls the existing Python data pipeline.

## Prepare the data directory

```sh
mkdir -p out
./src/generate-motis-config.py --skip-missing-files
```

Edit `out/config.yml` to point to your OSM extract and adjust tiles as described in
`docs/docs/index.md`.

Next, import data (this can take a while):

```sh
cd out
motis import
```

## Run with Docker Compose (Coolify)

```sh
docker compose up --build
```

Coolify should map its persistent storage to the `out/` directory so the container sees
`/var/lib/motis/config.yml` and `/var/lib/motis/data`.

### Build arguments

* `MOTIS_VERSION`: release tag for the MOTIS binary (default `v2.7.0`).

## Automated nightly updates (Coolify)

Enable the `motis-updater` service in Coolify and set the following environment variables
for automated downloads and nightly imports:

### Required

* `REGIONS`: space-separated list of region codes (e.g. `de fr ch`). When omitted, all
  regions in `feeds/` are processed.

### Scheduling

* `UPDATE_TZ`: time zone for scheduling (default `UTC`).
* `UPDATE_CRON`: cron expression (`minute hour * * *`, default `0 2 * * *`).
* `RUN_ON_START`: run an update when the container starts (default `true`).

### Optional downloads (cached in the shared volume)

* `OSM_URL`: optional OSM extract URL (downloaded into the volume if missing).
* `OSM_FILE`: optional override for the downloaded OSM file path.
* `COASTLINE_URL`: optional coastline zip URL (downloaded into the volume if missing).
* `COASTLINE_FILE`: optional override for the downloaded coastline path.
* `FORCE_OSM_DOWNLOAD`: set to `true` to re-download the OSM extract each run.
* `FORCE_COASTLINE_DOWNLOAD`: set to `true` to re-download the coastline data each run.

Both the server and updater services should share the same `out/` volume so the imports
and cached downloads persist across runs.

### Example: Poland

For a Poland-only deployment that updates nightly at 02:00 (UTC), set:

* `REGIONS=pl`
* `OSM_URL=https://download.geofabrik.de/europe/poland-latest.osm.pbf`
* `COASTLINE_URL=https://osmdata.openstreetmap.de/download/land-polygons-complete-4326.zip`

### Coolify notes

* Ensure the `out/` directory is a persistent volume shared by both the `motis` and
  `motis-updater` services.
* The build requires Python dependencies (such as `lxml`) that compile native extensions,
  so the Dockerfile installs build tools and system headers to avoid pip failures in Coolify.
* Make sure the updater service is enabled in Coolify if you want automated nightly imports.

## Configuration

* `MOTIS_CONFIG`: config path inside the container (default `/var/lib/motis/config.yml`).
