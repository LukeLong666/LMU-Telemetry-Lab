package com.lmutl.infra.discord;

import com.lmutl.api.error.ApiException;
import com.lmutl.domain.SessionInfo;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@Component
public class DiscordClient {

    private static final Logger log = LoggerFactory.getLogger(DiscordClient.class);
    private static final String API = "https://discord.com/api/v10";
    private static final Pattern USER_MENTION = Pattern.compile("<@(\\d+)>");
    private static final Duration SHARES_TTL = Duration.ofSeconds(60);
    private static final Duration MEMBER_TTL = Duration.ofMinutes(15);

    private final DiscordConfig config;
    private final ObjectMapper mapper;
    private final HttpClient http = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(5))
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    private final Map<String, CacheEntry<List<Map<String, Object>>>> sharesCache = new ConcurrentHashMap<>();
    private final Map<String, CacheEntry<JsonNode>> memberCache = new ConcurrentHashMap<>();

    public DiscordClient(DiscordConfig config, ObjectMapper mapper) {
        this.config = config;
        this.mapper = mapper;
    }

    public boolean isConfigured() {
        return config.isConfigured();
    }

    public String inviteUrl() {
        return config.inviteUrl();
    }

    public Map<String, Object> shareToForum(String carClass,
                                           String title,
                                           String content,
                                           String trackTagName,
                                           List<Path> files) {
        DiscordConfig.Config cfg = config.load();
        if (cfg.botToken() == null) {
            return Map.of("success", false, "error", "Discord Bot not configured");
        }
        String channelId = cfg.channels().get(carClass);
        if (channelId == null) {
            return Map.of("success", false, "error", "No Discord channel ID configured for car class: " + carClass);
        }

        String tagId = matchTag(channelId, trackTagName);
        try {
            String boundary = "----LMUTelemetry" + UUID.randomUUID().toString().replace("-", "");
            ByteArrayOutputStream body = new ByteArrayOutputStream();
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("name", title);
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("content", content);
            List<Map<String, Object>> attachments = new ArrayList<>();
            for (int i = 0; i < files.size(); i++) {
                Path file = files.get(i);
                attachments.add(Map.of(
                        "id", i,
                        "filename", file.getFileName().toString(),
                        "description", "Uploaded file: " + file.getFileName()
                ));
            }
            message.put("attachments", attachments);
            payload.put("message", message);
            if (tagId != null) {
                payload.put("applied_tags", List.of(tagId));
            }

            writeField(body, boundary, "payload_json", null,
                    mapper.writeValueAsString(payload).getBytes(StandardCharsets.UTF_8));
            for (int i = 0; i < files.size(); i++) {
                Path file = files.get(i);
                writeField(body, boundary, "files[" + i + "]", file.getFileName().toString(),
                        Files.readAllBytes(file));
            }
            body.write(("--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));

            HttpRequest request = HttpRequest.newBuilder(URI.create(API + "/channels/" + channelId + "/threads"))
                    .timeout(Duration.ofSeconds(30))
                    .header("Authorization", "Bot " + cfg.botToken())
                    .header("User-Agent", "LMU-Telemetry-Lab/1.5.3")
                    .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                    .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray()))
                    .build();
            HttpResponse<byte[]> response = send(request);
            if (response.statusCode() == 200 || response.statusCode() == 201) {
                JsonNode node = mapper.readTree(response.body());
                return Map.of("success", true, "thread_id", node.path("id").asText());
            }
            String error = new String(response.body(), StandardCharsets.UTF_8);
            log.error("Discord forum post failed: {} {}", response.statusCode(), error);
            return Map.of("success", false, "error", "Discord API error: " + response.statusCode() + " - " + error);
        } catch (Exception e) {
            log.error("Discord share failed", e);
            return Map.of("success", false, "error", e.getMessage() == null ? "Discord share failed" : e.getMessage());
        }
    }

    public Map<String, Object> searchGuildMember(String username) {
        DiscordConfig.Config cfg = config.load();
        if (cfg.botToken() == null || cfg.guildId() == null) {
            return null;
        }
        String query = username == null ? "" : username.replaceFirst("^@", "").trim();
        if (query.isBlank()) {
            return null;
        }
        try {
            String encoded = java.net.URLEncoder.encode(query, StandardCharsets.UTF_8);
            JsonNode members = getJson(API + "/guilds/" + cfg.guildId() + "/members/search?query=" + encoded + "&limit=100");
            String lower = query.toLowerCase(Locale.ROOT);
            for (JsonNode member : members) {
                JsonNode user = member.path("user");
                if (matchesMember(user, member, lower, true)) {
                    return Map.of("user_id", user.path("id").asText(), "username", user.path("username").asText());
                }
            }
            for (JsonNode member : members) {
                JsonNode user = member.path("user");
                if (matchesMember(user, member, lower, false)) {
                    return Map.of("user_id", user.path("id").asText(), "username", user.path("username").asText());
                }
            }
        } catch (Exception e) {
            log.error("Failed to search Discord member {}", username, e);
        }
        return null;
    }

    public JsonNode getGuildMember(String userId) {
        DiscordConfig.Config cfg = config.load();
        if (cfg.botToken() == null || cfg.guildId() == null) {
            return null;
        }
        CacheEntry<JsonNode> cached = memberCache.get(userId);
        if (cached != null && !cached.expired(MEMBER_TTL)) {
            return cached.value();
        }
        try {
            JsonNode member = getJson(API + "/guilds/" + cfg.guildId() + "/members/" + userId);
            memberCache.put(userId, new CacheEntry<>(member, System.currentTimeMillis()));
            return member;
        } catch (Exception e) {
            log.warn("Failed to fetch Discord member {}: {}", userId, e.getMessage());
            return null;
        }
    }

    public List<Map<String, Object>> listSharedLaps(String carClass) {
        DiscordConfig.Config cfg = config.load();
        if (cfg.botToken() == null || cfg.guildId() == null) {
            return List.of();
        }
        String channelId = cfg.channels().get(carClass);
        if (channelId == null) {
            return List.of();
        }
        CacheEntry<List<Map<String, Object>>> cached = sharesCache.get(channelId);
        if (cached != null && !cached.expired(SHARES_TTL)) {
            return cached.value();
        }

        try {
            List<JsonNode> threads = new ArrayList<>();
            JsonNode active = getJson(API + "/guilds/" + cfg.guildId() + "/threads/active");
            for (JsonNode thread : active.path("threads")) {
                if (channelId.equals(thread.path("parent_id").asText())) {
                    threads.add(thread);
                }
            }
            JsonNode archived = getJson(API + "/channels/" + channelId + "/threads/archived/public");
            for (JsonNode thread : archived.path("threads")) {
                threads.add(thread);
            }

            Map<String, JsonNode> unique = new LinkedHashMap<>();
            for (JsonNode thread : threads) {
                boolean locked = thread.path("locked").asBoolean(false)
                        || thread.path("thread_metadata").path("locked").asBoolean(false);
                if (!locked && !thread.path("id").asText().isBlank()) {
                    unique.put(thread.path("id").asText(), thread);
                }
            }
            List<JsonNode> sorted = new ArrayList<>(unique.values());
            sorted.sort(Comparator.comparing((JsonNode node) -> node.path("id").asText()).reversed());

            List<Map<String, Object>> shares = new ArrayList<>();
            for (JsonNode thread : sorted.subList(0, Math.min(20, sorted.size()))) {
                Map<String, Object> share = fetchThread(thread.path("id").asText(), thread.path("name").asText());
                if (share != null) {
                    shares.add(share);
                }
            }
            sharesCache.put(channelId, new CacheEntry<>(shares, System.currentTimeMillis()));
            return shares;
        } catch (Exception e) {
            log.error("Failed to list Discord shares for {}", carClass, e);
            return List.of();
        }
    }

    public Map<String, Object> getThreadAttachments(String threadId) {
        DiscordConfig.Config cfg = config.load();
        if (cfg.botToken() == null) {
            return null;
        }
        try {
            JsonNode message = getJson(API + "/channels/" + threadId + "/messages/" + threadId);
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("telemetry", attachment(message, ".duckdb"));
            result.put("setup", attachment(message, ".svm"));
            return result;
        } catch (Exception e) {
            log.error("Failed to fetch Discord thread attachments {}", threadId, e);
            return null;
        }
    }

    public void downloadFile(String url, Path destination) throws IOException {
        if (url == null || !(url.startsWith("https://cdn.discordapp.com/")
                || url.startsWith("https://media.discordapp.net/"))) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "Unsupported download URL");
        }
        Path parent = destination.toAbsolutePath().getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        Path temp = destination.resolveSibling(destination.getFileName() + ".tmp");
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                    .timeout(Duration.ofMinutes(5))
                    .header("User-Agent", "LMU-Telemetry-Lab/1.5.3")
                    .GET()
                    .build();
            HttpResponse<InputStream> response = http.send(request, HttpResponse.BodyHandlers.ofInputStream());
            if (response.statusCode() != 200) {
                throw new IOException("Download failed with status " + response.statusCode());
            }
            try (InputStream input = response.body()) {
                Files.copy(input, temp, StandardCopyOption.REPLACE_EXISTING);
            }
            Files.move(temp, destination, StandardCopyOption.REPLACE_EXISTING);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IOException("Download interrupted", e);
        } finally {
            Files.deleteIfExists(temp);
        }
    }

    private Map<String, Object> fetchThread(String threadId, String threadName) {
        try {
            JsonNode message = getJson(API + "/channels/" + threadId + "/messages/" + threadId);
            String content = message.path("content").asText("");
            String cleaned = content.contains("---") ? content.split("---", 2)[1].trim() : content;

            String authorId = null;
            String authorName = "Unknown";
            String authorDisplay = "Unknown";
            String avatarUrl = null;
            Matcher matcher = USER_MENTION.matcher(content);
            if (matcher.find()) {
                String mentionId = matcher.group(1);
                JsonNode member = getGuildMember(mentionId);
                if (member != null) {
                    JsonNode user = member.path("user");
                    authorId = user.path("id").asText(mentionId);
                    authorName = user.path("username").asText("Unknown");
                    String globalName = user.path("global_name").asText("");
                    String nick = member.path("nick").asText("");
                    authorDisplay = !nick.isBlank() ? nick : (!globalName.isBlank() ? globalName : authorName);
                    avatarUrl = avatarUrl(user, authorId);
                }
            }
            if (authorId == null) {
                JsonNode author = message.path("author");
                authorId = author.path("id").asText();
                authorName = author.path("username").asText("Unknown");
                String globalName = author.path("global_name").asText("");
                authorDisplay = globalName.isBlank() ? authorName : globalName;
                avatarUrl = avatarUrl(author, authorId);
            }

            Map<String, Object> telemetry = attachment(message, ".duckdb");
            if (telemetry == null) {
                return null;
            }
            Map<String, Object> author = new LinkedHashMap<>();
            author.put("id", authorId);
            author.put("username", authorName);
            author.put("display_name", authorDisplay);
            author.put("avatar_url", avatarUrl);

            Map<String, Object> share = new LinkedHashMap<>();
            share.put("thread_id", threadId);
            share.put("title", threadName);
            share.put("author", author);
            share.put("content", cleaned);
            share.put("telemetry", telemetry);
            share.put("setup", attachment(message, ".svm"));
            share.put("created_at", message.path("timestamp").asText(""));
            return share;
        } catch (Exception e) {
            log.warn("Failed to fetch Discord thread {}: {}", threadId, e.getMessage());
            return null;
        }
    }

    private String matchTag(String channelId, String trackTagName) {
        if (trackTagName == null || trackTagName.isBlank()) {
            return null;
        }
        try {
            JsonNode channel = getJson(API + "/channels/" + channelId);
            String clean = trackTagName.toLowerCase(Locale.ROOT).trim();
            List<String> potential = new ArrayList<>();
            potential.add(clean);
            Map<String, List<String>> aliases = Map.of(
                    "algarve", List.of("portimao", "portimão"),
                    "sarthe", List.of("le mans", "lemans"),
                    "americas", List.of("cota"),
                    "losail", List.of("lusail"),
                    "spa-francorchamps", List.of("spa")
            );
            for (Map.Entry<String, List<String>> entry : aliases.entrySet()) {
                if (clean.contains(entry.getKey())) {
                    potential.addAll(entry.getValue());
                }
            }
            for (JsonNode tag : channel.path("available_tags")) {
                String name = tag.path("name").asText("").toLowerCase(Locale.ROOT).trim();
                for (String candidate : potential) {
                    if (name.contains(candidate) || candidate.contains(name)) {
                        return tag.path("id").asText();
                    }
                }
            }
        } catch (Exception e) {
            log.warn("Failed to match Discord tag: {}", e.getMessage());
        }
        return null;
    }

    private Map<String, Object> attachment(JsonNode message, String extension) {
        for (JsonNode attachment : message.path("attachments")) {
            String filename = attachment.path("filename").asText("").toLowerCase(Locale.ROOT);
            if (filename.endsWith(extension)) {
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("filename", attachment.path("filename").asText());
                result.put("url", attachment.path("url").asText());
                result.put("size", attachment.path("size").asLong());
                return result;
            }
        }
        return null;
    }

    private String avatarUrl(JsonNode user, String userId) {
        String hash = user.path("avatar").asText("");
        if (!hash.isBlank()) {
            return "https://cdn.discordapp.com/avatars/" + userId + "/" + hash + ".png";
        }
        try {
            int index = (int) ((Long.parseLong(userId) >> 22) % 6);
            return "https://cdn.discordapp.com/embed/avatars/" + index + ".png";
        } catch (Exception e) {
            return null;
        }
    }

    private boolean matchesMember(JsonNode user, JsonNode member, String query, boolean exact) {
        String username = user.path("username").asText("").toLowerCase(Locale.ROOT);
        String globalName = user.path("global_name").asText("").toLowerCase(Locale.ROOT);
        String nick = member.path("nick").asText("").toLowerCase(Locale.ROOT);
        if (exact) {
            return username.equals(query) || globalName.equals(query) || nick.equals(query);
        }
        return (!username.isEmpty() && username.contains(query))
                || (!globalName.isEmpty() && globalName.contains(query))
                || (!nick.isEmpty() && nick.contains(query));
    }

    private JsonNode getJson(String url) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create(url))
                .timeout(Duration.ofSeconds(15))
                .header("Authorization", "Bot " + config.load().botToken())
                .header("User-Agent", "LMU-Telemetry-Lab/1.5.3")
                .GET()
                .build();
        HttpResponse<byte[]> response = send(request);
        if (response.statusCode() < 200 || response.statusCode() >= 300) {
            throw new IOException("Discord API " + response.statusCode() + ": "
                    + new String(response.body(), StandardCharsets.UTF_8));
        }
        return mapper.readTree(response.body());
    }

    private HttpResponse<byte[]> send(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<byte[]> response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        if (response.statusCode() == 429) {
            String retryAfter = response.headers().firstValue("Retry-After").orElse("1");
            long millis = (long) (Double.parseDouble(retryAfter) * 1000);
            Thread.sleep(Math.min(10_000, Math.max(500, millis)));
            response = http.send(request, HttpResponse.BodyHandlers.ofByteArray());
        }
        return response;
    }

    private static void writeField(ByteArrayOutputStream output, String boundary,
                                   String name, String filename, byte[] data) throws IOException {
        output.write(("--" + boundary + "\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(("Content-Disposition: form-data; name=\"" + name + "\""
                + (filename == null ? "" : "; filename=\"" + filename + "\"") + "\r\n").getBytes(StandardCharsets.UTF_8));
        output.write(("Content-Type: " + (filename == null ? "application/json" : "application/octet-stream") + "\r\n\r\n")
                .getBytes(StandardCharsets.UTF_8));
        output.write(data);
        output.write("\r\n".getBytes(StandardCharsets.UTF_8));
    }

    private record CacheEntry<T>(T value, long timestamp) {
        boolean expired(Duration ttl) {
            return System.currentTimeMillis() - timestamp > ttl.toMillis();
        }
    }
}
