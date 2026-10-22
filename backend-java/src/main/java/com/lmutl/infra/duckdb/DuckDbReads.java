package com.lmutl.infra.duckdb;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;

public final class DuckDbReads {

    private DuckDbReads() {
    }

    /**
     * DuckDB tables mix DOUBLE, INTEGER, BOOLEAN and VARCHAR values. JDBC's
     * getDouble() throws on BOOLEAN ("false"); this converts every numeric-ish
     * value the same way pandas does for the Python oracle.
     */
    private static double number(ResultSet rs, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null) {
            return Double.NaN;
        }
        if (value instanceof Boolean bool) {
            return bool ? 1.0 : 0.0;
        }
        if (value instanceof Number numeric) {
            return numeric.doubleValue();
        }
        try {
            return Double.parseDouble(value.toString());
        } catch (NumberFormatException e) {
            return Double.NaN;
        }
    }

    private static Double numberOrNull(ResultSet rs, int index) throws SQLException {
        Object value = rs.getObject(index);
        if (value == null) {
            return null;
        }
        double number = number(rs, index);
        return Double.isNaN(number) && !isBoolean(value) ? null : number;
    }

    private static boolean isBoolean(Object value) {
        return value instanceof Boolean;
    }

    public static double[] readValues(Connection connection, String table) throws SQLException {
        String sql = "SELECT value FROM \"" + table + "\" ORDER BY rowid";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<Double> values = new ArrayList<>();
            while (rs.next()) {
                values.add(number(rs, 1));
            }
            double[] result = new double[values.size()];
            for (int i = 0; i < values.size(); i++) {
                result[i] = values.get(i);
            }
            return result;
        }
    }

    public static Event lastEventBefore(Connection connection, String table, double timestamp) {
        String sql = "SELECT ts, value FROM \"" + table + "\" WHERE ts <= ? ORDER BY ts DESC LIMIT 1";
        try (java.sql.PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setDouble(1, timestamp);
            try (ResultSet rs = statement.executeQuery()) {
                if (rs.next()) {
                    double ts = number(rs, 1);
                    if (!Double.isNaN(ts)) {
                        return new Event(ts, number(rs, 2));
                    }
                }
            }
        } catch (SQLException e) {
            return null;
        }
        return null;
    }

    public static EventWheel lastEventWheelBefore(Connection connection, String table, double timestamp) {
        String sql = "SELECT ts, value1, value2, value3, value4 FROM \"" + table
                + "\" WHERE ts <= ? ORDER BY ts DESC LIMIT 1";
        try (java.sql.PreparedStatement statement = connection.prepareStatement(sql)) {
            statement.setDouble(1, timestamp);
            try (ResultSet rs = statement.executeQuery()) {
                if (rs.next()) {
                    double ts = number(rs, 1);
                    if (!Double.isNaN(ts)) {
                        double[] values = new double[4];
                        for (int wheel = 0; wheel < 4; wheel++) {
                            values[wheel] = number(rs, wheel + 2);
                        }
                        return new EventWheel(ts, values);
                    }
                }
            }
        } catch (SQLException e) {
            return null;
        }
        return null;
    }

    public static List<Event> readEvents(Connection connection, String table) throws SQLException {
        String sql = "SELECT ts, value FROM \"" + table + "\" ORDER BY ts";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<Event> events = new ArrayList<>();
            while (rs.next()) {
                double ts = number(rs, 1);
                if (Double.isNaN(ts)) {
                    continue;
                }
                events.add(new Event(ts, number(rs, 2)));
            }
            return events;
        }
    }

    public static List<Event> readEventsColumn(Connection connection, String table, String column) throws SQLException {
        String sql = "SELECT ts, \"" + column + "\" FROM \"" + table + "\" ORDER BY ts";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<Event> events = new ArrayList<>();
            while (rs.next()) {
                double ts = number(rs, 1);
                if (Double.isNaN(ts)) {
                    continue;
                }
                events.add(new Event(ts, number(rs, 2)));
            }
            return events;
        }
    }

    public static List<Event> readEventsOrEmpty(Connection connection, String table) {
        try {
            return readEvents(connection, table);
        } catch (SQLException e) {
            return List.of();
        }
    }

    public static List<EventWheel> readEventWheels(Connection connection, String table) throws SQLException {
        String sql = "SELECT ts, value1, value2, value3, value4 FROM \"" + table + "\" ORDER BY ts";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<EventWheel> events = new ArrayList<>();
            while (rs.next()) {
                double ts = number(rs, 1);
                if (Double.isNaN(ts)) {
                    continue;
                }
                double[] values = new double[4];
                for (int wheel = 0; wheel < 4; wheel++) {
                    values[wheel] = number(rs, wheel + 2);
                }
                events.add(new EventWheel(ts, values));
            }
            return events;
        }
    }

    public static double[][] readWheelValues(Connection connection, String table) throws SQLException {
        String sql = "SELECT value1, value2, value3, value4 FROM \"" + table + "\" ORDER BY rowid";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<double[]> rows = new ArrayList<>();
            while (rs.next()) {
                double[] values = new double[4];
                for (int wheel = 0; wheel < 4; wheel++) {
                    values[wheel] = number(rs, wheel + 1);
                }
                rows.add(values);
            }
            double[][] result = new double[4][rows.size()];
            for (int row = 0; row < rows.size(); row++) {
                for (int wheel = 0; wheel < 4; wheel++) {
                    result[wheel][row] = rows.get(row)[wheel];
                }
            }
            return result;
        }
    }

    public static double[] readColumn(Connection connection, String table, String column) throws SQLException {
        String sql = "SELECT \"" + column + "\" FROM \"" + table + "\" ORDER BY rowid";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            List<Double> values = new ArrayList<>();
            while (rs.next()) {
                values.add(number(rs, 1));
            }
            double[] result = new double[values.size()];
            for (int i = 0; i < values.size(); i++) {
                result[i] = values.get(i);
            }
            return result;
        }
    }

    public static List<String> tableNames(Connection connection) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("SHOW TABLES")) {
            List<String> names = new ArrayList<>();
            while (rs.next()) {
                names.add(rs.getString(1));
            }
            return names;
        }
    }

    public static List<String> columns(Connection connection, String table) throws SQLException {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery("DESCRIBE \"" + table + "\"")) {
            List<String> columns = new ArrayList<>();
            while (rs.next()) {
                columns.add(rs.getString(1));
            }
            return columns;
        }
    }

    public static double[] readValuesOrEmpty(Connection connection, String table) {
        try {
            return readValues(connection, table);
        } catch (SQLException e) {
            return new double[0];
        }
    }

    public static Double scalarDouble(Connection connection, String sql) {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            if (rs.next()) {
                return numberOrNull(rs, 1);
            }
        } catch (SQLException e) {
            return null;
        }
        return null;
    }

    public static Integer scalarInt(Connection connection, String sql) {
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            if (rs.next()) {
                Object value = rs.getObject(1);
                if (value == null) {
                    return null;
                }
                if (value instanceof Number numeric) {
                    return numeric.intValue();
                }
                try {
                    return Integer.parseInt(value.toString());
                } catch (NumberFormatException e) {
                    return null;
                }
            }
        } catch (SQLException e) {
            return null;
        }
        return null;
    }

    public record Event(double ts, double value) {
    }

    public record EventWheel(double ts, double[] values) {
    }
}
