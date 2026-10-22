package com.lmutl.infra.fusion;

import com.lmutl.domain.Channel;
import com.lmutl.domain.FusedFrame;
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
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.sql.Connection;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

@Component
public class FusionEngine {

    private static final Logger log = LoggerFactory.getLogger(FusionEngine.class);

    private static final Set<String> SKIP_TABLES = Set.of(
            "GPS Time", "metadata", "channelsList", "eventsList", "Session Info",
            "Lap", "Lap Time", "GPS Speed", "Gear", "Lap Dist",
            "AntiStall Activated", "Best LapTime", "Best Sector1", "Best Sector2",
            "CloudDarkness", "Engine Max RPM", "Headlights State",
            "Brakes Air Temp", "Clutch RPM", "FFB Output", "Steering Pos Unfiltered",
            "Steering Shaft Torque", "SurfaceTypes", "Throttle Pos Unfiltered",
            "Time Behind Next", "Wind Heading", "Wind Speed",
            "Brake Pos Unfiltered", "Clutch Pos Unfiltered", "RearFlapLegalStatus"
    );

    private static final Set<String> SPARSE_CHANNELS = Set.of(
            "TyresCompound", "WheelsDetached", "TC", "ABS", "TCCut",
            "TCLevel", "ABSLevel", "TCSlipAngle", "Wheel ABS", "Wheel TC", "WheelABS", "WheelTC"
    );

    private static final Set<String> PULSE_CHANNELS = Set.of("TC", "ABS", "TCCut");
    private static final Set<String> NO_FFILL_CHANNELS = Set.of();

    private final DuckDbConnectionFactory connections;
    private final MetadataReader metadataReader;
    private final TrackRegistry trackRegistry;
    private final CarCatalog carCatalog;

    public FusionEngine(DuckDbConnectionFactory connections,
                        MetadataReader metadataReader,
                        TrackRegistry trackRegistry,
                        CarCatalog carCatalog) {
        this.connections = connections;
        this.metadataReader = metadataReader;
        this.trackRegistry = trackRegistry;
        this.carCatalog = carCatalog;
    }

    public FusedFrame fuse(Path database, FusionOptions options) {
        try (Connection connection = connections.open(database)) {
            double[] gps = DuckDbReads.readValues(connection, "GPS Time");
            if (gps.length == 0) {
                throw new IllegalStateException("GPS Time table is empty.");
            }
            Map<String, String> meta = metadataReader.read(connection);
            String trackName = meta.get("TrackName");
            String trackLayout = meta.get("TrackLayout");
            String rawCar = meta.get("CarName");
            String rawClass = meta.get("CarClass");

            double sessionStart = gps[0];
            double sessionEnd = gps[gps.length - 1];
            double start = options.trimStart() == null ? sessionStart : Math.max(sessionStart, options.trimStart());
            double end = options.trimEnd() == null ? sessionEnd : Math.min(sessionEnd, options.trimEnd());
            if (!(end > start)) {
                end = sessionEnd;
                start = sessionStart;
            }

            int frequency = Math.max(1, options.targetFreq());
            double[] master = FusionMath.masterTimeline(start, end, frequency);
            LinkedHashMap<String, Channel> channels = new LinkedHashMap<>();
            put(channels, "Time", master);

            LapBoundaryResolver.Result boundaries = LapBoundaryResolver.resolve(connection);
            put(channels, "Lap", buildLapChannel(master, boundaries));

            DistanceResult distance = buildDistance(connection, gps, master, boundaries, trackName, trackLayout, frequency);
            put(channels, "Lap Dist", distance.lapDistance());

            put(channels, "Gear", buildGear(connection, master));

            fuseTables(connection, gps, master, start, end, options.trimStart() != null, channels);

            buildSteeringAngle(channels, rawCar, rawClass);
            buildElevation(channels, trackName, trackLayout);
            buildVirtualChannels(channels, distance.speed());

            return new FusedFrame(frequency, master, channels);
        } catch (Exception e) {
            log.error("Telemetry fusion failed for {}", database, e);
            throw new IllegalStateException("Telemetry fusion failed: " + e.getMessage(), e);
        }
    }

