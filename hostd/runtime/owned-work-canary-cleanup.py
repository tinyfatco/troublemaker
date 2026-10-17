#!/usr/bin/env python3
"""Remove only temporary canary authorization state after a sealed accepted trace.

Canonical Hostd event/receipt, capability use/close, runtime delivery ledger,
awareness sequence, and phone/outbox evidence are intentionally preserved.
Filesystem socket/controller removal is performed separately by the root
execution wrapper after this check succeeds.
"""

import argparse
import os
import sqlite3


def fail(message: str) -> None:
    raise SystemExit(message)


def row_tuple(row):
    return tuple(row) if row is not None else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", required=True)
    parser.add_argument("--delivery-id", required=True)
    parser.add_argument("--context-id", required=True)
    args = parser.parse_args()
    if os.geteuid() == 0:
        fail("cleanup must run as the Hostd database owner, not root")

    database = os.path.realpath(args.database)
    if database != args.database or not os.path.isfile(database):
        fail("database must be an existing canonical regular file")
    connection = sqlite3.connect(f"file:{database}?mode=rw", uri=True, timeout=5)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys=ON")
    try:
        connection.execute("BEGIN IMMEDIATE")
        event_before = connection.execute(
            "SELECT * FROM events WHERE id=?", (args.delivery_id,)
        ).fetchone()
        capability_before = connection.execute(
            "SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?", (args.delivery_id,)
        ).fetchone()
        sequence_before = connection.execute(
            "SELECT * FROM awareness_sequences WHERE context_id=?", (args.context_id,)
        ).fetchone()
        outbox_before = connection.execute(
            "SELECT COUNT(*),COALESCE(MAX(id),0),SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) FROM outbox"
        ).fetchone()
        authorization = connection.execute(
            "SELECT consumed_at,consumed_by FROM owned_work_canary_authorizations WHERE delivery_id=?",
            (args.delivery_id,),
        ).fetchone()
        if (
            event_before is None
            or event_before["context_id"] != args.context_id
            or event_before["status"] != "completed"
            or event_before["attempts"] != 2
        ):
            fail("accepted event evidence differs")
        if (
            capability_before is None
            or capability_before["status"] != "closed"
            or capability_before["use_count"] != 1
            or not capability_before["last_used_at"]
            or not capability_before["completed_at"]
            or capability_before["last_used_at"] > capability_before["completed_at"]
        ):
            fail("accepted capability evidence differs")
        if (
            authorization is None
            or not authorization["consumed_at"]
            or authorization["consumed_by"] != "root-coordinator-v1"
        ):
            fail("consumed authorization state differs")
        if connection.execute(
            "SELECT COUNT(*) FROM owned_work_canary_authorizations"
        ).fetchone()[0] != 1:
            fail("authorization table is not one-shot")

        connection.execute(
            "DELETE FROM owned_work_canary_authorizations WHERE delivery_id=?", (args.delivery_id,)
        )
        connection.execute("DROP TABLE owned_work_canary_authorizations")

        event_after = connection.execute(
            "SELECT * FROM events WHERE id=?", (args.delivery_id,)
        ).fetchone()
        capability_after = connection.execute(
            "SELECT * FROM zulip_topic_capabilities WHERE delivery_id=?", (args.delivery_id,)
        ).fetchone()
        sequence_after = connection.execute(
            "SELECT * FROM awareness_sequences WHERE context_id=?", (args.context_id,)
        ).fetchone()
        outbox_after = connection.execute(
            "SELECT COUNT(*),COALESCE(MAX(id),0),SUM(CASE WHEN status='sending' THEN 1 ELSE 0 END) FROM outbox"
        ).fetchone()
        if row_tuple(event_after) != row_tuple(event_before):
            fail("cleanup changed canonical event evidence")
        if row_tuple(capability_after) != row_tuple(capability_before):
            fail("cleanup changed canonical capability evidence")
        if row_tuple(sequence_after) != row_tuple(sequence_before):
            fail("cleanup changed awareness sequence evidence")
        if row_tuple(outbox_after) != row_tuple(outbox_before):
            fail("cleanup changed phone/outbox evidence")
        connection.commit()
    except BaseException:
        connection.rollback()
        raise
    finally:
        connection.close()

    print("temporary owned-work authorization table removed; canonical evidence preserved")


if __name__ == "__main__":
    main()
