import com.lmutl.infra.duckdb.DuckDbConnectionFactory;
import com.lmutl.infra.duckdb.DuckDbReads;

import java.nio.file.Path;
import java.sql.Connection;

public class CarrySpike {
    public static void main(String[] args) throws Exception {
        Path db = Path.of(args[0]);
        try (Connection con = new DuckDbConnectionFactory().open(db)) {
            for (String table : new String[]{"ABSLevel", "TCCut", "TCLevel", "TCSlipAngle", "ABS", "TC"}) {
                System.out.println(table + " scalar=" + DuckDbReads.lastEventBefore(con, table, 50.120001));
            }
            for (String table : new String[]{"TyresCompound", "WheelsDetached"}) {
                var event = DuckDbReads.lastEventWheelBefore(con, table, 50.120001);
                System.out.println(table + " wheel=" + (event == null ? "null" : event.ts() + " " + java.util.Arrays.toString(event.values())));
            }
        }
    }
}
