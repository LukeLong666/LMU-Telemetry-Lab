package com.lmutl.application;

import com.lmutl.api.error.ApiException;
import com.lmutl.domain.Channel;
import com.lmutl.domain.FusedFrame;
import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.domain.Track3DPoint;
import com.lmutl.domain.Track3DResponse;
import com.lmutl.domain.Track3DSectorPoint;
import com.lmutl.infra.fusion.FusionEngine;
import com.lmutl.infra.fusion.FusionOptions;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Service
public class Track3DService {

    private static final int TARGET_POINTS = 4000;
    private static final double DEG_TO_M = 111320.0;

    private final SessionService sessionService;
    private final LapService lapService;
    private final FusionEngine fusionEngine;

    public Track3DService(SessionService sessionService,
                          LapService lapService,
                          FusionEngine fusionEngine) {
        this.sessionService = sessionService;
        this.lapService = lapService;
        this.fusionEngine = fusionEngine;
    }

    public Track3DResponse build(String profileId, String sessionId, int lapNumber, Integer stint) {
        Path database = sessionService.resolve(profileId, sessionId);
        LapsResponse header = lapService.header(database);
        List<LapInfo> laps = header.laps();

        LapInfo selected = laps.stream()
                .filter(lap -> lap.lap() == lapNumber && (stint == null || lap.stint() == stint))
                .findFirst()
                .orElse(null);
        if (selected == null && lapNumber >= 0 && lapNumber < laps.size()) {
            selected = laps.get(lapNumber);
        }
        if (selected == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Lap not found");
        }
        final LapInfo chosen = selected;

        List<LapInfo> stintLaps = laps.stream()
                .filter(lap -> lap.stint() == chosen.stint())
                .toList();
        double stintStart = stintLaps.stream().mapToDouble(LapInfo::startTime).min().orElse(chosen.startTime());
        double stintEnd = stintLaps.stream().mapToDouble(LapInfo::endTime).max().orElse(chosen.endTime());
        boolean firstLap = chosen.startTime() <= stintStart + 5.0;
        boolean lastLap = chosen.endTime() >= stintEnd - 5.0;

        List<LapInfo> validLaps = stintLaps.stream()
                .filter(lap -> lap.isValid() && !lap.isOutLap())
                .toList();
        LapInfo best = validLaps.stream()
                .min(java.util.Comparator.comparingDouble(LapInfo::duration))
                .orElseGet(() -> stintLaps.stream()
                        .max(java.util.Comparator.comparingDouble(LapInfo::duration))
                        .orElse(chosen));
        if (best == null || best.duration() < 5.0) {
            best = chosen;
        }

        FusedFrame baseFrame = fusionEngine.fuse(database,
                new FusionOptions(100, best.startTime(), best.endTime()));
        double racingStart = firstLap ? stintStart : chosen.startTime();
        double racingEnd = lastLap ? stintEnd : chosen.endTime();
        FusedFrame racingFrame = fusionEngine.fuse(database,
                new FusionOptions(100, racingStart, racingEnd));

        Extracted base = extract(baseFrame);
        Extracted racing = extract(racingFrame);
        if (base == null || racing == null) {
            return empty(header, chosen, best, base);
        }

        double centerLat = mean(base.lat);
        double centerLon = mean(base.lon);
        double lonScale = Math.cos(Math.toRadians(centerLat));
        double[] baseX = projectX(base.lon, centerLon, lonScale);
        double[] baseY = projectY(base.lat, centerLat);
        double[] racingX = projectX(racing.lon, centerLon, lonScale);
        double[] racingY = projectY(racing.lat, centerLat);

        double zBase = min(base.z);
        NearestIndex index = new NearestIndex(baseX, baseY);
        double[] snappedZ = new double[racingX.length];
        for (int i = 0; i < racingX.length; i++) {
            snappedZ[i] = base.z[index.nearest(racingX[i], racingY[i])];
        }

        List<Track3DPoint> baseMap = formatPoints(baseX, baseY, base, zBase, base.z);
        List<Track3DPoint> racingLine = formatPoints(racingX, racingY, racing, zBase, snappedZ);
        List<Track3DSectorPoint> sectors = buildSectors(base, baseX, baseY, zBase, best);

        Track3DResponse.Center center = new Track3DResponse.Center(centerLat, centerLon, lonScale);
        return new Track3DResponse(
                baseMap,
                racingLine,
                header.metadata().trackName(),
                header.metadata().trackLayout(),
                header.metadata().layoutKey(),
                best.lap(),
                chosen,
                sectors,
                center,
                zBase
        );
    }

