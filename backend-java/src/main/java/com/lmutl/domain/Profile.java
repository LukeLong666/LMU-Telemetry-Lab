package com.lmutl.domain;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonInclude(JsonInclude.Include.NON_NULL)
public record Profile(
        String id,
        String name,
        @JsonProperty("created_at") String createdAt,
        @JsonProperty("last_used") String lastUsed,
        @JsonProperty("is_default") boolean isDefault,
        @JsonProperty("avatar_url") String avatarUrl,
        @JsonProperty("session_count") Integer sessionCount
) {

    public Profile withSessionCount(int count) {
        return new Profile(id, name, createdAt, lastUsed, isDefault, avatarUrl, count);
    }

    public Profile withoutSessionCount() {
        return new Profile(id, name, createdAt, lastUsed, isDefault, avatarUrl, null);
    }

    public Profile withName(String newName) {
        return new Profile(id, newName, createdAt, lastUsed, isDefault, avatarUrl, sessionCount);
    }

    public Profile withAvatar(String newAvatarUrl) {
        return new Profile(id, name, createdAt, lastUsed, isDefault, newAvatarUrl, sessionCount);
    }

    public Profile withDefault(boolean value) {
        return new Profile(id, name, createdAt, lastUsed, value, avatarUrl, sessionCount);
    }
}
