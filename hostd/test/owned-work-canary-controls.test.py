#!/usr/bin/env python3
import importlib.util
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


def authorization(delivery_id="delivery-neutral"):
    return {
        "version": 1,
        "nonce": "neutral-nonce",
        "contextId": "context-neutral",
        "deliveryId": delivery_id,
        "source": "zulip",
        "senderId": 42,
        "channelId": "7",
        "topic": "neutral topic",
        "bodySha256": "a" * 64,
        "expiresAt": "2999-01-01T00:00:00.000Z",
        "candidateSha": "b" * 40,
        "leaseSeconds": 5,
        "deadlineMs": 90000,
    }


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
            self.assertEqual(coordinator.require_root_file(str(path))["deliveryId"], "delivery-neutral")
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


    def test_root_coordinator_drives_the_exact_one_shot_order(self):
        if os.geteuid() != 0:
            self.skipTest("root coordinator integration requires root")
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            database = root / "state.sqlite"
            auth_path = root / "authorization.json"
            socket_path = root / "control.sock"
            ledger = root / "zulip-inbound-deliveries.jsonl"
            receipt = root / "receipt.json"
            auth = authorization()
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
                "--database", str(database),
                "--runtime-ledger", str(ledger),
                "--receipt", str(receipt),
                "--peer-uid", str(os.geteuid()),
                "--peer-gid", str(os.getegid()),
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
