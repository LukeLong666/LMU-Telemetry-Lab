package com.lmutl.api;

import com.lmutl.application.LapExportService;
import org.springframework.core.io.FileSystemResource;
import org.springframework.core.io.Resource;
import org.springframework.http.ContentDisposition;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.charset.StandardCharsets;

@RestController
@RequestMapping("/api/v1/sessions")
public class ExportController {

    private final LapExportService exportService;

    public ExportController(LapExportService exportService) {
        this.exportService = exportService;
    }

    @GetMapping("/{sessionId}/export/lap/{lapNumber}")
    public ResponseEntity<Resource> exportLap(
            @PathVariable String sessionId,
            @PathVariable int lapNumber,
            @RequestParam(name = "custom_car_model", required = false) String customCarModel,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        LapExportService.ExportResult result = exportService.export(profileId, sessionId, lapNumber, customCarModel);
        Resource resource = new FileSystemResource(result.path());
        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(result.filename(), StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .contentType(MediaType.APPLICATION_OCTET_STREAM)
                .contentLength(result.path().toFile().length())
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .body(resource);
    }
}
