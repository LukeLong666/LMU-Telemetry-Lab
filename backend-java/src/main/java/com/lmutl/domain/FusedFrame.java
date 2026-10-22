package com.lmutl.domain;

import java.util.LinkedHashMap;
import java.util.Map;

public record FusedFrame(
        int frequency,
        double[] time,
        LinkedHashMap<String, Channel> channels
) {

    public Channel channel(String name) {
        return channels.get(name);
    }

    public boolean has(String name) {
        return channels.containsKey(name);
    }

    public double[] scalar(String name) {
        Channel channel = channels.get(name);
        return channel == null || channel.width() != 1 ? null : channel.data();
    }

    public Map<String, Channel> channelMap() {
        return channels;
    }
}
