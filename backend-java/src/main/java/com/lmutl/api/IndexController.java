package com.lmutl.api;

import com.lmutl.api.error.ApiException;
import com.lmutl.infra.fs.AppPaths;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

import java.nio.file.Files;
import java.nio.file.Path;

@Controller
public class IndexController {

    private final AppPaths paths;

    public IndexController(AppPaths paths) {
        this.paths = paths;
    }

    @GetMapping({"/", "/index.html"})
    public ResponseEntity<Resource> index() {
        Path index = paths.frontendDir().resolve("index.html");
        if (!Files.isRegularFile(index)) {
            throw new ApiException(HttpStatus.NOT_FOUND,
                    "Frontend build not found; run the Vite dev server or build frontend/dist");
        }
        return ResponseEntity.ok()
                .contentType(MediaType.TEXT_HTML)
                .body(new FileSystemResource(index));
    }
}
