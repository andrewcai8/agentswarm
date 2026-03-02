# Runbook

## Document Ownership
- Type: Agent-maintained living artifact.
- Created by: User or template bootstrap before run.
- Updated by: Agent as operating procedures and recovery steps evolve.

## Operating Modes
- Local dev: `<command>`
- Swarm run: `<command>`
- Recovery run: `<command>`

## Monitoring
- Key logs: `<path or command>`
- Key metrics: `<what to watch>`
- Failure signals: `<what indicates degradation>`

## Recovery Procedures
### Restart Orchestrator
1. `<step>`
2. `<step>`
3. `<verification>`

### Partial Failure Handling
1. `<identify failed component>`
2. `<safe retry or isolation action>`
3. `<verify system returns to healthy state>`

### Resource Ceiling Behavior
- CPU cap response: `<expected behavior>`
- Memory cap response: `<expected behavior>`
- Disk cap response: `<expected behavior>`
