package com.lmutl.application;

import com.lmutl.domain.LapInfo;
import com.lmutl.domain.LapsResponse;
import com.lmutl.domain.ReferenceLap;
import com.lmutl.infra.fs.PathSafety;
import com.lmutl.infra.fs.SessionRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

@Service
public class ReferenceLapService {

    private static final Logger log = LoggerFactory.getLogger(ReferenceLapService.class);

    private final SessionRepository repository;
    private final LapService lapService;

    public ReferenceLapService(SessionRepository repository, LapService lapService) {
        this.repository = repository;
        this.lapService = lapService;
    }

    public List<ReferenceLap> find(String profileId, String trackName, String trackLayout, String carClass) {
        String profile = profileId == null || profileId.isBlank() ? "guest" : profileId;
        String wantedTrack = trackName == null ? "" : trackName.trim();
        String wantedLayout = trackLayout == null ? "" : trackLayout.trim();
        String wantedClass = carClass == null ? "" : carClass.trim();

        List<ReferenceLap> result = new ArrayList<>();
        for (Path file : repository.listFiles(profile)) {
            try {
                LapsResponse header = lapService.header(file);
                String dbTrack = header.metadata().trackName() == null ? "" : header.metadata().trackName().trim();
                String dbLayout = header.metadata().trackLayout() == null ? "" : header.metadata().trackLayout().trim();
                String dbClass = header.metadata().carClass() == null ? "" : header.metadata().carClass().trim();

                boolean trackMatches = dbTrack.equals(wantedTrack);
                boolean layoutMatches = dbLayout.equals(wantedLayout)
                        || (wantedLayout.isEmpty() && (dbLayout.isEmpty() || dbLayout.equals(dbTrack)));
                boolean classMatches = dbClass.equals(wantedClass);
                if (!trackMatches || !layoutMatches || !classMatches) {
                    continue;
                }

                String sessionId = file.getFileName().toString();
                String sessionName = PathSafety.stripDuckDb(sessionId);
                double date = lastModifiedSeconds(file);
                int totalLaps = header.laps().size();
                int stintCount = header.laps().stream().mapToInt(LapInfo::stint).max().orElse(0);

                for (LapInfo lap : header.laps()) {
                    result.add(new ReferenceLap(
                            sessionId,
                            sessionName,
                            date,
                            lap.lap(),
                            lap.stint(),
                            lap.startTime(),
                            lap.endTime(),
                            lap.duration(),
                            lap.isValid(),
                            lap.s1(),
                            lap.s2(),
                            lap.s3(),
                            header.metadata().driverName(),
                            header.metadata().sessionTime(),
                            header.metadata().modelName(),
                            header.metadata().rawCarName(),
                            totalLaps,
                            stintCount,
                            lap.fuelUsed()
                    ));
                }
            } catch (Exception e) {
                log.warn("Failed to scan reference laps in {}: {}", file.getFileName(), e.getMessage());
            }
        }

        result.sort(Comparator.comparingDouble(ReferenceLap::date)
                .thenComparingInt(ReferenceLap::lap)
                .reversed());
        return result;
    }

    private static double lastModifiedSeconds(Path file) {
        try {
            return Files.getLastModifiedTime(file).toMillis() / 1000.0;
        } catch (IOException e) {
            return 0.0;
        }
    }
}
