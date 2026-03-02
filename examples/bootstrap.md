# Bootstrap Guide For New Generated Repos

Use this guide to create a new project folder under `generated-repos/<project-name>` from the local `generated-repos/example` template folder.

This is the orchestration doc for "plan mode style" project bootstrapping:
- collect high-level intent,
- ask structured questions,
- generate all required markdowns,
- validate no placeholders remain,
- hand off to swarm execution.

---

## 1) What This Produces

For each new project (example: `generated-repos/minecraft`), create:
- `ENTRY_POINT.md`
- `SPEC.md`
- `AGENTS.md`
- `README.md`
- `RUNBOOK.md`
- `DECISIONS.md`

Do not copy:
- `generated-repos/bootstrap.md` (this file is only a generator playbook)
- `generated-repos/example/INSTRUCTIONS.md` (local note file, not project contract)

---

## 2) Ownership Model

Before first swarm run:
- User creates/finalizes: `SPEC.md`, `AGENTS.md`
- Template bootstrap creates initial: `README.md`, `RUNBOOK.md`, `DECISIONS.md`, `ENTRY_POINT.md`

During swarm run:
- Agent updates: `README.md`, `RUNBOOK.md`, `DECISIONS.md`
- User remains authority for: `SPEC.md`, `AGENTS.md` (agent can propose changes)

---

## 3) Bootstrap Workflow (Plan-Mode Style)

### Phase A: Create Folder + Copy Templates

1. Create new folder:
```bash
mkdir -p generated-repos/<project-name>
```

2. Copy template markdowns:
```bash
cp generated-repos/example/ENTRY_POINT.md generated-repos/<project-name>/
cp generated-repos/example/SPEC.md generated-repos/<project-name>/
cp generated-repos/example/AGENTS.md generated-repos/<project-name>/
cp generated-repos/example/README.md generated-repos/<project-name>/
cp generated-repos/example/RUNBOOK.md generated-repos/<project-name>/
cp generated-repos/example/DECISIONS.md generated-repos/<project-name>/
```

### Phase B: Collect Inputs

Inputs expected from user:
- Project name
- 2-4 sentence high-level product description
- Any hard constraints already known (time, budget, stack, infra limits)

### Phase C: Ask Required Questions

Ask these in batches. Do not skip unanswered required fields.

Batch 1 (product and success):
- Who is the target user?
- What is the primary workflow?
- Top 3 ranked success criteria?
- Hard limits (time, cost, offline/online)?

Batch 2 (acceptance):
- What exact commands/tests define "done"?
- What manual end-to-end demo must pass?
- Any latency/performance thresholds?

Batch 3 (architecture and dependencies):
- Repo topology (single app, monorepo, services)?
- Required boundaries (UI/API/worker/storage)?
- Allowed dependencies?
- Banned dependencies?
- Scaffold-only dependencies allowed temporarily?

Batch 4 (scope control):
- Must-have capabilities (3-7)?
- Nice-to-have capabilities (3-7)?
- Explicit out-of-scope items (3+ minimum)?
- Throughput ranges (task fan-out, branch/PR size, timeline)?

Batch 5 (operations):
- Restart expectations?
- Failure tolerance?
- Resource ceilings?
- Backpressure/rate-limit expectations?

### Phase D: Fill Files

Fill each file with the collected answers:
- `SPEC.md`: complete all sections, remove all placeholders.
- `AGENTS.md`: set concrete dependency/testing/commit policies.
- `README.md`: add exact setup/run/verify commands.
- `RUNBOOK.md`: add monitoring + restart + recovery steps.
- `DECISIONS.md`: add initial architecture decisions.
- `ENTRY_POINT.md`: verify ownership matrix matches the current project policy.

### Phase E: Validate Quality Gates

The bootstrap is incomplete unless all gates pass:
- No placeholder tokens remain (`<...>` or backfilled TODO text).
- `SPEC.md` has explicit acceptance tests with runnable commands.
- `SPEC.md` includes must-have, nice-to-have, and out-of-scope.
- `AGENTS.md` has concrete allowed/banned dependency policy.
- `README.md` can be followed from clean machine assumptions.
- `RUNBOOK.md` has restart and partial failure handling.
- `DECISIONS.md` has at least one active decision.

Optional validation command:
```bash
rg -n "<.*>|TODO|TBD" generated-repos/<project-name>/*.md
```

---

## 4) File Translation Rules

Translate high-level user intent into each file using these rules:

- Put "what and why" in `SPEC.md`.
- Put "how to execute work" in `AGENTS.md`.
- Put "how to run now" in `README.md`.
- Put "how to recover when broken" in `RUNBOOK.md`.
- Put "why architecture choices were made" in `DECISIONS.md`.
- Put "who owns which doc" in `ENTRY_POINT.md`.

If a requirement appears in multiple files, keep one source of truth:
- Product intent: `SPEC.md`
- Execution policy: `AGENTS.md`
- Operational steps: `RUNBOOK.md`

---

## 5) Example: Create `generated-repos/minecraft`

1. Copy templates to `generated-repos/minecraft`.
2. Paste user's Minecraft high-level description into `SPEC.md` Product Statement.
3. Ask missing question batches from Phase C.
4. Fill all docs using Phase D.
5. Run quality gates from Phase E.
6. Start swarm only after user signs off on `SPEC.md` and `AGENTS.md`.

---

## 6) Minimum Completion Criteria (Bootstrap Done)

Bootstrap is complete only when:
- `SPEC.md` and `AGENTS.md` are user-approved.
- `README.md`, `RUNBOOK.md`, and `DECISIONS.md` are non-empty and project-specific.
- `ENTRY_POINT.md` ownership matrix is accurate.
- No unresolved placeholders remain.
