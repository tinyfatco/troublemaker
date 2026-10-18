#!/usr/bin/env python3
"""Prepare one blocked, generic owned-work canary event and print its authorization JSON.

Run as the Hostd service user while Hostd is stopped. Redirect stdout to a new
root-custodied 0600 authorization file. The event remains unclaimable until the
root coordinator atomically consumes the authorization and changes its status.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import re
import secrets
import sqlite3
import sys
import time


def fail(message: str) -> None:
    raise SystemExit(message)


def exact_sha(value: str) -> bool:
    return re.fullmatch(r"[a-f0-9]{40}", value) is not None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--config", required=True)
    parser.add_argument("--context-id", required=True)
    parser.add_argument("--principal-hash", required=True)
    parser.add_argument("--channel-id", required=True, type=int)
    parser.add_argument("--channel-name", required=True)
    parser.add_argument("--topic", required=True)
    parser.add_argument("--sender-id", required=True, type=int)
    parser.add_argument("--sender-is-bot", action="store_true", required=True)
    parser.add_argument("--sender-email", required=True)
    parser.add_argument("--sender-name", required=True)
    parser.add_argument("--agent-name", required=True)
    parser.add_argument("--prompt-file", required=True)
    parser.add_argument("--candidate-sha", required=True)
    parser.add_argument("--lease-seconds", type=int, default=5)
    parser.add_argument("--deadline-seconds", type=int, default=150)
    args = parser.parse_args()

    if os.geteuid() == 0:
        fail("prepare must run as the Hostd service user, not root")
    if not exact_sha(args.candidate_sha):
        fail("candidate SHA must be exact lowercase SHA-1")
    if not 3 <= args.lease_seconds <= 20:
        fail("lease must be 3-20 seconds")
    if not 30 <= args.deadline_seconds <= 170:
        fail("deadline must be 30-170 seconds")
    if args.channel_id < 1 or args.sender_id < 1:
        fail("channel and sender IDs must be positive")

    with open(args.prompt_file, "r", encoding="utf-8") as handle:
        prompt = handle.read()
    if not prompt.strip() or len(prompt) > 2000 or "\x00" in prompt:
        fail("prompt must be non-empty, bounded UTF-8 text")
    if prompt.strip().lower() == "stop" or prompt.lstrip().startswith("/"):
        fail("control and stop prompts are forbidden")
    body = f"@**{args.agent_name}** {prompt.strip()}"

    config_path = os.path.realpath(args.config)
    if config_path != args.config or not os.path.isfile(config_path):
        fail("config must be an existing canonical regular file")
    with open(config_path, "rb") as handle:
        config_bytes = handle.read()
    try:
        config = json.loads(config_bytes)
    except json.JSONDecodeError:
        fail("config JSON is invalid")
    delivery_holds = config.get("phone", {}).get("deliveryHolds")
    if (
        not isinstance(delivery_holds, list)
        or len(delivery_holds) > 256
        or not all(isinstance(value, str) and value and len(value) <= 256 and ":" in value for value in delivery_holds)
        or len(set(delivery_holds)) != len(delivery_holds)
        or delivery_holds.count(args.context_id) != 1
    ):
        fail("effective phone delivery hold is missing or invalid")
    hold_state = {
        "contextId": args.context_id,
        "held": True,
        "deliveryHolds": delivery_holds,
    }
    phone_config_sha256 = hashlib.sha256(config_bytes).hexdigest()
    phone_hold_state_sha256 = hashlib.sha256(
        json.dumps(hold_state, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    ).hexdigest()

    nonce = secrets.token_hex(24)
    delivery_id = f"zulip-canary:{nonce}"
    provider_id = f"canary:{nonce}"
    now = dt.datetime.now(dt.timezone.utc)
    expires = now + dt.timedelta(seconds=args.deadline_seconds + 5)
    authorization = {
        "version": 1,
        "nonce": nonce,
        "contextId": args.context_id,
        "deliveryId": delivery_id,
        "source": "zulip",
        "senderId": args.sender_id,
        "senderIsBot": args.sender_is_bot,
        "channelId": str(args.channel_id),
        "topic": args.topic,
        "bodySha256": hashlib.sha256(body.encode("utf-8")).hexdigest(),
        "phoneConfigSha256": phone_config_sha256,
        "phoneHoldStateSha256": phone_hold_state_sha256,
        "expiresAt": expires.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "candidateSha": args.candidate_sha,
        "leaseSeconds": args.lease_seconds,
        "deadlineMs": args.deadline_seconds * 1000,
    }
    authorization_json = json.dumps(authorization, separators=(",", ":"), ensure_ascii=False)
    synthetic_message_id = -(int(nonce[:12], 16) % 2_000_000_000 + 1)
    message = {
        "id": synthetic_message_id,
        "sender_id": args.sender_id,
        "sender_email": args.sender_email,
        "sender_full_name": args.sender_name,
        "sender_is_bot": args.sender_is_bot,
        "timestamp": int(time.time()),
        "content": body,
        "raw_content": body,
        "is_mentioned": True,
        "flags": ["mentioned"],
        "type": "stream",
        "stream_id": args.channel_id,
        "display_recipient": args.channel_name,
        "subject": args.topic,
    }
    payload = {"message": message, "ownedWorkCanary": authorization}
    timestamp = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    database_path = os.path.realpath(args.database)
    if database_path != args.database or not os.path.isfile(database_path):
        fail("database must be an existing canonical regular file")
    connection = sqlite3.connect(f"file:{database_path}?mode=rw", uri=True, timeout=5)
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        connection.execute("BEGIN IMMEDIATE")
        context = connection.execute(
            "SELECT target_id FROM contexts WHERE id = ?", (args.context_id,)
        ).fetchone()
        if context is None:
            fail("context does not exist")
        active = connection.execute(
            "SELECT COUNT(*) FROM events WHERE status IN ('queued','failed','leased','accepted','running')"
        ).fetchone()[0]
        if active != 0:
            fail("event queue is not clear")
        if connection.execute(
            "SELECT 1 FROM owned_work_canary_authorizations LIMIT 1"
        ).fetchone() is not None:
            fail("another canary authorization exists")
        connection.execute(
            "INSERT INTO awareness_sequences(context_id,last_sequence) VALUES (?,0) "
            "ON CONFLICT(context_id) DO NOTHING",
            (args.context_id,),
        )
        sequence = connection.execute(
            "UPDATE awareness_sequences SET last_sequence=last_sequence+1 WHERE context_id=? "
            "RETURNING last_sequence",
            (args.context_id,),
        ).fetchone()[0]
        connection.execute(
            "INSERT INTO events(id,source,provider_message_id,provider_thread_id,principal_hash,"
            "target_id,context_id,awareness_sequence,status,attempts,last_error,received_at,"
            "completed_at,payload_json,available_at,lease_token,lease_expires_at,accepted_at,"
            "started_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'canary-blocked',0,NULL,?,NULL,?,?,"
            "NULL,NULL,NULL,NULL,?)",
            (
                delivery_id,
                "zulip",
                provider_id,
                f"channel:{args.channel_id}",
                args.principal_hash,
                context[0],
                args.context_id,
                sequence,
                timestamp,
                json.dumps(payload, separators=(",", ":"), ensure_ascii=False),
                authorization["expiresAt"],
                timestamp,
            ),
        )
        connection.execute(
            "INSERT INTO owned_work_canary_authorizations(delivery_id,authorization_json,"
            "lease_seconds,expires_at,consumed_at,consumed_by,created_at) "
            "VALUES (?,?,?,?,NULL,NULL,?)",
            (
                delivery_id,
                authorization_json,
                args.lease_seconds,
                authorization["expiresAt"],
                timestamp,
            ),
        )
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()

    sys.stdout.write(authorization_json)
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()
