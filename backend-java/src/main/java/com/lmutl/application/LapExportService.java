package com.lmutl.application;

import com.lmutl.api.error.ApiException;
import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.infra.car.CarCatalog;
import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.DuckDbReads;
import com.lmutl.infra.fs.AppPaths;
import com.lmutl.infra.fs.PathSafety;
import com.lmutl.infra.fs.SessionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

@Service
public class LapExportService {

    private static final Logger log = LoggerFactory.getLogger(LapExportService.class);
    private static final Set<String> COPY_WHOLE = Set.of("metadata", "channelsList");
    private static final Set<String> SPARSE_CHANNELS = Set.of(
            "TyresCompound", "WheelsDetached", "TC", "ABS", "TCCut",
            "TCLevel", "ABSLevel", "TCSlipAngle", "Wheel ABS", "Wheel TC", "WheelABS", "WheelTC"
    );

    private final SessionRepository sessions;
    private final LapService lapService;
    private final SetupService setupService;
    private final CarCatalog carCatalog;
    private final DuckDbConnectionFactory connections;
    private final AppPaths paths;

    public LapExportService(SessionRepository sessions,
                            LapService lapService,
                            SetupService setupService,
                            CarCatalog carCatalog,
                            DuckDbConnectionFactory connections,
                            AppPaths paths) {
        this.sessions = sessions;
        this.lapService = lapService;
        this.setupService = setupService;
        this.carCatalog = carCatalog;
        this.connections = connections;
        this.paths = paths;
    }

    public ExportResult export(String profileId, String sessionId, int lapNumber, String customCarModel) {
        Path source = sessions.resolve(profileId, sessionId);
        LapsResponse header = lapService.header(source);
        LapInfo target = header.laps().stream()
                .filter(lap -> lap.lap() == lapNumber)
                .findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Lap " + lapNumber + " not found"));

        Map<String, String> metadata = setupService.readMetadata(source);
        String layoutName = metadata.getOrDefault("TrackLayout", "Layout").replace(" ", "-")
                .replaceAll("[\\\\/*?:\"<>|]", "");
        String rawCar = metadata.getOrDefault("CarName", "");
        String rawClass = metadata.getOrDefault("CarClass", "");
        String carModel = customCarModel != null && !customCarModel.isBlank()
                ? customCarModel
                : carCatalog.getCarInfo(rawCar, rawClass).modelName();
        carModel = carModel.replace(" ", "-");
        String recordingTime = metadata.getOrDefault("RecordingTime", PathSafety.stripDuckDb(sessionId));
        String lapTime = formatLapTime(target.duration());
        String filename = layoutName + "-" + carModel + "-L" + lapNumber + "-" + lapTime + "_" + recordingTime + ".duckdb";

        Path cacheDir = paths.profileCacheDir(profileId);
        Path output = cacheDir.resolve(filename).normalize();
        try {
            Files.createDirectories(cacheDir);
            Files.deleteIfExists(output);
            writeSlicedDatabase(source, header, target, output);
            if (customCarModel != null && !customCarModel.isBlank()) {
                updateCarName(output, customCarModel);
            }
            return new ExportResult(output, filename);
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.error("Lap export failed for {} lap {}", sessionId, lapNumber, e);
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Lap export failed: " + e.getMessage(), e);
        }
    }

