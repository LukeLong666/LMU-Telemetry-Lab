package com.lmutl.infra.track;

import com.lmutl.domain.TrackDefinition;

import java.util.LinkedHashMap;
import java.util.Map;

public final class TrackMatcher {

    private TrackMatcher() {
    }

    public static Match match(String searchName, Map<String, TrackDefinition> registry) {
        if (searchName == null || searchName.isBlank() || registry.isEmpty()) {
            return null;
        }
        String normalized = TrackNames.normalizeTrack(searchName);

        for (Map.Entry<String, TrackDefinition> entry : registry.entrySet()) {
            if (TrackNames.normalizeTrack(entry.getKey()).equals(normalized)) {
                return new Match(entry.getKey(), entry.getValue());
            }
        }

        for (Map.Entry<String, TrackDefinition> entry : registry.entrySet()) {
            for (String alias : entry.getValue().aliases()) {
                if (TrackNames.normalizeTrack(alias).equals(normalized)) {
                    return new Match(entry.getKey(), entry.getValue());
                }
            }
        }

        Map<String, String> candidates = new LinkedHashMap<>();
        for (Map.Entry<String, TrackDefinition> entry : registry.entrySet()) {
            candidates.put(TrackNames.normalizeTrack(entry.getKey()), entry.getKey());
            for (String alias : entry.getValue().aliases()) {
                candidates.put(TrackNames.normalizeTrack(alias), entry.getKey());
            }
        }

        String bestKey = null;
        double bestScore = 0.6;
        for (Map.Entry<String, String> candidate : candidates.entrySet()) {
            double score = SequenceMatcher.ratio(normalized, candidate.getKey());
            if (score >= bestScore && (bestKey == null || score > bestScore)) {
                bestScore = score;
                bestKey = candidate.getValue();
            }
        }
        if (bestKey != null) {
            return new Match(bestKey, registry.get(bestKey));
        }
        return null;
    }

    public record Match(String key, TrackDefinition definition) {
    }
}
