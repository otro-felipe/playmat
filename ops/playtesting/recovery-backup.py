#!/usr/bin/env python3
"""Private, same-volume recovery backups. Never publishes snapshots or prints their contents."""
import argparse
from contextlib import closing
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import struct
import tempfile
import time
import uuid

BACKUP_NAME = re.compile(r"\d{8}T\d{6}Z-\d{20}-[0-9a-f]{32}")
PRIVATE_FILE = 0o600
PRIVATE_DIR = 0o700


def private_dir(path):
    if path.is_symlink():
        raise ValueError("Private backup directory cannot be a symlink")
    path.mkdir(mode=PRIVATE_DIR, parents=True, exist_ok=True)
    if not path.is_dir():
        raise ValueError("Private backup directory required")
    path.chmod(PRIVATE_DIR)


def regular(path):
    if path.is_symlink() or not path.is_file():
        raise ValueError("Regular private file required")


def sync(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def digest(path):
    regular(path)
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            value.update(chunk)
    return value.hexdigest()


def fingerprint(engine):
    extensions = engine / "extensions"
    if extensions.is_dir() and any(p.is_dir() for p in extensions.iterdir()):
        raise ValueError("Recovery does not support extension packages")
    value = hashlib.sha256()
    count = 0
    for folder in ("lib", "plugins"):
        jars = sorted((engine / folder).rglob("*.jar"))
        if not jars:
            raise ValueError("Assembled engine required")
        for jar in jars:
            regular(jar)
            value.update(jar.relative_to(engine).as_posix().encode())
            value.update(b"\0")
            value.update(struct.pack(">q", jar.stat().st_size))
            with jar.open("rb") as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    value.update(chunk)
            count += 1
    return f"jars-v1:{value.hexdigest()}:{count}"


def read_database(path):
    regular(path)
    return sqlite3.connect(path.absolute().as_uri() + "?mode=ro", uri=True, timeout=5)


def check_database(path):
    with closing(read_database(path)) as db:
        if db.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
            raise ValueError("Invalid backup database")
        tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"checkpoints", "recovery_participants", "recovery_claims", "recovery_mappings"} <= tables:
            raise ValueError("Recovery tables missing")
        if db.execute("PRAGMA user_version").fetchone()[0] != 2:
            raise ValueError("Unsupported recovery store version")


def write_json(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_FILE)
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream)
        stream.flush()
        os.fsync(stream.fileno())


