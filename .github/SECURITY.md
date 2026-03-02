# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in Longshot, please report it responsibly.

**Do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please use one of these methods:

1. **GitHub Security Advisories** (preferred): [Report a vulnerability](https://github.com/andrewcai8/longshot/security/advisories/new)
2. **Email**: Contact the maintainers directly at andrewca78@gmail.com

### What to include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

### Response timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Depends on severity, but we aim for 30 days

### Scope

This policy covers the Longshot codebase and its infrastructure. Third-party dependencies should be reported to their respective maintainers.

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | ✅        |

## Security Best Practices for Contributors

- Never commit API keys, tokens, or secrets
- Use `.env` files for local configuration (`.env` is gitignored)
- Review `.env.example` for required variables — never hardcode values
