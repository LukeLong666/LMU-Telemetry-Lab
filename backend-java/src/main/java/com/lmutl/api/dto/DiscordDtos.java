package com.lmutl.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public final class DiscordDtos {

    private DiscordDtos() {
    }

    public record ShareRequest(
            @JsonProperty("lap_number") int lapNumber,
            String title,
            String content,
            @JsonProperty("attach_setup") boolean attachSetup,
            @JsonProperty("car_class") String carClass,
            @JsonProperty("custom_car_model") String customCarModel,
            @JsonProperty("profile_id") String profileId,
            @JsonProperty("discord_handle") String discordHandle
    ) {
    }

    public record DownloadRequest(
            @JsonProperty("profile_id") String profileId,
            @JsonProperty("telemetry_url") String telemetryUrl,
            @JsonProperty("telemetry_filename") String telemetryFilename,
            @JsonProperty("setup_url") String setupUrl,
            @JsonProperty("setup_filename") String setupFilename
    ) {
    }
}
