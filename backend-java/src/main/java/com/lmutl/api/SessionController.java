package com.lmutl.api;

import com.lmutl.api.dto.SessionDtos;
import com.lmutl.application.SessionService;
import com.lmutl.domain.SessionInfo;
import com.lmutl.infra.fs.SessionRepository;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sessions")
public class SessionController {

    private final SessionService service;

    public SessionController(SessionService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list(@RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        List<SessionInfo> sessions = service.list(profileId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("sessions", sessions);
        return body;
    }

    @PostMapping("/upload")
    public Map<String, Object> upload(
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId,
            @RequestPart("file") MultipartFile file) {
        SessionRepository.UploadedSession uploaded = service.upload(profileId, file);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", uploaded.id());
        body.put("status", "uploaded");
        body.put("size", uploaded.size());
        return body;
    }

    @PostMapping("/{sessionId}/rename")
    public Map<String, Object> rename(
            @PathVariable String sessionId,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId,
            @RequestBody SessionDtos.RenameRequest request) {
        String newName = service.rename(profileId, sessionId, request == null ? null : request.newName());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", newName);
        body.put("old_id", sessionId);
        body.put("status", "renamed");
        return body;
    }

    @DeleteMapping("/{sessionId}")
    public Map<String, Object> delete(
            @PathVariable String sessionId,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        service.delete(profileId, sessionId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("id", sessionId);
        body.put("status", "deleted");
        return body;
    }
}