def backup(engine, backups, keep=4):
    if not 1 <= keep <= 96:
        raise ValueError("Invalid backup retention")
    source = engine / "db/pvp-recovery.db"
    regular(source)
    private_dir(backups)
    fd = os.open(backups / ".backup.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, PRIVATE_FILE)
    try:
        os.fchmod(fd, PRIVATE_FILE)
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        # Exclusive ownership makes partial copies left by a killed backup safe to remove.
        for old in backups.glob(".partial-*"):
            if old.is_symlink() or not old.is_dir():
                raise ValueError("Invalid partial backup entry")
            shutil.rmtree(old)
        return create_backup(engine, backups, source, keep)
    finally:
        os.close(fd)


def create_backup(engine, backups, source, keep):
    binary_id = fingerprint(engine)
    partial = Path(tempfile.mkdtemp(prefix=".partial-", dir=backups))
    try:
        target = partial / "pvp-recovery.db"
        target.touch(mode=PRIVATE_FILE)
        deadline = time.monotonic() + 60

        def progress(status, remaining, total):
            if time.monotonic() > deadline:
                raise TimeoutError("Recovery backup busy")

        # SQLite's online backup API includes committed WAL pages and excludes uncommitted writes.
        with closing(read_database(source)) as original, closing(sqlite3.connect(target)) as copy:
            original.backup(copy, pages=256, progress=progress, sleep=0.05)
            copy.execute("PRAGMA journal_mode=DELETE")
        check_database(target)
        sync(target)
        commit = engine / ".commit"
        write_json(partial / "manifest.json", {
            "format": 1, "engine": binary_id, "sha256": digest(target),
            "commit": commit.read_text().strip() if commit.is_file() else "unknown",
            "createdAt": int(time.time()),
        })
        sync(partial)
        name = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{time.time_ns():020d}-" + uuid.uuid4().hex
        result = backups / name
        partial.rename(result)
        sync(backups)
        completed = sorted(p for p in backups.iterdir() if BACKUP_NAME.fullmatch(p.name))
        for old in completed[:-keep]:
            if old.is_symlink() or not old.is_dir():
                raise ValueError("Invalid private backup entry")
            shutil.rmtree(old)
        sync(backups)
        return result
    finally:
        if partial.exists():
            shutil.rmtree(partial)


def restore(engine, saved):
    # Offline only. This POSIX record lock conflicts with Java CheckpointStore's FileChannel lock.
    if saved.is_symlink() or not saved.is_dir():
        raise ValueError("Private saved directory required")
    regular(saved / "manifest.json")
    manifest = json.loads((saved / "manifest.json").read_text())
    source = saved / "pvp-recovery.db"
    if (manifest.get("format") != 1 or manifest.get("engine") != fingerprint(engine)
            or manifest.get("sha256") != digest(source)):
        raise ValueError("Incompatible or damaged backup")
    check_database(source)
    database = engine / "db"
    if not database.is_dir():
        raise ValueError("Mount and link the private database volume before restoration")
    # The image deliberately links this directory to its private persistent volume. Resolve that
    # configured directory once; database, lock and backup files still reject symlinks individually.
    database = database.resolve(strict=True)
    lock_path = database / "pvp-recovery.db.lock"
    fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, PRIVATE_FILE)
    staged = None
    try:
        os.fchmod(fd, PRIVATE_FILE)
        fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        existing = [database / ("pvp-recovery.db" + suffix) for suffix in ("", "-wal", "-shm", "-journal")]
        for path in existing:
            if path.exists() or path.is_symlink():
                regular(path)
        handle, name = tempfile.mkstemp(prefix=".restore-", dir=database)
        os.close(handle)
        staged = Path(name)
        shutil.copyfile(source, staged)
        staged.chmod(PRIVATE_FILE)
        if digest(staged) != manifest["sha256"]:
            raise ValueError("Backup changed during restore")
        sync(staged)
        previous = [p for p in existing if p.exists()]
        if previous:
            preserved = database / ("before-recovery-restore-" + uuid.uuid4().hex)
            private_dir(preserved)
            for path in previous:
                path.chmod(PRIVATE_FILE)
                path.rename(preserved / path.name)
            sync(preserved)
        staged.replace(database / "pvp-recovery.db")
        sync(database)
    finally:
        if staged is not None and staged.exists():
            staged.unlink()
        os.close(fd)


def daemon(engine, backups, interval, keep):
    private_dir(backups)
    print(f"Recovery private backup configured: intervalSeconds={interval} keep={keep}", flush=True)
    last_ok = None
    while True:
        state = "waiting_for_database"
        delay = 5
        try:
            if (engine / "db/pvp-recovery.db").exists():
                backup(engine, backups, keep)
                state, last_ok, delay = "ok", int(time.time()), interval
                print("Recovery private backup completed", flush=True)
        except Exception:
            state, delay = "failed", 30
            print("Recovery private backup failed; previous copies retained", flush=True)
        try:
            temporary = backups / (".status-" + uuid.uuid4().hex)
            write_json(temporary, {"state": state, "lastSuccessAt": last_ok, "intervalSeconds": interval, "keep": keep})
            temporary.replace(backups / "status.json")
            sync(backups)
        except Exception:
            print("Recovery private backup status unavailable", flush=True)
        time.sleep(delay)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("once", "daemon", "restore"))
    parser.add_argument("--engine", type=Path, default=Path("/opt/xmage"))
    parser.add_argument("--backups", type=Path, default=Path("/var/lib/playmat/backups/pvp-recovery"))
    parser.add_argument("--saved", type=Path)
    args = parser.parse_args()
    try:
        interval = int(os.environ.get("PLAYMAT_RECOVERY_BACKUP_SECONDS", "900"))
        keep = int(os.environ.get("PLAYMAT_RECOVERY_BACKUP_KEEP", "4"))
        if not 60 <= interval <= 86400 or not 1 <= keep <= 96:
            raise ValueError("Invalid private backup configuration")
        if args.action == "restore":
            if args.saved is None:
                raise ValueError("Select a private saved backup")
            restore(args.engine, args.saved)
        elif args.action == "once":
            backup(args.engine, args.backups, keep)
        else:
            daemon(args.engine, args.backups, interval, keep)
    except Exception:
        # SQL, paths, identities and serialized state must never enter logs.
        parser.exit(1, "Recovery private backup operation failed\n")


if __name__ == "__main__":
    main()
