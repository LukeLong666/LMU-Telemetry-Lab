package com.lmutl.api;

import com.lmutl.config.AppProperties;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.LinkedHashMap;
import java.util.Map;

@RestController
public class HealthController {

    private final AppProperties properties;

    public HealthController(AppProperties properties) {
        this.properties = properties;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("service", "antigravity-backend");
        body.put("version", properties.getVersion());
        return body;
    }

    /**
     * The Python backend has a stale 1.4.3 version string on this endpoint.
     * Keep it for a byte-compatible contract; the root /health endpoint reports
     * the real build version.
     */
    @GetMapping("/api/v1/health")
    public Map<String, Object> apiHealth() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "ok");
        body.put("service", "antigravity-backend");
        body.put("version", "1.4.3");
        return body;
    }

    @GetMapping("/api/v1/ping")
    public Map<String, Object> ping() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "pong");
        body.put("message", "API is reachable");
        return body;
    }
}