    private double[] buildLapChannel(double[] master, LapBoundaryResolver.Result boundaries) {
        double[] lap = new double[master.length];
        for (int i = 0; i < boundaries.boundaries().size(); i++) {
            double boundaryStart = boundaries.boundaries().get(i);
            double boundaryEnd = i + 1 < boundaries.boundaries().size()
                    ? boundaries.boundaries().get(i + 1)
                    : boundaries.sessionEnd() + 1.0;
            for (int j = 0; j < master.length; j++) {
                if (master[j] >= boundaryStart && master[j] < boundaryEnd) {
                    lap[j] = i;
                }
            }
        }
        return lap;
    }

    private DistanceResult buildDistance(Connection connection,
                                         double[] gps,
                                         double[] master,
                                         LapBoundaryResolver.Result boundaries,
                                         String trackName,
                                         String trackLayout,
                                         int frequency) throws Exception {
        double[] sourceSpeed;
        try {
            sourceSpeed = DuckDbReads.readValues(connection, "Ground Speed");
        } catch (Exception e) {
            sourceSpeed = DuckDbReads.readValues(connection, "GPS Speed");
        }
        if (sourceSpeed.length == 0) {
            sourceSpeed = new double[gps.length];
        }
        double maxSpeed = 0.0;
        for (double value : sourceSpeed) {
            if (!Double.isNaN(value)) {
                maxSpeed = Math.max(maxSpeed, value);
            }
        }
        if (maxSpeed > 150.0) {
            for (int i = 0; i < sourceSpeed.length; i++) {
                sourceSpeed[i] /= 3.6;
            }
        }

        double[] sourceTime = FusionMath.mapIndicesToTimes(gps, sourceSpeed.length);
        double dt = 1.0 / Math.max(1, frequency);
        double[] speed = new double[master.length];
        for (int i = 0; i < master.length; i++) {
            speed[i] = FusionMath.interp(sourceTime, sourceSpeed, master[i]);
        }
        double[] cumulative = new double[master.length];
        double total = 0.0;
        for (int i = 0; i < master.length; i++) {
            total += speed[i] * dt;
            cumulative[i] = total;
        }

        double initialOffset = 0.0;
        Double firstLapDist = DuckDbReads.scalarDouble(connection, "SELECT value FROM \"Lap Dist\" ORDER BY rowid LIMIT 1");
        if (firstLapDist != null) {
            initialOffset = firstLapDist;
        }

        double[] lapDistance = new double[master.length];
        double[] segmentEnds = new double[boundaries.boundaries().size()];
        int[] startIndices = new int[boundaries.boundaries().size()];
        int[] endIndices = new int[boundaries.boundaries().size()];
        for (int i = 0; i < boundaries.boundaries().size(); i++) {
            double boundaryStart = boundaries.boundaries().get(i);
            double boundaryEnd = i + 1 < boundaries.boundaries().size()
                    ? boundaries.boundaries().get(i + 1)
                    : boundaries.sessionEnd() + 1.0;
            int idxStart = FusionMath.lowerBound(master, boundaryStart);
            int idxEnd = FusionMath.lowerBound(master, boundaryEnd);
            startIndices[i] = idxStart;
            endIndices[i] = idxEnd;
            if (idxStart >= master.length) {
                segmentEnds[i] = 0.0;
                continue;
            }
            int limit = Math.min(idxEnd, master.length);
            double baseDistance = cumulative[idxStart];
            double last = 0.0;
            for (int j = idxStart; j < limit; j++) {
                double value = Math.max(0.0, cumulative[j] - baseDistance);
                if (i == 0) {
                    value += initialOffset;
                }
                lapDistance[j] = value;
                last = value;
            }
            segmentEnds[i] = last;
        }

        double referenceLength = referenceLength(connection, boundaries, segmentEnds, trackName, trackLayout);
        for (int i = 0; i < boundaries.boundaries().size(); i++) {
            double segmentEnd = segmentEnds[i];
            if (segmentEnd < 100.0) {
                continue;
            }
            double ratio = referenceLength > 0 ? segmentEnd / referenceLength : 0.0;
            if (ratio > 0.8 && ratio < 1.2) {
                double scale = referenceLength / segmentEnd;
                int limit = Math.min(endIndices[i], master.length);
                for (int j = startIndices[i]; j < limit; j++) {
                    lapDistance[j] *= scale;
                }
            }
        }
        return new DistanceResult(speed, lapDistance);
    }

