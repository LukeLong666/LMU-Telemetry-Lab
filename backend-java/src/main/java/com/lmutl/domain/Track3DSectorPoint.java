package com.lmutl.domain;

public record Track3DSectorPoint(
        int id,
        double x,
        double y,
        double dx,
        double dy,
        double z,
        double dist,
        double lat,
        double lon,
        double lateral,
        double width
) {
}
