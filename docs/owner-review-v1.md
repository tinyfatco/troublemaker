# Owner review v1 — frozen wire contract

This contract records private review and explicit authorization of an immutable
artifact version. It installs no publisher, model tool, APNs transport, or
automatic external action. The native review UI is a separate consumer.

The normative wire shapes are in [owner-review-v1.schema.json](owner-review-v1.schema.json).
The schema root is a `work_item` response; `$defs` names below identify all other
request and response shapes. Hash, byte-length, binding, and state constraints
in this document also apply. Unknown object keys and unsupported versions are
rejected. Incompatible changes require a new contract version.

## Native artifact and approval

`OwnerReviewArtifactVersion` and `OwnerReviewApproval` match the corresponding
Swift types in `ComputerMobileCore/OwnerPushNotificationContract.swift`:

```json
{
  "version": 1,
  "work_item_id": "work-item-example",
  "revision_id": "revision-one",
  "media_id": "media-one",
  "media_sha256": "<64 lowercase hex characters>",
  "text_sha256": "<64 lowercase hex characters>",
  "action": "publish",
  "account_id": "account-one"
}
```

```json
{
  "version": 1,
  "approval_id": "approval-one",
  "artifact_approval_digest": "<64 lowercase hex characters>"
}
```

`artifact_approval_digest` is SHA-256 of the following UTF-8 strings joined with
one LF (`\n`) and **no trailing LF**:

```text
computer-owner-review-artifact-v1
1
work_item_id
revision_id
media_id
media_sha256
text_sha256
publish
account_id
```

The field names in that block stand for their values. Media SHA-256 covers exact
decoded bytes. Text SHA-256 covers exact UTF-8 text, including whitespace and
line endings, without Unicode normalization. Text must be well-formed Unicode.
The shared synthetic [digest vector](../test/fixtures/owner-review-v1.json)
includes the complete canonical string, media, text, artifact and approval.

All identifiers use the existing server device contract's 1–128 ASCII letters,
digits, `.`, `_`, `:`, and `-`. This is a supported subset of Swift's wider Unicode
identifier validation. Digests are exactly 64 lowercase hexadecimal characters.
V1 supports `publish` only. The opaque account identifier must identify the exact
destination account in the consuming server's trusted account registry; a
publisher must never silently substitute its default account or action.

## Authenticated client routes

Prefix: `/api/v2/agents/{route_agent_id}/owner-review-items/{work_item_id}`.

| Method and suffix | Request | Success response |
| --- | --- | --- |
| `GET` (no suffix) | Empty body | `work_item` |
| `GET /revisions/{revision_id}/media` | Empty body | Exact media bytes |
| `POST /approvals` | `OwnerReviewApproval` | `decision_result` |
| `POST /rejections` | Same three fields as `OwnerReviewApproval` | `decision_result` |

All success responses use HTTP 200 and `Cache-Control: no-store`. JSON POSTs use
`application/json` (optional `charset=utf-8`). Query parameters are prohibited.
Media responses include their recorded content type, byte length, attachment
disposition, `nosniff`, and a sandbox content security policy. There are no signed
URLs, redirects, or unauthenticated media routes. Old media remains immutable
and privately fetchable by its revision; approving it after an edit fails.

Requests require the existing P-256 `DeviceGrant` request signature, including
method, full path, timestamp, fresh nonce, content type, exact body digest, and
subject identity. Enrollment must explicitly include the new `owner_review`
scope. Existing grants gain no authority automatically. The native grant scope
enum/enrollment UI must adopt this scope before enabling its review renderer.
The owner bearer can enroll/revoke grants, but cannot fetch or approve review
items. The producer bearer also cannot act as a device approval.

The facade derives binding, route, and subject from the verified grant. The work
item must match all three. Wrong bindings receive 404. The facade checks the
current upstream subject identity and rechecks grant revocation/expiry after
that lookup. Missing scope, stale signatures, tampered bodies, revoked grants,
and nonce replay fail before any review mutation. The store consumes only this
verified authority; callers must not expose its direct methods to a model.

The UI must fetch the current item and media, verify both content hashes and
the artifact approval digest, visibly render the exact text/media/action/account,
and submit the approval only after an explicit owner choice. Local cached review
state alone is insufficient. Rejection uses the same identity shape; its route
records `rejected` and confers no execution authority.

## Independent server producer routes

These routes use the facade's existing independent producer bearer, configured
through `ownerPushProducerToken`. It is never returned to the client or forwarded
to the model runtime. No new credential format or credential store is introduced.

| POST path | Request `$defs` | Response `$defs` |
| --- | --- | --- |
| `/api/v2/owner-review-items` | `put_request` | `mutation_result` |
| `/api/v2/owner-review-executions` | `execution_request` | `execution_result` |
| `/api/v2/owner-review-reconciliations` | `reconciliation_request` | `mutation_result` |

All three require version 1 and explicit `binding_id`, `route_agent_id`, and
`subject_agent_id`; the route must be allowlisted and its current upstream
subject must match. The independently authenticated producer is trusted to assign
the intended relationship and exact account/action. Client-supplied binding or
account overrides are rejected on approval routes.

Creation supplies `expected_revision_id: null`, artifact, exact `text`,
`media_type`, and canonical padded `media_base64`. Edits supply the current
revision as `expected_revision_id` and a never-used revision ID. The store
compares the current revision atomically, verifies both hashes, and retains
immutable history. Reusing a media ID with different bytes within a work item
fails. Changing artifact metadata or content under an existing revision fails.

