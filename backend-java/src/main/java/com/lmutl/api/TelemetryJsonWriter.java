package com.lmutl.api;

import com.lmutl.domain.Channel;
import com.lmutl.domain.FusedFrame;
import tools.jackson.core.JsonGenerator;
import tools.jackson.core.json.JsonFactory;

import java.io.IOException;
import java.io.OutputStream;

public final class TelemetryJsonWriter {

    private TelemetryJsonWriter() {
    }

    public static void write(OutputStream output, FusedFrame frame, double[] baselines) throws IOException {
        JsonFactory factory = JsonFactory.builder().build();
        try (JsonGenerator generator = factory.createGenerator(output)) {
            generator.writeStartObject();
            for (Channel channel : frame.channels().values()) {
                generator.writeName(channel.name());
                writeChannel(generator, channel);
            }
            generator.writeName("suspension_baselines");
            writeArray(generator, baselines);
            generator.writeEndObject();
        }
    }

    private static void writeChannel(JsonGenerator generator, Channel channel) {
        if (channel.width() == 1) {
            writeArray(generator, channel.data());
            return;
        }
        int frames = channel.frames();
        generator.writeStartArray();
        for (int frame = 0; frame < frames; frame++) {
            generator.writeStartArray();
            for (int wheel = 0; wheel < channel.width(); wheel++) {
                writeNumber(generator, channel.valueAt(frame, wheel));
            }
            generator.writeEndArray();
        }
        generator.writeEndArray();
    }

    private static void writeArray(JsonGenerator generator, double[] values) {
        generator.writeStartArray();
        for (double value : values) {
            writeNumber(generator, value);
        }
        generator.writeEndArray();
    }

    private static void writeNumber(JsonGenerator generator, double value) {
        if (Double.isNaN(value) || Double.isInfinite(value)) {
            generator.writeNull();
        } else {
            generator.writeNumber(value);
        }
    }
}
