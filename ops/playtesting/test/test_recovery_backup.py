import importlib.util
from contextlib import closing
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "recovery-backup.py"
spec = importlib.util.spec_from_file_location("recovery_backup", SCRIPT)
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class RecoveryBackupTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.engine = self.root / "engine"
        for name in ("lib", "plugins", "db"):
            (self.engine / name).mkdir(parents=True)
        (self.engine / "lib/core.jar").write_bytes(b"synthetic core binary")
        (self.engine / "plugins/human.jar").write_bytes(b"synthetic plugin binary")
        (self.engine / ".commit").write_text("synthetic-source")
        self.source = self.engine / "db/pvp-recovery.db"
        self.backups = self.root / "private-backups"
        self.db = sqlite3.connect(self.source)
        self.addCleanup(self.db.close)
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA wal_autocheckpoint=0;
            PRAGMA user_version=2;
            CREATE TABLE checkpoints(id TEXT PRIMARY KEY,context BLOB,snapshot BLOB);
            CREATE TABLE recovery_participants(id TEXT,identity TEXT);
            CREATE TABLE recovery_claims(id TEXT,generation INTEGER);
            CREATE TABLE recovery_mappings(id TEXT,table_id TEXT);
            INSERT INTO checkpoints VALUES('fixture',X'010203',zeroblob(16384));
            INSERT INTO recovery_participants VALUES('fixture','synthetic-reserved-seat');
            INSERT INTO recovery_claims VALUES('fixture',3);
            INSERT INTO recovery_mappings VALUES('fixture','synthetic-original-table');
        """)

    def read_all(self, file):
        with closing(sqlite3.connect(file)) as db:
            return {table: db.execute("SELECT * FROM " + table).fetchall() for table in (
                "checkpoints", "recovery_participants", "recovery_claims", "recovery_mappings")}

    def test_online_backup_includes_committed_wal_and_excludes_live_uncommitted_data(self):
        self.db.execute("INSERT INTO checkpoints VALUES('committed-wal',X'04',X'05')")
        self.db.commit()
        self.assertGreater(Path(str(self.source) + "-wal").stat().st_size, 0)
        expected = self.read_all(self.source)
        self.db.execute("UPDATE checkpoints SET snapshot=X'99'")
        saved = backup.backup(self.engine, self.backups)
        self.assertEqual(expected, self.read_all(saved / "pvp-recovery.db"))
        self.assertFalse((saved / "pvp-recovery.db-wal").exists())
        self.assertEqual(0o700, self.backups.stat().st_mode & 0o777)
        self.assertEqual(0o700, saved.stat().st_mode & 0o777)
        for file in saved.iterdir():
            self.assertEqual(0o600, file.stat().st_mode & 0o777)
        manifest = json.loads((saved / "manifest.json").read_text())
        self.assertEqual("synthetic-source", manifest["commit"])
        self.assertEqual(backup.fingerprint(self.engine), manifest["engine"])

    def test_restore_preserves_all_tables_and_prior_database_then_can_be_written(self):
        expected = self.read_all(self.source)
        saved = backup.backup(self.engine, self.backups)
        self.db.execute("UPDATE checkpoints SET context=X'98'")
        self.db.commit()
        self.db.close()
        prior = self.read_all(self.source)
        backup.restore(self.engine, saved)
        self.assertEqual(expected, self.read_all(self.source))
        preserved = list((self.engine / "db").glob("before-recovery-restore-*"))
        self.assertEqual(1, len(preserved))
        self.assertEqual(prior, self.read_all(preserved[0] / "pvp-recovery.db"))
        self.assertEqual(0o700, preserved[0].stat().st_mode & 0o777)
        self.assertEqual(0o600, self.source.stat().st_mode & 0o777)
        with sqlite3.connect(self.source) as db:
            self.assertEqual([("ok",)], db.execute("PRAGMA integrity_check").fetchall())
            db.execute("UPDATE recovery_claims SET generation=4")
        self.assertEqual(4, self.read_all(self.source)["recovery_claims"][0][1])

    def test_restore_rejects_live_process_lock_without_changing_database(self):
        saved = backup.backup(self.engine, self.backups)
        lock = self.engine / "db/pvp-recovery.db.lock"
        child = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time;f=open(sys.argv[1],'w');"
                                  "fcntl.lockf(f,fcntl.LOCK_EX);print('ready',flush=True);time.sleep(30)", str(lock)],
                                 stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual("ready", child.stdout.readline().strip())
            expected = self.read_all(self.source)
            with self.assertRaises(BlockingIOError):
                backup.restore(self.engine, saved)
            self.assertEqual(expected, self.read_all(self.source))
        finally:
            child.terminate()
            child.wait(timeout=5)
            child.stdout.close()

    def test_tampering_and_incompatible_jars_are_rejected_before_restore(self):
        saved = backup.backup(self.engine, self.backups)
        expected = self.read_all(self.source)
        (self.engine / "plugins/human.jar").write_bytes(b"different plugin binary")
        with self.assertRaises(ValueError):
            backup.restore(self.engine, saved)
        self.assertEqual(expected, self.read_all(self.source))
        (self.engine / "plugins/human.jar").write_bytes(b"synthetic plugin binary")
        with (saved / "pvp-recovery.db").open("ab") as file:
            file.write(b"changed")
        with self.assertRaises(ValueError):
            backup.restore(self.engine, saved)
        self.assertEqual(expected, self.read_all(self.source))

    def test_retention_only_removes_completed_backups_after_success(self):
        unrelated = self.backups / "unrelated-private-data"
        self.backups.mkdir()
        unrelated.write_text("preserve")
        abandoned = self.backups / ".partial-abandoned"
        abandoned.mkdir()
        (abandoned / "pvp-recovery.db").write_bytes(b"interrupted copy")
        for _ in range(5):
            latest = backup.backup(self.engine, self.backups, keep=2)
            self.assertTrue(latest.exists())
        complete = [p for p in self.backups.iterdir() if backup.BACKUP_NAME.fullmatch(p.name)]
        self.assertEqual(2, len(complete))
        self.assertFalse(abandoned.exists())
        self.assertEqual("preserve", unrelated.read_text())
        self.db.execute("PRAGMA user_version=999")
        self.db.commit()
        with self.assertRaises(ValueError):
            backup.backup(self.engine, self.backups, keep=1)
        self.assertEqual(set(complete), {p for p in self.backups.iterdir() if backup.BACKUP_NAME.fullmatch(p.name)})
        self.assertFalse(list(self.backups.glob(".partial-*")))

    def test_symlinks_are_rejected_and_errors_do_not_print_private_content(self):
        self.backups.symlink_to(self.engine / "db", target_is_directory=True)
        with self.assertRaises(ValueError):
            backup.backup(self.engine, self.backups)
        self.backups.unlink()
        self.source.unlink()
        self.source.symlink_to(self.engine / "lib/core.jar")
        result = subprocess.run([sys.executable, str(SCRIPT), "once", "--engine", str(self.engine),
                                 "--backups", str(self.backups)], capture_output=True, text=True)
        self.assertEqual(1, result.returncode)
        self.assertEqual("", result.stdout)
        self.assertEqual("Recovery private backup operation failed\n", result.stderr)

    def test_daemon_records_effective_private_status_without_snapshot_contents(self):
        child = subprocess.Popen([sys.executable, str(SCRIPT), "daemon", "--engine", str(self.engine),
                                  "--backups", str(self.backups)], stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True,
                                 env={**os.environ, "PLAYMAT_RECOVERY_BACKUP_SECONDS": "60", "PLAYMAT_RECOVERY_BACKUP_KEEP": "2"})
        try:
            deadline = time.monotonic() + 5
            status = self.backups / "status.json"
            while not status.exists() and time.monotonic() < deadline:
                self.assertIsNone(child.poll())
                time.sleep(0.02)
            value = json.loads(status.read_text())
            self.assertEqual("ok", value["state"])
            self.assertGreater(value["lastSuccessAt"], 0)
            self.assertEqual(60, value["intervalSeconds"])
            self.assertEqual(2, value["keep"])
            self.assertEqual(0o600, status.stat().st_mode & 0o777)
        finally:
            child.terminate()
            out, err = child.communicate(timeout=5)
        self.assertEqual("", err)
        self.assertEqual("Recovery private backup configured: intervalSeconds=60 keep=2\n"
                         "Recovery private backup completed\n", out)

    @unittest.skipUnless(os.environ.get("PLAYMAT_RECOVERY_JAVA_CLASSPATH"), "Explicit compiled Java store fixture required")
    def test_restore_rejects_the_actual_java_checkpoint_store_lock(self):
        saved = backup.backup(self.engine, self.backups)
        self.db.close()
        source = self.root / "RecoveryBackupLockProbe.java"
        source.write_text('''
import java.nio.file.Paths;
import mage.server.recovery.CheckpointStore;
public final class RecoveryBackupLockProbe {
    public static void main(String[] args) throws Exception {
        try (CheckpointStore store = new CheckpointStore(Paths.get(args[0]))) {
            System.out.println("ready");
            System.out.flush();
            System.in.read();
        }
    }
}
''')
        cp = os.environ["PLAYMAT_RECOVERY_JAVA_CLASSPATH"]
        java = os.environ.get("PLAYMAT_RECOVERY_JAVA", shutil.which("java"))
        javac = os.environ.get("PLAYMAT_RECOVERY_JAVAC", shutil.which("javac"))
        subprocess.run([javac, "-cp", cp, "-d", str(self.root), str(source)], check=True, capture_output=True)
        child = subprocess.Popen([java, "-cp", str(self.root) + os.pathsep + cp,
                                  "RecoveryBackupLockProbe", str(self.source)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual("ready", child.stdout.readline().strip(), "Actual Java CheckpointStore opened and holds its lock")
            expected = self.read_all(self.source)
            with self.assertRaises(BlockingIOError):
                backup.restore(self.engine, saved)
            self.assertEqual(expected, self.read_all(self.source))
        finally:
            child.communicate("close", timeout=5)
        self.assertEqual(0, child.returncode)
        backup.restore(self.engine, saved)
        self.assertEqual(expected, self.read_all(self.source))


if __name__ == "__main__":
    unittest.main()
