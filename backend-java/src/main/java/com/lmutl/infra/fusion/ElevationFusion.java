package com.lmutl.infra.fusion;

import com.lmutl.domain.TrackDefinition;
import com.lmutl.infra.track.LayoutMatcher;
import com.lmutl.infra.track.TrackMatcher;
import com.lmutl.infra.track.TrackRegistry;

import java.util.Arrays;

public final class ElevationFusion {

    private ElevationFusion() {
    }

    public static double[] computeZ(double[] lat,
                                    double[] lon,
                                    double[] distance,
                                    String trackName,
                                    String trackLayout,
                                    TrackRegistry registry) {
        int size = lat == null ? 0 : lat.length;
        if (size == 0 || distance == null || distance.length == 0) {
            return new double[size];
        }
        TrackMatcher.Match trackMatch = registry.findTrack(trackName);
        if (trackMatch == null) {
            return new double[size];
        }
        TrackDefinition track = trackMatch.definition();
        LayoutMatcher.Match layoutMatch = registry.findLayout(track, trackLayout, trackMatch.key());
        if (layoutMatch == null || layoutMatch.layout().refPoints().isEmpty()) {
            return new double[size];
        }
        TrackDefinition.TrackLayout layout = layoutMatch.layout();
        double[] xp = new double[layout.refPoints().size()];
        double[] fp = new double[layout.refPoints().size()];
        for (int i = 0; i < xp.length; i++) {
            xp[i] = layout.refPoints().get(i).dist();
            fp[i] = layout.refPoints().get(i).alt();
        }

        double[] cleaned = new double[size];
        for (int i = 0; i < size; i++) {
            cleaned[i] = Double.isNaN(distance[i]) ? 0.0 : distance[i];
        }
        double[] cd = FusionMath.uniqueFirst(cleaned);
        if (cd.length < 2) {
            return new double[size];
        }
        double[] telD = new double[cd.length];
        for (int i = 0; i < cd.length; i++) {
            telD[i] = cd[i] - cd[0];
        }
        double maxTelD = Arrays.stream(telD).max().orElse(0.0);
        if (!(maxTelD > 1.0)) {
            return new double[size];
        }
        double refMax = xp[xp.length - 1];
        double[] zRaw = new double[cd.length];
        for (int i = 0; i < cd.length; i++) {
            double normalized = (telD[i] / maxTelD) * refMax;
            zRaw[i] = FusionMath.interp(xp, fp, Math.max(0.0, Math.min(refMax, normalized)));
        }
        double offset = fp[0] - zRaw[0];
        double error = fp[fp.length - 1] - zRaw[zRaw.length - 1];
        double[] zCorrected = new double[zRaw.length];
        for (int i = 0; i < zRaw.length; i++) {
            double fraction = zRaw.length == 1 ? 0.0 : (double) i / (zRaw.length - 1);
            zCorrected[i] = zRaw[i] + offset + (error - offset) * fraction;
        }

        double[] zFull = new double[size];
        for (int i = 0; i < size; i++) {
            zFull[i] = FusionMath.interp(cd, zCorrected, cleaned[i]);
        }

        int window = Math.min(40, size);
        double[] smoothed;
        if (window > 1) {
            int pad = window / 2;
            double[] padded = new double[size + pad * 2];
            for (int i = 0; i < padded.length; i++) {
                int source = Math.max(0, Math.min(size - 1, i - pad));
                padded[i] = zFull[source];
            }
            smoothed = new double[size];
            for (int i = 0; i < size; i++) {
                double sum = 0.0;
                for (int j = 0; j < window; j++) {
                    sum += padded[i + j];
                }
                smoothed[i] = sum / window;
            }
        } else {
            smoothed = zFull;
        }

        return spikeFilter(smoothed);
    }

    private static double[] spikeFilter(double[] z) {
        double[] safe = z.clone();
        int n = safe.length;
        if (n > 2) {
            if (safe[0] < safe[1] - 5.0) {
                safe[0] = safe[1];
            }
            for (int i = 1; i < n - 1; i++) {
                double average = (safe[i - 1] + safe[i + 1]) / 2.0;
                if (safe[i] < average - 5.0) {
                    safe[i] = average;
                }
            }
            if (safe[n - 1] < safe[n - 2] - 5.0) {
                safe[n - 1] = safe[n - 2];
            }
        }
        return safe;
    }
}
