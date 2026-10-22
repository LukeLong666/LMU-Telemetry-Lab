package com.lmutl.domain;

public record ReferenceLap(
        String sessionId,
        String sessionName,
        double date,
        int lap,
        int stint,
        double startTime,
        double endTime,
        double duration,
        boolean isValid,
        Double s1,
        Double s2,
        Double s3,
        String driver,
        String sessionTime,
        String carModel,
        String rawCarName,
        int totalLaps,
        int stintCount,
        double fuelUsed
) {
}