    private double referenceLength(Connection connection,
                                   LapBoundaryResolver.Result boundaries,
                                   double[] segmentEnds,
                                   String trackName,
                                   String trackLayout) {
        TrackMatcher.Match trackMatch = trackRegistry.findTrack(trackName);
        if (trackMatch != null) {
            TrackDefinition track = trackMatch.definition();
            LayoutMatcher.Match layoutMatch = trackRegistry.findLayout(track, trackLayout, trackMatch.key());
            if (layoutMatch != null && layoutMatch.layout().officialLength() > 0) {
                return layoutMatch.layout().officialLength();
            }
        }
        List<Double> valid = new ArrayList<>();
        for (double end : segmentEnds) {
            if (end > 2000.0) {
                valid.add(end);
            }
        }
        if (!valid.isEmpty()) {
            double[] values = valid.stream().mapToDouble(Double::doubleValue).toArray();
            return FusionMath.median(values);
        }
        return 6019.0;
    }

    private double[] buildGear(Connection connection, double[] master) {
        List<DuckDbReads.Event> events = DuckDbReads.readEventsOrEmpty(connection, "Gear");
        if (events.isEmpty()) {
            return null;
        }
        double initialGear;
        if (events.size() >= 2) {
            double first = events.get(0).value();
            double second = events.get(1).value();
            initialGear = first == 0.0 && second > 0.0 ? second - 1.0 : first;
        } else {
            initialGear = events.get(0).value();
        }
        double[] timestamps = new double[events.size() + 1];
        double[] values = new double[events.size() + 1];
        timestamps[0] = -1.0;
        values[0] = initialGear;
        for (int i = 0; i < events.size(); i++) {
            timestamps[i + 1] = events.get(i).ts();
            values[i + 1] = events.get(i).value();
        }
        double[] gear = new double[master.length];
        for (int i = 0; i < master.length; i++) {
            int index = FusionMath.upperBound(timestamps, master[i]) - 1;
            index = Math.max(0, Math.min(values.length - 1, index));
            gear[i] = values[index];
        }
        return gear;
    }

