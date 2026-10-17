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
import re
import socket
import signal
import sqlite3
import stat
import struct
import time
from typing import Any

AUTH_KEYS = {
    "version", "nonce", "contextId", "deliveryId", "source", "senderId",
    "senderIsBot", "channelId", "topic", "bodySha256", "phoneConfigSha256",
    "phoneHoldStateSha256", "expiresAt", "candidateSha",
    "leaseSeconds", "deadlineMs",
}
WAITING_PHASES = {"response_waiting", "receipt_waiting", "work_waiting"}
FIXED_SOCKET_PATH = "/run/troublemaker-hostd/computer-control/owned-work-canary.sock"
HOLD_META_KEY = "owned-work-canary:phone-hold-attestation:v1"


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
    if not isinstance(value.get("nonce"), str) or not re.fullmatch(r"[a-f0-9]{48}", value["nonce"]):
        raise CanaryAbort("authorization nonce is invalid")
    if value.get("deliveryId") != f"zulip-canary:{value['nonce']}":
        raise CanaryAbort("authorization delivery is invalid")
    if (
        not isinstance(value.get("contextId"), str)
        or not value["contextId"]
        or len(value["contextId"]) > 256
        or ":" not in value["contextId"]
        or not isinstance(value.get("senderId"), int)
        or isinstance(value["senderId"], bool)
        or value["senderId"] < 1
        or value.get("senderIsBot") is not True
        or not isinstance(value.get("channelId"), str)
        or not value["channelId"].isdigit()
        or int(value["channelId"]) < 1
        or not isinstance(value.get("topic"), str)
        or not value["topic"]
        or len(value["topic"]) > 256
    ):
        raise CanaryAbort("authorization source identity is invalid")
    for field in ("bodySha256", "phoneConfigSha256", "phoneHoldStateSha256"):
        if not isinstance(value.get(field), str) or len(value[field]) != 64 or any(
            character not in "0123456789abcdef" for character in value[field]
        ):
            raise CanaryAbort(f"authorization {field} is invalid")
    if (
        not isinstance(value.get("candidateSha"), str)
        or not re.fullmatch(r"[a-f0-9]{40}", value["candidateSha"])
        or not isinstance(value.get("leaseSeconds"), int)
        or isinstance(value["leaseSeconds"], bool)
        or not 3 <= value["leaseSeconds"] <= 20
        or not isinstance(value.get("deadlineMs"), int)
        or isinstance(value["deadlineMs"], bool)
        or not 30_000 <= value["deadlineMs"] <= 170_000
    ):
        raise CanaryAbort("authorization candidate or timing is invalid")
    try:
        expires = dt.datetime.fromisoformat(value["expiresAt"].replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise CanaryAbort("authorization expiry is invalid") from error
    now = dt.datetime.now(dt.timezone.utc)
    if expires <= now or expires > now + dt.timedelta(milliseconds=value["deadlineMs"] + 10_000):
        raise CanaryAbort("authorization is expired or overlong")
    return value



def validate_phone_hold(
    config_path: str, authorization: dict[str, Any], expected_gid: int | None = None
) -> dict[str, Any]:
    if not os.path.isabs(config_path) or os.path.realpath(config_path) != config_path:
        raise CanaryAbort("phone config path is not canonical")
    info = os.lstat(config_path)
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_ISLNK(info.st_mode)
        or info.st_uid != 0
        or (expected_gid is not None and info.st_gid != expected_gid)
        or stat.S_IMODE(info.st_mode) != 0o640
    ):
        raise CanaryAbort("phone config ownership or mode is unsafe")
    with open(config_path, "rb") as handle:
        raw = handle.read()
    config_sha256 = hashlib.sha256(raw).hexdigest()
    try:
        config = json.loads(raw)
    except json.JSONDecodeError as error:
        raise CanaryAbort("phone config JSON is invalid") from error
    delivery_holds = config.get("phone", {}).get("deliveryHolds")
    context_id = authorization["contextId"]
    if (
        not isinstance(delivery_holds, list)
        or len(delivery_holds) > 256
        or any(
            not isinstance(value, str)
            or not value
            or len(value) > 256
            or ":" not in value
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
            for value in delivery_holds
        )
        or len(set(delivery_holds)) != len(delivery_holds)
        or delivery_holds.count(context_id) != 1
    ):
        raise CanaryAbort("effective phone delivery hold is missing or invalid")
    hold_state = {
        "contextId": context_id,
        "held": True,
        "deliveryHolds": delivery_holds,
    }
    hold_sha256 = hashlib.sha256(canonical(hold_state).encode()).hexdigest()
    if (
        config_sha256 != authorization["phoneConfigSha256"]
        or hold_sha256 != authorization["phoneHoldStateSha256"]
    ):
        raise CanaryAbort("phone hold fingerprint is stale or mismatched")
    return {
        "configSha256": config_sha256,
        "effectiveStateSha256": hold_sha256,
        "holdCount": delivery_holds.count(context_id),
    }




