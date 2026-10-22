package com.lmutl.infra.system;

import com.lmutl.infra.fs.AppPaths;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Stream;

@Component
public class SteeringWheelScanner {

    private final AppPaths paths;

    public SteeringWheelScanner(AppPaths paths) {
        this.paths = paths;
    }

    public Map<String, Object> scan() {
        Path root = paths.steeringWheelDir();
        Map<String, List<Map<String, String>>> categories = new TreeMap<>();
        if (root == null || !Files.isDirectory(root)) {
            return Map.of("categories", Map.of());
        }
        try (Stream<Path> stream = Files.walk(root, 6)) {
            List<Path> images = stream
                    .filter(Files::isRegularFile)
                    .filter(SteeringWheelScanner::isImage)
                    .toList();
            for (Path image : images) {
                Path relative = root.relativize(image);
                Path parent = relative.getParent();
                String category = parent == null ? "Root" : parent.toString();
                String fileName = image.getFileName().toString();
                String name = fileName.substring(0, fileName.lastIndexOf('.'));
                String path = relative.toString().replace('\\', '/');
                categories.computeIfAbsent(category, key -> new ArrayList<>())
                        .add(Map.of("name", name, "path", path));
            }
        } catch (IOException e) {
            return Map.of("categories", Map.of());
        }

        Map<String, Object> result = new LinkedHashMap<>();
        Map<String, Object> ordered = new LinkedHashMap<>();
        categories.forEach((category, wheels) -> {
            wheels.sort(Comparator.comparing(entry -> entry.get("name"), String.CASE_INSENSITIVE_ORDER));
            ordered.put(category, wheels);
        });
        result.put("categories", ordered);
        return result;
    }

    private static boolean isImage(Path path) {
        String name = path.getFileName().toString().toLowerCase(Locale.ROOT);
        return name.endsWith(".png") || name.endsWith(".jpg") || name.endsWith(".jpeg") || name.endsWith(".webp");
    }
}
