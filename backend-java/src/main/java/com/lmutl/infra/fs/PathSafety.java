package com.lmutl.infra.fs;

import com.lmutl.api.error.ApiException;
import org.springframework.http.HttpStatus;

import java.nio.file.Path;

public final class PathSafety {

    private PathSafety() {
    }

    public static Path resolveUnder(Path root, String child) {
        if (child == null || child.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Path is required");
        }
        String trimmed = child.trim();
        if (trimmed.indexOf('\0') >= 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid path");
        }
        Path relative = Path.of(trimmed);
        if (relative.isAbsolute()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Absolute paths are not allowed here");
        }
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Path candidate = normalizedRoot.resolve(relative).normalize();
        if (!candidate.startsWith(normalizedRoot) || candidate.equals(normalizedRoot)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Path escapes the data directory");
        }
        return candidate;
    }

    public static String safeFileName(String name) {
        if (name == null || name.isBlank()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "File name is required");
        }
        String trimmed = name.trim();
        if (trimmed.indexOf('\0') >= 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }
        Path fileName = Path.of(trimmed).getFileName();
        if (fileName == null) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }
        String value = fileName.toString();
        if (value.isBlank() || ".".equals(value) || "..".equals(value)) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "Invalid file name");
        }
        return value;
    }

    public static boolean isDuckDb(String fileName) {
        return fileName != null && fileName.toLowerCase().endsWith(".duckdb");
    }

    public static String stripDuckDb(String fileName) {
        if (fileName == null) {
            return "";
        }
        String lower = fileName.toLowerCase();
        if (lower.endsWith(".duckdb")) {
            return fileName.substring(0, fileName.length() - ".duckdb".length());
        }
        return fileName;
    }
}
