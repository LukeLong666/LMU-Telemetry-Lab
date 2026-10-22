package com.lmutl.application;

import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.domain.SessionMetadata;
import com.lmutl.domain.TrackDefinition;
import com.lmutl.infra.car.CarCatalog;
import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.DuckDbReads;
import com.lmutl.infra.duckdb.LapBoundaryResolver;
import com.lmutl.infra.duckdb.MetadataReader;
import com.lmutl.infra.track.LayoutMatcher;
import com.lmutl.infra.track.TrackMatcher;
import com.lmutl.infra.track.TrackRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Service
public class LapService {

    private static final Logger log = LoggerFactory.getLogger(LapService.class);
    private static final Pattern FIRST_NUMBER = Pattern.compile("([\\d.]+)");

    private final DuckDbConnectionFactory connections;
    private final MetadataReader metadataReader;
    private final TrackRegistry trackRegistry;
    private final CarCatalog carCatalog;
    private final ObjectMapper mapper;
    private final Map<Path, HeaderCache> headerCache = new ConcurrentHashMap<>();

    public LapService(DuckDbConnectionFactory connections,
                      MetadataReader metadataReader,
                      TrackRegistry trackRegistry,
                      CarCatalog carCatalog,
                      ObjectMapper mapper) {
        this.connections = connections;
        this.metadataReader = metadataReader;
        this.trackRegistry = trackRegistry;
        this.carCatalog = carCatalog;
        this.mapper = mapper;
    }

    public void clearCache() {
        headerCache.clear();
    }

    public LapsResponse header(Path database) {
        Path key = database.toAbsolutePath().normalize();
        long size = fileSize(key);
        long modified = lastModifiedMillis(key);
        HeaderCache cached = headerCache.get(key);
        if (cached != null && cached.size() == size && cached.modified() == modified) {
            return cached.response();
        }

        try (Connection connection = connections.open(key)) {
            LapBoundaryResolver.Result boundaries = LapBoundaryResolver.resolve(connection);
            Map<String, String> meta = metadataReader.read(connection);

            List<DuckDbReads.Event> sector1 = DuckDbReads.readEventsOrEmpty(connection, "Last Sector1");
            List<DuckDbReads.Event> sector2 = DuckDbReads.readEventsOrEmpty(connection, "Last Sector2");
            List<DuckDbReads.Event> inPits = DuckDbReads.readEventsOrEmpty(connection, "In Pits");
            double[] gpsTimes = DuckDbReads.readValuesOrEmpty(connection, "GPS Time");
            double[] fuelValues = DuckDbReads.readValuesOrEmpty(connection, "Fuel Level");
            double[] fuelTimes = mapIndicesToTimes(gpsTimes, fuelValues.length);

            List<LapInfo> laps = buildLaps(boundaries, sector1, sector2, inPits, fuelValues, fuelTimes);
            SessionMetadata metadata = buildMetadata(connection, meta, boundaries, laps, gpsTimes);
            LapsResponse response = new LapsResponse(laps, metadata);
            headerCache.put(key, new HeaderCache(response, size, modified));
            return response;
        } catch (Exception e) {
            log.error("Failed to read lap header for {}", database, e);
            throw new IllegalStateException("Failed to read lap header: " + e.getMessage(), e);
        }
    }

    private static long fileSize(Path file) {
        try {
            return Files.size(file);
        } catch (IOException e) {
            return 0L;
        }
    }

