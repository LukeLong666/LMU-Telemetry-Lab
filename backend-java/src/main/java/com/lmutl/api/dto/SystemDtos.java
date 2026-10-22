package com.lmutl.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

public final class SystemDtos {

    private SystemDtos() {
    }

    public record OpenPathRequest(String path, Integer x, Integer y, Integer width, Integer height) {
    }

    public record ImportPathsRequest(
            List<String> paths,
            @JsonProperty("profile_id") String profileId
    ) {
    }
}
