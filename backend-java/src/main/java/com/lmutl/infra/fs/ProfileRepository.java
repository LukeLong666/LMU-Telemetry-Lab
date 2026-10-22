package com.lmutl.infra.fs;

import com.lmutl.api.error.ApiException;
import com.lmutl.domain.Profile;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Repository;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.locks.ReentrantReadWriteLock;

@Repository
public class ProfileRepository {

    private static final Logger log = LoggerFactory.getLogger(ProfileRepository.class);
    private static final DateTimeFormatter ISO = DateTimeFormatter.ISO_LOCAL_DATE_TIME;

    private final AppPaths paths;
    private final ObjectMapper mapper;
    private final ReentrantReadWriteLock lock = new ReentrantReadWriteLock();

    public ProfileRepository(AppPaths paths, ObjectMapper mapper) {
        this.paths = paths;
        this.mapper = mapper;
    }

    public List<Profile> list() {
        lock.readLock().lock();
        try {
            List<Profile> storage = readLocked();
            List<Profile> result = new ArrayList<>(storage.size());
            for (Profile profile : storage) {
                result.add(profile.withSessionCount(countSessions(profile.id())));
            }
            return result;
        } finally {
            lock.readLock().unlock();
        }
    }

    public Optional<Profile> find(String profileId) {
        String safeId = safeProfileId(profileId);
        lock.readLock().lock();
        try {
            return readLocked().stream().filter(p -> p.id().equals(safeId)).findFirst();
        } finally {
            lock.readLock().unlock();
        }
    }

