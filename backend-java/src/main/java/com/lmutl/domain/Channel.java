package com.lmutl.domain;

public final class Channel {

    private final String name;
    private final int width;
    private final double[] data;

    private Channel(String name, int width, double[] data) {
        this.name = name;
        this.width = width;
        this.data = data;
    }

    public static Channel scalar(String name, double[] values) {
        return new Channel(name, 1, values);
    }

    public static Channel vector(String name, double[][] values) {
        int frames = values.length;
        double[] flat = new double[frames * 4];
        for (int i = 0; i < frames; i++) {
            double[] row = values[i];
            for (int wheel = 0; wheel < 4; wheel++) {
                flat[i * 4 + wheel] = wheel < row.length ? row[wheel] : Double.NaN;
            }
        }
        return new Channel(name, 4, flat);
    }

    public static Channel fromFlat(String name, int width, double[] data) {
        return new Channel(name, width, data);
    }

    public String name() {
        return name;
    }

    public int width() {
        return width;
    }

    public double[] data() {
        return data;
    }

    public double valueAt(int frame, int component) {
        return data[frame * width + component];
    }

    public int frames() {
        return width == 0 ? 0 : data.length / width;
    }
}
