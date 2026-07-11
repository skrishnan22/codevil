# Security

## Supported version

Security fixes are applied to the `main` branch. Self-hosters should track `main` or a tagged release once published.

## Reporting vulnerabilities

Do not open public GitHub issues for security vulnerabilities. Report them privately through [GitHub Security Advisories](https://github.com/skrishnan22/codevil/security/advisories/new).

## Deployment model

Codevil sandboxes execute untrusted LLM-generated code in isolated containers. Treat every session as hostile input.

Deployment secrets, required credentials, and production hardening guidance are documented in `.env.example` and [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).
