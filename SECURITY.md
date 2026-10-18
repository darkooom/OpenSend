# Security policy

## Reporting a vulnerability

Please do not open a public issue for suspected vulnerabilities.

Use GitHub's private vulnerability reporting form:

<https://github.com/darkooom/OpenSend/security/advisories/new>

Include the affected version or commit, deployment assumptions, reproduction steps, impact and a
minimal proof of concept. Remove credentials, recipient data, message content, customer records and
production logs. Do not test against systems you do not own or have permission to assess.

There is currently no published security email address and no guaranteed response SLA. If private
vulnerability reporting is unavailable, contact the repository owner through a private GitHub
channel and disclose only enough to establish a secure follow-up path.

## Supported versions

OpenSend has not published a stable release. Until the first beta is tagged, only the current
`main` branch is considered for security fixes. After beta releases begin, the newest beta will be
the only supported pre-release line unless a release note states otherwise.

## Security documentation

The implementation's identity, tenant isolation, encryption, SSRF, signing, content-handling and
abuse-control design is described in [docs/SECURITY.md](docs/SECURITY.md). Security reports should
not assume that documented controls replace verification against the affected source revision.