Limits: 8 MiB decoded media, 128 KiB UTF-8 text, 12 MiB producer creation body,
4 KiB execution/reconciliation and client decision bodies. Supported media types
are PNG, JPEG, MP4, PDF, and plain text. MIME type is producer-declared; clients
must use a safe renderer and verify content bytes. Storage fails closed at 128
items, 64 revisions per item, 256 decisions per revision, or 32 MiB metadata.
History is never silently evicted to make identifiers reusable.

## State and idempotency

`work_item.state` is `pending_review`, `approved`, `rejected`, `uncertain`,
`completed`, or `not_completed`. Responses contain the current artifact, exact
text, content digest, media metadata, binding, and optional latest decision and
execution receipt. A new revision always starts at `pending_review`.

An approval/rejection ID is immutable within a work item, including its history.
A fresh decision for the current digest becomes authoritative. Exact retries
return `duplicate` and the original decision, plus the **current** work item;
they cannot reverse a newer rejection or restore approval after an edit.
Changed reuse of an ID fails. A new ID with a stale digest fails. Producer
revision retries likewise cannot roll back the current revision. Retries use a
fresh signed request nonce; reusing a transport nonce yields HTTP 409.

Execution requires a separate producer request containing the current exact
approval and an immutable `attempt_id`. The current decision must be approved.
The server persists an `uncertain` execution receipt **before** returning
`disposition: claimed, may_execute: true`. Only that first successful claim can
authorize one external attempt. This implementation performs no external action.

Every subsequent exact claim returns `disposition: reconcile_required,
may_execute: false`, including after restart or completion. A different attempt
ID cannot bypass an existing execution claim. `work_item` always describes the
current revision, even when a retry refers to a historical receipt; the response
must never be treated as renewed permission. Once claimed, that revision cannot
receive further decisions. While uncertain, it cannot be edited either.

Timeouts, crashes and lost responses leave the attempt uncertain. A trusted
producer must independently establish the provider's outcome and submit the
matching attempt ID and artifact digest, a unique `reconciliation_id`, and
`outcome: completed` or `not_completed`. Unknown outcomes remain uncertain.
Exact reconciliation retries are idempotent; conflicting outcomes fail. Neither
terminal outcome permits another attempt on the same revision. A new attempt
requires a new revision and a new explicit approval, even when the previous
outcome was `not_completed`.

## Durable storage and wiring

Construct `OwnerReviewStore` with a dedicated absolute directory beneath an
existing protected parent, and inject it as `ConsoleAccessFacadeOptions.ownerReview`.
Omission leaves review unavailable. It needs independent producer authority;
it does not require enabling push or installing an executor. No runtime or
deployment configuration is changed by this implementation.

The store uses owner-only directory/files, content-addressed immutable blobs,
an exclusive local filesystem lock, temporary writes, file fsync, atomic rename,
and directory fsync. Each operation rereads disk under the lock, including reads,
so multiple instances cannot use stale in-memory approvals or observe a pending
write. Blob durability precedes metadata durability. Referenced bytes are checked
before returning review content, approving, and claiming execution.

A write/sync/rename failure returns no success and disables that store instance.
A fresh instance validates the surviving committed document; it does not infer
permission from an earlier failed response. Missing/corrupt metadata, unsafe
permissions/symlinks, or missing/corrupt media fail closed. These guarantees assume
a local filesystem honoring atomic rename and fsync, and exclusive ownership of
this directory. They cannot protect against an operator rolling back the entire
durable store or a compromised producer/account registry.

A crash may leave `writer.lock`; the service does not automatically steal it.
Recovery must first establish that no writer remains, inspect the protected
durable receipt, and reconcile any uncertain external attempt before clearing
the abandoned lock and reopening. Do not delete receipts, reset the directory,
or restore an old snapshot to retry a public action. No such recovery operation
is performed here.

Errors are content-free `{ "error": "<code>" }`: 400 malformed contract, 401
authentication, 403 missing scope/device grant or wrong route/subject proof, 404
unknown route/item/binding, 409 stale/conflicting identity, replay, changed agent
or custody conflict, 413 oversized body, 502 unavailable upstream authority, 503
unavailable/busy/unsafe/uncertain storage, and 507 exhausted capacity. Unexpected
authentication persistence failures return 500 and do not enter review storage.

## Content-free push

`ownerReviewNotification` constructs the existing version-1 owner-push envelope:
`context.kind: task`, `context_id: work_item_id`, `relationship_id: binding_id`,
and `anchor_id: revision_id`. No text, media, account, approval, digest, or URL is
included. Identifiers must be opaque and must not encode private content.
Opening the notification leads to the authenticated GET route above.

Compose `OwnerReviewStore.authorizesContext` with the existing owner-push context
verifier for task pointers; it verifies current revision and exact binding.
Explicit dispatch remains in the existing producer-authenticated owner-push
runtime, with its registration, deduplication, and generic notification copy.
Creating an item or recording a decision does not dispatch a notification.

## Verification

`pnpm test:owner-review` checks the frozen schema/digest, exact bytes, real
P-256 enrollment and signed facade HTTP requests, binding/scope/revocation and
nonce boundaries, edits/retries, content-free push pointers, concurrent store
access, corrupt storage, and write/fsync/rename failures across media, approval,
edit, execution claim, and reconciliation. Fixtures and local fake services are
synthetic. The route tests assert that review performs no upstream action.
