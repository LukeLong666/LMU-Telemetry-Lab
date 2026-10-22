package com.lmutl.infra.track;

import com.lmutl.domain.TrackDefinition;
import com.lmutl.domain.TrackDefinition.TrackLayout;

import java.util.LinkedHashMap;
import java.util.Map;

public final class LayoutMatcher {

    private LayoutMatcher() {
    }

    public static Match match(TrackDefinition track, String rawLayout, String rawTrack) {
        if (track == null || rawLayout == null || rawLayout.isBlank()) {
            return null;
        }
        Map<String, TrackLayout> layouts = track.layouts();
        if (layouts.isEmpty()) {
            return null;
        }

        String normalizedLayout = TrackNames.normalizeLayout(rawLayout);
        String normalizedTrack = rawTrack == null ? "" : TrackNames.normalizeLayout(rawTrack);

        for (Map.Entry<String, TrackLayout> entry : layouts.entrySet()) {
            if (TrackNames.normalizeLayout(entry.getKey()).equals(normalizedLayout)) {
                return new Match(entry.getKey(), entry.getValue());
            }
        }

        for (Map.Entry<String, TrackLayout> entry : layouts.entrySet()) {
            for (String alias : entry.getValue().aliases()) {
                if (TrackNames.normalizeLayout(alias).equals(normalizedLayout)) {
                    return new Match(entry.getKey(), entry.getValue());
                }
            }
        }

        String strippedLayout = normalizedLayout;
        if (!normalizedTrack.isEmpty() && normalizedLayout.contains(normalizedTrack)) {
            strippedLayout = normalizedLayout.replace(normalizedTrack, "").trim();
            strippedLayout = TrackNames.stripLeadingNonAlnum(strippedLayout);
        }

        if (!strippedLayout.isEmpty()) {
            for (Map.Entry<String, TrackLayout> entry : layouts.entrySet()) {
                String key = strippedKey(entry.getKey());
                if (key.equals(strippedLayout)) {
                    return new Match(entry.getKey(), entry.getValue());
                }
                for (String alias : entry.getValue().aliases()) {
                    if (TrackNames.stripLeadingNonAlnum(TrackNames.normalizeLayout(alias)).equals(strippedLayout)) {
                        return new Match(entry.getKey(), entry.getValue());
                    }
                }
            }
            for (Map.Entry<String, TrackLayout> entry : layouts.entrySet()) {
                String key = strippedKey(entry.getKey());
                if (key.contains(strippedLayout) || strippedLayout.contains(key)) {
                    return new Match(entry.getKey(), entry.getValue());
                }
                for (String alias : entry.getValue().aliases()) {
                    String normalizedAlias = TrackNames.normalizeLayout(alias);
                    if (normalizedAlias.contains(strippedLayout) || strippedLayout.contains(normalizedAlias)) {
                        return new Match(entry.getKey(), entry.getValue());
                    }
                }
            }
        }

        for (Map.Entry<String, TrackLayout> entry : layouts.entrySet()) {
            String key = TrackNames.normalizeLayout(entry.getKey());
            if (key.contains(normalizedLayout) || normalizedLayout.contains(key)) {
                return new Match(entry.getKey(), entry.getValue());
            }
        }

        TrackLayout fallback = layouts.get("Default");
        if (fallback != null) {
            return new Match("Default", fallback);
        }
        return null;
    }

    private static String strippedKey(String key) {
        String normalized = TrackNames.normalizeLayout(key);
        normalized = normalized.replace("layout", "").trim();
        return TrackNames.stripLeadingNonAlnum(normalized);
    }

    public record Match(String key, TrackLayout layout) {
    }
}
