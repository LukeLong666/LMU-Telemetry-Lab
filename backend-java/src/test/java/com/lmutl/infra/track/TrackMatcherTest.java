package com.lmutl.infra.track;

import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import static org.assertj.core.api.Assertions.assertThat;

class TrackMatcherTest {

    private static TrackRegistry registry;

    @BeforeAll
    static void setUp() {
        registry = new TrackRegistry(new ObjectMapper());
        registry.load();
    }

    @Test
    void loadsRegistryCounts() {
        assertThat(registry.tracks()).hasSize(18);
        int layouts = registry.tracks().values().stream().mapToInt(t -> t.layouts().size()).sum();
        assertThat(layouts).isEqualTo(34);
        int points = registry.tracks().values().stream()
                .flatMap(t -> t.layouts().values().stream())
                .mapToInt(l -> l.refPoints().size())
                .sum();
        assertThat(points).isEqualTo(469);
    }

    @Test
    void matchesKnownTracksAndAliases() {
        assertThat(key("Algarve International Circuit")).isEqualTo("Algarve International Circuit");
        assertThat(key("Circuit de la Sarthe")).isEqualTo("Circuit de La Sarthe");
        assertThat(key("Le Mans")).isEqualTo("Circuit de La Sarthe");
        assertThat(key("Monza")).isEqualTo("Autodromo Nazionale Monza");
        assertThat(key("Autodromo Nazionale Monza")).isEqualTo("Autodromo Nazionale Monza");
        assertThat(key("Spa")).isEqualTo("Circuit de Spa-Francorchamps");
        assertThat(key("COTA")).isEqualTo("Circuit of the Americas");
        assertThat(key("Austin")).isEqualTo("Circuit of the Americas");
        assertThat(key("Sakhir")).isEqualTo("Bahrain International Circuit");
        assertThat(key("Portimao")).isEqualTo("Algarve International Circuit");
    }

    @Test
    void matchesLayouts() {
        assertThat(layout("Paul Ricard", "Paul Ricard - ELMS")).isEqualTo("Default");
        assertThat(layout("Paul Ricard", "Paul Ricard - 1A")).isEqualTo("Layout 1A");
        assertThat(layout("Paul Ricard", "Paul Ricard - 1A-V2")).isEqualTo("Layout 1A-V2");
        assertThat(layout("Paul Ricard", "Paul Ricard - 1A-V2-Short")).isEqualTo("Layout 1A-V2-Short");
        assertThat(layout("Paul Ricard", "Paul Ricard - 3A")).isEqualTo("Layout 3A");
        assertThat(layout("Paul Ricard", "Some Unknown Layout")).isEqualTo("Default");
        assertThat(layout("Paul Ricard", "Paul Ricard")).isEqualTo("Default");
    }

    @Test
    void sequenceMatcherMatchesPythonRatios() {
        assertThat(SequenceMatcher.ratio("monza", "monzaa")).isCloseTo(0.909091, withinOneMillionth());
        assertThat(SequenceMatcher.ratio("paul ricard", "paul riccard")).isCloseTo(0.956522, withinOneMillionth());
        assertThat(SequenceMatcher.ratio("abc", "xyz")).isEqualTo(0.0);
        assertThat(SequenceMatcher.ratio("equal", "equal")).isEqualTo(1.0);
    }

    private static String key(String name) {
        TrackMatcher.Match match = registry.findTrack(name);
        assertThat(match).as("track match for %s", name).isNotNull();
        return match.key();
    }

    private static String layout(String trackName, String rawLayout) {
        TrackMatcher.Match track = registry.findTrack(trackName);
        assertThat(track).isNotNull();
        LayoutMatcher.Match match = registry.findLayout(track.definition(), rawLayout, track.key());
        assertThat(match).isNotNull();
        return match.key();
    }

    private static org.assertj.core.data.Offset<Double> withinOneMillionth() {
        return org.assertj.core.data.Offset.offset(0.000001);
    }
}