def process_start_ticks(pid: int) -> str:
    try:
        value = pathlib.Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except OSError as error:
        raise CanaryAbort("attested Hostd process is not live") from error
    fields = value[value.rfind(")") + 2:].split()
    if len(fields) < 20 or not fields[19].isdigit():
        raise CanaryAbort("attested Hostd process identity is invalid")
    return fields[19]


def validate_effective_phone_hold(
    config_path: str,
    database: str,
    authorization: dict[str, Any],
    uid: int,
    gid: int,
    expected_pid: int,
) -> dict[str, Any]:
    file_state = validate_phone_hold(config_path, authorization, gid)

    def read_attestation(connection: sqlite3.Connection):
        row = connection.execute("SELECT value FROM meta WHERE key=?", (HOLD_META_KEY,)).fetchone()
        return json.loads(row[0]) if row else None

    attestation = with_database(database, uid, gid, read_attestation)
    if not isinstance(attestation, dict) or set(attestation) != {
        "version", "pid", "processStartTicks", "startedAt", "configPath",
        "configSha256", "deliveryHolds",
    }:
        raise CanaryAbort("effective phone hold attestation is missing or malformed")
    if (
        attestation["version"] != 1
        or not isinstance(attestation["pid"], int)
        or attestation["pid"] != expected_pid
        or not isinstance(attestation["processStartTicks"], str)
        or attestation["configPath"] != config_path
        or attestation["configSha256"] != authorization["phoneConfigSha256"]
        or not isinstance(attestation["deliveryHolds"], list)
        or attestation["deliveryHolds"].count(authorization["contextId"]) != 1
        or process_start_ticks(attestation["pid"]) != attestation["processStartTicks"]
    ):
        raise CanaryAbort("effective live phone hold attestation differs")
    effective_state = {
        "contextId": authorization["contextId"],
        "held": True,
        "deliveryHolds": attestation["deliveryHolds"],
    }
    effective_sha256 = hashlib.sha256(canonical(effective_state).encode()).hexdigest()
    if effective_sha256 != authorization["phoneHoldStateSha256"]:
        raise CanaryAbort("effective live phone hold fingerprint differs")
    return {
        **file_state,
        "liveAttestationSha256": hashlib.sha256(canonical(attestation).encode()).hexdigest(),
    }




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



