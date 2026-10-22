package com.lmutl.infra.track;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Minimal port of Python's difflib.SequenceMatcher ratio() (Ratcliff/Obershelp).
 * The track registry relies on the exact same similarity metric as the Python backend.
 */
public final class SequenceMatcher {

    private SequenceMatcher() {
    }

    public static double ratio(String left, String right) {
        if (left == null || right == null) {
            return 0.0;
        }
        int total = left.length() + right.length();
        if (total == 0) {
            return 1.0;
        }
        int matches = 0;
        for (int[] block : matchingBlocks(left, right)) {
            matches += block[2];
        }
        return (2.0 * matches) / total;
    }

    static List<int[]> matchingBlocks(String a, String b) {
        List<int[]> blocks = new ArrayList<>();
        Deque<int[]> queue = new ArrayDeque<>();
        queue.add(new int[]{0, a.length(), 0, b.length()});
        while (!queue.isEmpty()) {
            int[] range = queue.removeFirst();
            int alo = range[0];
            int ahi = range[1];
            int blo = range[2];
            int bhi = range[3];
            int[] match = findLongestMatch(a, b, alo, ahi, blo, bhi);
            if (match[2] > 0) {
                blocks.add(match);
                if (alo < match[0] && blo < match[1]) {
                    queue.add(new int[]{alo, match[0], blo, match[1]});
                }
                if (match[0] + match[2] < ahi && match[1] + match[2] < bhi) {
                    queue.add(new int[]{match[0] + match[2], ahi, match[1] + match[2], bhi});
                }
            }
        }
        blocks.sort(Comparator.comparingInt(block -> block[0]));

        List<int[]> merged = new ArrayList<>();
        for (int[] block : blocks) {
            if (!merged.isEmpty()) {
                int[] last = merged.get(merged.size() - 1);
                if (last[0] + last[2] == block[0] && last[1] + last[2] == block[1]) {
                    last[2] += block[2];
                    continue;
                }
            }
            merged.add(new int[]{block[0], block[1], block[2]});
        }
        merged.add(new int[]{a.length(), b.length(), 0});
        return merged;
    }

    private static int[] findLongestMatch(String a, String b, int alo, int ahi, int blo, int bhi) {
        Map<Character, List<Integer>> b2j = new HashMap<>();
        for (int j = blo; j < bhi; j++) {
            b2j.computeIfAbsent(b.charAt(j), key -> new ArrayList<>()).add(j);
        }

        int bestI = alo;
        int bestJ = blo;
        int bestSize = 0;
        int[] previous = new int[Math.max(1, bhi - blo + 1)];

        for (int i = alo; i < ahi; i++) {
            int[] current = new int[previous.length];
            List<Integer> positions = b2j.get(a.charAt(i));
            if (positions != null) {
                for (int j : positions) {
                    if (j < blo) {
                        continue;
                    }
                    if (j >= bhi) {
                        break;
                    }
                    int k = ((j > blo) ? previous[j - 1 - blo] : 0) + 1;
                    current[j - blo] = k;
                    if (k > bestSize) {
                        bestI = i - k + 1;
                        bestJ = j - k + 1;
                        bestSize = k;
                    }
                }
            }
            previous = current;
        }
        return new int[]{bestI, bestJ, bestSize};
    }
}
