package com.lmutl.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "lmu")
public class AppProperties {

    private boolean devMode = true;
    private String dataDir = "";
    private String telemetryDir = "";
    private String frontendDir = "../frontend/dist";
    private String steeringWheelDir = "../frontend/public/steering wheel";
    private String version = "1.5.3";

    public boolean isDevMode() {
        return devMode;
    }

    public void setDevMode(boolean devMode) {
        this.devMode = devMode;
    }

    public String getDataDir() {
        return dataDir;
    }

    public void setDataDir(String dataDir) {
        this.dataDir = dataDir;
    }

    public String getTelemetryDir() {
        return telemetryDir;
    }

    public void setTelemetryDir(String telemetryDir) {
        this.telemetryDir = telemetryDir;
    }

    public String getFrontendDir() {
        return frontendDir;
    }

    public void setFrontendDir(String frontendDir) {
        this.frontendDir = frontendDir;
    }

    public String getSteeringWheelDir() {
        return steeringWheelDir;
    }

    public void setSteeringWheelDir(String steeringWheelDir) {
        this.steeringWheelDir = steeringWheelDir;
    }

    public String getVersion() {
        return version;
    }

    public void setVersion(String version) {
        this.version = version;
    }
}
