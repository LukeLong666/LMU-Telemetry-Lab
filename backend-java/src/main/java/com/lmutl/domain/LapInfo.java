package com.lmutl.domain;

public record LapInfo(
        int lap,
        double startTime,
        double endTime,
        double duration,
        boolean isValid,
        boolean isOutLap,
        boolean inPit,
        double fuelUsed,
        Double s1,
        Double s2,
        Double s3,
        int stint
) {
}