    private void writeSlicedDatabase(Path source, LapsResponse header, LapInfo target, Path output) throws Exception {
        double start = target.startTime();
        double end = target.endTime();
        double duration = target.duration();

        SourceInfo info = inspectSource(source, start, end);
        List<String> tables = info.tables();

        try (Connection out = connections.open(output)) {
            out.createStatement().execute("ATTACH '" + sqlLiteral(source.toAbsolutePath().toString()) + "' AS src (READ_ONLY)");
            try (Statement statement = out.createStatement()) {
                for (String table : tables) {
                    if (COPY_WHOLE.contains(table)) {
                        statement.execute("CREATE TABLE " + ident(table) + " AS SELECT * FROM src." + ident(table));
                        continue;
                    }
                    if ("Lap".equals(table)) {
                        statement.execute("CREATE TABLE " + ident(table)
                                + " AS SELECT * FROM (VALUES (CAST(0.0 AS DOUBLE), 0), (CAST(" + duration + " AS DOUBLE), 1)) t(ts, value)");
                        continue;
                    }
                    if ("Lap Time".equals(table) || "Best LapTime".equals(table)) {
                        statement.execute("CREATE TABLE " + ident(table)
                                + " AS SELECT CAST(" + duration + " AS DOUBLE) AS ts, CAST(" + duration + " AS DOUBLE) AS value");
                        continue;
                    }
                    if (("Last Sector1".equals(table) || "Best Sector1".equals(table)) && target.s1() != null) {
                        statement.execute("CREATE TABLE " + ident(table)
                                + " AS SELECT CAST(" + target.s1() + " AS DOUBLE) AS ts, CAST(" + target.s1() + " AS DOUBLE) AS value");
                        continue;
                    }
                    if (("Last Sector2".equals(table) || "Best Sector2".equals(table))
                            && target.s1() != null && target.s2() != null) {
                        double total = target.s1() + target.s2();
                        statement.execute("CREATE TABLE " + ident(table)
                                + " AS SELECT CAST(" + total + " AS DOUBLE) AS ts, CAST(" + total + " AS DOUBLE) AS value");
                        continue;
                    }

                    List<String> columns = info.columns().getOrDefault(table, List.of());
                    int rowCount = info.rowCounts().getOrDefault(table, 0);
                    boolean hasTimestamp = columns.contains("ts");
                    List<String> valueColumns = columns.stream().filter(column -> !"ts".equals(column)).toList();
                    if (valueColumns.isEmpty()) {
                        continue;
                    }
                    String valueList = String.join(", ", valueColumns.stream().map(LapExportService::ident).toList());

                    if (hasTimestamp) {
                        if (SPARSE_CHANNELS.contains(table)) {
                            statement.execute("CREATE TABLE " + ident(table) + " AS "
                                    + "SELECT CAST(0.0 AS DOUBLE) AS ts, " + valueList
                                    + " FROM src." + ident(table) + " WHERE ts <= " + start
                                    + " ORDER BY ts DESC LIMIT 1");
                            statement.execute("INSERT INTO " + ident(table)
                                    + " SELECT ts - " + start + ", " + valueList
                                    + " FROM src." + ident(table) + " WHERE ts > " + start + " AND ts <= " + (end + 1.0));
                        } else {
                            statement.execute("CREATE TABLE " + ident(table) + " AS "
                                    + "SELECT ts - " + start + " AS ts, " + valueList
                                    + " FROM src." + ident(table) + " WHERE ts >= " + start + " AND ts <= " + (end + 1.0));
                        }
                    } else {
                        double ratio = info.maxRows() > 0 ? (double) rowCount / info.maxRows() : 0.0;
                        int minRow = (int) (info.minRow100() * ratio);
                        int maxRow = (int) (info.maxRow100() * ratio);
                        if ("GPS Time".equals(table)) {
                            statement.execute("CREATE TABLE " + ident(table) + " AS "
                                    + "SELECT CAST(value - " + start + " AS FLOAT) AS value FROM src." + ident(table)
                                    + " WHERE rowid >= " + minRow + " AND rowid <= " + maxRow);
                        } else if ("Lap Dist".equals(table)) {
                            double offsetValue = info.lapDistOffset();
                            statement.execute("CREATE TABLE " + ident(table) + " AS "
                                    + "SELECT CAST(value - " + offsetValue + " AS FLOAT) AS value FROM src." + ident(table)
                                    + " WHERE rowid >= " + minRow + " AND rowid <= " + maxRow);
                        } else {
                            statement.execute("CREATE TABLE " + ident(table) + " AS SELECT * FROM src." + ident(table)
                                    + " WHERE rowid >= " + minRow + " AND rowid <= " + maxRow);
                        }
                    }
                }
                statement.execute("INSERT INTO metadata (key, value) VALUES ('ExportedLap', '" + target.lap() + "')");
                statement.execute("INSERT INTO metadata (key, value) VALUES ('ExportedFrom', '"
                        + sqlLiteral(source.getFileName().toString()) + "')");
                statement.execute("CHECKPOINT");
            }
        }
    }

    private SourceInfo inspectSource(Path source, double start, double end) throws Exception {
        try (Connection src = connections.open(source)) {
            List<String> tables = DuckDbReads.tableNames(src);
            Integer count = DuckDbReads.scalarInt(src, "SELECT COUNT(*) FROM \"GPS Time\"");
            int maxRows = count == null ? 0 : count;
            Integer minRow = DuckDbReads.scalarInt(src,
                    "SELECT MIN(rowid) FROM \"GPS Time\" WHERE value >= " + start);
            Integer maxRow = DuckDbReads.scalarInt(src,
                    "SELECT MIN(rowid) FROM \"GPS Time\" WHERE value > " + end);
            int minRow100 = minRow == null ? 0 : minRow;
            int maxRow100 = maxRow == null ? Math.max(0, maxRows - 1) : maxRow;

            Map<String, List<String>> columns = new java.util.LinkedHashMap<>();
            Map<String, Integer> rowCounts = new java.util.LinkedHashMap<>();
            for (String table : tables) {
                columns.put(table, DuckDbReads.columns(src, table));
                Integer tableCount = DuckDbReads.scalarInt(src, "SELECT COUNT(*) FROM " + ident(table));
                rowCounts.put(table, tableCount == null ? 0 : tableCount);
            }

            double lapDistOffset = 0.0;
            if (rowCounts.containsKey("Lap Dist") && maxRows > 0) {
                int ratioRow = (int) (minRow100 * ((double) rowCounts.get("Lap Dist") / maxRows));
                Double offset = DuckDbReads.scalarDouble(src,
                        "SELECT value FROM \"Lap Dist\" WHERE rowid >= " + ratioRow + " ORDER BY rowid LIMIT 1");
                if (offset != null) {
                    lapDistOffset = offset;
                }
            }
            return new SourceInfo(tables, maxRows, minRow100, maxRow100, columns, rowCounts, lapDistOffset);
        }
    }

    private void updateCarName(Path output, String carName) throws Exception {
        try (Connection out = connections.open(output);
             var statement = out.prepareStatement("UPDATE metadata SET value = ? WHERE key = 'CarName'")) {
            statement.setString(1, carName);
            statement.executeUpdate();
            out.createStatement().execute("CHECKPOINT");
        }
    }

    private static String formatLapTime(double seconds) {
        int minutes = (int) (seconds / 60);
        int wholeSeconds = (int) (seconds % 60);
        int millis = (int) ((seconds * 1000) % 1000);
        return String.format(Locale.ROOT, "%dm%02ds%03d", minutes, wholeSeconds, millis);
    }

    private static String ident(String name) {
        return "\"" + name.replace("\"", "\"\"") + "\"";
    }

    private static String sqlLiteral(String value) {
        return value.replace("'", "''");
    }

    public record ExportResult(Path path, String filename) {
    }

    private record SourceInfo(
            List<String> tables,
            int maxRows,
            int minRow100,
            int maxRow100,
            Map<String, List<String>> columns,
            Map<String, Integer> rowCounts,
            double lapDistOffset
    ) {
    }
}
