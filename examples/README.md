# How to create a new project

Make a new project under `target-repo/` (configured via the `TARGET_REPO_PATH` environment variable in `.env`).

When you run Longshot, workers clone and commit to the repository specified by `GIT_REPO_URL`. The local checkout you work with lives at the path set by `TARGET_REPO_PATH` — by default this is `target-repo/` in the project root.

Use bootstrap.md with your development coding agent when creating the spec documents for the new repo. One way is to copy the file into your coding agent CLI.

Example
```
Read the boostrap.md file, and help me create a project that is
  recreating minecraft in the browser
```
