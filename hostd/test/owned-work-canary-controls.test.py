#!/usr/bin/env python3
import importlib.util
import datetime as dt
import hashlib
import json
import os
import pathlib
import socket
import subprocess
import time
import sqlite3
import stat
import struct
import tempfile
import threading
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "owned_work_canary_coordinator",
    ROOT / "runtime" / "owned-work-canary-coordinator.py",
)
coordinator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(coordinator)


def authorization(seed="neutral"):
    nonce = hashlib.sha256(seed.encode()).hexdigest()[:48]
    expires = dt.datetime.now(dt.timezone.utc) + dt.timedelta(seconds=95)
    return {
        "version": 1,
        "nonce": nonce,
        "contextId": "operator:neutral:intake",
        "deliveryId": f"zulip-canary:{nonce}",
        "source": "zulip",
        "senderId": 42,
        "senderIsBot": True,
        "channelId": "7",
        "topic": "neutral topic",
        "bodySha256": "a" * 64,
        "phoneConfigSha256": "d" * 64,
        "phoneHoldStateSha256": "e" * 64,
        "expiresAt": expires.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "candidateSha": "b" * 40,
        "leaseSeconds": 5,
        "deadlineMs": 90000,
    }



def test_process_start_ticks():
    value = pathlib.Path("/proc/self/stat").read_text(encoding="utf-8")
    return value[value.rfind(")") + 2:].split()[19]


def install_hold_attestation(connection, config_path, config_bytes, holds):
    connection.execute("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
    attestation = {
        "version": 1,
        "pid": os.getpid(),
        "processStartTicks": test_process_start_ticks(),
        "startedAt": coordinator.utc_now(),
        "configPath": str(config_path),
        "configSha256": hashlib.sha256(config_bytes).hexdigest(),
        "deliveryHolds": holds,
    }
    connection.execute(
        "INSERT OR REPLACE INTO meta(key,value) VALUES (?,?)",
        (coordinator.HOLD_META_KEY, json.dumps(attestation, separators=(",", ":"))),
    )



def database_fixture(path, auth):
    connection = sqlite3.connect(path)
    connection.executescript("""
        PRAGMA journal_mode=WAL;
        CREATE TABLE events(
            id TEXT PRIMARY KEY, source TEXT, context_id TEXT, status TEXT, attempts INTEGER,
            payload_json TEXT, available_at TEXT, updated_at TEXT
        );
        CREATE TABLE owned_work_canary_authorizations(
            delivery_id TEXT PRIMARY KEY, authorization_json TEXT, lease_seconds INTEGER,
            expires_at TEXT, consumed_at TEXT, consumed_by TEXT, created_at TEXT
        );
    """)
    connection.execute(
        "INSERT INTO events VALUES (?,?,?,'canary-blocked',0,?,NULL,NULL)",
        (auth["deliveryId"], "zulip", auth["contextId"], json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))),
    )
    connection.execute(
        "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,NULL,NULL,?)",
        (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], "2026-01-01T00:00:00.000Z"),
    )
    connection.commit()
    connection.close()