    private Track3DResponse empty(LapsResponse header, LapInfo selected, LapInfo best, Extracted base) {
        Track3DResponse.Center center = new Track3DResponse.Center(0.0, 0.0, 1.0);
        return new Track3DResponse(List.of(), List.of(),
                header.metadata().trackName(), header.metadata().trackLayout(), header.metadata().layoutKey(),
                best == null ? selected.lap() : best.lap(), selected, List.of(), center, 0.0);
    }

    private Extracted extract(FusedFrame frame) {
        double[] lat = frame.scalar("GPS Latitude");
        double[] lon = frame.scalar("GPS Longitude");
        double[] distance = frame.scalar("Lap Dist");
        if (lat == null || lon == null || distance == null) {
            return null;
        }
        double[] speed = frame.scalar("Ground Speed");
        if (speed == null) {
            speed = frame.scalar("GPS Speed");
        }
        double[] throttle = frame.scalar("Throttle Pos");
        double[] brake = frame.scalar("Brake Pos");
        double[] lateral = frame.scalar("Path Lateral");
        double[] width = frame.scalar("Track Edge");
        double[] inPits = frame.scalar("In Pits");
        double[] z = frame.scalar("WorldPosZ");
        double[] time = frame.scalar("Time");

        int count = 0;
        for (int i = 0; i < lat.length; i++) {
            if (validCoordinate(lat[i]) && validCoordinate(lon[i])) {
                count++;
            }
        }
        if (count == 0) {
            return null;
        }
        Extracted result = new Extracted(count);
        int target = 0;
        for (int i = 0; i < lat.length; i++) {
            if (!validCoordinate(lat[i]) || !validCoordinate(lon[i])) {
                continue;
            }
            result.lat[target] = lat[i];
            result.lon[target] = lon[i];
            result.d[target] = valueAt(distance, i, 0.0);
            result.speed[target] = valueAt(speed, i, 0.0);
            result.throttle[target] = valueAt(throttle, i, 0.0);
            result.brake[target] = valueAt(brake, i, 0.0);
            result.lateral[target] = valueAt(lateral, i, 0.0);
            result.width[target] = valueAt(width, i, 7.5);
            result.inPits[target] = (int) valueAt(inPits, i, 0.0);
            result.z[target] = valueAt(z, i, 0.0);
            result.time[target] = valueAt(time, i, 0.0);
            target++;
        }
        return result;
    }

    private List<Track3DPoint> formatPoints(double[] x, double[] y, Extracted data,
                                            double zBase, double[] zValues) {
        if (x.length == 0) {
            return List.of();
        }
        int step = Math.max(1, x.length / TARGET_POINTS);
        List<Track3DPoint> points = new ArrayList<>();
        for (int i = 0; i < x.length; i += step) {
            points.add(new Track3DPoint(
                    safe(x[i]),
                    safe(y[i]),
                    safe(zValues[i] - zBase),
                    safe(data.d[i]),
                    safe(data.speed[i]),
                    safe(data.throttle[i]),
                    safe(data.brake[i]),
                    safe(data.lateral[i]),
                    safe(data.width[i]),
                    (int) safe(data.inPits[i]),
                    safe(data.lat[i]),
                    safe(data.lon[i])
            ));
        }
        return points;
    }

    private List<Track3DSectorPoint> buildSectors(Extracted base,
                                                  double[] x,
                                                  double[] y,
                                                  double zBase,
                                                  LapInfo baseLap) {
        if (baseLap.s1() == null || baseLap.s2() == null || base.time.length == 0) {
            return List.of();
        }
        double t1 = baseLap.startTime() + baseLap.s1();
        double t2 = t1 + baseLap.s2();
        int idx1 = nearestTime(base.time, t1);
        int idx2 = nearestTime(base.time, t2);
        List<Track3DSectorPoint> result = new ArrayList<>(3);
        result.add(sector(0, 0, base, x, y, zBase));
        result.add(sector(idx1, 1, base, x, y, zBase));
        result.add(sector(idx2, 2, base, x, y, zBase));
        return result;
    }

    private Track3DSectorPoint sector(int index, int id, Extracted base,
                                      double[] x, double[] y, double zBase) {
        int n = x.length;
        int window = 5;
        int i1 = Math.floorMod(index - window, n);
        int i2 = Math.floorMod(index + window, n);
        double dx = x[i2] - x[i1];
        double dy = y[i2] - y[i1];
        double magnitude = Math.hypot(dx, dy);
        if (magnitude == 0.0) {
            magnitude = 1.0;
        }
        return new Track3DSectorPoint(
                id,
                safe(x[index]),
                safe(y[index]),
                safe(dx / magnitude),
                safe(dy / magnitude),
                safe(base.z[index] - zBase),
                safe(base.d[index]),
                safe(base.lat[index]),
                safe(base.lon[index]),
                safe(base.lateral[index]),
                safe(base.width[index])
        );
    }