    private void fuseTables(Connection connection,
                            double[] gps,
                            double[] master,
                            double start,
                            double end,
                            boolean trimActive,
                            LinkedHashMap<String, Channel> channels) throws Exception {
        for (String table : DuckDbReads.tableNames(connection)) {
            if (SKIP_TABLES.contains(table)) {
                continue;
            }
            List<String> columns = DuckDbReads.columns(connection, table);
            if (columns.isEmpty()) {
                continue;
            }
            boolean hasTimestamp = columns.contains("ts");
            boolean wheelTable = columns.contains("value1") && columns.contains("value2")
                    && columns.contains("value3") && columns.contains("value4");
            if (wheelTable) {
                if (hasTimestamp) {
                    List<DuckDbReads.EventWheel> events = DuckDbReads.readEventWheels(connection, table);
                    boolean carryAdded = false;
                    if (trimActive && SPARSE_CHANNELS.contains(table)) {
                        DuckDbReads.EventWheel carry = DuckDbReads.lastEventWheelBefore(connection, table, start + 1e-6);
                        if (carry != null) {
                            List<DuckDbReads.EventWheel> withCarry = new ArrayList<>();
                            withCarry.add(new DuckDbReads.EventWheel(start, carry.values()));
                            withCarry.addAll(events);
                            events = withCarry;
                            carryAdded = true;
                        }
                    }
                    if (events.isEmpty() || (!carryAdded && !hasEventWheelInRange(events, start, end))) {
                        continue;
                    }
                    double[][] data = new double[master.length][4];
                    for (double[] row : data) {
                        java.util.Arrays.fill(row, Double.NaN);
                    }
                    assignEventWheels(data, master, events, start, end, table, carryAdded);
                    putVector(channels, table, data, table);
                } else {
                    double[][] source = DuckDbReads.readWheelValues(connection, table);
                    double[] sourceTime = FusionMath.mapIndicesToTimes(gps, source.length == 0 ? 0 : source[0].length);
                    double[][] data = new double[master.length][4];
                    for (int wheel = 0; wheel < 4; wheel++) {
                        for (int i = 0; i < master.length; i++) {
                            data[i][wheel] = source.length <= wheel || source[wheel].length == 0
                                    ? Double.NaN
                                    : FusionMath.interp(sourceTime, source[wheel], master[i]);
                        }
                    }
                    putVector(channels, table, data, table);
                }
                continue;
            }

            for (String column : columns) {
                if ("ts".equals(column)) {
                    continue;
                }
                String targetName = "value".equals(column) ? table : table + "_" + column;
                if (hasTimestamp) {
                    List<DuckDbReads.Event> events = "value".equals(column)
                            ? DuckDbReads.readEvents(connection, table)
                            : DuckDbReads.readEventsColumn(connection, table, column);
                    boolean carryAdded = false;
                    if (trimActive && SPARSE_CHANNELS.contains(table)) {
                        DuckDbReads.Event carry = DuckDbReads.lastEventBefore(connection, table, start + 1e-6);
                        if (carry != null) {
                            List<DuckDbReads.Event> withCarry = new ArrayList<>();
                            withCarry.add(new DuckDbReads.Event(start, carry.value()));
                            withCarry.addAll(events);
                            events = withCarry;
                            carryAdded = true;
                        }
                    }
                    if (events.isEmpty() || (!carryAdded && !hasEventInRange(events, start, end))) {
                        continue;
                    }
                    double[] data = new double[master.length];
                    java.util.Arrays.fill(data, Double.NaN);
                    assignEvents(data, master, events, start, end, table, carryAdded);
                    put(channels, targetName, data);
                } else {
                    double[] source = DuckDbReads.readColumn(connection, table, column);
                    double[] sourceTime = FusionMath.mapIndicesToTimes(gps, source.length);
                    double[] data = new double[master.length];
                    for (int i = 0; i < master.length; i++) {
                        data[i] = source.length == 0
                                ? Double.NaN
                                : FusionMath.interp(sourceTime, source, master[i]);
                    }
                    put(channels, targetName, data);
                }
            }
        }
    }

    private boolean hasEventInRange(List<DuckDbReads.Event> events, double start, double end) {
        for (DuckDbReads.Event event : events) {
            double ts = FusionMath.round3(event.ts());
            if (ts >= start && ts <= end) {
                return true;
            }
        }
        return false;
    }

    private boolean hasEventWheelInRange(List<DuckDbReads.EventWheel> events, double start, double end) {
        for (DuckDbReads.EventWheel event : events) {
            double ts = FusionMath.round3(event.ts());
            if (ts >= start && ts <= end) {
                return true;
            }
        }
        return false;
    }

    private void assignEvents(double[] target,
                              double[] master,
                              List<DuckDbReads.Event> events,
                              double start,
                              double end,
                              String table,
                              boolean carryPrefix) {
        int cursor = 0;
        for (DuckDbReads.Event event : events) {
            boolean carry = carryPrefix && cursor == 0;
            cursor++;
            double ts = FusionMath.round3(event.ts());
            // Carry-over is forced to the first master frame. Ordinary events keep
            // Python's raw-start filter (a rounded timestamp can be < raw start).
            if (!carry && (ts < start || ts > end)) {
                continue;
            }
            int index = FusionMath.lowerBound(master, ts);
            index = Math.min(index, master.length - 1);
            if (index < 0) {
                continue;
            }
            if (PULSE_CHANNELS.contains(table)) {
                double value = event.value();
                if (value == 1.0) {
                    target[index] = 1.0;
                } else if (value == 0.0) {
                    if (target[index] == 1.0 && index + 1 < target.length) {
                        target[index + 1] = 0.0;
                    } else {
                        target[index] = 0.0;
                    }
                } else {
                    target[index] = value;
                }
            } else {
                target[index] = event.value();
            }
        }
        if (SPARSE_CHANNELS.contains(table)) {
            forwardFillScalar(target);
            if ("WheelsDetached".equals(table)) {
                replaceNaNs(target, 0.0);
            }
        }
    }

