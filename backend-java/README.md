# Java Backend (Spring Boot)

This is the in-progress Java 21 / Spring Boot 4.1.x rewrite of the Python FastAPI backend.
The contract and migration plan are in [`../JAVA_BACKEND_REWRITE_PLAN.md`](../JAVA_BACKEND_REWRITE_PLAN.md).

## Build

The sandbox cannot write to `%USERPROFILE%\.m2`, so this repository uses a workspace-local
Maven repository during development:

```powershell
$env:MAVEN_OPTS='-Dmaven.repo.local=C:/Users/lukel/Desktop/LMU-Telemetry-Lab/.m2repo'
mvn -B -DskipTests package
```

A normal developer machine can omit `MAVEN_OPTS` and use the default `~/.m2`.

## Run (development)

```powershell
$env:APP_DATA_DIR='C:\Users\lukel\Desktop\LMU-Telemetry-Lab\.devdata'
$env:SERVER_PORT='8001'
java -jar target/lmu-telemetry-backend-1.5.3-java.jar
```

Then open `http://127.0.0.1:8001/api/v1/health` (Vite proxies `/api` to 8001).

In production Electron expects port `8000`; set `SERVER_PORT=8000` or use the packaged launcher.

## Implemented endpoints (P1–P3)

| Group | Endpoints |
|---|---|
| Health | `GET /health`, `GET /api/v1/health`, `GET /api/v1/ping`, `GET /api/v1/debug/env` |
| Profiles | `GET/POST /api/v1/profiles`, `POST /profiles/reorder`, `PUT/DELETE /profiles/{id}`, `POST /profiles/{id}/avatar` |
| Sessions | `GET /sessions`, `POST /sessions/upload`, `POST /sessions/{id}/rename`, `DELETE /sessions/{id}` |
| Laps | `GET /sessions/{id}/laps`, `GET /reference-laps` |
| Telemetry | `GET /sessions/{id}/telemetry` (streaming JSON, 1:1 channel set with Python) |
| 3D | `GET /sessions/{id}/3d-track` |
| Setup | `GET /sessions/{id}/setup`, `GET /sessions/{id}/setup/export` |
| Export | `GET /sessions/{id}/export/lap/{n}` |
| Discord | `GET /discord/config`, `GET /discord/shares`, `POST /discord/shares/download`, `POST /sessions/{id}/discord/share` |
| System | `GET /system/validate-path`, `POST /system/open-path`, `POST /system/import-paths`, `POST /system/pick-and-upload` (legacy Swing), `GET /steering-wheels` |

Still pending: verify `jpackage` app-image creation on a normal Windows shell, then run the
Electron packaged-path E2E (native picker → import → analysis).

## Tests

```powershell
$env:MAVEN_OPTS='-Dmaven.repo.local=C:/Users/lukel/Desktop/LMU-Telemetry-Lab/.m2repo'
mvn -B test
```

`FusionEngineTest` uses `../testdata/duckdb/synthetic_monza_multistint.duckdb` and is skipped
if the fixture is absent.

## Parity checks

Start the Python oracle on `8012` and the Java backend on `8011`, then:

```powershell
.\.venv\Scripts\python.exe tools\parity\run_parity.py --python http://127.0.0.1:8012 --java http://127.0.0.1:8011
.\.venv\Scripts\python.exe tools\parity\compare_telemetry.py --db testdata\duckdb\synthetic_monza_multistint.duckdb --freq 10 --stint 1
```

`compare_telemetry.py` calls the Python fusion engine in-process, so it does not need
pyarrow/parquet or the Python HTTP server.
