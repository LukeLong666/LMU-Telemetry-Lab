# Java Backend — Implementation Status

Updated: 2026-10-19

## Completed

### P0 — Foundation

- Maven project with Java 21 + Spring Boot 4.1.1.
- DuckDB JDBC `1.5.6.0` verified against a synthetic native LMU database.
- `AppProperties` / `AppPaths` / atomic file helpers / path traversal guard.
- Logging to `backend_debug.log`, FastAPI-compatible `{"detail": ...}` errors.
- CORS, profile-data static mount, steering-wheel static mount.
- Synthetic LMU fixture generator: [`tools/fixtures/generate_synthetic_duckdb.py`](../tools/fixtures/generate_synthetic_duckdb.py).
- Python↔Java HTTP parity harness: [`tools/parity/run_parity.py`](../tools/parity/run_parity.py).
- Direct telemetry parity harness: [`tools/parity/compare_telemetry.py`](../tools/parity/compare_telemetry.py).

### P1 — Profiles / Sessions / System

- `GET/POST /api/v1/profiles`, reorder, rename, delete, avatar upload.
- `GET /api/v1/sessions`, upload, rename, delete.
- `GET/POST /api/v1/system/validate-path`, `open-path`, `import-paths`.
- Legacy `/system/pick-and-upload` via Swing (`java.desktop`).
- `GET /api/v1/steering-wheels`.
- Legacy data migration from `<app-home>/DuckDB_data` to the guest profile.

### P2 — Tracks / Cars / Laps

- `tracks.json` exported from the Python registry (18 tracks, 34 layouts, 469 elevation points).
- Python-compatible track and layout matching, including `difflib.SequenceMatcher` port.
- Car lookup seeded with the Python `STANDARD_MAPPING` (CSV optional; current no-CSV behavior matches).
- `GET /api/v1/sessions/{id}/laps` with lap boundaries, sectors, stint, pit/out-lap, fuel, metadata.
- `GET /api/v1/reference-laps`.

### P3 — Fusion / Telemetry

- `FusionEngine` with:
  - master timeline and lap channel
  - speed integration, lap-distance normalization
  - gear as-of alignment
  - generic scalar/wheel event and continuous tables
  - sparse-channel forward fill, pulse channels, carry-over
  - steering calibration
  - elevation fusion (`WorldPosZ`)
  - virtual channels (`Slip Ratio`, tyre inside/outside, `ABS`/`TC`, `Susp Pos` sign)
- Streaming JSON writer with `NaN` → `null`.
- `GET /api/v1/sessions/{id}/telemetry` with `freq`, `stint_id`, `lap_id`.
- `suspension_baselines` computed identically to Python.

### P4 — 3D

- `GET /api/v1/sessions/{id}/3d-track` with selected lap/stint, shortest-valid-lap base map,
  stint anchoring, elevation `zBase`, nearest-point Z snapping (uniform grid), 4000-point
  downsampling, and Sector lines.
- Point-level parity with Python on the synthetic fixture for laps 0/1/2.

### P5 — Setup / Export / Discord

- `GET /api/v1/sessions/{id}/setup` (nested CarSetup JSON).
- `GET /api/v1/sessions/{id}/setup/export` (SVM, byte-identical to Python on the fixture).
- `GET /api/v1/sessions/{id}/export/lap/{n}` using DuckDB `ATTACH` + SQL slicing; key table
  contents match Python (30 tables, same row counts/values).
- Discord config/shares/download/share endpoints with in-memory caches, tag matching,
  member verification, forum multipart upload, avatar resolution, and `discord__` session
  downloads.

## Verified parity (synthetic fixture)

`run_parity.py`:

```text
PASS health
PASS profiles
PASS sessions
PASS laps
PASS reference-laps
PASS steering-wheels
RESULT: PASS
```

`compare_telemetry.py`:

```text
freq=10  stint=1  -> PASS (31 channels, 1201 rows)
freq=60  stint=1  -> PASS (31 channels, 7201 rows)
freq=10  lap=2    -> PASS (30 channels, 601 rows)
```

`compare_3d.py --lap 0/1/2` -> PASS (baseMap, racingLine, sectors, center, zBase, metadata).

All scalar/vector values and `suspension_baselines` match within `1e-6`.

## P6 — packaging / web hosting

> The user explicitly descoped desktop installer work: backend + web frontend running
> separately is sufficient. Packaging is therefore **deferred**, not a completion blocker.

- `frontend/index.html` was missing from the repo (the global `*.html` ignore rule hid it);
  restored and the `.gitignore` exception added.
- `npm run build` succeeds (Vite 7.3.1); `frontend/dist` is generated.
- `desktop/main.js`: native `pick-telemetry-files` IPC; `preload.js`: `electronAPI.pickTelemetryFiles`;
  frontend `importPaths()` and native-first `FileManager` flow.
- Backend static hosting: `/` + `/index.html` via `IndexController`; `/assets/**`,
  `/country_flag/**`, `/logos/**`, `/steering wheel/**` and root files via
  `FrontendResourceController`; `/api/v1/profile-data/**` via resource handler.
- Verified web mode: `/` 200 HTML, hashed JS/CSS 200, root PNG 200, nested country flag 200,
  URL-encoded steering-wheel path 200, `/api/v1/health` 200, unknown API 404 JSON.
- Default Spring port is **8000** (matching Electron); dev can use `SERVER_PORT=8001`.
- `build_backend_java.ps1` builds a working app-image (`dist/lmu-telemetry-backend`), and the
  packaged exe was started successfully on 8000 with real sessions. NSIS installer build was
  deferred by the user, so do not treat installer generation as required.
- Added mtime/size caches for `/sessions` and `/laps`; repeated reads avoid reopening DuckDB.
- `/sessions` best-lap selection now follows Python's valid/non-out-lap/single-lap rules.
- Added `GET /api/v1/debug/env` for Python parity.

## Real-sample validation notes

- 6 curated real LMU sessions (Fuji/Monza/Imola; 5–24 minutes) are in `testdata/duckdb/real/`.
- `/sessions` and `/laps` match Python for all 6.
- 10 Hz telemetry and 3D match on the representative long sessions (Monza race, Fuji race).
- Known edge differences remain for some 60 Hz and qualifying sessions (numpy `arange`
  millisecond rounding / start-frame carry-over). The web frontend uses 10 Hz and 3D uses
  100 Hz, so these do not block normal use.

## Deferred / optional

1. NSIS installer / jpackage signing (user descoped desktop installer).
2. Perfect 60 Hz and qualifying-session numeric parity.
3. Electron native-picker E2E.
