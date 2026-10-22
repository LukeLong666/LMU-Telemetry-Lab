package com.lmutl.application;

import com.lmutl.api.dto.SystemDtos;
import com.lmutl.api.error.ApiException;
import com.lmutl.infra.fs.SessionRepository;
import com.lmutl.infra.system.FilePicker;
import com.lmutl.infra.system.SteeringWheelScanner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Service
public class SystemService {

    private static final Logger log = LoggerFactory.getLogger(SystemService.class);

    private final SessionRepository sessions;
    private final FilePicker filePicker;
    private final SteeringWheelScanner steeringWheels;

    public SystemService(SessionRepository sessions,
                         FilePicker filePicker,
                         SteeringWheelScanner steeringWheels) {
        this.sessions = sessions;
        this.filePicker = filePicker;
        this.steeringWheels = steeringWheels;
    }

    public Map<String, Object> validatePath(String rawPath) {
        boolean exists = false;
        if (rawPath != null && !rawPath.isBlank()) {
            exists = Files.exists(Path.of(rawPath).normalize());
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("exists", exists);
        return body;
    }

    public Map<String, Object> openPath(String rawPath) {
        if (rawPath == null || rawPath.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Path is required");
        }
        Path path = Path.of(rawPath).normalize();
        Map<String, Object> body = new LinkedHashMap<>();
        if (Files.exists(path)) {
            openInFileManager(path);
            body.put("status", "success");
            body.put("message", "Opening " + path);
            return body;
        }
        Path parent = path.getParent();
        if (parent != null && Files.exists(parent)) {
            openInFileManager(parent);
            body.put("status", "partial");
            body.put("message", "Path not found, opening parent: " + parent);
            return body;
        }
        throw new ApiException(HttpStatus.NOT_FOUND, "Path not found");
    }

    public Map<String, Object> importPaths(List<String> paths, String profileId) {
        List<String> imported = sessions.importPaths(normalizeProfile(profileId), paths);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "success");
        body.put("id", imported.get(imported.size() - 1));
        body.put("ids", imported);
        body.put("message", "Imported " + imported.size() + " file(s)");
        return body;
    }

    public Map<String, Object> pickAndUpload(SystemDtos.OpenPathRequest request, String profileId) {
        List<Path> selected;
        try {
            selected = filePicker.pick(request);
        } catch (IllegalStateException e) {
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, e.getMessage(), e);
        }
        if (selected.isEmpty()) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("status", "cancelled");
            return body;
        }
        return importPaths(selected.stream().map(Path::toString).toList(), profileId);
    }

    public Map<String, Object> steeringWheels() {
        return steeringWheels.scan();
    }

    private void openInFileManager(Path path) {
        String os = System.getProperty("os.name", "").toLowerCase(Locale.ROOT);
        try {
            ProcessBuilder builder;
            if (os.contains("win")) {
                builder = new ProcessBuilder("explorer.exe", path.toString());
            } else if (os.contains("mac")) {
                builder = new ProcessBuilder("open", path.toString());
            } else {
                builder = new ProcessBuilder("xdg-open", path.toString());
            }
            builder.start();
        } catch (IOException e) {
            log.error("Failed to open path {}", path, e);
            throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "Failed to open path: " + e.getMessage(), e);
        }
    }

    private String normalizeProfile(String profileId) {
        return profileId == null || profileId.isBlank() ? "guest" : profileId;
    }
}
