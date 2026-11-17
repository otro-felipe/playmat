package mage.server.recovery;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import java.nio.file.Path;
import java.sql.SQLException;
import java.util.UUID;
import static org.junit.jupiter.api.Assertions.*;

class RecoveryStoreTest {
    @TempDir Path dir;

    @Test void identityConsentClaimsAndBootFencingAreDurableAndAtomic() throws Exception {
        try (CheckpointStore store = new CheckpointStore(dir.resolve("recovery.db"))) {
            UUID id=CheckpointStoreTest.fixture(store);
            CheckpointStore.Captured first=store.inspect(id,CheckpointStoreTest.ENGINE);
            CheckpointContext context=(CheckpointContext)CheckpointContext.read(first.context);
            RecoveryPrincipal one=new RecoveryPrincipal(UUID.randomUUID(),"agent:"+UUID.randomUUID());
            UUID accountTwo=UUID.randomUUID();
            RecoveryPrincipal two=new RecoveryPrincipal(accountTwo,"human:"+accountTwo);
            context.seats.get(0).principal=one; context.seats.get(1).principal=two;
            store.saveRecoverable(context,first.snapshot,CheckpointStoreTest.ENGINE,"boot1",context.tableId,context.gameId);
            long revision=store.inspect(id,CheckpointStoreTest.ENGINE).revision;
            assertTrue(store.participant(id,one));assertTrue(store.participant(id,two));
            RecoveryPrincipal differentGrant=new RecoveryPrincipal(one.accountId,"agent:"+UUID.randomUUID());
            assertFalse(store.participant(id,differentGrant));
            assertEquals(java.util.Collections.singletonList(id),store.matches(one));
            store.boot("boot2");
            assertEquals("waiting",store.claim(id).status);
            assertNull(store.acquire(id,revision,"boot2"));
            assertThrows(SQLException.class,()->store.consent(id,one,revision-1));
            store.consent(id,one,revision);
            assertNull(store.acquire(id,revision,"boot2"));
            store.consent(id,two,revision);
            String token=store.acquire(id,revision,"boot2");assertNotNull(token);
            assertNull(store.acquire(id,revision,"boot2"),"repeated claim cannot allocate another table");
            assertEquals(1,store.claim(id).generation);
            UUID newTable=UUID.randomUUID(),newGame=UUID.randomUUID();
            store.activate(id,token,newTable,newGame);
            assertThrows(SQLException.class,()->store.activate(id,token,UUID.randomUUID(),UUID.randomUUID()));
            assertThrows(SQLException.class,()->store.saveRecoverable(context,first.snapshot,CheckpointStoreTest.ENGINE,"boot1",newTable,newGame));
            context.seats.get(0).principal=differentGrant;
            assertThrows(SQLException.class,()->store.saveRecoverable(context,first.snapshot,CheckpointStoreTest.ENGINE,"boot2",newTable,newGame));
            assertFalse(store.participant(id,differentGrant),"failed participant replacement rolls back the entire identity transaction");
            context.seats.get(0).principal=one;
            store.boot("boot3");
            assertNull(store.acquire(id,revision,"boot3"),"agreements from the dead process do not restart clocks");
            assertEquals("waiting",store.claim(id).status);
            store.finish(id,"completed");store.boot("boot4");
            assertEquals("completed",store.claim(id).status);
        }
    }
}
