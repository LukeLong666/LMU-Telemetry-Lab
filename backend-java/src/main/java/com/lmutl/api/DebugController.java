package com.lmutl.api;

import com.lmutl.infra.fs.AppPaths;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.file.Files;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/debug")
public class DebugController {

    private final AppPaths paths;

    public DebugController(AppPaths paths) {
        this.paths = paths;
    }

    @GetMapping("/env")
    public Map<String, Object> env() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("is_frozen", false);
        body.put("sys_executable", ProcessHandle.current().info().command().orElse("java"));
        body.put("os_getcwd", System.getProperty("user.dir", "."));
        body.put("APP_DATA_ROOT", paths.dataRoot().toString());
        body.put("APP_DATA_ROOT_exists", Files.isDirectory(paths.dataRoot()));
        body.put("files_in_data", listData());
        body.put("env_duckdb_data_dir", System.getenv("DUCKDB_DATA_DIR"));
        return body;
    }

    private List<String> listData() {
        if (!Files.isDirectory(paths.dataRoot())) {
            return List.of();
        }
        try (var stream = Files.list(paths.dataRoot())) {
            return stream.map(path -> path.getFileName().toString()).sorted().toList();
        } catch (IOException e) {
            return List.of();
        }
    }
}
