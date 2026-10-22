package com.lmutl.infra.duckdb;

import java.sql.Connection;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

public final class LapBoundaryResolver {

    private LapBoundaryResolver() {
    }

    public static Result resolve(Connection connection) throws SQLException {
        Double startValue = DuckDbReads.scalarDouble(connection, "SELECT MIN(value) FROM \"GPS Time\"");
        Double endValue = DuckDbReads.scalarDouble(connection, "SELECT MAX(value) FROM \"GPS Time\"");
        if (startValue == null || endValue == null) {
            throw new SQLException("GPS Time table is empty.");
        }
        double sessionStart = startValue;
        double sessionEnd = endValue;

        List<DuckDbReads.Event> lapStartEvents = DuckDbReads.readEventsOrEmpty(connection, "Lap");
        List<DuckDbReads.Event> lapTimeEvents = DuckDbReads.readEventsOrEmpty(connection, "Lap Time");
        List<DuckDbReads.Event> validLapTimes = lapTimeEvents.stream()
                .filter(event -> event.value() > 0)
                .toList();

        List<Double> boundaries = new ArrayList<>();
        if (lapStartEvents.isEmpty()) {
            boundaries.add(sessionStart);
        } else {
            double firstLapStart = lapStartEvents.get(0).ts();
            boundaries.add(firstLapStart);

            if (!validLapTimes.isEmpty()) {
                DuckDbReads.Event firstLapTime = validLapTimes.get(0);
                double calcStart = firstLapTime.ts() - firstLapTime.value();
                if (lapStartEvents.size() > 1) {
                    double secondLapStart = lapStartEvents.get(1).ts();
                    if (calcStart < secondLapStart - 1.0 && calcStart > boundaries.get(0) + 1.0) {
                        boundaries.add(calcStart);
                    }
                } else if (calcStart > boundaries.get(0) + 1.0) {
                    boundaries.add(calcStart);
                }
            }

            for (int i = 1; i < lapStartEvents.size(); i++) {
                boundaries.add(lapStartEvents.get(i).ts());
            }
        }

        TreeSet<Double> unique = new TreeSet<>(boundaries);
        List<Double> sorted = new ArrayList<>(unique);
        if (sorted.isEmpty() || sorted.get(0) - sessionStart > 1.0) {
            sorted.add(0, sessionStart);
        }
        return new Result(sessionStart, sessionEnd, List.copyOf(sorted), List.copyOf(validLapTimes));
    }

    public record Result(
            double sessionStart,
            double sessionEnd,
            List<Double> boundaries,
            List<DuckDbReads.Event> lapTimes
    ) {
    }
}