def contain_failure(
    database: str,
    authorization: dict[str, Any],
    uid: int,
    gid: int,
    reason: str = "owned_work_canary_aborted",
) -> dict[str, Any]:
    """Atomically make the exact canary non-replayable before old-code rollback."""
    timestamp = utc_now()
    authorization_json = canonical(authorization)

    def transaction(connection: sqlite3.Connection) -> dict[str, Any]:
        connection.execute("BEGIN IMMEDIATE")
        try:
            event = connection.execute(
                "SELECT source,context_id,status,attempts,payload_json,lease_token,lease_expires_at "
                "FROM events WHERE id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            durable = connection.execute(
                "SELECT authorization_json FROM owned_work_canary_authorizations WHERE delivery_id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            if event is None or durable is None:
                raise CanaryAbort("containment event or authorization is missing")
            if (
                event["source"] != "zulip"
                or event["context_id"] != authorization["contextId"]
                or event["payload_json"] is None
                or json.loads(event["payload_json"]).get("ownedWorkCanary") != authorization
                or durable["authorization_json"] != authorization_json
            ):
                raise CanaryAbort("containment identity differs")
            if event["status"] not in {"completed", "dead"}:
                connection.execute(
                    "UPDATE events SET status='dead',lease_token=NULL,lease_expires_at=NULL,"
                    "last_error=?,updated_at=? WHERE id=?",
                    (reason[:1000], timestamp, authorization["deliveryId"]),
                )
            elif event["lease_token"] is not None or event["lease_expires_at"] is not None:
                connection.execute(
                    "UPDATE events SET lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?",
                    (timestamp, authorization["deliveryId"]),
                )
            capability = connection.execute(
                "SELECT status,use_count FROM zulip_topic_capabilities WHERE delivery_id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            if capability is not None and capability["status"] == "issued":
                connection.execute(
                    "UPDATE zulip_topic_capabilities SET status='closed',completed_at=? "
                    "WHERE delivery_id=? AND context_id=? AND status='issued'",
                    (timestamp, authorization["deliveryId"], authorization["contextId"]),
                )
            final_event = connection.execute(
                "SELECT status,attempts,lease_token,lease_expires_at,last_error FROM events WHERE id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            final_capability = connection.execute(
                "SELECT status,use_count,completed_at FROM zulip_topic_capabilities WHERE delivery_id=?",
                (authorization["deliveryId"],),
            ).fetchone()
            if final_event["status"] not in {"completed", "dead"}:
                raise CanaryAbort("containment did not terminalize the event")
            if final_event["lease_token"] is not None or final_event["lease_expires_at"] is not None:
                raise CanaryAbort("containment left a delivery lease active")
            if final_capability is not None and final_capability["status"] != "closed":
                raise CanaryAbort("containment left the exact capability open")
            connection.commit()
            return {
                "eventStatus": final_event["status"],
                "attempts": final_event["attempts"],
                "capabilityStatus": final_capability["status"] if final_capability else None,
                "capabilityUseCount": final_capability["use_count"] if final_capability else None,
                "containedAt": timestamp,
            }
        except BaseException:
            connection.rollback()
            raise

    return with_database(database, uid, gid, transaction)




def canonical_query_digest(connection: sqlite3.Connection, sql: str, parameters=()) -> dict[str, Any]:
    cursor = connection.execute(sql, parameters)
    columns = [description[0] for description in cursor.description]
    rows = []
    for row in cursor.fetchall():
        encoded = {}
        for column, value in zip(columns, row):
            if isinstance(value, bytes):
                encoded[column] = {"bytesHex": value.hex()}
            else:
                encoded[column] = value
        rows.append(encoded)
    payload = canonical({"columns": columns, "rows": rows}).encode()
    return {"count": len(rows), "sha256": hashlib.sha256(payload).hexdigest()}



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
        full_outbox_digest = canonical_query_digest(
            connection, "SELECT * FROM outbox ORDER BY id"
        )
        context_outbox_digest = canonical_query_digest(
            connection, "SELECT * FROM outbox WHERE context_id=? ORDER BY id",
            (authorization["contextId"],),
        )
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
                "context": context_outbox_digest["count"],
                "fullRowsSha256": full_outbox_digest["sha256"],
                "contextRowsSha256": context_outbox_digest["sha256"],
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
    parser.add_argument("--test-socket-root")
    parser.add_argument("--database", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--runtime-ledger", required=True)
    parser.add_argument("--receipt", required=True)
    parser.add_argument("--peer-uid", required=True, type=int)
    parser.add_argument("--peer-gid", required=True, type=int)
    parser.add_argument("--hostd-pid", required=True, type=int)
    parser.add_argument("--timeout-seconds", type=int, default=170)
    args = parser.parse_args()

    if os.geteuid() != 0:
        raise SystemExit("coordinator must run as root")
    socket_path = pathlib.Path(args.socket)
    trusted_socket_root = pathlib.Path(args.test_socket_root) if args.test_socket_root else pathlib.Path("/run")
    if not socket_path.is_absolute() or not trusted_socket_root.is_absolute():
        raise SystemExit("socket and trust root must be absolute")
    if args.test_socket_root is None and str(socket_path) != FIXED_SOCKET_PATH:
        raise SystemExit("production coordinator socket path differs from the fixed contract")
    if os.path.realpath(socket_path.parent) != str(socket_path.parent):
        raise SystemExit("socket parent ancestry is not canonical")
    if os.path.realpath(trusted_socket_root) != str(trusted_socket_root):
        raise SystemExit("socket trust root is not canonical")
    try:
        socket_path.relative_to(trusted_socket_root)
    except ValueError as error:
        raise SystemExit("socket escaped its trusted root") from error
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
    consumed_path = pathlib.Path(args.authorization + ".consumed")

    def terminate(signum, _frame):
        raise CanaryAbort(f"coordinator received signal {signum}")

    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        signal.signal(signum, terminate)

    try:
        parent = socket_path.parent
        current = parent
        while True:
            parent_info = os.lstat(current)
            if (
                not stat.S_ISDIR(parent_info.st_mode)
                or stat.S_ISLNK(parent_info.st_mode)
                or parent_info.st_uid != 0
                or (stat.S_IMODE(parent_info.st_mode) & 0o022) != 0
                or os.path.realpath(current) != str(current)
            ):
                raise CanaryAbort("socket ancestry must be canonical, root-owned, and not group/world writable")
            if current == trusted_socket_root:
                break
            if current.parent == current:
                raise CanaryAbort("socket ancestry escaped its trusted root")
            current = current.parent
        if socket_path.exists() or consumed_path.exists():
            raise CanaryAbort("socket or consumed authorization already exists")
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(socket_path))
        os.chown(socket_path, 0, args.peer_gid)
        os.chmod(socket_path, 0o660)
        socket_info = os.lstat(socket_path)
        if (
            not stat.S_ISSOCK(socket_info.st_mode)
            or stat.S_ISLNK(socket_info.st_mode)
            or socket_info.st_uid != 0
            or socket_info.st_gid != args.peer_gid
            or stat.S_IMODE(socket_info.st_mode) != 0o660
        ):
            raise CanaryAbort("bound socket ownership or mode differs")
        listener.listen(1)
        listener.settimeout(min(args.timeout_seconds, 10))

        initial_hold = validate_effective_phone_hold(
            args.config, args.database, authorization, args.peer_uid, args.peer_gid, args.hostd_pid
        )
        receipt["phoneHoldBeforeActivation"] = initial_hold
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
        receipt["phoneHoldBeforeWorkRelease"] = validate_effective_phone_hold(
            args.config, args.database, authorization, args.peer_uid, args.peer_gid, args.hostd_pid
        )

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

        receipt["phoneHoldAfterSettlement"] = validate_effective_phone_hold(
            args.config, args.database, authorization, args.peer_uid, args.peer_gid, args.hostd_pid
        )
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
            "outboxFullRowsSha256": final["outbox"]["fullRowsSha256"],
            "outboxContextRowsSha256": final["outbox"]["contextRowsSha256"],
            "activeEvents": final["activeEvents"],
        })
    except BaseException as error:
        for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            signal.signal(signum, signal.SIG_IGN)
        receipt["completedAt"] = utc_now()
        receipt["error"] = str(error)
        try:
            receipt["containment"] = contain_failure(
                args.database, authorization, args.peer_uid, args.peer_gid
            )
        except BaseException as containment_error:
            receipt["containmentError"] = str(containment_error)
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
