#!/usr/bin/env python3
"""Root wrapper fail-safe: terminalize one exact canary before old-code rollback."""

import argparse
import importlib.util
import json
import pathlib


COORDINATOR = pathlib.Path(__file__).with_name("owned-work-canary-coordinator.py")
SPEC = importlib.util.spec_from_file_location("owned_work_canary_coordinator", COORDINATOR)
coordinator = importlib.util.module_from_spec(SPEC)
assert SPEC.loader
SPEC.loader.exec_module(coordinator)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--authorization", required=True)
    parser.add_argument("--database", required=True)
    parser.add_argument("--peer-uid", required=True, type=int)
    parser.add_argument("--peer-gid", required=True, type=int)
    args = parser.parse_args()
    if coordinator.os.geteuid() != 0:
        raise SystemExit("containment wrapper must run as root")
    requested = pathlib.Path(args.authorization)
    consumed = pathlib.Path(args.authorization + ".consumed")
    present = [path for path in (requested, consumed) if path.exists()]
    if len(present) != 1:
        raise SystemExit("exactly one original or consumed authorization file must exist")
    authorization = coordinator.require_root_file(str(present[0]))
    result = coordinator.contain_failure(
        args.database,
        authorization,
        args.peer_uid,
        args.peer_gid,
        "owned_work_canary_rollback_containment",
    )
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
