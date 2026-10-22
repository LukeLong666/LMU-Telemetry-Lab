package com.lmutl.infra.fs;

import com.lmutl.api.error.ApiException;
import com.lmutl.infra.discord.DiscordClient;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Repository;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;

@Repository
public class SessionRepository {

    private static final Logger log = LoggerFactory.getLogger(SessionRepository.class);

    private final AppPaths paths;
    private final DiscordClient discordClient;

    public SessionRepository(AppPaths paths, DiscordClient discordClient) {
        this.paths = paths;
        this.discordClient = discordClient;
    }

    public List<Path> listFiles(String profileId) {
        Map<String, Path> byName = new LinkedHashMap<>();
        for (Path file : duckDbFilesIn(paths.profileDataDir(profileId))) {
            byName.put(file.getFileName().toString(), file);
        }
        Path gameDir = paths.gameTelemetryDir();
        if (gameDir != null) {
            for (Path file : duckDbFilesIn(gameDir)) {
                byName.putIfAbsent(file.getFileName().toString(), file);
            }
        }
        return byName.values().stream()
                .sorted(Comparator.comparingLong(SessionRepository::lastModifiedMillis).reversed())
                .toList();
    }

    private static List<Path> duckDbFilesIn(Path dir) {
        if (!Files.isDirectory(dir)) {
            return List.of();
        }
        try (Stream<Path> stream = Files.list(dir)) {
            return stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".duckdb"))
                    .toList();
        } catch (IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to list sessions", e);
        }
    }

    public Path resolve(String profileId, String sessionId) {
        if (sessionId != null && sessionId.startsWith("discord__")) {
            return resolveDiscordSession(sessionId);
        }
        Path dir = paths.profileDataDir(profileId);
        Path file = PathSafety.resolveUnder(dir, sessionId);
        if (!PathSafety.isDuckDb(file.getFileName().toString())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Only .duckdb files are supported");
        }
        if (Files.isRegularFile(file)) {
            return file;
        }
        Path fromGame = resolveInGameTelemetry(sessionId);
        if (fromGame != null) {
            return fromGame;
        }
        throw new ApiException(HttpStatus.NOT_FOUND, "Session not found");
    }

    private Path resolveInGameTelemetry(String sessionId) {
        Path gameDir = paths.gameTelemetryDir();
        if (gameDir == null) {
            return null;
        }
        Path candidate = PathSafety.resolveUnder(gameDir, sessionId);
        return Files.isRegularFile(candidate) ? candidate : null;
    }

    private Path resolveWritable(String profileId, String sessionId) {
        Path dir = paths.profileDataDir(profileId);
        Path file = PathSafety.resolveUnder(dir, sessionId);
        if (!PathSafety.isDuckDb(file.getFileName().toString())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Only .duckdb files are supported");
        }
        if (!Files.isRegularFile(file)) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    "Sessions read straight from the game telemetry folder are read-only");
        }
        return file;
    }

    private Path resolveDiscordSession(String sessionId) {
        String threadId = sessionId.substring("discord__".length());
        if (!threadId.matches("\\d+")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid Discord thread id");
        }
        Path cacheDir = paths.dataRoot().resolve("cache").resolve("discord_temp");
        Path cached = cacheDir.resolve(threadId + ".duckdb");
        if (Files.isRegularFile(cached)) {
            return cached;
        }
        try {
            Files.createDirectories(cacheDir);
            var attachments = discordClient.getThreadAttachments(threadId);
            if (attachments == null || attachments.get("telemetry") == null) {
                throw new ApiException(HttpStatus.NOT_FOUND, "Discord telemetry attachment not found.");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> telemetry = (Map<String, Object>) attachments.get("telemetry");
            discordClient.downloadFile(String.valueOf(telemetry.get("url")), cached);
            return cached;
        } catch (ApiException e) {
            throw e;
        } catch (Exception e) {
            try {
                Files.deleteIfExists(cached);
            } catch (IOException ignored) {
            }
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                    "Failed to download Discord session: " + e.getMessage(), e);
        }
    }

    public UploadedSession upload(String profileId, MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "File is required");
        }
        String original = file.getOriginalFilename();
        String fileName = PathSafety.safeFileName(original == null ? "session.duckdb" : original);
        if (!PathSafety.isDuckDb(fileName)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Only .duckdb files are allowed");
        }
        Path dir = paths.profileDataDir(profileId);
        Path target = PathSafety.resolveUnder(dir, fileName);
        try {
            AtomicFiles.copy(file.getInputStream(), target);
        } catch (IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Upload failed: " + e.getMessage(), e);
        }
        try {
            return new UploadedSession(fileName, Files.size(target));
        } catch (IOException e) {
            return new UploadedSession(fileName, file.getSize());
        }
    }

    public List<String> importPaths(String profileId, List<String> sourcePaths) {
        if (sourcePaths == null || sourcePaths.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "No files selected");
        }
        Path dir = paths.profileDataDir(profileId);
        List<Path> sources = new ArrayList<>();
        for (String raw : sourcePaths) {
            if (raw == null || raw.isBlank()) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid source path");
            }
            Path source = Path.of(raw);
            if (!source.isAbsolute()) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "Source path must be absolute: " + raw);
            }
            source = source.normalize();
            if (!Files.isRegularFile(source)) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "Source file not found: " + raw);
            }
            String fileName = PathSafety.safeFileName(source.getFileName().toString());
            if (!PathSafety.isDuckDb(fileName)) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "Only .duckdb files are allowed: " + raw);
            }
            sources.add(source);
        }

        List<String> imported = new ArrayList<>(sources.size());
        for (Path source : sources) {
            String fileName = PathSafety.safeFileName(source.getFileName().toString());
            Path target = PathSafety.resolveUnder(dir, fileName);
            try {
                AtomicFiles.copy(source, target);
                imported.add(fileName);
            } catch (IOException e) {
                throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR,
                        "Failed to import " + source.getFileName() + ": " + e.getMessage(), e);
            }
        }
        log.info("Imported {} file(s) into profile {}", imported.size(), profileId);
        return imported;
    }

    public String rename(String profileId, String sessionId, String newName) {
        Path dir = paths.profileDataDir(profileId);
        Path oldPath = resolveWritable(profileId, sessionId);
        String targetName = newName == null ? "" : newName.trim();
        if (targetName.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "New name is required");
        }
        if (!PathSafety.isDuckDb(targetName)) {
            targetName = targetName + ".duckdb";
        }
        targetName = PathSafety.safeFileName(targetName);
        if (!PathSafety.isDuckDb(targetName)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }
        Path newPath = PathSafety.resolveUnder(dir, targetName);
        if (Files.exists(newPath)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "File with new name already exists");
        }
        try {
            Files.move(oldPath, newPath);
            clearCache(profileId, sessionId);
            log.info("Renamed session {} -> {} (profile={})", sessionId, targetName, profileId);
            return targetName;
        } catch (IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Rename failed: " + e.getMessage(), e);
        }
    }

    public void delete(String profileId, String sessionId) {
        Path file = resolveWritable(profileId, sessionId);
        try {
            Files.deleteIfExists(file);
            clearCache(profileId, sessionId);
            log.info("Deleted session {} (profile={})", sessionId, profileId);
        } catch (IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Delete failed: " + e.getMessage(), e);
        }
    }

    public void clearCache(String profileId, String sessionId) {
        Path cacheDir = paths.profileCacheDir(profileId);
        if (!Files.isDirectory(cacheDir)) {
            return;
        }
        try (Stream<Path> stream = Files.list(cacheDir)) {
            List<Path> stale = stream
                    .filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().startsWith(sessionId))
                    .toList();
            for (Path path : stale) {
                Files.deleteIfExists(path);
            }
        } catch (IOException e) {
            log.warn("Failed to clear cache for {}: {}", sessionId, e.getMessage());
        }
    }

    private static long lastModifiedMillis(Path path) {
        try {
            FileTime time = Files.getLastModifiedTime(path);
            return time.toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    public record UploadedSession(String id, long size) {
    }
}
