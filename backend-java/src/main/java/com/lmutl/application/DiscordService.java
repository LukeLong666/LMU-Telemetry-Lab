package com.lmutl.application;

import com.lmutl.api.dto.DiscordDtos;
import com.lmutl.api.error.ApiException;
import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.infra.car.CarCatalog;
import com.lmutl.infra.discord.DiscordClient;
import com.lmutl.infra.discord.DiscordConfig;
import com.lmutl.infra.fs.AppPaths;
import com.lmutl.infra.fs.PathSafety;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class DiscordService {

    private static final Logger log = LoggerFactory.getLogger(DiscordService.class);

    private final DiscordConfig config;
    private final DiscordClient client;
    private final SessionService sessionService;
    private final LapService lapService;
    private final LapExportService lapExportService;
    private final SvmExporter svmExporter;
    private final SetupService setupService;
    private final CarCatalog carCatalog;
    private final AppPaths paths;

    public DiscordService(DiscordConfig config,
                          DiscordClient client,
                          SessionService sessionService,
                          LapService lapService,
                          LapExportService lapExportService,
                          SvmExporter svmExporter,
                          SetupService setupService,
                          CarCatalog carCatalog,
                          AppPaths paths) {
        this.config = config;
        this.client = client;
        this.sessionService = sessionService;
        this.lapService = lapService;
        this.lapExportService = lapExportService;
        this.svmExporter = svmExporter;
        this.setupService = setupService;
        this.carCatalog = carCatalog;
        this.paths = paths;
    }

    public Map<String, Object> config() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("is_configured", config.isConfigured());
        body.put("invite_url", config.inviteUrl());
        return body;
    }

    public Map<String, Object> shares(String carClass) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("shares", client.listSharedLaps(carClass));
        return body;
    }

    public Map<String, Object> share(String profileId, String sessionId, DiscordDtos.ShareRequest request) {
        if (!config.isConfigured()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "Discord Bot is not configured. Please check discord_config.json");
        }
        if (request == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Request body is required");
        }
        if (request.discordHandle() == null || request.discordHandle().isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "Discord username is required for server membership verification.");
        }
        String profile = request.profileId() == null || request.profileId().isBlank() ? "guest" : request.profileId();
        Path database = sessionService.resolve(profile, sessionId);
        LapsResponse header = lapService.header(database);
        LapInfo lap = header.laps().stream()
                .filter(item -> item.lap() == request.lapNumber())
                .findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND,
                        "Lap " + request.lapNumber() + " not found"));

        Map<String, String> metadata = setupService.readMetadata(database);
        String trackName = metadata.getOrDefault("TrackName", "Track");
        String layoutName = metadata.getOrDefault("TrackLayout", "Layout").replace(" ", "-")
                .replaceAll("[\\\\/*?:\"<>|]", "");
        String rawCar = metadata.getOrDefault("CarName", "");
        String rawClass = metadata.getOrDefault("CarClass", "");
        String friendlyCar = request.customCarModel() != null && !request.customCarModel().isBlank()
                ? request.customCarModel()
                : carCatalog.getCarInfo(rawCar, rawClass).modelName();
        String carModel = friendlyCar.replace(" ", "-");
        String recordingTime = metadata.getOrDefault("RecordingTime", PathSafety.stripDuckDb(sessionId));
        String lapTime = formatLapTime(lap.duration());

        List<Path> files = new ArrayList<>();
        try {
            LapExportService.ExportResult export = lapExportService.export(
                    profile, sessionId, request.lapNumber(), request.customCarModel());
            files.add(export.path());

            if (request.attachSetup()) {
                try {
                    String svm = svmExporter.generate(database);
                    Path setupFile = paths.profileCacheDir(profile)
                            .resolve(layoutName + "_" + carModel + "_" + recordingTime + "_setup.svm");
                    Files.writeString(setupFile, svm);
                    files.add(setupFile);
                } catch (Exception e) {
                    log.error("Setup generation failed for Discord share", e);
                }
            }

            Map<String, Object> member = client.searchGuildMember(request.discordHandle());
            if (member == null) {
                throw new ApiException(HttpStatus.BAD_REQUEST,
                        "You are not a member of our Discord server yet! Please join our server to share telemetry.");
            }
            String driverMention = "<@" + member.get("user_id") + ">";
            String trackDisplay = layoutName != null && !layoutName.isBlank() && !layoutName.equals(trackName)
                    ? trackName + " (" + layoutName + ")"
                    : trackName;
            String headerBlock = "### Telemetry Shared by " + driverMention + "\n\n"
                    + "* **Track:** " + trackDisplay + "\n"
                    + "* **Car:** " + friendlyCar + "\n"
                    + "* **Lap Time:** " + lapTime + "\n\n"
                    + "---\n\n";
            String fullContent = headerBlock + (request.content() == null ? "" : request.content());

            Map<String, Object> result = client.shareToForum(
                    request.carClass(),
                    request.title(),
                    fullContent,
                    trackName,
                    files);
            if (!Boolean.TRUE.equals(result.get("success"))) {
                throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                        String.valueOf(result.getOrDefault("error", "Discord share failed")));
            }
            return result;
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            log.error("Discord sharing failed", e);
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Discord sharing failed: " + e.getMessage(), e);
        } finally {
            for (Path file : files) {
                try {
                    Files.deleteIfExists(file);
                } catch (Exception e) {
                    log.warn("Failed to clean up {}", file);
                }
            }
        }
    }

    public Map<String, Object> download(DiscordDtos.DownloadRequest request) {
        if (request == null || request.telemetryUrl() == null || request.telemetryFilename() == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Telemetry URL and filename are required");
        }
        String profile = request.profileId() == null || request.profileId().isBlank() ? "guest" : request.profileId();
        String telemetryFilename = PathSafety.safeFileName(request.telemetryFilename());
        if (!PathSafety.isDuckDb(telemetryFilename)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid telemetry file type. Must end in .duckdb");
        }
        Path telemetryPath = paths.profileDataDir(profile).resolve(telemetryFilename).normalize();
        try {
            client.downloadFile(request.telemetryUrl(), telemetryPath);
        } catch (Exception e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Failed to download telemetry file: " + e.getMessage(), e);
        }

        boolean setupDownloaded = false;
        if (request.setupUrl() != null && request.setupFilename() != null) {
            String setupFilename = PathSafety.safeFileName(request.setupFilename());
            if (setupFilename.toLowerCase(Locale.ROOT).endsWith(".svm")) {
                Path setupPath = paths.profileDataDir(profile).resolve(setupFilename).normalize();
                try {
                    client.downloadFile(request.setupUrl(), setupPath);
                    setupDownloaded = true;
                } catch (Exception e) {
                    log.error("Failed to download setup file", e);
                }
            }
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("success", true);
        body.put("telemetry_path", telemetryPath.toString());
        body.put("setup_downloaded", setupDownloaded);
        return body;
    }

    private static String formatLapTime(double seconds) {
        int minutes = (int) (seconds / 60);
        int wholeSeconds = (int) (seconds % 60);
        int millis = (int) ((seconds * 1000) % 1000);
        return String.format(Locale.ROOT, "%dm%02ds%03d", minutes, wholeSeconds, millis);
    }
}
