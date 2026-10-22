package com.lmutl.domain;

import java.util.List;

public record Track3DResponse(
        List<Track3DPoint> baseMap,
        List<Track3DPoint> racingLine,
        String trackName,
        String trackLayout,
        String layoutKey,
        int fastestLap,
        LapInfo selectedLapInfo,
        List<Track3DSectorPoint> trackSectors,
        Center center,
        double zBase
) {

    public record Center(double lat, double lon, double lonScale) {
    }
}
