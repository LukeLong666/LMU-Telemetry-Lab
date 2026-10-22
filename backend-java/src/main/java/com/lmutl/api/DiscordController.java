package com.lmutl.api;

import com.lmutl.api.dto.DiscordDtos;
import com.lmutl.application.DiscordService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class DiscordController {

    private final DiscordService service;

    public DiscordController(DiscordService service) {
        this.service = service;
    }

    @GetMapping("/discord/config")
    public Map<String, Object> config() {
        return service.config();
    }

    @GetMapping("/discord/shares")
    public Map<String, Object> shares(@RequestParam(name = "car_class") String carClass) {
        return service.shares(carClass);
    }

    @PostMapping("/discord/shares/download")
    public Map<String, Object> download(@RequestBody DiscordDtos.DownloadRequest request) {
        return service.download(request);
    }

    @PostMapping("/sessions/{sessionId}/discord/share")
    public Map<String, Object> share(
            @PathVariable String sessionId,
            @RequestParam(name = "profile_id", required = false) String profileId,
            @RequestBody DiscordDtos.ShareRequest request) {
        String profile = profileId != null ? profileId : request.profileId();
        return service.share(profile, sessionId, request);
    }
}
