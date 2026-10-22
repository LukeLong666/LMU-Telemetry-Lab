package com.lmutl.infra.fusion;

import com.lmutl.domain.FusedFrame;
import com.lmutl.infra.car.CarCatalog;
import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.MetadataReader;
import com.lmutl.infra.track.TrackRegistry;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class FusionEngineTest {

    @Test
    void fusesSyntheticSession() {
        Path fixture = Path.of("..", "testdata", "duckdb", "synthetic_monza_multistint.duckdb");
        Assumptions.assumeTrue(Files.exists(fixture), "synthetic fixture not present");

        TrackRegistry registry = new TrackRegistry(new ObjectMapper());
        registry.load();
        FusionEngine engine = new FusionEngine(
                new DuckDbConnectionFactory(),
                new MetadataReader(),
                registry,
                new CarCatalog()
        );

        FusedFrame frame = engine.fuse(fixture, new FusionOptions(10, null, null));
        assertThat(frame.frequency()).isEqualTo(10);
        assertThat(frame.time()).hasSize(1801);
        assertThat(frame.channel("Time")).isNotNull();
        assertThat(frame.channel("Lap Dist")).isNotNull();
        assertThat(frame.channel("WorldPosZ")).isNotNull();
        assertThat(frame.channel("Susp Pos").width()).isEqualTo(4);
        assertThat(frame.channel("TyresTempInside").width()).isEqualTo(4);
        assertThat(frame.channel("Steering Angle")).isNotNull();

        double[] distance = frame.scalar("Lap Dist");
        assertThat(distance).isNotNull();
        assertThat(distance[100]).isGreaterThan(0.0);
        double[] elevation = frame.scalar("WorldPosZ");
        assertThat(elevation).isNotNull();
        assertThat(elevation[100]).isNotNaN();
    }
}
