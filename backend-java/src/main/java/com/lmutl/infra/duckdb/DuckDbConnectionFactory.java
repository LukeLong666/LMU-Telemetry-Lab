package com.lmutl.infra.duckdb;

import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;

@Component
public class DuckDbConnectionFactory {

    static {
        try {
            Class.forName("org.duckdb.DuckDBDriver");
        } catch (ClassNotFoundException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    public Connection open(Path database) throws SQLException {
        String path = database.toAbsolutePath().normalize().toString().replace('\\', '/');
        return DriverManager.getConnection("jdbc:duckdb:" + path);
    }
}
