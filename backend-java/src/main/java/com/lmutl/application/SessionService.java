package com.lmutl.application;

import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.domain.SessionInfo;
import com.lmutl.domain.SessionMetadata;
import com.lmutl.domain.TrackDefinition;
import com.lmutl.infra.fs.PathSafety;
import com.lmutl.infra.fs.SessionRepository;
import com.lmutl.infra.track.TrackRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

@Service
public class SessionService {

    private static final Logger log = LoggerFactory.getLogger(SessionService.class);

    private final SessionRepository repository;
    private final LapService lapService;
    private final TrackRegistry trackRegistry;
    private final Map<Path, CacheEntry> cache = new ConcurrentHashMap<>();

    public SessionService(SessionRepository repository,
                          LapService lapService,
                          TrackRegistry trackRegistry) {
        this.repository = repository;
        this.lapService = lapService;
        this.trackRegistry = trackRegistry;
    }

    public List<SessionInfo> list(String profileId) {
        List<Path> files = repository.listFiles(normalizeProfile(profileId));
        List<SessionInfo> result = new ArrayList<>(files.size());
        for (Path file : files) {
            result.add(scan(file));
        }
        return result;
    }

    public SessionInfo scan(Path file) {
        Path cacheKey = file.toAbsolutePath().normalize();
        String fileName = cacheKey.getFileName().toString();
        String id = fileName;
        String name = PathSafety.stripDuckDb(fileName);
        double created = lastModifiedSeconds(cacheKey);
        long size = fileSize(cacheKey);
        long modified = lastModifiedMillis(cacheKey);
        CacheEntry cached = cache.get(cacheKey);
        if (cached != null && cached.size() == size && cached.modified() == modified) {
            return cached.info();
        }

        try {
            LapsResponse header = lapService.header(cacheKey);
            SessionMetadata metadata = header.metadata();
            List<LapInfo> laps = header.laps();

            boolean singleLap = laps.size() == 1;
            List<LapInfo> valid = laps.stream()
                    .filter(lap -> lap.isValid() && (!lap.isOutLap() || singleLap) && lap.duration() > 0)
                    .toList();
            LapInfo best = valid.stream()
                    .min(Comparator.comparingDouble(LapInfo::duration))
                    .orElse(null);
            boolean bestValid = best != null;
            if (best == null) {
                best = laps.stream()
                        .filter(lap -> (!lap.isOutLap() || singleLap) && lap.duration() > 0)
                        .min(Comparator.comparingDouble(LapInfo::duration))
                        .orElse(null);
            }

            String common = metadata.commonTrackName();
            TrackDefinition track = common == null ? null : trackRegistry.tracks().get(common);
            SessionInfo info = new SessionInfo(
                    id,
                    name,
                    created,
                    size,
                    emptyToNull(metadata.trackName()),
                    emptyToNull(metadata.trackLayout()),
                    track == null ? null : emptyToNull(metadata.layoutKey()),
                    track == null ? null : emptyToNull(common),
                    track == null ? null : emptyToNull(track.displayName()),
                    track == null ? null : metadata.trackAliases(),
                    emptyToNull(metadata.modelName()),
                    emptyToNull(metadata.carClass()),
                    emptyToNull(metadata.rawCarName()),
                    emptyToNull(metadata.country()),
                    metadata.officialTrackLength() == null || metadata.officialTrackLength() <= 0
                            ? null : metadata.officialTrackLength(),
                    emptyToNull(metadata.driverName()),
                    best == null ? null : best.duration(),
                    best == null ? null : bestValid
            );
            cache.put(cacheKey, new CacheEntry(info, size, modified));
            return info;
        } catch (Exception e) {
            log.warn("Failed to read session metadata for {}: {}", fileName, e.getMessage());
            return new SessionInfo(id, name, created, size,
                    null, null, null, null, null, null, null, null, null, null, null, null, null, null);
        }
    }

    public SessionRepository.UploadedSession upload(String profileId, MultipartFile file) {
        SessionRepository.UploadedSession uploaded = repository.upload(normalizeProfile(profileId), file);
        clearCaches();
        return uploaded;
    }

    public String rename(String profileId, String sessionId, String newName) {
        String renamed = repository.rename(normalizeProfile(profileId), sessionId, newName);
        clearCaches();
        return renamed;
    }

    public void delete(String profileId, String sessionId) {
        repository.delete(normalizeProfile(profileId), sessionId);
        clearCaches();
    }

    public Path resolve(String profileId, String sessionId) {
        return repository.resolve(normalizeProfile(profileId), sessionId);
    }

    private void clearCaches() {
        cache.clear();
        lapService.clearCache();
    }

    private String normalizeProfile(String profileId) {
        return profileId == null || profileId.isBlank() ? "guest" : profileId;
    }

    private static double lastModifiedSeconds(Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis() / 1000.0;
        } catch (IOException e) {
            return Instant.now().getEpochSecond();
        }
    }

    private static long lastModifiedMillis(Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis();
        } catch (IOException e) {
            return 0L;
        }
    }

    private static long fileSize(Path file) {
        try {
            return Files.size(file);
        } catch (IOException e) {
            return 0L;
        }
    }

    private static String emptyToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    private record CacheEntry(SessionInfo info, long size, long modified) {
    }
}
