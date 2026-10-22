package com.lmutl.infra.discord;

import com.lmutl.infra.fs.AppPaths;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class DiscordConfig {

    private static final Logger log = LoggerFactory.getLogger(DiscordConfig.class);

    private final AppPaths paths;
    private final ObjectMapper mapper;

    public DiscordConfig(AppPaths paths, ObjectMapper mapper) {
        this.paths = paths;
        this.mapper = mapper;
    }

    public Config load() {
        for (Path candidate : new Path[]{
                paths.appHome().resolve("discord_config.json"),
                paths.dataRoot().resolve("discord_config.json")
        }) {
            if (Files.isRegularFile(candidate)) {
                try {
                    JsonNode root = mapper.readTree(candidate.toFile());
                    String token = text(root, "bot_token");
                    String envToken = System.getenv("DISCORD_BOT_TOKEN");
                    if (envToken != null && !envToken.isBlank()) {
                        token = envToken;
                    }
                    String guildId = text(root, "guild_id");
                    String invite = text(root, "invite_url");
                    Map<String, String> channels = new LinkedHashMap<>();
                    JsonNode channelNode = root.path("channels");
                    if (channelNode.isObject()) {
                        channelNode.properties().forEach(entry ->
                                channels.put(entry.getKey(), entry.getValue().asText("")));
                    }
                    return new Config(token, guildId, invite, channels);
                } catch (Exception e) {
                    log.error("Failed to load Discord config from {}", candidate, e);
                }
            }
        }
        return new Config(null, null, "https://discord.gg/your-invite-code", Map.of());
    }

    public boolean isConfigured() {
        Config config = load();
        return config.botToken() != null && !config.botToken().isBlank();
    }

    public String inviteUrl() {
        return load().inviteUrl();
    }

    public String channelId(String carClass) {
        return load().channels().get(carClass);
    }

    public String guildId() {
        return load().guildId();
    }

    private static String text(JsonNode root, String key) {
        String value = root.path(key).asText("");
        return value.isBlank() ? null : value;
    }

    public record Config(String botToken, String guildId, String inviteUrl, Map<String, String> channels) {
    }
}
