package com.lmutl.infra.fs;

import com.lmutl.api.error.ApiException;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PathSafetyTest {

    @TempDir
    Path root;

    @Test
    void resolvesRelativePathUnderRoot() {
        Path resolved = PathSafety.resolveUnder(root, "session.duckdb");
        assertThat(resolved.getParent()).isEqualTo(root.toAbsolutePath().normalize());
    }

    @Test
    void rejectsTraversalAndAbsolutePaths() {
        assertThatThrownBy(() -> PathSafety.resolveUnder(root, "..\\outside.duckdb"))
                .isInstanceOf(ApiException.class);
        assertThatThrownBy(() -> PathSafety.resolveUnder(root, "C:\\Windows\\evil.duckdb"))
                .isInstanceOf(ApiException.class);
    }

    @Test
    void sanitizesFileNames() {
        assertThat(PathSafety.safeFileName("..\\evil.duckdb")).isEqualTo("evil.duckdb");
        assertThat(PathSafety.isDuckDb("SESSION.DUCKDB")).isTrue();
        assertThat(PathSafety.stripDuckDb("session.duckdb")).isEqualTo("session");
    }
}
