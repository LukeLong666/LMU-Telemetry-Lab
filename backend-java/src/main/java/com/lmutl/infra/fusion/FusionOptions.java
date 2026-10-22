package com.lmutl.infra.fusion;

public record FusionOptions(int targetFreq, Double trimStart, Double trimEnd) {

    public static FusionOptions of(int targetFreq) {
        return new FusionOptions(targetFreq, null, null);
    }
}
