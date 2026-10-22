package com.lmutl.infra.car;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class CarCatalogTest {

    private final CarCatalog catalog = new CarCatalog();

    @Test
    void matchesStandardTeams() {
        assertThat(catalog.getCarInfo("United Autosports", "LMGT3").modelName())
                .isEqualTo("McLaren 720S GT3 Evo");
        assertThat(catalog.getCarInfo("United Autosports", "LMGT3").steeringLock()).isEqualTo(540);
        assertThat(catalog.getCarInfo("Toyota Gazoo Racing", "Hypercar").modelName())
                .isEqualTo("Toyota GR010 Hybrid");
        assertThat(catalog.getCarInfo("Toyota Gazoo Racing", "Hypercar").steeringLock()).isEqualTo(480);
    }

    @Test
    void fallsBackToTitleCasedNameWithoutCsv() {
        assertThat(catalog.getCarInfo("Ferrari 499P #50", "Hypercar").modelName())
                .isEqualTo("Ferrari 499P #50");
        assertThat(catalog.getCarInfo("mclaren_720s_gt3_evo", "LMGT3").modelName())
                .isEqualTo("Mclaren 720S GT3 Evo");
        assertThat(catalog.getCarInfo("BMW M Hybrid V8:EC", "Hypercar").modelName())
                .isEqualTo("BMW M Hybrid V8");
        assertThat(catalog.getCarInfo("", "LMGT3").modelName()).isEmpty();
    }

    @Test
    void parsesSteeringLock() {
        assertThat(catalog.parseSteerLock("524deg (18.5deg)")).isEqualTo(524);
        assertThat(catalog.parseSteerLock("")).isNull();
        assertThat(catalog.parseSteerLock(null)).isNull();
    }
}
