package com.lmutl.api;

import com.lmutl.api.error.ApiException;
import com.lmutl.infra.fs.AppPaths;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.MediaTypeFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Explicit frontend resource controller. Spring's PathPattern resource handler
 * only resolved root-level files on this setup, so nested assets are served here.
 */
@Controller
public class FrontendResourceController {

    private final AppPaths paths;

    public FrontendResourceController(AppPaths paths) {
        this.paths = paths;
    }

    @GetMapping({"/assets/**", "/country_flag/**", "/logos/**", "/steering wheel/**", "/{file:.+}"})
    public ResponseEntity<Resource> frontend(HttpServletRequest request) {
        String uri = request.getRequestURI();
        if (uri == null || uri.equals("/")) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Not Found");
        }
        String decoded = URLDecoder.decode(uri, StandardCharsets.UTF_8);
        String relative = decoded.startsWith("/") ? decoded.substring(1) : decoded;
        Path root = paths.frontendDir().toAbsolutePath().normalize();
        Path file = root.resolve(relative).normalize();
        if (!file.startsWith(root) || !Files.isRegularFile(file)) {
            throw new ApiException(HttpStatus.NOT_FOUND, "Not Found");
        }
        Resource resource = new FileSystemResource(file);
        MediaType mediaType = MediaTypeFactory.getMediaType(resource)
                .orElse(MediaType.APPLICATION_OCTET_STREAM);
        return ResponseEntity.ok().contentType(mediaType).body(resource);
    }
}
