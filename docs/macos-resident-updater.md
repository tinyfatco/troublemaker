# macOS Resident Updater

Long-running macOS residents must not unload and reload their own LaunchAgent.
`launchd` can terminate the resident's descendants during job teardown, which
creates a race between `bootout` and `bootstrap` and can leave the resident
unloaded.

The resident updater uses a separate host-owned LaunchAgent. A resident may
publish a clean candidate to a local release repository and enqueue a branch,
but only the updater builds, activates, health-checks, and rolls back the live
runtime.

## Install

Create a host-owned bare Git repository and push a reviewed release branch to
it. Then install the updater with deployment-specific paths:

```bash
scripts/install-macos-resident-updater.sh \
  --runtime-root "/absolute/path/to/resident-data" \
  --resident-label "com.example.resident" \
  --resident-plist "$HOME/Library/LaunchAgents/com.example.resident.plist" \
  --health-url "http://127.0.0.1:3000/health" \
  --repository "/absolute/path/to/resident-releases.git" \
  --build-ui
```

The installer copies the update logic into the resident's durable data root and
loads a separate `<resident-label>.updater` LaunchAgent. The live runtime source
tree is never the updater's execution path.

## Request an update

Push the exact reviewed commit to a branch in the configured release repository,
then enqueue it through the installed request command:

```bash
/absolute/path/to/resident-data/host-updater/request-update \
  /absolute/path/to/resident-data/host-updater/updater.conf \
  release
```

The request records both the branch and its commit. If the branch changes before
the updater clones it, activation fails closed and the current resident remains
running.

For each request the updater:

1. Clones a fresh candidate and verifies the requested commit.
2. Installs dependencies and builds the server, plus the UI when configured.
3. Rejects a build that leaves the candidate checkout dirty.
4. Writes and validates a candidate service plist.
5. Stops the resident from the independent updater job, loads the candidate,
   and checks loopback health plus PID stability.
6. Restores the previous plist and runtime automatically if activation fails.

Requests are serialized with a host-owned lock. Failed requests and candidates
are retained under `failed-releases/` for diagnosis; successful activation and
rollback receipts live under `host-updater/state/`.