class CanaryControlTests(unittest.TestCase):
    def test_root_authorization_rejects_mode_and_symlink_changes(self):
        if os.geteuid() != 0:
            self.skipTest("root ownership test requires root")
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "authorization.json"
            path.write_text(json.dumps(authorization()), encoding="utf-8")
            os.chmod(path, 0o600)
            self.assertEqual(coordinator.require_root_file(str(path))["deliveryId"], authorization()["deliveryId"])
            os.chmod(path, 0o640)
            with self.assertRaisesRegex(coordinator.CanaryAbort, "root-owned 0600"):
                coordinator.require_root_file(str(path))
            os.chmod(path, 0o600)
            link = pathlib.Path(directory) / "authorization-link.json"
            link.symlink_to(path)
            with self.assertRaisesRegex(coordinator.CanaryAbort, "regular non-symlink"):
                coordinator.require_root_file(str(link))

    def test_atomic_activation_is_one_shot_and_exact_delivery_bound(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / "state.sqlite")
            auth = authorization()
            database_fixture(path, auth)
            coordinator.consume_and_activate(path, auth, os.geteuid(), os.getegid())
            connection = sqlite3.connect(path)
            state = connection.execute(
                "SELECT status,attempts FROM events WHERE id=?", (auth["deliveryId"],)
            ).fetchone()
            consumed = connection.execute(
                "SELECT consumed_at,consumed_by FROM owned_work_canary_authorizations WHERE delivery_id=?",
                (auth["deliveryId"],),
            ).fetchone()
            connection.close()
            self.assertEqual(state, ("queued", 0))
            self.assertTrue(consumed[0])
            self.assertEqual(consumed[1], "root-coordinator-v1")
            with self.assertRaisesRegex(coordinator.CanaryAbort, "already consumed"):
                coordinator.consume_and_activate(path, auth, os.geteuid(), os.getegid())

    def test_concurrent_activation_allows_exactly_one_consumer(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / "state.sqlite")
            auth = authorization()
            database_fixture(path, auth)
            outcomes = []
            barrier = threading.Barrier(2)

            def consume():
                barrier.wait()
                try:
                    coordinator.consume_and_activate(path, auth, os.geteuid(), os.getegid())
                    outcomes.append("accepted")
                except coordinator.CanaryAbort:
                    outcomes.append("rejected")

            threads = [threading.Thread(target=consume) for _ in range(2)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
            self.assertEqual(sorted(outcomes), ["accepted", "rejected"])

    def test_full_row_outbox_digest_detects_in_place_change_with_same_summary(self):
        connection = sqlite3.connect(":memory:")
        connection.execute(
            "CREATE TABLE outbox(id INTEGER PRIMARY KEY,context_id TEXT,status TEXT,body TEXT,provider_id TEXT)"
        )
        connection.executemany(
            "INSERT INTO outbox VALUES (?,?,?,?,?)",
            [
                (1, "operator:neutral:intake", "completed", "first", "provider-1"),
                (2, "other:neutral:intake", "completed", "second", "provider-2"),
            ],
        )
        full_before = coordinator.canonical_query_digest(connection, "SELECT * FROM outbox ORDER BY id")
        context_before = coordinator.canonical_query_digest(
            connection, "SELECT * FROM outbox WHERE context_id=? ORDER BY id", ("operator:neutral:intake",)
        )
        summary_before = connection.execute(
            "SELECT COUNT(*),MAX(id),SUM(status='sending') FROM outbox"
        ).fetchone()
        connection.execute("UPDATE outbox SET body='changed' WHERE id=1")
        full_after = coordinator.canonical_query_digest(connection, "SELECT * FROM outbox ORDER BY id")
        context_after = coordinator.canonical_query_digest(
            connection, "SELECT * FROM outbox WHERE context_id=? ORDER BY id", ("operator:neutral:intake",)
        )
        summary_after = connection.execute(
            "SELECT COUNT(*),MAX(id),SUM(status='sending') FROM outbox"
        ).fetchone()
        connection.close()
        self.assertEqual(summary_before, summary_after)
        self.assertNotEqual(full_before["sha256"], full_after["sha256"])
        self.assertNotEqual(context_before["sha256"], context_after["sha256"])

    def test_phone_hold_revalidation_denies_missing_wrong_stale_and_removed_hold(self):
        if os.geteuid() != 0:
            self.skipTest("root config custody test requires root")
        with tempfile.TemporaryDirectory() as directory:
            config_path = pathlib.Path(directory) / "config.json"
            auth = authorization()

            def write_holds(holds):
                raw = json.dumps({"phone": {"deliveryHolds": holds}}, separators=(",", ":")).encode()
                config_path.write_bytes(raw)
                os.chmod(config_path, 0o640)
                return raw

            def bind(raw, holds):
                auth["phoneConfigSha256"] = hashlib.sha256(raw).hexdigest()
                auth["phoneHoldStateSha256"] = hashlib.sha256(coordinator.canonical({
                    "contextId": auth["contextId"], "held": True, "deliveryHolds": holds,
                }).encode()).hexdigest()

            raw = write_holds([auth["contextId"]])
            bind(raw, [auth["contextId"]])
            self.assertEqual(coordinator.validate_phone_hold(str(config_path), auth)["holdCount"], 1)
            stale = dict(auth)
            stale["phoneConfigSha256"] = "0" * 64
            with self.assertRaisesRegex(coordinator.CanaryAbort, "fingerprint is stale"):
                coordinator.validate_phone_hold(str(config_path), stale)
            raw = write_holds([])
            bind(raw, [])
            with self.assertRaisesRegex(coordinator.CanaryAbort, "hold is missing"):
                coordinator.validate_phone_hold(str(config_path), auth)
            raw = write_holds(["context-wrong:neutral"])
            bind(raw, ["context-wrong:neutral"])
            with self.assertRaisesRegex(coordinator.CanaryAbort, "hold is missing"):
                coordinator.validate_phone_hold(str(config_path), auth)
            raw = write_holds([auth["contextId"]])
            bind(raw, [auth["contextId"]])
            self.assertEqual(coordinator.validate_phone_hold(str(config_path), auth)["holdCount"], 1)
            write_holds([])
            with self.assertRaisesRegex(coordinator.CanaryAbort, "hold is missing"):
                coordinator.validate_phone_hold(str(config_path), auth)

    def test_effective_live_hold_attestation_denies_missing_wrong_stale_and_removed_state(self):
        if os.geteuid() != 0:
            self.skipTest("root effective-state custody test requires root")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database = root / "state.sqlite"
            config_path = root / "config.json"
            auth = authorization()
            holds = [auth["contextId"]]
            config_bytes = json.dumps({"phone": {"deliveryHolds": holds}}, separators=(",", ":")).encode()
            config_path.write_bytes(config_bytes)
            os.chmod(config_path, 0o640)
            auth["phoneConfigSha256"] = hashlib.sha256(config_bytes).hexdigest()
            auth["phoneHoldStateSha256"] = hashlib.sha256(coordinator.canonical({
                "contextId": auth["contextId"], "held": True, "deliveryHolds": holds,
            }).encode()).hexdigest()
            connection = sqlite3.connect(database)
            connection.execute("CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)")
            connection.commit()
            connection.close()
            with self.assertRaisesRegex(coordinator.CanaryAbort, "attestation is missing"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid()
                )
            connection = sqlite3.connect(database)
            install_hold_attestation(connection, config_path, config_bytes, holds)
            connection.commit()
            connection.close()
            self.assertEqual(
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid()
                )["holdCount"],
                1,
            )
            with self.assertRaisesRegex(coordinator.CanaryAbort, "attestation differs"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid() + 1
                )

            def mutate(**changes):
                connection = sqlite3.connect(database)
                row = json.loads(connection.execute(
                    "SELECT value FROM meta WHERE key=?", (coordinator.HOLD_META_KEY,)
                ).fetchone()[0])
                row.update(changes)
                connection.execute(
                    "UPDATE meta SET value=? WHERE key=?",
                    (json.dumps(row, separators=(",", ":")), coordinator.HOLD_META_KEY),
                )
                connection.commit()
                connection.close()
                return row

            valid = mutate()
            mutate(configSha256="0" * 64)
            with self.assertRaisesRegex(coordinator.CanaryAbort, "attestation differs"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid()
                )
            mutate(**{**valid, "deliveryHolds": ["operator:wrong:intake"]})
            with self.assertRaisesRegex(coordinator.CanaryAbort, "attestation differs"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid()
                )
            mutate(**{**valid, "deliveryHolds": []})
            with self.assertRaisesRegex(coordinator.CanaryAbort, "attestation differs"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), os.getpid()
                )
            mutate(**{**valid, "pid": 2147483647, "processStartTicks": "1"})
            with self.assertRaisesRegex(coordinator.CanaryAbort, "not live"):
                coordinator.validate_effective_phone_hold(
                    str(config_path), str(database), auth, os.geteuid(), os.getegid(), 2147483647
                )

    def test_failure_containment_is_terminal_idempotent_and_exact_delivery_only(self):
        if os.geteuid() != 0:
            self.skipTest("root rollback wrapper test requires root")
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / "state.sqlite")
            auth = authorization()
            sibling = "delivery-sibling"
            connection = sqlite3.connect(path)
            connection.executescript("""
                CREATE TABLE events(
                    id TEXT PRIMARY KEY,source TEXT,context_id TEXT,status TEXT,attempts INTEGER,
                    payload_json TEXT,available_at TEXT,updated_at TEXT,lease_token TEXT,
                    lease_expires_at TEXT,last_error TEXT,completed_at TEXT
                );
                CREATE TABLE owned_work_canary_authorizations(
                    delivery_id TEXT PRIMARY KEY,authorization_json TEXT,lease_seconds INTEGER,
                    expires_at TEXT,consumed_at TEXT,consumed_by TEXT,created_at TEXT
                );
                CREATE TABLE zulip_topic_capabilities(
                    delivery_id TEXT PRIMARY KEY,status TEXT,use_count INTEGER,
                    last_used_at TEXT,completed_at TEXT,context_id TEXT
                );
            """)
            payload = json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))
            connection.execute(
                "INSERT INTO events VALUES (?,?,?,'leased',1,?,NULL,NULL,'lease-one','2999-01-01T00:00:00Z',NULL,NULL)",
                (auth["deliveryId"], "zulip", auth["contextId"], payload),
            )
            connection.execute(
                "INSERT INTO events VALUES (?,?,?,'queued',0,?,NULL,NULL,NULL,NULL,NULL,NULL)",
                (sibling, "zulip", "context-sibling", json.dumps({"message": {"id": -2}})),
            )
            connection.execute(
                "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,?,?,?)",
                (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], coordinator.utc_now(), "root-coordinator-v1", coordinator.utc_now()),
            )
            connection.execute(
                "INSERT INTO zulip_topic_capabilities VALUES (?,'issued',0,NULL,NULL,?)",
                (auth["deliveryId"], auth["contextId"]),
            )
            connection.execute(
                "INSERT INTO zulip_topic_capabilities VALUES (?,'issued',0,NULL,NULL,'context-sibling')",
                (sibling,),
            )
            connection.commit()
            sibling_before = connection.execute("SELECT * FROM events WHERE id=?", (sibling,)).fetchone()
            sibling_capability_before = connection.execute(
                "SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?", (sibling,)
            ).fetchone()
            connection.close()
            auth_path = pathlib.Path(directory) / "authorization.json"
            auth_path.write_text(json.dumps(auth), encoding="utf-8")
            os.chmod(auth_path, 0o600)
            consumed_auth_path = pathlib.Path(str(auth_path) + ".consumed")
            auth_path.rename(consumed_auth_path)
            wrapper = subprocess.run([
                "python3", str(ROOT / "runtime" / "owned-work-canary-contain.py"),
                "--authorization", str(auth_path), "--database", path,
                "--peer-uid", str(os.geteuid()), "--peer-gid", str(os.getegid()),
            ], capture_output=True, text=True)
            self.assertEqual(wrapper.returncode, 0, wrapper.stderr)
            first = json.loads(wrapper.stdout)
            second = coordinator.contain_failure(path, auth, os.geteuid(), os.getegid())
            self.assertEqual(first["eventStatus"], "dead")
            self.assertEqual(second["eventStatus"], "dead")
            connection = sqlite3.connect(path)
            event = connection.execute("SELECT * FROM events WHERE id=?", (auth["deliveryId"],)).fetchone()
            capability = connection.execute(
                "SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?", (auth["deliveryId"],)
            ).fetchone()
            self.assertEqual(event[3], "dead")
            self.assertEqual(event[4], 1)
            self.assertEqual(event[5], payload)
            self.assertIsNone(event[8])
            self.assertIsNone(event[9])
            self.assertEqual(capability[1], "closed")
            self.assertEqual(capability[2], 0)
            self.assertEqual(connection.execute("SELECT * FROM events WHERE id=?", (sibling,)).fetchone(), sibling_before)
            self.assertEqual(
                connection.execute("SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?", (sibling,)).fetchone(),
                sibling_capability_before,
            )
            self.assertEqual(
                connection.execute(
                    "SELECT COUNT(*) FROM events WHERE id=? AND status IN ('queued','failed','leased','accepted','running')",
                    (auth["deliveryId"],),
                ).fetchone()[0],
                0,
                "old-code scheduler cannot reclaim the contained canary",
            )
            connection.close()

    def test_linux_peer_credentials_distinguish_the_connecting_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(pathlib.Path(directory) / "peer.sock")
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(path)
            listener.listen(1)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(path)
            server, _ = listener.accept()
            pid, uid, gid = struct.unpack("3i", server.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            self.assertEqual(uid, os.geteuid())
            self.assertEqual(gid, os.getegid())
            self.assertGreater(pid, 0)
            client.close()
            server.close()
            listener.close()
            self.assertTrue(stat.S_ISSOCK(os.lstat(path).st_mode))


    def test_timeout_and_sigterm_terminally_contain_before_wrapper_rollback(self):
        if os.geteuid() != 0:
            self.skipTest("root coordinator containment test requires root")
        for mode in ("timeout", "sigterm"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as directory:
                root = pathlib.Path(directory)
                database = root / "state.sqlite"
                auth_path = root / "authorization.json"
                config_path = root / "config.json"
                socket_path = root / "control.sock"
                ledger = root / "zulip-inbound-deliveries.jsonl"
                receipt = root / "receipt.json"
                auth = authorization(f"delivery-{mode}")
                config_bytes = json.dumps(
                    {"phone": {"deliveryHolds": [auth["contextId"]]}}, separators=(",", ":")
                ).encode()
                config_path.write_bytes(config_bytes)
                os.chmod(config_path, 0o640)
                auth["phoneConfigSha256"] = hashlib.sha256(config_bytes).hexdigest()
                auth["phoneHoldStateSha256"] = hashlib.sha256(coordinator.canonical({
                    "contextId": auth["contextId"], "held": True,
                    "deliveryHolds": [auth["contextId"]],
                }).encode()).hexdigest()
                connection = sqlite3.connect(database)
                connection.executescript("""
                    CREATE TABLE events(
                        id TEXT PRIMARY KEY,source TEXT,context_id TEXT,status TEXT,attempts INTEGER,
                        payload_json TEXT,available_at TEXT,updated_at TEXT,lease_token TEXT,
                        lease_expires_at TEXT,last_error TEXT,completed_at TEXT
                    );
                    CREATE TABLE owned_work_canary_authorizations(
                        delivery_id TEXT PRIMARY KEY,authorization_json TEXT,lease_seconds INTEGER,
                        expires_at TEXT,consumed_at TEXT,consumed_by TEXT,created_at TEXT
                    );
                    CREATE TABLE zulip_topic_capabilities(
                        delivery_id TEXT PRIMARY KEY,status TEXT,use_count INTEGER,last_used_at TEXT,
                        completed_at TEXT,channel_id INTEGER,topic TEXT,context_id TEXT
                    );
                    CREATE TABLE outbox(id INTEGER PRIMARY KEY,context_id TEXT,status TEXT);
                """)
                install_hold_attestation(connection, config_path, config_bytes, [auth["contextId"]])
                connection.execute(
                    "INSERT INTO events VALUES (?,?,?,'canary-blocked',0,?,NULL,NULL,NULL,NULL,NULL,NULL)",
                    (auth["deliveryId"], "zulip", auth["contextId"], json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))),
                )
                connection.execute(
                    "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,NULL,NULL,?)",
                    (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], coordinator.utc_now()),
                )
                connection.commit()
                connection.close()
                auth_path.write_text(json.dumps(auth), encoding="utf-8")
                os.chmod(auth_path, 0o600)
                ledger.write_text("", encoding="utf-8")
                timeout = "1" if mode == "timeout" else "30"
                process = subprocess.Popen([
                    "python3", str(ROOT / "runtime" / "owned-work-canary-coordinator.py"),
                    "--authorization", str(auth_path), "--socket", str(socket_path),
                    "--test-socket-root", str(root), "--database", str(database),
                    "--config", str(config_path), "--runtime-ledger", str(ledger),
                    "--receipt", str(receipt), "--peer-uid", str(os.geteuid()),
                    "--peer-gid", str(os.getegid()), "--hostd-pid", str(os.getpid()),
                    "--timeout-seconds", timeout,
                ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                for _ in range(300):
                    connection = sqlite3.connect(database)
                    state = connection.execute(
                        "SELECT status FROM events WHERE id=?", (auth["deliveryId"],)
                    ).fetchone()[0]
                    connection.close()
                    if state == "queued":
                        break
                    if process.poll() is not None:
                        self.fail(process.stderr.read())
                    time.sleep(0.01)
                if mode == "sigterm":
                    process.terminate()
                stdout, stderr = process.communicate(timeout=10)
                self.assertNotEqual(process.returncode, 0, stdout or stderr)
                result = json.loads(receipt.read_text(encoding="utf-8"))
                self.assertEqual(result["outcome"], "aborted")
                self.assertEqual(result["containment"]["eventStatus"], "dead")
                connection = sqlite3.connect(database)
                event = connection.execute(
                    "SELECT status,lease_token,lease_expires_at FROM events WHERE id=?",
                    (auth["deliveryId"],),
                ).fetchone()
                connection.close()
                self.assertEqual(event, ("dead", None, None))

    def test_removed_live_hold_aborts_before_work_release_and_closes_only_its_capability(self):
        if os.geteuid() != 0:
            self.skipTest("root coordinator hold-removal test requires root")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database = root / "state.sqlite"
            auth_path = root / "authorization.json"
            config_path = root / "config.json"
            socket_path = root / "control.sock"
            ledger = root / "zulip-inbound-deliveries.jsonl"
            receipt = root / "receipt.json"
            auth = authorization("delivery-removed-hold")
            config_bytes = json.dumps(
                {"phone": {"deliveryHolds": [auth["contextId"]]}}, separators=(",", ":")
            ).encode()
            config_path.write_bytes(config_bytes)
            os.chmod(config_path, 0o640)
            auth["phoneConfigSha256"] = hashlib.sha256(config_bytes).hexdigest()
            auth["phoneHoldStateSha256"] = hashlib.sha256(coordinator.canonical({
                "contextId": auth["contextId"], "held": True,
                "deliveryHolds": [auth["contextId"]],
            }).encode()).hexdigest()
            connection = sqlite3.connect(database)
            connection.executescript("""
                CREATE TABLE events(
                    id TEXT PRIMARY KEY,source TEXT,context_id TEXT,status TEXT,attempts INTEGER,
                    payload_json TEXT,available_at TEXT,updated_at TEXT,lease_token TEXT,
                    lease_expires_at TEXT,last_error TEXT,completed_at TEXT
                );
                CREATE TABLE owned_work_canary_authorizations(
                    delivery_id TEXT PRIMARY KEY,authorization_json TEXT,lease_seconds INTEGER,
                    expires_at TEXT,consumed_at TEXT,consumed_by TEXT,created_at TEXT
                );
                CREATE TABLE zulip_topic_capabilities(
                    delivery_id TEXT PRIMARY KEY,status TEXT,use_count INTEGER,last_used_at TEXT,
                    completed_at TEXT,channel_id INTEGER,topic TEXT,context_id TEXT
                );
                CREATE TABLE outbox(id INTEGER PRIMARY KEY,context_id TEXT,status TEXT);
            """)
            install_hold_attestation(connection, config_path, config_bytes, [auth["contextId"]])
            connection.execute(
                "INSERT INTO events VALUES (?,?,?,'canary-blocked',0,?,NULL,NULL,NULL,NULL,NULL,NULL)",
                (auth["deliveryId"], "zulip", auth["contextId"], json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))),
            )
            connection.execute(
                "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,NULL,NULL,?)",
                (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], coordinator.utc_now()),
            )
            connection.commit()
            connection.close()
            auth_path.write_text(json.dumps(auth), encoding="utf-8")
            os.chmod(auth_path, 0o600)
            ledger.write_text("", encoding="utf-8")
            process = subprocess.Popen([
                "python3", str(ROOT / "runtime" / "owned-work-canary-coordinator.py"),
                "--authorization", str(auth_path), "--socket", str(socket_path),
                "--test-socket-root", str(root), "--database", str(database),
                "--config", str(config_path), "--runtime-ledger", str(ledger),
                "--receipt", str(receipt), "--peer-uid", str(os.geteuid()),
                "--peer-gid", str(os.getegid()), "--hostd-pid", str(os.getpid()),
                    "--timeout-seconds", "30",
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for _ in range(300):
                if socket_path.exists():
                    break
                if process.poll() is not None:
                    self.fail(process.stderr.read())
                time.sleep(0.01)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(socket_path))
            stream = client.makefile("rwb", buffering=0)

            def send(value):
                stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())

            def receive():
                return json.loads(stream.readline())

            send({"v": 1, "type": "consume", "authorization": auth})
            self.assertEqual(receive()["type"], "armed")
            for phase in ("response_waiting", "receipt_waiting", "work_waiting"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            connection = sqlite3.connect(database)
            now = coordinator.utc_now()
            connection.execute(
                "UPDATE events SET status='completed',attempts=2,completed_at=?,updated_at=? WHERE id=?",
                (now, now, auth["deliveryId"]),
            )
            connection.execute(
                "INSERT INTO zulip_topic_capabilities VALUES (?,'issued',0,NULL,NULL,?,?,?)",
                (auth["deliveryId"], int(auth["channelId"]), auth["topic"], auth["contextId"]),
            )
            connection.commit()
            connection.close()
            self.assertEqual(receive()["type"], "release_response")
            send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": "response_released"})
            self.assertEqual(receive()["type"], "release_receipt")
            for phase in ("receipt_released", "receipt_rejected"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            removed_bytes = b'{"phone":{"deliveryHolds":[]}}'
            config_path.write_bytes(removed_bytes)
            os.chmod(config_path, 0o640)
            connection = sqlite3.connect(database)
            install_hold_attestation(connection, config_path, removed_bytes, [])
            connection.commit()
            connection.close()
            abort = receive()
            self.assertEqual(abort["type"], "abort")
            stream.close()
            client.close()
            stdout, stderr = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, stdout or stderr)
            result = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertEqual(result["outcome"], "aborted")
            self.assertEqual(result["containment"]["eventStatus"], "completed")
            connection = sqlite3.connect(database)
            event = connection.execute(
                "SELECT status,attempts,lease_token,lease_expires_at FROM events WHERE id=?",
                (auth["deliveryId"],),
            ).fetchone()
            capability = connection.execute(
                "SELECT status,use_count FROM zulip_topic_capabilities WHERE delivery_id=?",
                (auth["deliveryId"],),
            ).fetchone()
            connection.close()
            self.assertEqual(event, ("completed", 2, None, None))
            self.assertEqual(capability, ("closed", 0))
            self.assertNotIn("release_work", [row["phase"] for row in result["phases"]])

    def test_controller_loss_after_stale_receipt_contains_before_rollback(self):
        if os.geteuid() != 0:
            self.skipTest("root coordinator controller-loss test requires root")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database = root / "state.sqlite"
            auth_path = root / "authorization.json"
            config_path = root / "config.json"
            socket_path = root / "control.sock"
            ledger = root / "zulip-inbound-deliveries.jsonl"
            receipt = root / "receipt.json"
            auth = authorization("controller-loss")
            config_bytes = json.dumps(
                {"phone": {"deliveryHolds": [auth["contextId"]]}}, separators=(",", ":")
            ).encode()
            config_path.write_bytes(config_bytes)
            os.chmod(config_path, 0o640)
            auth["phoneConfigSha256"] = hashlib.sha256(config_bytes).hexdigest()
            auth["phoneHoldStateSha256"] = hashlib.sha256(coordinator.canonical({
                "contextId": auth["contextId"], "held": True,
                "deliveryHolds": [auth["contextId"]],
            }).encode()).hexdigest()
            connection = sqlite3.connect(database)
            connection.executescript("""
                CREATE TABLE events(
                    id TEXT PRIMARY KEY,source TEXT,context_id TEXT,status TEXT,attempts INTEGER,
                    payload_json TEXT,available_at TEXT,updated_at TEXT,lease_token TEXT,
                    lease_expires_at TEXT,last_error TEXT,completed_at TEXT
                );
                CREATE TABLE owned_work_canary_authorizations(
                    delivery_id TEXT PRIMARY KEY,authorization_json TEXT,lease_seconds INTEGER,
                    expires_at TEXT,consumed_at TEXT,consumed_by TEXT,created_at TEXT
                );
                CREATE TABLE zulip_topic_capabilities(
                    delivery_id TEXT PRIMARY KEY,status TEXT,use_count INTEGER,last_used_at TEXT,
                    completed_at TEXT,channel_id INTEGER,topic TEXT,context_id TEXT
                );
                CREATE TABLE outbox(id INTEGER PRIMARY KEY,context_id TEXT,status TEXT);
            """)
            install_hold_attestation(connection, config_path, config_bytes, [auth["contextId"]])
            connection.execute(
                "INSERT INTO events VALUES (?,?,?,'canary-blocked',0,?,NULL,NULL,NULL,NULL,NULL,NULL)",
                (auth["deliveryId"], "zulip", auth["contextId"], json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))),
            )
            connection.execute(
                "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,NULL,NULL,?)",
                (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], coordinator.utc_now()),
            )
            connection.commit()
            connection.close()
            auth_path.write_text(json.dumps(auth), encoding="utf-8")
            os.chmod(auth_path, 0o600)
            ledger.write_text("", encoding="utf-8")
            process = subprocess.Popen([
                "python3", str(ROOT / "runtime" / "owned-work-canary-coordinator.py"),
                "--authorization", str(auth_path), "--socket", str(socket_path),
                "--test-socket-root", str(root), "--database", str(database),
                "--config", str(config_path), "--runtime-ledger", str(ledger),
                "--receipt", str(receipt), "--peer-uid", str(os.geteuid()),
                "--peer-gid", str(os.getegid()), "--hostd-pid", str(os.getpid()),
                    "--timeout-seconds", "30",
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for _ in range(300):
                if socket_path.exists():
                    break
                if process.poll() is not None:
                    self.fail(process.stderr.read())
                time.sleep(0.01)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(socket_path))
            stream = client.makefile("rwb", buffering=0)

            def send(value):
                stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())

            def receive():
                return json.loads(stream.readline())

            send({"v": 1, "type": "consume", "authorization": auth})
            self.assertEqual(receive()["type"], "armed")
            for phase in ("response_waiting", "receipt_waiting", "work_waiting"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            connection = sqlite3.connect(database)
            now = coordinator.utc_now()
            connection.execute(
                "UPDATE events SET status='completed',attempts=2,completed_at=?,updated_at=? WHERE id=?",
                (now, now, auth["deliveryId"]),
            )
            connection.execute(
                "INSERT INTO zulip_topic_capabilities VALUES (?,'issued',0,NULL,NULL,?,?,?)",
                (auth["deliveryId"], int(auth["channelId"]), auth["topic"], auth["contextId"]),
            )
            connection.commit()
            connection.close()
            self.assertEqual(receive()["type"], "release_response")
            send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": "response_released"})
            self.assertEqual(receive()["type"], "release_receipt")
            for phase in ("receipt_released", "receipt_rejected"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            stream.close()
            client.close()
            stdout, stderr = process.communicate(timeout=10)
            self.assertNotEqual(process.returncode, 0, stdout or stderr)
            result = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertEqual(result["outcome"], "aborted")
            self.assertEqual(result["containment"]["eventStatus"], "completed")
            connection = sqlite3.connect(database)
            event = connection.execute(
                "SELECT status,attempts,lease_token,lease_expires_at FROM events WHERE id=?",
                (auth["deliveryId"],),
            ).fetchone()
            capability = connection.execute(
                "SELECT status,use_count FROM zulip_topic_capabilities WHERE delivery_id=?",
                (auth["deliveryId"],),
            ).fetchone()
            connection.close()
            self.assertEqual(event, ("completed", 2, None, None))
            self.assertEqual(capability, ("closed", 0))
            self.assertNotIn("release_work", [row["phase"] for row in result["phases"]])

    def test_root_coordinator_drives_the_exact_one_shot_order(self):
        if os.geteuid() != 0:
            self.skipTest("root coordinator integration requires root")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database = root / "state.sqlite"
            auth_path = root / "authorization.json"
            config_path = root / "config.json"
            socket_path = root / "control.sock"
            ledger = root / "zulip-inbound-deliveries.jsonl"
            receipt = root / "receipt.json"
            auth = authorization()
            config_bytes = json.dumps(
                {"phone": {"deliveryHolds": [auth["contextId"]]}},
                separators=(",", ":"),
            ).encode()
            config_path.write_bytes(config_bytes)
            os.chmod(config_path, 0o640)
            hold_state = {
                "contextId": auth["contextId"],
                "held": True,
                "deliveryHolds": [auth["contextId"]],
            }
            auth["phoneConfigSha256"] = hashlib.sha256(config_bytes).hexdigest()
            auth["phoneHoldStateSha256"] = hashlib.sha256(
                coordinator.canonical(hold_state).encode()
            ).hexdigest()
            connection = sqlite3.connect(database)
            connection.executescript("""
                CREATE TABLE events(
                    id TEXT PRIMARY KEY, source TEXT, context_id TEXT, status TEXT, attempts INTEGER,
                    payload_json TEXT, available_at TEXT, updated_at TEXT, lease_token TEXT,
                    lease_expires_at TEXT, last_error TEXT, completed_at TEXT
                );
                CREATE TABLE owned_work_canary_authorizations(
                    delivery_id TEXT PRIMARY KEY, authorization_json TEXT, lease_seconds INTEGER,
                    expires_at TEXT, consumed_at TEXT,
                    consumed_by TEXT, created_at TEXT
                );
                CREATE TABLE zulip_topic_capabilities(
                    delivery_id TEXT PRIMARY KEY, status TEXT, use_count INTEGER,
                    last_used_at TEXT, completed_at TEXT, channel_id INTEGER,
                    topic TEXT, context_id TEXT
                );
                CREATE TABLE outbox(id INTEGER PRIMARY KEY,context_id TEXT,status TEXT);
            """)
            install_hold_attestation(connection, config_path, config_bytes, [auth["contextId"]])
            connection.execute(
                "INSERT INTO events VALUES (?,?,?,'canary-blocked',0,?,NULL,NULL,NULL,NULL,NULL,NULL)",
                (auth["deliveryId"], "zulip", auth["contextId"], json.dumps({"ownedWorkCanary": auth}, separators=(",", ":"))),
            )
            connection.execute(
                "INSERT INTO owned_work_canary_authorizations VALUES (?,?,?,?,NULL,NULL,?)",
                (auth["deliveryId"], coordinator.canonical(auth), auth["leaseSeconds"], auth["expiresAt"], coordinator.utc_now()),
            )
            connection.commit()
            connection.close()
            auth_path.write_text(json.dumps(auth), encoding="utf-8")
            os.chmod(auth_path, 0o600)
            ledger.write_text("", encoding="utf-8")
            process = subprocess.Popen([
                "python3", str(ROOT / "runtime" / "owned-work-canary-coordinator.py"),
                "--authorization", str(auth_path),
                "--socket", str(socket_path),
                "--test-socket-root", str(root),
                "--database", str(database),
                "--config", str(config_path),
                "--runtime-ledger", str(ledger),
                "--receipt", str(receipt),
                "--peer-uid", str(os.geteuid()),
                "--peer-gid", str(os.getegid()), "--hostd-pid", str(os.getpid()),
                "--timeout-seconds", "30",
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            for _ in range(200):
                if socket_path.exists():
                    break
                if process.poll() is not None:
                    self.fail(process.stderr.read())
                time.sleep(0.01)
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.connect(str(socket_path))
            stream = client.makefile("rwb", buffering=0)

            def send(value):
                stream.write((json.dumps(value, separators=(",", ":")) + "\n").encode())

            def receive():
                return json.loads(stream.readline())

            send({"v": 1, "type": "consume", "authorization": auth})
            self.assertEqual(receive()["type"], "armed")
            for phase in ("response_waiting", "receipt_waiting", "work_waiting"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            connection = sqlite3.connect(database)
            now = coordinator.utc_now()
            connection.execute(
                "UPDATE events SET status='completed',attempts=2,completed_at=?,updated_at=? WHERE id=?",
                (now, now, auth["deliveryId"]),
            )
            connection.execute(
                "INSERT INTO zulip_topic_capabilities VALUES (?,'issued',0,NULL,NULL,?,?,?)",
                (auth["deliveryId"], int(auth["channelId"]), auth["topic"], auth["contextId"]),
            )
            connection.commit()
            connection.close()
            self.assertEqual(receive()["type"], "release_response")
            send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": "response_released"})
            self.assertEqual(receive()["type"], "release_receipt")
            for phase in ("receipt_released", "receipt_rejected"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            self.assertEqual(receive()["type"], "release_work")
            send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": "work_released"})
            now = coordinator.utc_now()
            connection = sqlite3.connect(database)
            connection.execute(
                "UPDATE zulip_topic_capabilities SET status='closed',use_count=1,last_used_at=?,completed_at=? WHERE delivery_id=?",
                (now, now, auth["deliveryId"]),
            )
            connection.commit()
            connection.close()
            ledger.write_text(
                json.dumps({"deliveryId": auth["deliveryId"], "claimedAt": now}) + "\n" +
                json.dumps({"deliveryId": auth["deliveryId"], "completedAt": now}) + "\n",
                encoding="utf-8",
            )
            for phase in ("work_settled", "route_settled"):
                send({"v": 1, "type": "phase", "nonce": auth["nonce"], "deliveryId": auth["deliveryId"], "phase": phase})
            stream.close()
            client.close()
            stdout, stderr = process.communicate(timeout=10)
            self.assertEqual(process.returncode, 0, stderr or stdout)
            result = json.loads(receipt.read_text(encoding="utf-8"))
            self.assertEqual(result["outcome"], "accepted")
            self.assertEqual(result["attempts"], 2)
            self.assertEqual(result["capabilityUseCount"], 1)
            self.assertEqual(result["runtimeLedger"], {"claimed": 1, "completed": 1})
            self.assertEqual(result["phoneHoldBeforeActivation"], result["phoneHoldBeforeWorkRelease"])
            self.assertEqual(result["phoneHoldBeforeWorkRelease"], result["phoneHoldAfterSettlement"])
            self.assertEqual(result["phoneHoldAfterSettlement"]["holdCount"], 1)
            self.assertEqual(len(result["outboxFullRowsSha256"]), 64)
            self.assertEqual(len(result["outboxContextRowsSha256"]), 64)
            ordered = [row["phase"] for row in result["phases"]]
            for before, after in (
                ("duplicate_completed", "response_released"),
                ("response_released", "receipt_released"),
                ("receipt_released", "receipt_rejected"),
                ("receipt_rejected", "work_released"),
                ("work_released", "work_settled"),
                ("work_settled", "route_settled"),
            ):
                self.assertLess(ordered.index(before), ordered.index(after))



if __name__ == "__main__":
    unittest.main()
