package mage.server;

import com.j256.ormlite.field.DatabaseField;
import com.j256.ormlite.table.DatabaseTable;
import mage.server.recovery.RecoveryPrincipal;

import java.util.Locale;

/** Durable owner of a product-created agent account in the engine account database. */
@DatabaseTable(tableName = "product_agent_seat")
public class ProductSeatBinding {

    @DatabaseField(id = true)
    private String engineKey;
    @DatabaseField(canBeNull = false)
    private String accountId;
    @DatabaseField(canBeNull = false)
    private String seatId;

    public ProductSeatBinding() {
    }

    ProductSeatBinding(String name, RecoveryPrincipal principal) {
        engineKey = name.toLowerCase(Locale.ROOT);
        accountId = principal.accountId.toString();
        seatId = principal.seatId;
    }

    boolean belongsTo(RecoveryPrincipal principal) {
        return principal != null && accountId.equals(principal.accountId.toString()) && seatId.equals(principal.seatId);
    }
}
