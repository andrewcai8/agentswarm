# Scripts

Utility scripts for development and testing.

- `reset-target.sh` — Resets the target repository to its initial commit, deletes worker branches, and clears state
- `test_sandbox.py` — End-to-end tests for Modal sandbox (requires Modal credentials)
- `create-runtime-bundle.sh` — Builds the release runtime tarball consumed by packaged CLI installs
- `generate-homebrew-formula.py` — Generates a Homebrew formula from a release version + sdist SHA256
- `setup-release.sh` — One-time GitHub setup for Homebrew tap repo + release workflow variables/secrets
