# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities through
[GitHub private vulnerability reporting](https://github.com/tinyfatco/troublemaker/security/advisories/new).
This creates a private discussion with the maintainers and keeps exploit
details out of public issues and pull requests.

Do not include live credentials, customer data, private messages, production
topology, or unrelated personal information in a report. Revoke or rotate any
credential that may already be exposed, then describe it using a redacted
identifier.

A useful report includes:

- the affected Troublemaker revision or release;
- the security impact and the conditions required to reproduce it;
- a minimal proof of concept against a local or otherwise authorized system;
- relevant logs with secrets and private identifiers removed;
- a suggested remediation, when available.

The maintainers will use the private advisory to acknowledge the report,
clarify reproduction details, coordinate a fix, and discuss disclosure timing.
Please allow that process to finish before publishing exploit details.

## Safe research boundaries

Only test systems and data you own or have explicit permission to assess. Do
not degrade service, access another person's conversations or workspace,
extract credentials, retain unauthorized access, or use social engineering.
Use synthetic data and a local sandbox whenever possible.

Reports about a third-party provider should normally go to that provider unless
Troublemaker's integration creates or amplifies the vulnerability.

## Supported code

Security fixes target the current `main` branch. If a problem affects an older
revision, include that revision in the report so the maintainers can determine
whether a supported version is also affected.

For ordinary bugs and feature requests that do not contain sensitive security
details, use the repository's public issue tracker.