    public Profile ensureGuest() {
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            if (!profiles.isEmpty()) {
                return profiles.get(0);
            }
            Profile guest = newProfile("Guest", "guest", true, null);
            paths.ensureProfileDirs(guest.id());
            profiles.add(guest);
            saveLocked(profiles);
            log.info("Created default Guest profile");
            return guest.withSessionCount(0);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public Profile create(String name, boolean isDefault, String avatarUrl) {
        if (name == null || name.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Profile name is required");
        }
        String trimmed = name.trim();
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            for (Profile existing : profiles) {
                if (existing.name().equalsIgnoreCase(trimmed)) {
                    return existing.withSessionCount(countSessions(existing.id()));
                }
            }
            String id = uniqueId(profiles, trimmed);
            Profile created = newProfile(trimmed, id, isDefault, avatarUrl);
            paths.ensureProfileDirs(id);
            profiles.add(created);
            saveLocked(profiles);
            log.info("Created profile: {} (id={})", trimmed, id);
            return created.withSessionCount(0);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public boolean updateName(String profileId, String newName) {
        if (newName == null || newName.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Profile name is required");
        }
        String safeId = safeProfileId(profileId);
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            for (int i = 0; i < profiles.size(); i++) {
                Profile p = profiles.get(i);
                if (p.id().equals(safeId)) {
                    profiles.set(i, p.withName(newName.trim()));
                    saveLocked(profiles);
                    return true;
                }
            }
            return false;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public boolean updateAvatar(String profileId, String avatarUrl) {
        String safeId = safeProfileId(profileId);
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            for (int i = 0; i < profiles.size(); i++) {
                Profile p = profiles.get(i);
                if (p.id().equals(safeId)) {
                    profiles.set(i, p.withAvatar(avatarUrl));
                    saveLocked(profiles);
                    return true;
                }
            }
            return false;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public List<Profile> reorder(List<String> profileIds) {
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            Map<String, Profile> byId = new LinkedHashMap<>();
            for (Profile p : profiles) {
                byId.put(p.id(), p);
            }
            List<Profile> reordered = new ArrayList<>();
            if (profileIds != null) {
                for (String rawId : profileIds) {
                    if (rawId == null) {
                        continue;
                    }
                    Profile p = byId.remove(rawId);
                    if (p != null) {
                        reordered.add(p.withDefault(reordered.isEmpty()));
                    }
                }
            }
            boolean firstRemaining = reordered.isEmpty();
            for (Profile p : byId.values()) {
                reordered.add(p.withDefault(firstRemaining));
                firstRemaining = false;
            }
            saveLocked(reordered);
            List<Profile> result = new ArrayList<>(reordered.size());
            for (Profile p : reordered) {
                result.add(p.withSessionCount(countSessions(p.id())));
            }
            return result;
        } finally {
            lock.writeLock().unlock();
        }
    }

    public void delete(String profileId) {
        String safeId = safeProfileId(profileId);
        if ("guest".equals(safeId)) {
            return;
        }
        lock.writeLock().lock();
        try {
            List<Profile> profiles = readLocked();
            List<Profile> remaining = new ArrayList<>();
            boolean found = false;
            for (Profile p : profiles) {
                if (p.id().equals(safeId)) {
                    found = true;
                } else {
                    remaining.add(p);
                }
            }
            if (!found) {
                return;
            }
            try {
                AtomicFiles.deleteRecursively(paths.profileRoot(safeId));
            } catch (IOException e) {
                throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to delete profile files", e);
            }
            saveLocked(remaining);
            log.info("Deleted profile: {}", safeId);
        } finally {
            lock.writeLock().unlock();
        }
    }

    public void migrateLegacyData() {
        Path legacy = paths.legacyDataDir();
        if (!Files.isDirectory(legacy)) {
            return;
        }
        Path guestData = paths.profileDataDir("guest");
        try {
            paths.ensureProfileDirs("guest");
            long existing;
            try (var stream = Files.list(guestData)) {
                existing = stream.filter(Files::isRegularFile)
                        .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".duckdb"))
                        .count();
            }
            if (existing > 0) {
                return;
            }
            try (var stream = Files.list(legacy)) {
                List<Path> files = stream
                        .filter(Files::isRegularFile)
                        .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".duckdb"))
                        .toList();
                for (Path file : files) {
                    AtomicFiles.copy(file, guestData.resolve(file.getFileName().toString()));
                    log.info("Migrated legacy session: {}", file.getFileName());
                }
            }
        } catch (IOException e) {
            log.warn("Legacy data migration failed", e);
        }
    }

    private Profile newProfile(String name, String id, boolean isDefault, String avatarUrl) {
        String now = LocalDateTime.now().format(ISO);
        return new Profile(id, name, now, now, isDefault, avatarUrl, null);
    }

    private String uniqueId(List<Profile> profiles, String name) {
        String base = name.toLowerCase(Locale.ROOT).replace(" ", "_");
        base = base.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (base.isBlank()) {
            base = "user_" + profiles.size();
        }
        String candidate = base;
        int suffix = 2;
        while (idExists(profiles, candidate)) {
            candidate = base + "_" + suffix;
            suffix++;
        }
        return candidate;
    }

    private boolean idExists(List<Profile> profiles, String id) {
        return profiles.stream().anyMatch(p -> p.id().equals(id));
    }

    private int countSessions(String profileId) {
        Path dir = paths.profileDataDir(profileId);
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        try (var stream = Files.list(dir)) {
            long count = stream.filter(Files::isRegularFile)
                    .filter(p -> p.getFileName().toString().toLowerCase(Locale.ROOT).endsWith(".duckdb"))
                    .count();
            return (int) Math.min(Integer.MAX_VALUE, count);
        } catch (IOException e) {
            return 0;
        }
    }

    private List<Profile> readLocked() {
        Path file = paths.profilesFile();
        if (!Files.isRegularFile(file)) {
            return new ArrayList<>();
        }
        try {
            List<Profile> profiles = mapper.readValue(file.toFile(), new TypeReference<List<Profile>>() {
            });
            if (profiles == null) {
                return new ArrayList<>();
            }
            return new ArrayList<>(profiles);
        } catch (Exception e) {
            log.error("Failed to read profiles.json; returning empty list", e);
            return new ArrayList<>();
        }
    }

    private void saveLocked(List<Profile> profiles) {
        List<Profile> storage = profiles.stream().map(Profile::withoutSessionCount).toList();
        try {
            String json = mapper.writerWithDefaultPrettyPrinter().writeValueAsString(storage);
            AtomicFiles.writeString(paths.profilesFile(), json);
        } catch (Exception e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to save profiles.json", e);
        }
    }

    private String safeProfileId(String profileId) {
        String safe = PathSafety.safeFileName(profileId);
        if (".".equals(safe) || "..".equals(safe) || safe.contains("/") || safe.contains("\\")) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid profile id");
        }
        return safe;
    }
}