    private void assignEventWheels(double[][] target,
                                   double[] master,
                                   List<DuckDbReads.EventWheel> events,
                                   double start,
                                   double end,
                                   String table,
                                   boolean carryPrefix) {
        int cursor = 0;
        for (DuckDbReads.EventWheel event : events) {
            boolean carry = carryPrefix && cursor == 0;
            cursor++;
            double ts = FusionMath.round3(event.ts());
            if (!carry && (ts < start || ts > end)) {
                continue;
            }
            int index = Math.min(FusionMath.lowerBound(master, ts), master.length - 1);
            for (int wheel = 0; wheel < 4; wheel++) {
                target[index][wheel] = event.values()[wheel];
            }
        }
        if (SPARSE_CHANNELS.contains(table)) {
            forwardFillVector(target);
            if ("WheelsDetached".equals(table)) {
                for (double[] row : target) {
                    for (int wheel = 0; wheel < 4; wheel++) {
                        if (Double.isNaN(row[wheel])) {
                            row[wheel] = 0.0;
                        }
                    }
                }
            }
        }
    }

    private void forwardFillScalar(double[] values) {
        double last = Double.NaN;
        for (int i = 0; i < values.length; i++) {
            if (Double.isNaN(values[i])) {
                values[i] = last;
            } else {
                last = values[i];
            }
        }
    }

    private void forwardFillVector(double[][] values) {
        for (int wheel = 0; wheel < 4; wheel++) {
            double last = Double.NaN;
            for (double[] value : values) {
                if (Double.isNaN(value[wheel])) {
                    value[wheel] = last;
                } else {
                    last = value[wheel];
                }
            }
        }
    }

    private static void replaceNaNs(double[] values, double replacement) {
        for (int i = 0; i < values.length; i++) {
            if (Double.isNaN(values[i])) {
                values[i] = replacement;
            }
        }
    }

    private void buildSteeringAngle(LinkedHashMap<String, Channel> channels, String rawCar, String rawClass) {
        Channel steering = channels.get("Steering Pos");
        if (steering == null || steering.width() != 1) {
            return;
        }
        double[] values = steering.data().clone();
        double max = 0.0;
        for (double value : values) {
            if (!Double.isNaN(value)) {
                max = Math.max(max, Math.abs(value));
            }
        }
        int lock = carCatalog.getCarInfo(rawCar, rawClass).steeringLock();
        if (max <= 2.0) {
            for (int i = 0; i < values.length; i++) {
                values[i] *= lock / 2.0;
            }
        }
        put(channels, "Steering Angle", values);
    }

    private void buildElevation(LinkedHashMap<String, Channel> channels, String trackName, String trackLayout) {
        Channel lat = channels.get("GPS Latitude");
        Channel lon = channels.get("GPS Longitude");
        Channel distance = channels.get("Lap Dist");
        if (lat == null || lon == null || distance == null || lat.width() != 1 || lon.width() != 1) {
            return;
        }
        double[] z = ElevationFusion.computeZ(lat.data(), lon.data(), distance.data(),
                trackName, trackLayout, trackRegistry);
        put(channels, "WorldPosZ", z);
    }

