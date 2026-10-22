package com.lmutl.domain;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.ALWAYS)
public record SessionMetadata(
        String trackName,
        String commonTrackName,
        List<String> trackAliases,
        String country,
        String trackLayout,
        String layoutKey,
        Double officialTrackLength,
        String carClass,
        String modelName,
        String rawCarName,
        String driverName,
        String sessionTime,
        double sessionDuration,
        String sessionType,
        String weather,
        List<TrackSectorPoint> trackSectors,
        double fuelCapacity,
        int tyreCompoundMax,
        Integer steeringLock,
        String steeringLockString
) {

    public record TrackSectorPoint(double lat, double lon, int id) {
    }
}
