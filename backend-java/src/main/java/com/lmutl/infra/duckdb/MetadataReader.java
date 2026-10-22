package com.lmutl.infra.duckdb;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.sql.Connection;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;

@Component
public class MetadataReader {

    private static final Logger log = LoggerFactory.getLogger(MetadataReader.class);

    public Map<String, String> read(Connection connection) {
        Map<String, String> metadata = new LinkedHashMap<>();
        String sql = "SELECT key, value FROM metadata";
        try (Statement statement = connection.createStatement();
             ResultSet rs = statement.executeQuery(sql)) {
            while (rs.next()) {
                metadata.put(rs.getString(1), rs.getString(2));
            }
        } catch (SQLException e) {
            log.warn("Failed to read metadata table", e);
        }
        return metadata;
    }

    public String value(Map<String, String> metadata, String key, String fallback) {
        String value = metadata.get(key);
        return value == null || value.isBlank() ? fallback : value;
    }
}
