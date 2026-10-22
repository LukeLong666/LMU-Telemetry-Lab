package com.lmutl.application;

import com.lmutl.domain.Channel;
import com.lmutl.domain.FusedFrame;
import com.lmutl.infra.fusion.FusionEngine;
import com.lmutl.infra.fusion.FusionOptions;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.util.Arrays;

@Service
public class TelemetryService {

    private final SessionService sessionService;
    private final LapService lapService;
    private final FusionEngine fusionEngine;

    public TelemetryService(SessionService sessionService,
                            LapService lapService,
                            FusionEngine fusionEngine) {
        this.sessionService = sessionService;
        this.lapService = lapService;
        this.fusionEngine = fusionEngine;
    }

    public Result load(String profileId, String sessionId, int frequency, Integer stintId, Integer lapId) {
        Path database = sessionService.resolve(profileId, sessionId);
        Double trimStart = null;
        Double trimEnd = null;

        if (stintId != null || lapId != null) {
            var header = lapService.header(database);
            if (lapId != null) {
                var target = header.laps().stream()
                        .filter(lap -> lap.lap() == lapId)
                        .findFirst()
                        .orElseThrow(() -> new com.lmutl.api.error.ApiException(
                                org.springframework.http.HttpStatus.NOT_FOUND,
                                "Lap " + lapId + " not found"));
                trimStart = target.startTime();
                trimEnd = target.endTime();
            } else {
                var stintLaps = header.laps().stream()
                        .filter(lap -> lap.stint() == stintId)
                        .toList();
                if (stintLaps.isEmpty()) {
                    throw new com.lmutl.api.error.ApiException(
                            org.springframework.http.HttpStatus.NOT_FOUND,
                            "Stint " + stintId + " not found");
                }
                trimStart = stintLaps.stream().mapToDouble(lap -> lap.startTime()).min().orElseThrow();
                trimEnd = stintLaps.stream().mapToDouble(lap -> lap.endTime()).max().orElseThrow();
            }
        }

        FusedFrame frame = fusionEngine.fuse(database,
                new FusionOptions(frequency, trimStart, trimEnd));
        double[] baselines = suspensionBaselines(frame);
        return new Result(frame, baselines);
    }

    private double[] suspensionBaselines(FusedFrame frame) {
        double[] baselines = new double[]{0.0, 0.0, 0.0, 0.0};
        Channel suspension = frame.channel("Susp Pos");
        if (suspension == null || suspension.width() != 4) {
            return baselines;
        }
        int frames = suspension.frames();
        double[] speed = frame.scalar("Ground Speed");
        if (speed == null) {
            speed = frame.scalar("GPS Speed");
        }
        double[] gLat = frame.scalar("G Force Lat");
        double[] gLong = frame.scalar("G Force Long");

        double maxSpeed = 0.0;
        if (speed != null) {
            for (double value : speed) {
                if (!Double.isNaN(value)) {
                    maxSpeed = Math.max(maxSpeed, value);
                }
            }
        }
        double speedLimit = speed != null && maxSpeed < 80.0 ? 15.0 : 50.0;

        double[] sums = new double[4];
        int[] counts = new int[4];
        for (int i = 0; i < frames; i++) {
            double lat = gLat == null ? 0.0 : gLat[i];
            double lon = gLong == null ? 0.0 : gLong[i];
            double sp = speed == null ? 0.0 : speed[i];
            boolean latOk = Math.abs(Double.isNaN(lat) ? 999.0 : lat) < 0.3;
            boolean lonOk = Math.abs(Double.isNaN(lon) ? 999.0 : lon) < 0.5;
            boolean speedOk = speed == null || (Double.isNaN(sp) ? 999.0 : sp) < speedLimit;
            if (!(latOk && lonOk && speedOk)) {
                continue;
            }
            for (int wheel = 0; wheel < 4; wheel++) {
                double value = suspension.valueAt(i, wheel);
                if (!Double.isNaN(value)) {
                    sums[wheel] += value;
                    counts[wheel]++;
                }
            }
        }

        for (int wheel = 0; wheel < 4; wheel++) {
            if (counts[wheel] >= 10) {
                baselines[wheel] = sums[wheel] / counts[wheel];
            } else {
                double[] values = new double[frames];
                int length = 0;
                for (int i = 0; i < frames; i++) {
                    double value = suspension.valueAt(i, wheel);
                    if (!Double.isNaN(value)) {
                        values[length++] = value;
                    }
                }
                if (length > 0) {
                    double[] trimmed = Arrays.copyOf(values, length);
                    Arrays.sort(trimmed);
                    int middle = trimmed.length / 2;
                    baselines[wheel] = trimmed.length % 2 == 0
                            ? (trimmed[middle - 1] + trimmed[middle]) / 2.0
                            : trimmed[middle];
                }
            }
        }
        return baselines;
    }

    public record Result(FusedFrame frame, double[] suspensionBaselines) {
    }
}
