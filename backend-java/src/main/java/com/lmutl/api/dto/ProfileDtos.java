package com.lmutl.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

import java.util.List;

public final class ProfileDtos {

    private ProfileDtos() {
    }

    public record CreateRequest(String name) {
    }

    public record UpdateRequest(String name) {
    }

    public record ReorderRequest(@JsonProperty("profile_ids") List<String> profileIds) {
    }
}
