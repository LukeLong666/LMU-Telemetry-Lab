package com.lmutl.domain;

import com.fasterxml.jackson.annotation.JsonInclude;

import java.util.List;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record SessionInfo(
        String id,
        String name,
        double created,
        long size,
        String trackName,
        String trackLayout,
        String layoutKey,
        String commonTrackName,
        String displayName,
        List<String> trackAliases,
        String carModel,
        String carClass,
        String rawCarName,
        String country,
        Double officialTrackLength,
        String driverName,
        Double bestLapTime,
        Boolean bestLapValid
) {

    public SessionInfo withTrack(String trackName, String trackLayout, String layoutKey) {
        return new SessionInfo(id, name, created, size, trackName, trackLayout, layoutKey,
                commonTrackName, displayName, trackAliases, carModel, carClass, rawCarName,
                country, officialTrackLength, driverName, bestLapTime, bestLapValid);
    }
}
