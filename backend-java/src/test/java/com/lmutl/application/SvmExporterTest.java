package com.lmutl.application;

import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.MetadataReader;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class SvmExporterTest {

    @Test
    void exportsSvmFromSyntheticCarSetup() {
        Path fixture = Path.of("..", "testdata", "duckdb", "synthetic_monza_multistint.duckdb");
        Assumptions.assumeTrue(Files.exists(fixture), "synthetic fixture not present");

        SvmExporter exporter = new SvmExporter(
                new DuckDbConnectionFactory(),
                new MetadataReader(),
                new ObjectMapper()
        );
        String svm = exporter.generate(fixture);

        assertThat(svm).startsWith("VehicleClassSetting=\"Hypercar\"");
        assertThat(svm).contains("[GENERAL]");
        assertThat(svm).contains("WedgeSetting=0//N/A");
        assertThat(svm).contains("[FRONTLEFT]");
        assertThat(svm).contains("CompoundSetting=0//Medium");
        assertThat(svm).contains("[BASIC]");
        assertThat(svm).endsWith("\n");
    }
}
