package com.lmutl.domain;

public record LapsResponse(
        java.util.List<LapInfo> laps,
        SessionMetadata metadata
) {
}
