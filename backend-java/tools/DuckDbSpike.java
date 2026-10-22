import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;

public class DuckDbSpike {
    public static void main(String[] args) throws Exception {
        Class.forName("org.duckdb.DuckDBDriver");
        String path = args[0].replace('\\', '/');
        try (Connection con = DriverManager.getConnection("jdbc:duckdb:" + path)) {
            System.out.println("version=" + con.getMetaData().getDatabaseProductVersion());
            try {
                con.setReadOnly(true);
                System.out.println("setReadOnly=OK");
            } catch (Exception e) {
                System.out.println("setReadOnly=FAILED: " + e.getMessage());
            }
            try (Statement st = con.createStatement(); ResultSet rs = st.executeQuery("SHOW TABLES")) {
                int count = 0;
                while (rs.next()) {
                    count++;
                    if (count <= 10) {
                        System.out.println("table=" + rs.getString(1));
                    }
                }
                System.out.println("tableCount=" + count);
            }
            try (Statement st = con.createStatement();
                 ResultSet rs = st.executeQuery("SELECT key, value FROM metadata WHERE key IN ('TrackName','TrackLayout','CarName')")) {
                while (rs.next()) {
                    System.out.println(rs.getString(1) + "=" + rs.getString(2));
                }
            }
            try (Statement st = con.createStatement();
                 ResultSet rs = st.executeQuery("SELECT COUNT(*), MIN(value), MAX(value) FROM \"GPS Time\"")) {
                rs.next();
                System.out.println("gpsCount=" + rs.getLong(1) + " min=" + rs.getDouble(2) + " max=" + rs.getDouble(3));
            }
        }
    }
}
