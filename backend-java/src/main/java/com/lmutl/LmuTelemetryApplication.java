package com.lmutl;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.ConfigurationPropertiesScan;

@SpringBootApplication
@ConfigurationPropertiesScan
public class LmuTelemetryApplication {

    public static void main(String[] args) {
        SpringApplication.run(LmuTelemetryApplication.class, args);
    }
}
