package com.lmutl.api;

import com.lmutl.application.SetupService;
import com.lmutl.application.SvmExporter;
import com.lmutl.infra.car.CarCatalog;
import com.lmutl.infra.fs.PathSafety;
import com.lmutl.infra.fs.SessionRepository;
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
import java.nio.file.Path;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/sessions")
public class SetupController {

    private final SetupService setupService;
    private final SvmExporter svmExporter;
    private final CarCatalog carCatalog;
    private final SessionRepository sessionRepository;

    public SetupController(SetupService setupService,
                           SvmExporter svmExporter,
                           CarCatalog carCatalog,
                           SessionRepository sessionRepository) {
        this.setupService = setupService;
        this.svmExporter = svmExporter;
        this.carCatalog = carCatalog;
        this.sessionRepository = sessionRepository;
    }

    @GetMapping("/{sessionId}/setup")
    public Map<String, Object> setup(
            @PathVariable String sessionId,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        return setupService.getSetup(profileId, sessionId);
    }

    @GetMapping("/{sessionId}/setup/export")
    public ResponseEntity<String> exportSetup(
            @PathVariable String sessionId,
            @RequestParam(name = "custom_car_model", required = false) String customCarModel,
            @RequestParam(name = "profile_id", defaultValue = "guest") String profileId) {
        Path database = sessionRepository.resolve(profileId, sessionId);
        String content = svmExporter.generate(database);
        Map<String, String> metadata = setupService.readMetadata(database);

        String layoutName = metadata.getOrDefault("TrackLayout", "Layout").replace(" ", "-")
                .replaceAll("[\\\\/*?:\"<>|]", "");
        String rawCar = metadata.getOrDefault("CarName", "");
        String rawClass = metadata.getOrDefault("CarClass", "");
        String carModel = customCarModel != null && !customCarModel.isBlank()
                ? customCarModel
                : carCatalog.getCarInfo(rawCar, rawClass).modelName();
        carModel = carModel.replace(" ", "-");
        String recordingTime = metadata.getOrDefault("RecordingTime", PathSafety.stripDuckDb(sessionId));
        String filename = layoutName + "_" + carModel + "_" + recordingTime + "_setup.svm";

        ContentDisposition disposition = ContentDisposition.attachment()
                .filename(filename, StandardCharsets.UTF_8)
                .build();
        return ResponseEntity.ok()
                .contentType(new MediaType("text", "plain", StandardCharsets.UTF_8))
                .header(HttpHeaders.CONTENT_DISPOSITION, disposition.toString())
                .body(content);
    }
}
