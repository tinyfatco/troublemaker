#!/usr/bin/env python3
"""Root-owned, one-shot coordinator for the temporary owned-work canary.

The coordinator consumes one root-custodied authorization, atomically activates
its exact blocked event in Hostd SQLite, verifies the runtime peer with
SO_PEERCRED, and releases the response/receipt/work gates only in the reviewed
order. Every timeout or mismatch aborts closed.
"""

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import pathlib
import socket
import sqlite3
import stat
import struct
import time
from typing import Any

AUTH_KEYS = {
    "version", "nonce", "contextId", "deliveryId", "source", "senderId",
    "channelId", "topic", "bodySha256", "expiresAt", "candidateSha",
    "leaseSeconds", "deadlineMs",
}
WAITING_PHASES = {"response_waiting", "receipt_waiting", "work_waiting"}


class CanaryAbort(RuntimeError):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def canonical(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def require_root_file(path: str) -> dict[str, Any]:
    absolute = os.path.abspath(path)
    if absolute != path:
        raise CanaryAbort("authorization path must be absolute")
    info = os.lstat(path)
    if not stat.S_ISREG(info.st_mode) or stat.S_ISLNK(info.st_mode):
        raise CanaryAbort("authorization must be a regular non-symlink file")
    if info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1:
        raise CanaryAbort("authorization must be root-owned 0600 with one link")
    with open(path, "r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict) or set(value) != AUTH_KEYS:
        raise CanaryAbort("authorization shape is invalid")
    if value.get("version") != 1 or value.get("source") != "zulip":
        raise CanaryAbort("authorization version or source is invalid")
    if not isinstance(value.get("nonce"), str) or not value["nonce"]:
        raise CanaryAbort("authorization nonce is invalid")
    if not isinstance(value.get("deliveryId"), str) or not value["deliveryId"]:
        raise CanaryAbort("authorization delivery is invalid")
    if not isinstance(value.get("leaseSeconds"), int) or not 3 <= value["leaseSeconds"] <= 20:
        raise CanaryAbort("authorization lease is invalid")
    expires = dt.datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
    if expires <= dt.datetime.now(dt.timezone.utc):
        raise CanaryAbort("authorization is expired")
    return value


@contextlib.contextmanager
def as_effective_user(uid: int, gid: int):
    prior_uid = os.geteuid()
    prior_gid = os.getegid()
    os.setegid(gid)
    os.seteuid(uid)
    try:
        yield
    finally:
        os.seteuid(prior_uid)
        os.setegid(prior_gid)


def with_database(database: str, uid: int, gid: int, callback):
    with as_effective_user(uid, gid):
        connection = sqlite3.connect(f"file:{database}?mode=rw", uri=True, timeout=5)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            return callback(connection)
        finally:
            connection.close()


def consume_and_activate(database: str, authorization: dict[str, Any], uid: int, gid: int) -> None:
    auth_json = canonical(authorization)
    timestamp = utc_now()

    def transaction(connection: sqlite3.Connection) -> None:
        connection.execute("BEGIN IMMEDIATE")
        try:
            row = connection.execute(
                "SELECT authorization_json,lease_seconds,expires_at,consumed_at,consumed_by "
                "FROM owned_work_canary_authorizations WHERE delivery_id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            event = connection.execute(
                "SELECT source,context_id,status,attempts,payload_json FROM events WHERE id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            if row is None or event is None:
                raise CanaryAbort("authorization or event is missing")
            if row["consumed_at"] is not None or row["consumed_by"] is not None:
                raise CanaryAbort("authorization was already consumed")
            if row["authorization_json"] != auth_json or row["lease_seconds"] != authorization["leaseSeconds"]:
                raise CanaryAbort("durable authorization differs")
            if row["expires_at"] != authorization["expiresAt"] or row["expires_at"] <= timestamp:
                raise CanaryAbort("durable authorization is expired")
            if (
                event["source"] != "zulip"
                or event["context_id"] != authorization["contextId"]
                or event["status"] != "canary-blocked"
                or event["attempts"] != 0
            ):
                raise CanaryAbort("blocked event identity or state differs")
            payload = json.loads(event["payload_json"])
            if payload.get("ownedWorkCanary") != authorization:
                raise CanaryAbort("event authorization differs")
            active = connection.execute(
                "SELECT COUNT(*) FROM events WHERE id!=? AND status IN ('queued','failed','leased','accepted','running')",
                (authorization["deliveryId"],),
            ).fetchone()[0]
            if active != 0:
                raise CanaryAbort("another event is active")
            updated_auth = connection.execute(
                "UPDATE owned_work_canary_authorizations SET consumed_at=?,consumed_by='root-coordinator-v1' "
                "WHERE delivery_id=? AND consumed_at IS NULL AND consumed_by IS NULL",
                (timestamp, authorization["deliveryId"]),
            ).rowcount
            updated_event = connection.execute(
                "UPDATE events SET status='queued',available_at=?,updated_at=? "
                "WHERE id=? AND status='canary-blocked' AND attempts=0",
                (timestamp, timestamp, authorization["deliveryId"]),
            ).rowcount
            if updated_auth != 1 or updated_event != 1:
                raise CanaryAbort("atomic authorization consumption failed")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise

    with_database(database, uid, gid, transaction)


def database_snapshot(database: str, authorization: dict[str, Any], uid: int, gid: int) -> dict[str, Any]:
    def query(connection: sqlite3.Connection) -> dict[str, Any]:
        event = connection.execute(
            "SELECT status,attempts,lease_token,lease_expires_at,last_error,completed_at "
            "FROM events WHERE id=?",
            (authorization["deliveryId"],),
        ).fetchone()
        capability = connection.execute(
            "SELECT status,use_count,last_used_at,completed_at,channel_id,topic,context_id "
            "FROM zulip_topic_capabilities WHERE delivery_id=?",
            (authorization["deliveryId"],),
        ).fetchone()
        outbox = connection.execute(
            "SELECT COUNT(*) AS total,COALESCE(MAX(id),0) AS max_id,"
            "SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) AS sending FROM outbox"
        ).fetchone()
        context_outbox = connection.execute(
            "SELECT COUNT(*) FROM outbox WHERE context_id=?", (authorization["contextId"],)
        ).fetchone()[0]
        active = connection.execute(
            "SELECT COUNT(*) FROM events WHERE status IN ('queued','failed','leased','accepted','running')"
        ).fetchone()[0]
        return {
            "event": dict(event) if event else None,
            "capability": dict(capability) if capability else None,
            "outbox": {
                "total": outbox["total"],
                "maxId": outbox["max_id"],
                "sending": outbox["sending"] or 0,
                "context": context_outbox,
            },
            "activeEvents": active,
        }

    return with_database(database, uid, gid, query)


def send_frame(connection: socket.socket, authorization: dict[str, Any], kind: str) -> None:
    encoded = canonical({"v": 1, "type": kind, "nonce": authorization["nonce"]}).encode() + b"\n"
    connection.sendall(encoded)


def read_frame(stream, connection: socket.socket, deadline: float) -> dict[str, Any]:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise CanaryAbort("coordinator deadline expired")
    connection.settimeout(min(remaining, 5.0))
    line = stream.readline(4097)
    if not line:
        raise CanaryAbort("runtime controller disconnected")
    if len(line) > 4096 or not line.endswith(b"\n"):
        raise CanaryAbort("runtime frame is oversized or unterminated")
    try:
        frame = json.loads(line)
    except json.JSONDecodeError as error:
        raise CanaryAbort("runtime frame is invalid JSON") from error
    if not isinstance(frame, dict):
        raise CanaryAbort("runtime frame is not an object")
    return frame


def require_phase(frame: dict[str, Any], authorization: dict[str, Any], expected: str) -> None:
    if set(frame) != {"v", "type", "nonce", "deliveryId", "phase"}:
        raise CanaryAbort("runtime phase frame shape differs")
    if (
        frame["v"] != 1
        or frame["type"] != "phase"
        or frame["nonce"] != authorization["nonce"]
        or frame["deliveryId"] != authorization["deliveryId"]
        or frame["phase"] != expected
    ):
        raise CanaryAbort(f"runtime phase differs from {expected}")


def wait_event_completed_twice(database: str, authorization: dict[str, Any], uid: int, gid: int, deadline: float):
    while time.monotonic() < deadline:
        snapshot = database_snapshot(database, authorization, uid, gid)
        event = snapshot["event"]
        if event and event["attempts"] > 2:
            raise CanaryAbort("event exceeded two attempts")
        if event and event["status"] == "completed" and event["attempts"] == 2:
            capability = snapshot["capability"]
            if not capability or capability["status"] != "issued" or capability["use_count"] != 0:
                raise CanaryAbort("capability was missing, closed, or used before work release")
            return snapshot
        if event and event["status"] in {"dead", "uncertain"}:
            raise CanaryAbort("event reached a terminal failure before duplicate completion")
        time.sleep(0.1)
    raise CanaryAbort("duplicate completion did not occur before deadline")


def ledger_counts(path: str, delivery_id: str) -> dict[str, int]:
    claimed = completed = 0
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            if record.get("deliveryId") != delivery_id:
                continue
            if isinstance(record.get("claimedAt"), str):
                claimed += 1
            if isinstance(record.get("completedAt"), str):
                completed += 1
    return {"claimed": claimed, "completed": completed}


def write_receipt(path: str, receipt: dict[str, Any]) -> None:
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        os.write(descriptor, (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode())
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorization", required=True)
    parser.add_argument("--socket", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--runtime-ledger", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--peer-uid", required=True, type=int)
    parser.add_argument("--peer-gid", required=True, type=int)
    parser.add_argument("--timeout-seconds", type=int, default=170)
    args = parser.parse_args()

    if os.geteuid() != 0:
        raise SystemExit("coordinator must run as root")
    authorization = require_root_file(args.authorization)
    if args.timeout_seconds * 1000 > authorization["deadlineMs"] + 20_000:
        raise SystemExit("coordinator timeout exceeds authorization bound")
    deadline = time.monotonic() + args.timeout_seconds
    phases: list[dict[str, str]] = []
    receipt: dict[str, Any] = {
        "version": 1,
        "outcome": "aborted",
        "authorizationSha256": hashlib.sha256(canonical(authorization).encode()).hexdigest(),
        "deliveryIdSha256": hashlib.sha256(authorization["deliveryId"].encode()).hexdigest(),
        "startedAt": utc_now(),
        "phases": phases,
    }
    listener = None
    connection = None
    socket_path = pathlib.Path(args.socket)
    consumed_path = pathlib.Path(args.authorization + ".consumed")

    try:
        parent = socket_path.parent
        parent_info = os.lstat(parent)
        if not stat.S_ISDIR(parent_info.st_mode) or stat.S_ISLNK(parent_info.st_mode) or parent_info.st_uid != 0:
            raise CanaryAbort("socket parent must be a root-owned non-symlink directory")
        if socket_path.exists() or consumed_path.exists():
            raise CanaryAbort("socket or consumed authorization already exists")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        os.chown(socket_path, 0, args.peer_gid)
        os.chmod(socket_path, 0o660)
        listener.listen(1)
        listener.settimeout(min(args.timeout_seconds, 10))

        initial = database_snapshot(args.database, authorization, args.peer_uid, args.peer_gid)
        if initial["activeEvents"] != 0:
            raise CanaryAbort("event queue was not clear before activation")
        os.rename(args.authorization, consumed_path)
        directory_fd = os.open(str(pathlib.Path(args.authorization).parent), os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        consume_and_activate(args.database, authorization, args.peer_uid, args.peer_gid)
        phases.append({"phase": "authorization_consumed", "at": utc_now()})

        connection, _ = listener.accept()
        listener.close()
        listener = None
        peer_pid, peer_uid, peer_gid = struct.unpack(
            "3i", connection.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
        )
        if peer_uid != args.peer_uid or peer_gid != args.peer_gid or peer_pid <= 0:
            raise CanaryAbort("runtime peer credentials differ")
        stream = connection.makefile("rb", buffering=0)
        consume = read_frame(stream, connection, deadline)
        if set(consume) != {"v", "type", "authorization"}:
            raise CanaryAbort("consume frame shape differs")
        if consume["v"] != 1 or consume["type"] != "consume" or consume["authorization"] != authorization:
            raise CanaryAbort("consume frame authorization differs")
        send_frame(connection, authorization, "armed")
        phases.append({"phase": "runtime_armed", "at": utc_now()})

        waiting: set[str] = set()
        while waiting != WAITING_PHASES:
            frame = read_frame(stream, connection, deadline)
            phase = frame.get("phase")
            if phase not in WAITING_PHASES or phase in waiting:
                raise CanaryAbort("waiting phase is duplicated or out of order")
            require_phase(frame, authorization, phase)
            waiting.add(phase)
            phases.append({"phase": phase, "at": utc_now()})

        completed_twice = wait_event_completed_twice(
            args.database, authorization, args.peer_uid, args.peer_gid, deadline
        )
        phases.append({"phase": "duplicate_completed", "at": utc_now()})
        send_frame(connection, authorization, "release_response")
        frame = read_frame(stream, connection, deadline)
        require_phase(frame, authorization, "response_released")
        phases.append({"phase": "response_released", "at": utc_now()})

        send_frame(connection, authorization, "release_receipt")
        for expected in ("receipt_released", "receipt_rejected"):
            frame = read_frame(stream, connection, deadline)
            require_phase(frame, authorization, expected)
            phases.append({"phase": expected, "at": utc_now()})
        before_work = database_snapshot(args.database, authorization, args.peer_uid, args.peer_gid)
        if before_work["capability"]["status"] != "issued" or before_work["capability"]["use_count"] != 0:
            raise CanaryAbort("capability changed before work release")

        send_frame(connection, authorization, "release_work")
        for expected in ("work_released", "work_settled", "route_settled"):
            frame = read_frame(stream, connection, deadline)
            require_phase(frame, authorization, expected)
            phases.append({"phase": expected, "at": utc_now()})
        connection.settimeout(5)
        if connection.recv(1) not in (b"",):
            raise CanaryAbort("runtime sent bytes after route settlement")

        final = None
        while time.monotonic() < deadline:
            final = database_snapshot(args.database, authorization, args.peer_uid, args.peer_gid)
            capability = final["capability"]
            if (
                final["event"]["status"] == "completed"
                and final["event"]["attempts"] == 2
                and capability
                and capability["status"] == "closed"
                and capability["use_count"] == 1
                and capability["completed_at"]
                and capability["last_used_at"]
                and capability["last_used_at"] <= capability["completed_at"]
                and final["activeEvents"] == 0
            ):
                break
            time.sleep(0.1)
        else:
            raise CanaryAbort("final event/capability state did not settle")

        counts = ledger_counts(args.runtime_ledger, authorization["deliveryId"])
        if counts != {"claimed": 1, "completed": 1}:
            raise CanaryAbort("runtime ledger does not contain one claim and one completion")
        if final["outbox"] != initial["outbox"]:
            raise CanaryAbort("phone/outbox ledger changed during the canary")
        receipt.update({
            "outcome": "accepted",
            "completedAt": utc_now(),
            "attempts": final["event"]["attempts"],
            "capabilityUseCount": final["capability"]["use_count"],
            "runtimeLedger": counts,
            "outboxUnchanged": True,
            "activeEvents": final["activeEvents"],
        })
    except BaseException as error:
        receipt["completedAt"] = utc_now()
        receipt["error"] = str(error)
        if connection is not None:
            with contextlib.suppress(Exception):
                send_frame(connection, authorization, "abort")
        raise
    finally:
        with contextlib.suppress(Exception):
            if connection is not None:
                connection.close()
        with contextlib.suppress(Exception):
            if listener is not None:
                listener.close()
        with contextlib.suppress(FileNotFoundError):
            socket_path.unlink()
        write_receipt(args.receipt, receipt)


if __name__ == "__main__":
    main()
