package com.lmutl.api;

import com.lmutl.api.dto.SystemDtos;
import com.lmutl.application.SystemService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class SystemController {

    private final SystemService service;

    public SystemController(SystemService service) {
        this.service = service;
    }

    @GetMapping("/system/validate-path")
    public Map<String, Object> validatePath(@RequestParam("path") String path) {
        return service.validatePath(path);
    }

    @PostMapping("/system/open-path")
    public Map<String, Object> openPath(@RequestBody SystemDtos.OpenPathRequest request) {
        return service.openPath(request == null ? null : request.path());
    }

    @PostMapping("/system/import-paths")
    public Map<String, Object> importPaths(@RequestBody SystemDtos.ImportPathsRequest request) {
        if (request == null) {
            throw new com.lmutl.api.error.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST,
                    "Request body is required");
        }
        return service.importPaths(request.paths(), request.profileId());
    }

    @PostMapping("/system/pick-and-upload")
    public Map<String, Object> pickAndUpload(
            @RequestBody(required = false) SystemDtos.OpenPathRequest request,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        return service.pickAndUpload(request, profileId);
    }

    @GetMapping("/steering-wheels")
    public Map<String, Object> steeringWheels() {
        return service.steeringWheels();
    }
}
