package com.lmutl.infra.track;

import java.text.Normalizer;
import java.util.Locale;
import java.util.regex.Pattern;

final class TrackNames {

    private static final Pattern COMMON_NOISE = Pattern.compile(
            "\\b(circuit de la|circuit de|autodromo nazionale|international|grand prix|circuit|gp|autodromo)\\b");
    private static final Pattern SEPARATORS = Pattern.compile("[-_]");
    private static final Pattern LEADING_NON_ALNUM = Pattern.compile("^[^a-z0-9]+");

    private TrackNames() {
    }

    static String normalizeTrack(String input) {
        if (input == null) {
            return "";
        }
        String value = stripAccents(input).toLowerCase(Locale.ROOT).trim();
        value = SEPARATORS.matcher(value).replaceAll(" ");
        value = COMMON_NOISE.matcher(value).replaceAll("");
        return collapseWhitespace(value);
    }

    static String normalizeLayout(String input) {
        if (input == null) {
            return "";
        }
        String value = stripAccents(input).toLowerCase(Locale.ROOT).trim();
        value = SEPARATORS.matcher(value).replaceAll(" ");
        return collapseWhitespace(value);
    }

    static String stripLeadingNonAlnum(String input) {
        return LEADING_NON_ALNUM.matcher(input).replaceFirst("");
    }

    static String stripAccents(String input) {
        String decomposed = Normalizer.normalize(input, Normalizer.Form.NFD);
        StringBuilder builder = new StringBuilder(decomposed.length());
        decomposed.codePoints()
                .filter(cp -> Character.getType(cp) != Character.NON_SPACING_MARK)
                .forEach(builder::appendCodePoint);
        return builder.toString();
    }

    static String collapseWhitespace(String input) {
        return input.trim().replaceAll("\\s+", " ");
    }
}
