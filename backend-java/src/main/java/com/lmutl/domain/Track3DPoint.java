package com.lmutl.domain;

import com.fasterxml.jackson.annotation.JsonProperty;

public record Track3DPoint(
        double x,
        double y,
        double z,
        double d,
        double speed,
        double throttle,
        double brake,
        double lat,
        double width,
        @JsonProperty("in_pits") int inPits,
        @JsonProperty("raw_lat") double rawLat,
        @JsonProperty("raw_lon") double rawLon
) {
}
