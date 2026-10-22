package com.lmutl.application;

import com.lmutl.api.error.ApiException;
import com.lmutl.domain.Profile;
import com.lmutl.infra.fs.AppPaths;
import com.lmutl.infra.fs.AtomicFiles;
import com.lmutl.infra.fs.PathSafety;
import com.lmutl.infra.fs.ProfileRepository;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

import java.io.IOException;
import java.nio.file.Path;
import java.util.List;
import java.util.Locale;
import java.util.Set;

@Service
public class ProfileService {

    private static final Logger log = LoggerFactory.getLogger(ProfileService.class);
    private static final long MAX_AVATAR_BYTES = 10L * 1024 * 1024;
    private static final Set<String> ALLOWED_AVATAR_EXTENSIONS = Set.of(".png", ".jpg", ".jpeg", ".webp");

    private final ProfileRepository repository;
    private final AppPaths paths;

    public ProfileService(ProfileRepository repository, AppPaths paths) {
        this.repository = repository;
        this.paths = paths;
    }

    @PostConstruct
    public void init() {
        repository.ensureGuest();
        repository.migrateLegacyData();
    }

    public List<Profile> list() {
        List<Profile> profiles = repository.list();
        if (profiles.isEmpty()) {
            repository.ensureGuest();
            profiles = repository.list();
        }
        return profiles;
    }

    public Profile create(String name) {
        return repository.create(name, false, null);
    }

    public List<Profile> reorder(List<String> profileIds) {
        return repository.reorder(profileIds);
    }

    public void delete(String profileId) {
        repository.delete(profileId);
    }

    public void update(String profileId, String name) {
        if (!repository.updateName(profileId, name)) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Profile not found");
        }
    }

    public String uploadAvatar(String profileId, MultipartFile file) {
        Profile profile = repository.find(profileId)
                .orElseThrow(() -> new ApiException(HttpStatus.NOT_FOUND, "Profile not found"));
        if (file == null || file.isEmpty()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Avatar file is required");
        }
        if (file.getSize() > MAX_AVATAR_BYTES) {
            throw new ApiException(HttpStatus.PAYLOAD_TOO_LARGE, "Avatar file too large");
        }
        String original = file.getOriginalFilename();
        String safeName = PathSafety.safeFileName(original == null ? "avatar" : original);
        String extension = extensionOf(safeName);
        if (!ALLOWED_AVATAR_EXTENSIONS.contains(extension)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Unsupported avatar file type");
        }

        String timestamp = Long.toString(System.currentTimeMillis() / 1000L);
        String filename = "avatar_" + timestamp + extension;
        Path dir = paths.profileAvatarDir(profile.id());
        Path target = dir.resolve(filename).normalize();
        if (!target.startsWith(dir.normalize())) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid avatar path");
        }
        try {
            AtomicFiles.copy(file.getInputStream(), target);
        } catch (IOException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to save avatar", e);
        }

        String avatarUrl = "/api/v1/profile-data/Data/" + profile.id() + "/avatars/" + filename;
        if (!repository.updateAvatar(profile.id(), avatarUrl)) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Profile not found");
        }
        log.info("Updated avatar for profile {}: {}", profile.id(), filename);
        return avatarUrl;
    }

    private static String extensionOf(String filename) {
        int dot = filename.lastIndexOf('.');
        if (dot < 0) {
            return "";
        }
        return filename.substring(dot).toLowerCase(Locale.ROOT);
    }
}
