package com.lmutl.infra.track;

import com.lmutl.domain.TrackDefinition;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class TrackRegistry {

    private static final Logger log = LoggerFactory.getLogger(TrackRegistry.class);

    private final ObjectMapper mapper;
    private Map<String, TrackDefinition> tracks = Map.of();

    public TrackRegistry(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    @PostConstruct
    public void load() {
        ClassPathResource resource = new ClassPathResource("tracks.json");
        try (InputStream input = resource.getInputStream()) {
            Map<String, TrackDefinition> loaded = mapper.readValue(
                    input, new TypeReference<LinkedHashMap<String, TrackDefinition>>() {
                    });
            if (loaded == null || loaded.isEmpty()) {
                throw new IllegalStateException("tracks.json is empty");
            }
            tracks = Collections.unmodifiableMap(new LinkedHashMap<>(loaded));
            int layouts = tracks.values().stream().mapToInt(t -> t.layouts().size()).sum();
            int points = tracks.values().stream()
                    .flatMap(t -> t.layouts().values().stream())
                    .mapToInt(l -> l.refPoints().size())
                    .sum();
            log.info("Loaded {} tracks, {} layouts, {} elevation points", tracks.size(), layouts, points);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to load tracks.json", e);
        }
    }

    public Map<String, TrackDefinition> tracks() {
        return tracks;
    }

    public TrackMatcher.Match findTrack(String trackName) {
        return TrackMatcher.match(trackName, tracks);
    }

    public LayoutMatcher.Match findLayout(TrackDefinition track, String rawLayout, String rawTrack) {
        return LayoutMatcher.match(track, rawLayout, rawTrack);
    }
}
