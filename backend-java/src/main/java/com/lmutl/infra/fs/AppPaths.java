package com.lmutl.infra.fs;

import com.lmutl.config.AppProperties;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;

/**
 * Resolves all application data paths. The layout intentionally mirrors the
 * Python backend so existing user data is picked up without migration.
 */
@Component
public class AppPaths {

    private static final Logger log = LoggerFactory.getLogger(AppPaths.class);

    private final AppProperties properties;
    private final Path appHome;
    private final Path dataRoot;
    private final Path gameTelemetryDir;
    private final Path frontendDir;
    private final Path steeringWheelDir;

    public AppPaths(AppProperties properties) {
        this.properties = properties;
        this.appHome = Path.of(System.getProperty("lmu.home", System.getProperty("user.dir")))
                .toAbsolutePath()
                .normalize();
        this.dataRoot = resolveDataRoot();
        this.gameTelemetryDir = resolveTelemetryDir(properties.getTelemetryDir());
        this.frontendDir = resolveFrontendDir(properties.getFrontendDir());
        this.steeringWheelDir = resolveSteeringWheelDir(properties.getSteeringWheelDir());
    }

    @PostConstruct
    public void init() throws IOException {
        Files.createDirectories(dataRoot);
        ensureProfileDirs("guest");
        log.info("App home: {}", appHome);
        log.info("Data root: {}", dataRoot);
        log.info("Game telemetry dir: {}", gameTelemetryDir == null ? "<disabled>" : gameTelemetryDir);
        log.info("Frontend dir: {}", frontendDir);
        log.info("Steering wheel dir: {}", steeringWheelDir);
    }

    private Path resolveDataRoot() {
        String configured = properties.getDataDir();
        if (configured != null && !configured.isBlank()) {
            return Path.of(configured.trim()).toAbsolutePath().normalize();
        }
        String localAppData = System.getenv("LOCALAPPDATA");
        Path base;
        if (localAppData != null && !localAppData.isBlank()) {
            base = Path.of(localAppData);
        } else {
            base = Path.of(System.getProperty("user.home", "."));
        }
        String folder = properties.isDevMode() ? "LMU_Telemetry_Lab_Dev" : "LMU_Telemetry_Lab";
        return base.resolve(folder).toAbsolutePath().normalize();
    }

    private Path resolveAgainstHome(String raw) {
        if (raw == null || raw.isBlank()) {
            return appHome;
        }
        Path path = Path.of(raw);
        if (!path.isAbsolute()) {
            path = appHome.resolve(path);
        }
        return path.toAbsolutePath().normalize();
    }

    private Path resolveTelemetryDir(String configured) {
        if (configured == null || configured.isBlank()) {
            return null;
        }
        Path dir = Path.of(configured.trim()).toAbsolutePath().normalize();
        if (!Files.isDirectory(dir)) {
            log.warn("Configured telemetry dir does not exist, direct game reads disabled: {}", dir);
            return null;
        }
        return dir;
    }

    private Path resolveFrontendDir(String configured) {
        Path direct = resolveAgainstHome(configured);
        if (Files.isDirectory(direct)) {
            return direct;
        }
        // Packaged app-image layout: <app-home>/frontend/dist.
        Path appImageLayout = appHome.resolve("frontend/dist").normalize();
        if (Files.isDirectory(appImageLayout)) {
            return appImageLayout;
        }
        return direct;
    }

    private Path resolveSteeringWheelDir(String configured) {
        Path direct = resolveAgainstHome(configured);
        if (Files.isDirectory(direct)) {
            return direct;
        }
        Path publicDir = appHome.resolve("frontend/public/steering wheel").normalize();
        if (Files.isDirectory(publicDir)) {
            return publicDir;
        }
        Path distDir = appHome.resolve("frontend/dist/steering wheel").normalize();
        if (Files.isDirectory(distDir)) {
            return distDir;
        }
        return direct;
    }

    public Path appHome() {
        return appHome;
    }

    public Path dataRoot() {
        return dataRoot;
    }

    /** The LMU game's telemetry recording folder, or null when unavailable. */
    public Path gameTelemetryDir() {
        return gameTelemetryDir;
    }

    public Path profilesFile() {
        return dataRoot.resolve("profiles.json");
    }

    public Path profileRoot(String profileId) {
        return dataRoot.resolve("Data").resolve(profileId).normalize();
    }

    public Path profileDataDir(String profileId) {
        return profileRoot(profileId).resolve("DuckDB_data").normalize();
    }

    public Path profileCacheDir(String profileId) {
        return profileRoot(profileId).resolve("cache").normalize();
    }

    public Path profileAvatarDir(String profileId) {
        return profileRoot(profileId).resolve("avatars").normalize();
    }

    public Path legacyDataDir() {
        return appHome.resolve("DuckDB_data").normalize();
    }

    public void ensureProfileDirs(String profileId) {
        try {
            Files.createDirectories(profileDataDir(profileId));
            Files.createDirectories(profileCacheDir(profileId));
            Files.createDirectories(profileAvatarDir(profileId));
        } catch (IOException e) {
            throw new IllegalStateException("Failed to create profile directories for " + profileId, e);
        }
    }

    public Path frontendDir() {
        return frontendDir;
    }

    public Path steeringWheelDir() {
        return steeringWheelDir;
    }

    public String version() {
        return properties.getVersion();
    }

    public boolean devMode() {
        return properties.isDevMode();
    }

    public String platform() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
    }
}
