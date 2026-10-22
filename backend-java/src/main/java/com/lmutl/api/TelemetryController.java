package com.lmutl.api;

import com.lmutl.api.error.ApiException;
import com.lmutl.application.TelemetryService;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;

@RestController
@RequestMapping("/api/v1/sessions")
public class TelemetryController {

    private final TelemetryService service;

    public TelemetryController(TelemetryService service) {
        this.service = service;
    }

    @GetMapping("/{sessionId}/telemetry")
    public void telemetry(
            @PathVariable String sessionId,
            @RequestParam(name = "freq", defaultValue = "60") int frequency,
            @RequestParam(name = "stint_id", required = false) Integer stintId,
            @RequestParam(name = "lap_id", required = false) Integer lapId,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId,
            HttpServletResponse response) throws IOException {
        if (frequency < 1 || frequency > 1000) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "freq must be between 1 and 1000");
        }
        TelemetryService.Result result = service.load(profileId, sessionId, frequency, stintId, lapId);
        response.setStatus(HttpStatus.OK.value());
        response.setContentType("application/json");
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        TelemetryJsonWriter.write(response.getOutputStream(), result.frame(), result.suspensionBaselines());
    }
}
