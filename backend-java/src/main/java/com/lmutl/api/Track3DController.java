package com.lmutl.api;

import com.lmutl.api.error.ApiException;
import com.lmutl.application.Track3DService;
import com.lmutl.domain.Track3DResponse;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/sessions")
public class Track3DController {

    private final Track3DService service;

    public Track3DController(Track3DService service) {
        this.service = service;
    }

    @GetMapping("/{sessionId}/3d-track")
    public Track3DResponse track(
            @PathVariable String sessionId,
            @RequestParam(name = "lap") int lap,
            @RequestParam(name = "stint", required = false) Integer stint,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        if (lap < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "lap must be >= 0");
        }
        return service.build(profileId, sessionId, lap, stint);
    }
}
