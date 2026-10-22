package com.lmutl.infra.car;

import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Car lookup seeded with the standard mapping from the Python backend.
 * A CSV can be layered in later without changing callers.
 */
@Component
public class CarCatalog {

    private static final Pattern TECHNICAL_SUFFIX = Pattern.compile(":\\w+");
    private static final Pattern FIRST_NUMBER = Pattern.compile("(\\d+)");

    private final Map<String, CarSpec> standardMapping = new LinkedHashMap<>();

    public CarCatalog() {
        standardMapping.put("united autosports", new CarSpec("McLaren 720S GT3 Evo", "LMGT3", 540));
        standardMapping.put("manthey", new CarSpec("Porsche 911 GT3 R (992)", "LMGT3", 540));
        standardMapping.put("iron dames", new CarSpec("Porsche 911 GT3 R (992)", "LMGT3", 540));
        standardMapping.put("d'station", new CarSpec("Aston Martin Vantage AMR GT3 Evo", "LMGT3", 540));
        standardMapping.put("tf sport", new CarSpec("Corvette Z06 GT3.R", "LMGT3", 540));
        standardMapping.put("akkodis", new CarSpec("Lexus RC F GT3", "LMGT3", 540));
        standardMapping.put("toyota gazoo", new CarSpec("Toyota GR010 Hybrid", "Hypercar", 480));
        standardMapping.put("porsche penske", new CarSpec("Porsche 963", "Hypercar", 480));
        standardMapping.put("cadillac", new CarSpec("Cadillac V-Series.R", "Hypercar", 480));
        standardMapping.put("peugeot", new CarSpec("Peugeot 9X8", "Hypercar", 480));
        standardMapping.put("alpine endurance", new CarSpec("Alpine A424", "Hypercar", 480));
        standardMapping.put("oreca", new CarSpec("Oreca 07 Gibson", "LMP2", 480));
    }

    public CarSpec getCarInfo(String carNameMeta, String carClassMeta) {
        String carName = cleanTechnicalSuffixes(carNameMeta == null ? "" : carNameMeta);
        String clean = carName.toLowerCase(Locale.ROOT).trim();

        for (Map.Entry<String, CarSpec> entry : standardMapping.entrySet()) {
            if (clean.contains(entry.getKey())) {
                return entry.getValue();
            }
        }

        String name = titleCase(clean.replace("_", " "));
        name = name.replace("Gt3", "GT3")
                .replace("Gte", "GTE")
                .replace("Bmw", "BMW")
                .replace("Amg", "AMG")
                .replace("Lmh", "LMH")
                .replace("Lmdh", "LMDh")
                .replace("F1", "F1");
        return new CarSpec(name, carClassMeta == null ? "" : carClassMeta, 540);
    }

    public CarSpec getCarInfo(String carNameMeta, String carClassMeta, Integer overrideSteerLock) {
        CarSpec spec = getCarInfo(carNameMeta, carClassMeta);
        if (overrideSteerLock == null) {
            return spec;
        }
        return new CarSpec(spec.modelName(), spec.category(), overrideSteerLock);
    }

    public Integer parseSteerLock(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        Matcher matcher = FIRST_NUMBER.matcher(value);
        return matcher.find() ? Integer.parseInt(matcher.group(1)) : null;
    }

    private static String cleanTechnicalSuffixes(String value) {
        return TECHNICAL_SUFFIX.matcher(value).replaceAll("").trim();
    }

    private static String titleCase(String value) {
        StringBuilder result = new StringBuilder(value.length());
        boolean capitalizeNext = true;
        for (int i = 0; i < value.length(); i++) {
            char ch = value.charAt(i);
            if (Character.isLetter(ch)) {
                result.append(capitalizeNext ? Character.toUpperCase(ch) : Character.toLowerCase(ch));
                capitalizeNext = false;
            } else {
                result.append(ch);
                capitalizeNext = true;
            }
        }
        return result.toString();
    }

    public record CarSpec(String modelName, String category, int steeringLock) {
    }
}
