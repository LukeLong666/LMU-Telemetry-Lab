package com.lmutl.api;

import com.lmutl.api.dto.ProfileDtos;
import com.lmutl.application.ProfileService;
import com.lmutl.domain.Profile;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/profiles")
public class ProfileController {

    private final ProfileService service;

    public ProfileController(ProfileService service) {
        this.service = service;
    }

    @GetMapping
    public Map<String, Object> list() {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("profiles", service.list());
        return body;
    }

    @PostMapping
    public Profile create(@RequestBody ProfileDtos.CreateRequest request) {
        return service.create(request == null ? null : request.name());
    }

    @PostMapping("/reorder")
    public Map<String, Object> reorder(@RequestBody ProfileDtos.ReorderRequest request) {
        List<String> ids = request == null ? List.of() : request.profileIds();
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("profiles", service.reorder(ids));
        return body;
    }

    @DeleteMapping("/{profileId}")
    public Map<String, Object> delete(@PathVariable String profileId) {
        service.delete(profileId);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "success");
        return body;
    }

    @PutMapping("/{profileId}")
    public Map<String, Object> update(@PathVariable String profileId,
                                      @RequestBody ProfileDtos.UpdateRequest request) {
        service.update(profileId, request == null ? null : request.name());
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("status", "success");
        return body;
    }

    @PostMapping(value = "/{profileId}/avatar", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public Map<String, Object> uploadAvatar(@PathVariable String profileId,
                                            @RequestPart("file") MultipartFile file) {
        String avatarUrl = service.uploadAvatar(profileId, file);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("avatar_url", avatarUrl);
        return body;
    }
}