    private static long lastModifiedMillis(Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private List<LapInfo> buildLaps(LapBoundaryResolver.Result boundaries,
                                    List<DuckDbReads.Event> sector1,
                                    List<DuckDbReads.Event> sector2,
                                    List<DuckDbReads.Event> inPits,
                                    double[] fuelValues,
                                    double[] fuelTimes) {
        List<LapInfo> laps = new ArrayList<>();
        boolean lastAddedInPit = false;
        int stint = 1;

        for (int i = 0; i < boundaries.boundaries().size(); i++) {
            double start = boundaries.boundaries().get(i);
            double end = i + 1 < boundaries.boundaries().size()
                    ? boundaries.boundaries().get(i + 1)
                    : boundaries.sessionEnd();
            double rawDuration = end - start;
            if (rawDuration < 5.0) {
                continue;
            }

            Double matched = matchedLapTime(boundaries.lapTimes(), end);
            double duration = matched != null ? matched : rawDuration;

            Double s1Value = lastValue(sector1, end, start);
            Double s2Value = lastValue(sector2, end, start);
            Double s1 = null;
            Double s2 = null;
            Double s3 = null;
            if (s1Value != null) {
                s1 = s1Value;
                if (s2Value != null) {
                    s2 = s2Value - s1Value;
                    s3 = duration - s2Value;
                }
            }

            boolean inPit = isInPit(inPits, start, end);
            double fuelUsed = fuelUsed(fuelValues, fuelTimes, start, end);
            boolean outLap = i == 0 || lastAddedInPit;

            laps.add(new LapInfo(i, start, end, duration, matched != null, outLap, inPit,
                    fuelUsed, s1, s2, s3, stint));

            if (inPit) {
                stint++;
            }
            lastAddedInPit = inPit;
        }
        return laps;
    }

    private SessionMetadata buildMetadata(Connection connection,
                                          Map<String, String> meta,
                                          LapBoundaryResolver.Result boundaries,
                                          List<LapInfo> laps,
                                          double[] gpsTimes) {
        String rawTrack = value(meta, "TrackName", "Unknown Track");
        String rawLayout = value(meta, "TrackLayout", "");
        String rawCar = value(meta, "CarName", "Unknown Car");
        String rawClass = value(meta, "CarClass", "Unknown Class");
        String driver = value(meta, "DriverName", "Unknown Driver");
        String sessionTime = value(meta, "SessionTime", "Unknown Time");
        String sessionType = value(meta, "SessionType", "Unknown Session");
        String weather = value(meta, "WeatherConditions", "Unknown Weather");

        JsonNode setup = parseJson(meta.get("CarSetup"));
        JsonNode config = parseJson(meta.get("CarConfig"));

        double fuelCapacity = fuelCapacity(config, setup);
        int tyreCompoundMax = tyreCompoundMax(config, setup);
        String steeringLockString = setup == null ? null
                : text(setup.path("VM_STEER_LOCK"), "stringValue");
        Integer steeringLock = carCatalog.parseSteerLock(steeringLockString);

        CarCatalog.CarSpec car = carCatalog.getCarInfo(rawCar, rawClass, steeringLock);
        TrackMatcher.Match trackMatch = trackRegistry.findTrack(rawTrack);
        TrackDefinition track = trackMatch == null ? null : trackMatch.definition();
        LayoutMatcher.Match layoutMatch = track == null
                ? null
                : trackRegistry.findLayout(track, rawLayout, trackMatch.key());

        String layoutKey = layoutMatch == null ? emptyToNull(rawLayout) : layoutMatch.key();
        Double officialLength = layoutMatch == null || layoutMatch.layout() == null
                ? null
                : layoutMatch.layout().officialLength();

        officialLength = applyDistanceFingerprint(connection, track, officialLength);

        List<SessionMetadata.TrackSectorPoint> sectorPoints =
                buildSectorPoints(connection, laps, gpsTimes);

        return new SessionMetadata(
                rawTrack,
                trackMatch == null ? rawTrack : trackMatch.key(),
                track == null ? List.of() : track.aliases(),
                track == null ? "" : nullToEmpty(track.country()),
                rawLayout,
                layoutKey,
                officialLength,
                rawClass,
                car.modelName(),
                rawCar,
                driver,
                sessionTime,
                boundaries.sessionEnd() - boundaries.sessionStart(),
                sessionType,
                weather,
                sectorPoints,
                fuelCapacity,
                tyreCompoundMax,
                steeringLock,
                steeringLockString
        );
    }

    private Double applyDistanceFingerprint(Connection connection,
                                            TrackDefinition track,
                                            Double officialLength) {
        if (track == null) {
            return officialLength;
        }
        Double maxDistance = DuckDbReads.scalarDouble(connection, "SELECT MAX(value) FROM \"Lap Dist\"");
        if (maxDistance == null || maxDistance <= 500.0) {
            return officialLength;
        }
        double current = officialLength == null ? maxDistance : officialLength;
        double ratio = current > 0 ? maxDistance / current : 0.0;
        if (officialLength != null && ratio >= 0.8 && ratio <= 1.2) {
            return officialLength;
        }

        double bestLength = current;
        double minDiff = Math.abs(maxDistance - current);
        for (TrackDefinition.TrackLayout layout : track.layouts().values()) {
            if (layout.refPoints().isEmpty()) {
                continue;
            }
            double length = layout.officialLength();
            double diff = Math.abs(maxDistance - length);
            if (diff < minDiff) {
                minDiff = diff;
                bestLength = length;
            }
        }
        return bestLength;
    }

    private List<SessionMetadata.TrackSectorPoint> buildSectorPoints(Connection connection,
                                                                    List<LapInfo> laps,
                                                                    double[] gpsTimes) {
        List<LapInfo> valid = laps.stream()
                .filter(lap -> lap.isValid() && lap.s1() != null && lap.s2() != null)
                .sorted(Comparator.comparingDouble(LapInfo::duration))
                .toList();
        if (valid.isEmpty() || gpsTimes.length == 0) {
            return List.of();
        }
        LapInfo best = valid.get(0);
        double t1 = best.startTime() + best.s1();
        double t2 = best.startTime() + best.s1() + best.s2();
        double[] latitudes = DuckDbReads.readValuesOrEmpty(connection, "GPS Latitude");
        double[] longitudes = DuckDbReads.readValuesOrEmpty(connection, "GPS Longitude");
        if (latitudes.length == 0 || longitudes.length == 0) {
            return List.of();
        }

        List<SessionMetadata.TrackSectorPoint> points = new ArrayList<>(2);
        addSectorPoint(points, gpsTimes, latitudes, longitudes, t1, 1);
        addSectorPoint(points, gpsTimes, latitudes, longitudes, t2, 2);
        return points;
    }

    private void addSectorPoint(List<SessionMetadata.TrackSectorPoint> points,
                                double[] gpsTimes,
                                double[] latitudes,
                                double[] longitudes,
                                double targetTime,
                                int id) {
        int index = lowerBound(gpsTimes, targetTime);
        if (index >= gpsTimes.length || index >= latitudes.length || index >= longitudes.length) {
            return;
        }
        double lat = latitudes[index];
        double lon = longitudes[index];
        if (!Double.isNaN(lat) && !Double.isNaN(lon) && lat != 0.0 && lon != 0.0) {
            points.add(new SessionMetadata.TrackSectorPoint(lat, lon, id));
        }
    }

    private static Double matchedLapTime(List<DuckDbReads.Event> lapTimes, double end) {
        for (DuckDbReads.Event event : lapTimes) {
            if (Math.abs(event.ts() - end) < 0.5) {
                return event.value();
            }
        }
        return null;
    }

    private static Double lastValue(List<DuckDbReads.Event> events, double queryTime, double minTime) {
        Double value = null;
        for (DuckDbReads.Event event : events) {
            if (event.ts() > queryTime) {
                break;
            }
            if (event.ts() > minTime) {
                value = event.value();
            }
        }
        return value == null || value == 0.0 ? null : value;
    }

    private static boolean isInPit(List<DuckDbReads.Event> events, double start, double end) {
        for (DuckDbReads.Event event : events) {
            if (event.ts() >= end) {
                break;
            }
            if (event.ts() >= start && event.value() > 0.5) {
                return true;
            }
        }
        return false;
    }

    private static double fuelUsed(double[] fuelValues, double[] fuelTimes, double start, double end) {
        if (fuelValues.length == 0 || fuelTimes.length == 0) {
            return 0.0;
        }
        int startIndex = lowerBound(fuelTimes, start);
        int endIndex = lowerBound(fuelTimes, end);
        double startFuel = startIndex < fuelValues.length ? fuelValues[startIndex] : 0.0;
        double endFuel = endIndex > 0 && endIndex <= fuelValues.length ? fuelValues[endIndex - 1] : 0.0;
        return Math.max(0.0, startFuel - endFuel);
    }

    private static double[] mapIndicesToTimes(double[] gpsTimes, int sampleCount) {
        if (sampleCount == 0 || gpsTimes.length == 0) {
            return new double[0];
        }
        double[] times = new double[sampleCount];
        if (sampleCount == 1 || gpsTimes.length == 1) {
            times[0] = gpsTimes[0];
            return times;
        }
        double step = (double) (gpsTimes.length - 1) / (sampleCount - 1);
        for (int i = 0; i < sampleCount; i++) {
            double position = i * step;
            int index = (int) Math.floor(position);
            if (index >= gpsTimes.length - 1) {
                times[i] = gpsTimes[gpsTimes.length - 1];
            } else {
                double fraction = position - index;
                times[i] = gpsTimes[index] + fraction * (gpsTimes[index + 1] - gpsTimes[index]);
            }
        }
        return times;
    }

    static int lowerBound(double[] values, double target) {
        int low = 0;
        int high = values.length;
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (values[mid] < target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    private JsonNode parseJson(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return mapper.readTree(raw);
        } catch (Exception e) {
            log.warn("Failed to parse metadata JSON: {}", e.getMessage());
            return null;
        }
    }

    private static double fuelCapacity(JsonNode config, JsonNode setup) {
        if (config != null) {
            return config.path("fuelCapacity").asDouble(0.0);
        }
        if (setup != null) {
            JsonNode node = setup.path("VM_FUEL_CAPACITY");
            if (node.isObject()) {
                String text = node.path("stringValue").asText(node.path("lastSavedStringValue").asText(""));
                Double parsed = firstNumber(text);
                if (parsed != null) {
                    return parsed;
                }
                double value = node.path("value").asDouble(0.0);
                if (value > 0) {
                    return value;
                }
            }
        }
        return 0.0;
    }

    private static int tyreCompoundMax(JsonNode config, JsonNode setup) {
        if (config != null || setup == null) {
            return 0;
        }
        JsonNode front = setup.path("VM_FRONT_TIRE_COMPOUND");
        if (front.isObject()) {
            return front.path("maxValue").asInt(0);
        }
        JsonNode rear = setup.path("VM_REAR_TIRE_COMPOUND");
        if (rear.isObject()) {
            return rear.path("maxValue").asInt(0);
        }
        return 0;
    }

    private static Double firstNumber(String text) {
        if (text == null) {
            return null;
        }
        Matcher matcher = FIRST_NUMBER.matcher(text);
        if (!matcher.find()) {
            return null;
        }
        try {
            return Double.parseDouble(matcher.group(1));
        } catch (NumberFormatException e) {
            return null;
        }
    }

    private static String text(JsonNode node, String field) {
        if (node == null || !node.isObject()) {
            return null;
        }
        String value = node.path(field).asText(null);
        return value == null || value.isBlank() ? null : value;
    }

    private static String value(Map<String, String> metadata, String key, String fallback) {
        String value = metadata.get(key);
        return value == null || value.isBlank() ? fallback : value;
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private static String nullToEmpty(String value) {
        return value == null ? "" : value;
    }

    private record HeaderCache(LapsResponse response, long size, long modified) {
    }
}
