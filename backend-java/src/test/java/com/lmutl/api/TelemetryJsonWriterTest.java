package com.lmutl.api;

import com.lmutl.domain.Channel;
import com.lmutl.domain.FusedFrame;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class TelemetryJsonWriterTest {

    @Test
    void writesScalarsVectorsAndNullForNan() throws Exception {
        LinkedHashMap<String, Channel> channels = new LinkedHashMap<>();
        channels.put("Time", Channel.scalar("Time", new double[]{0.0, 0.1, 0.2}));
        channels.put("Ground Speed", Channel.scalar("Ground Speed", new double[]{1.0, Double.NaN, 3.0}));
        channels.put("Susp Pos", Channel.vector("Susp Pos", new double[][]{
                {1.0, 2.0, 3.0, 4.0},
                {Double.NaN, Double.NaN, Double.NaN, Double.NaN}
        }));
        FusedFrame frame = new FusedFrame(10, new double[]{0.0, 0.1, 0.2}, channels);

        ByteArrayOutputStream output = new ByteArrayOutputStream();
        TelemetryJsonWriter.write(output, frame, new double[]{1.0, 2.0, 3.0, 4.0});

        JsonNode json = new ObjectMapper().readTree(output.toByteArray());
        assertThat(json.path("Time").isArray()).isTrue();
        assertThat(json.path("Time").get(1).asDouble()).isEqualTo(0.1);
        assertThat(json.path("Ground Speed").get(1).isNull()).isTrue();
        assertThat(json.path("Susp Pos").get(0).get(2).asDouble()).isEqualTo(3.0);
        assertThat(json.path("Susp Pos").get(1).get(0).isNull()).isTrue();
        assertThat(json.path("suspension_baselines").get(3).asDouble()).isEqualTo(4.0);
    }
}
