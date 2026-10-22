package com.lmutl.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;
import java.util.Map;

public record TrackDefinition(
        @JsonProperty("display_name") String displayName,
        List<String> aliases,
        String country,
        Map<String, TrackLayout> layouts
) {

    public TrackDefinition {
        aliases = aliases == null ? List.of() : List.copyOf(aliases);
        layouts = layouts == null ? Map.of() : Map.copyOf(layouts);
    }

    public record TrackLayout(
            List<String> aliases,
            @JsonProperty("ref_points") List<ElevationPoint> refPoints
    ) {

        public TrackLayout {
            aliases = aliases == null ? List.of() : List.copyOf(aliases);
            refPoints = refPoints == null ? List.of() : List.copyOf(refPoints);
        }

        public double officialLength() {
            if (refPoints.isEmpty()) {
                return 0.0;
            }
            return refPoints.get(refPoints.size() - 1).dist();
        }
    }

    public record ElevationPoint(double dist, double alt, String corner) {
    }
}