    private void buildVirtualChannels(LinkedHashMap<String, Channel> channels, double[] groundSpeed) {
        Channel wheelSpeed = channels.get("Wheel Speed");
        if (wheelSpeed != null && wheelSpeed.width() == 4) {
            double[] source = wheelSpeed.data();
            double[] slip = new double[source.length];
            for (int frame = 0; frame < source.length / 4; frame++) {
                double speed = groundSpeed[Math.min(frame, groundSpeed.length - 1)];
                for (int wheel = 0; wheel < 4; wheel++) {
                    double wheelValue = source[frame * 4 + wheel];
                    double value = (wheelValue - speed) / Math.max(speed, 0.5);
                    if (wheel == 0 || wheel == 2) {
                        value = -value;
                    }
                    slip[frame * 4 + wheel] = value;
                }
            }
            putVector(channels, "Slip Ratio", slip);
        }

        Channel left = channels.get("TyresTempLeft");
        Channel centre = channels.get("TyresTempCentre");
        Channel right = channels.get("TyresTempRight");
        if (left != null && centre != null && right != null
                && left.width() == 4 && centre.width() == 4 && right.width() == 4) {
            double[] inside = new double[left.data().length];
            double[] outside = new double[left.data().length];
            for (int frame = 0; frame < left.data().length / 4; frame++) {
                for (int wheel = 0; wheel < 4; wheel++) {
                    int index = frame * 4 + wheel;
                    if (wheel == 0 || wheel == 2) {
                        inside[index] = right.data()[index];
                        outside[index] = left.data()[index];
                    } else {
                        inside[index] = left.data()[index];
                        outside[index] = right.data()[index];
                    }
                }
            }
            putVector(channels, "TyresTempInside", inside);
            putVector(channels, "TyresTempOutside", outside);
        }

        if (channels.containsKey("Wheel ABS")) {
            overrideWheelMax(channels, "Wheel ABS", "ABS");
        } else {
            overrideWheelMax(channels, "WheelABS", "ABS");
        }
        if (channels.containsKey("Wheel TC")) {
            overrideWheelMax(channels, "Wheel TC", "TC");
        } else {
            overrideWheelMax(channels, "WheelTC", "TC");
        }

        Channel suspension = channels.get("Susp Pos");
        if (suspension != null && suspension.width() == 4) {
            double[] flipped = suspension.data().clone();
            for (int i = 0; i < flipped.length; i++) {
                flipped[i] = -flipped[i];
            }
            replaceVector(channels, "Susp Pos", flipped);
        }
    }

    private void overrideWheelMax(LinkedHashMap<String, Channel> channels, String sourceName, String targetName) {
        Channel source = channels.get(sourceName);
        if (source == null || source.width() != 4) {
            return;
        }
        int frames = source.frames();
        double[] result = new double[frames];
        for (int frame = 0; frame < frames; frame++) {
            double max = Double.NaN;
            for (int wheel = 0; wheel < 4; wheel++) {
                double value = source.valueAt(frame, wheel);
                if (!Double.isNaN(value)) {
                    max = Double.isNaN(max) ? value : Math.max(max, value);
                }
            }
            result[frame] = max;
        }
        channels.put(targetName, Channel.scalar(targetName, result));
    }

    private void put(LinkedHashMap<String, Channel> channels, String name, double[] data) {
        if (data == null) {
            return;
        }
        String unique = uniqueName(channels, name);
        channels.put(unique, Channel.scalar(unique, data));
    }

    private void putVector(LinkedHashMap<String, Channel> channels, String name, double[] flat) {
        if (flat == null) {
            return;
        }
        String unique = uniqueName(channels, name);
        channels.put(unique, Channel.fromFlat(unique, 4, flat));
    }

    private void replaceVector(LinkedHashMap<String, Channel> channels, String name, double[] flat) {
        channels.put(name, Channel.fromFlat(name, 4, flat));
    }

    private void putVector(LinkedHashMap<String, Channel> channels, String name, double[][] values, String source) {
        if (values == null) {
            return;
        }
        String unique = uniqueName(channels, name);
        double[] flat = new double[values.length * 4];
        for (int frame = 0; frame < values.length; frame++) {
            for (int wheel = 0; wheel < 4; wheel++) {
                flat[frame * 4 + wheel] = values[frame][wheel];
            }
        }
        channels.put(unique, Channel.fromFlat(unique, 4, flat));
    }

    private String uniqueName(Map<String, Channel> channels, String name) {
        if (!channels.containsKey(name)) {
            return name;
        }
        int suffix = 2;
        String candidate = name + "_" + suffix;
        while (channels.containsKey(candidate)) {
            suffix++;
            candidate = name + "_" + suffix;
        }
        return candidate;
    }

    private record DistanceResult(double[] speed, double[] lapDistance) {
    }
}