    private static int nearestTime(double[] times, double target) {
        int best = 0;
        double bestDiff = Double.MAX_VALUE;
        for (int i = 0; i < times.length; i++) {
            double diff = Math.abs(times[i] - target);
            if (diff < bestDiff) {
                bestDiff = diff;
                best = i;
            }
        }
        return best;
    }

    private static double[] projectX(double[] lon, double centerLon, double lonScale) {
        double[] values = new double[lon.length];
        for (int i = 0; i < lon.length; i++) {
            values[i] = (lon[i] - centerLon) * lonScale * DEG_TO_M;
        }
        return values;
    }

    private static double[] projectY(double[] lat, double centerLat) {
        double[] values = new double[lat.length];
        for (int i = 0; i < lat.length; i++) {
            values[i] = (lat[i] - centerLat) * DEG_TO_M;
        }
        return values;
    }

    private static double mean(double[] values) {
        double sum = 0.0;
        int count = 0;
        for (double value : values) {
            if (!Double.isNaN(value)) {
                sum += value;
                count++;
            }
        }
        return count == 0 ? 0.0 : sum / count;
    }

    private static double min(double[] values) {
        double min = Double.POSITIVE_INFINITY;
        for (double value : values) {
            if (!Double.isNaN(value)) {
                min = Math.min(min, value);
            }
        }
        return Double.isInfinite(min) ? 0.0 : min;
    }

    private static boolean validCoordinate(double value) {
        return !Double.isNaN(value) && value != 0.0;
    }

    private static double valueAt(double[] values, int index, double fallback) {
        if (values == null || index >= values.length || Double.isNaN(values[index])) {
            return fallback;
        }
        return values[index];
    }

    private static double safe(double value) {
        return Double.isNaN(value) || Double.isInfinite(value) ? 0.0 : value;
    }

    private static final class Extracted {
        final double[] lat;
        final double[] lon;
        final double[] d;
        final double[] speed;
        final double[] throttle;
        final double[] brake;
        final double[] lateral;
        final double[] width;
        final double[] inPits;
        final double[] z;
        final double[] time;

        Extracted(int size) {
            lat = new double[size];
            lon = new double[size];
            d = new double[size];
            speed = new double[size];
            throttle = new double[size];
            brake = new double[size];
            lateral = new double[size];
            width = new double[size];
            inPits = new double[size];
            z = new double[size];
            time = new double[size];
        }
    }

    /**
     * Uniform grid nearest-neighbour index. The Python implementation uses an O(N*M)
     * loop; this keeps the same geometry with much better behaviour on long sessions.
     */
    private static final class NearestIndex {

        private static final double CELL = 20.0;
        private final double[] x;
        private final double[] y;
        private final Map<Long, List<Integer>> grid = new HashMap<>();

        NearestIndex(double[] x, double[] y) {
            this.x = x;
            this.y = y;
            for (int i = 0; i < x.length; i++) {
                grid.computeIfAbsent(key(x[i], y[i]), ignored -> new ArrayList<>()).add(i);
            }
        }

        int nearest(double px, double py) {
            int cellX = (int) Math.floor(px / CELL);
            int cellY = (int) Math.floor(py / CELL);
            for (int radius = 0; radius <= 6; radius++) {
                int best = -1;
                double bestDistance = Double.MAX_VALUE;
                for (int dx = -radius; dx <= radius; dx++) {
                    for (int dy = -radius; dy <= radius; dy++) {
                        if (radius > 0 && Math.abs(dx) != radius && Math.abs(dy) != radius) {
                            continue;
                        }
                        List<Integer> candidates = grid.get(key(cellX + dx, cellY + dy));
                        if (candidates == null) {
                            continue;
                        }
                        for (int candidate : candidates) {
                            double distance = (x[candidate] - px) * (x[candidate] - px)
                                    + (y[candidate] - py) * (y[candidate] - py);
                            if (distance < bestDistance) {
                                bestDistance = distance;
                                best = candidate;
                            }
                        }
                    }
                }
                if (best >= 0) {
                    return best;
                }
            }
            int best = 0;
            double bestDistance = Double.MAX_VALUE;
            for (int i = 0; i < x.length; i++) {
                double distance = (x[i] - px) * (x[i] - px) + (y[i] - py) * (y[i] - py);
                if (distance < bestDistance) {
                    bestDistance = distance;
                    best = i;
                }
            }
            return best;
        }

        private static long key(double x, double y) {
            long cellX = (long) Math.floor(x / CELL);
            long cellY = (long) Math.floor(y / CELL);
            return (cellX << 32) ^ (cellY & 0xffffffffL);
        }
    }
}
