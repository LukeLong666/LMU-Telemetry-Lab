package com.lmutl.api;

import com.lmutl.application.LapService;
import com.lmutl.application.ReferenceLapService;
import com.lmutl.application.SessionService;
import com.lmutl.domain.LapsResponse;
import com.lmutl.domain.ReferenceLap;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class LapController {

    private final SessionService sessionService;
    private final LapService lapService;
    private final ReferenceLapService referenceLapService;

    public LapController(SessionService sessionService,
                         LapService lapService,
                         ReferenceLapService referenceLapService) {
        this.sessionService = sessionService;
        this.lapService = lapService;
        this.referenceLapService = referenceLapService;
    }

    @GetMapping("/sessions/{sessionId}/laps")
    public LapsResponse laps(
            @PathVariable String sessionId,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        Path database = sessionService.resolve(profileId, sessionId);
        return lapService.header(database);
    }

    @GetMapping("/reference-laps")
    public Map<String, Object> referenceLaps(
            @RequestParam(name = "track_name") String trackName,
            @RequestParam(name = "track_layout", defaultValue = "") String trackLayout,
            @RequestParam(name = "car_class") String carClass,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        List<ReferenceLap> laps = referenceLapService.find(profileId, trackName, trackLayout, carClass);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("laps", laps);
        return body;
    }
}
