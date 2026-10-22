package com.lmutl.infra.fusion;

import java.util.Arrays;

public final class FusionMath {

    private FusionMath() {
    }

    public static double[] masterTimeline(double start, double end, int frequency) {
        double dt = 1.0 / frequency;
        // Match numpy.arange(start, end + dt, dt): the count is ceil(ratio) + 1.
        int count = (int) Math.ceil((end - start) / dt) + 1;
        double[] result = new double[Math.max(1, count)];
        for (int i = 0; i < result.length; i++) {
            // numpy's arange+round lands on the upper millisecond for exact .0005
            // boundaries; the tiny epsilon matches the Python oracle at 10/100 Hz.
            result[i] = Math.floor((start + i * dt) * 1000.0 + 0.5 + 1e-9) / 1000.0;
        }
        return result;
    }

    public static int lowerBound(double[] values, double target) {
        int low = 0;
        int high = values.length;
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (values[mid] < target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    public static int upperBound(double[] values, double target) {
        int low = 0;
        int high = values.length;
        while (low < high) {
            int mid = (low + high) >>> 1;
            if (values[mid] <= target) {
                low = mid + 1;
            } else {
                high = mid;
            }
        }
        return low;
    }

    public static double interp(double[] xp, double[] fp, double x) {
        if (xp.length == 0 || fp.length == 0) {
            return Double.NaN;
        }
        if (x <= xp[0]) {
            return fp[0];
        }
        if (x >= xp[xp.length - 1]) {
            return fp[fp.length - 1];
        }
        int index = lowerBound(xp, x);
        if (index <= 0) {
            return fp[0];
        }
        if (xp[index] == x) {
            return fp[index];
        }
        double x0 = xp[index - 1];
        double x1 = xp[index];
        if (x1 == x0) {
            return fp[index];
        }
        double ratio = (x - x0) / (x1 - x0);
        return fp[index - 1] + ratio * (fp[index] - fp[index - 1]);
    }

    public static double[] mapIndicesToTimes(double[] gpsTimes, int sampleCount) {
        if (sampleCount == 0 || gpsTimes.length == 0) {
            return new double[0];
        }
        double[] times = new double[sampleCount];
        if (sampleCount == 1 || gpsTimes.length == 1) {
            Arrays.fill(times, gpsTimes[0]);
            return times;
        }
        double step = (double) (gpsTimes.length - 1) / (sampleCount - 1);
        for (int i = 0; i < sampleCount; i++) {
            double position = i * step;
            int index = (int) Math.floor(position);
            if (index >= gpsTimes.length - 1) {
                times[i] = gpsTimes[gpsTimes.length - 1];
            } else {
                double fraction = position - index;
                times[i] = gpsTimes[index] + fraction * (gpsTimes[index + 1] - gpsTimes[index]);
            }
        }
        return times;
    }

    public static double[] uniqueFirst(double[] values) {
        double[] copy = values.clone();
        Arrays.sort(copy);
        int unique = 0;
        for (int i = 0; i < copy.length; i++) {
            if (i == 0 || copy[i] != copy[i - 1]) {
                copy[unique++] = copy[i];
            }
        }
        return Arrays.copyOf(copy, unique);
    }

    public static double median(double[] values) {
        double[] copy = Arrays.stream(values).filter(v -> !Double.isNaN(v)).sorted().toArray();
        if (copy.length == 0) {
            return 0.0;
        }
        int middle = copy.length / 2;
        return copy.length % 2 == 0 ? (copy[middle - 1] + copy[middle]) / 2.0 : copy[middle];
    }

    public static double mean(double[] values) {
        double sum = 0;
        int count = 0;
        for (double value : values) {
            if (!Double.isNaN(value)) {
                sum += value;
                count++;
            }
        }
        return count == 0 ? 0.0 : sum / count;
    }

    public static double round3(double value) {
        return Math.round(value * 1000.0) / 1000.0;
    }
}
