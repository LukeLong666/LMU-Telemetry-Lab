package com.lmutl.api.dto;

import com.fasterxml.jackson.annotation.JsonProperty;

public final class SessionDtos {

    private SessionDtos() {
    }

    public record RenameRequest(@JsonProperty("new_name") String newName) {
    }
}
