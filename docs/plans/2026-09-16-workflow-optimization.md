# Workflow optimization policy

Status: completed
Last action: policy/config verification passed.
Owner: Main (Pi)
Created: 2026-09-16

## Context
User approved the Advisor recommendation to optimize the intent-to-commit workflow and to codify differentiated handling for resumed, small, medium, and large tasks. Scope: global Pi policy under ~/.omp/agent/RULES.md and concurrency under ~/.omp/agent/config.yml, plus this durable record. Excluded: application source, project tests, automatic commits, automatic pushes, and enabling Advisor by default.

## Approach
- Keep evidence-driven planning, implementation, verification, review, and acceptance gates.
- Make commit conditional on explicit authorization; keep push separately authorized.
- Keep Advisor disabled by default; invoke only on explicit consultation or approval requests.
- Enforce the stricter three-subagent concurrency cap and align config with policy.
- Define resume, small, medium, and large task procedures with proportional overhead.
- Make repair and affected re-verification conditional on review findings.

## Critical files and ownership
| File | Owner | Purpose |
|---|---|---|
| ~/.omp/agent/RULES.md | Main | Global workflow policy |
| ~/.omp/agent/config.yml | Main | Runtime concurrency limit |
| docs/plans/2026-09-16-workflow-optimization.md | Main | Durable specification, checklist, evidence |

## Verification
| AC | Observable acceptance | Check |
|---|---|---|
| AC-01 | Policy distinguishes resume, small, medium, and large task execution | Read updated RULES.md sections |
| AC-02 | Commit/push authorization is explicit and Advisor remains opt-in | Read policy and config |
| AC-03 | Runtime maxConcurrency equals policy cap of 3 | Read config value |
| AC-04 | Conditional repair/re-verification and acceptance evidence are stated | Read final delivery policy |
| AC-05 | Changes are limited to intended policy/config/record files | Targeted diff/status inspection |

## Execution checklist
- [x] T-01 — Create approved workflow policy record — AC-01..AC-05
- [x] T-02 — Update global workflow rules — AC-01, AC-02, AC-04
- [x] T-03 — Align configured concurrency limit — AC-03
- [x] T-04 — Verify policy and configuration changes — AC-01..AC-05

## Evidence and handoff
- AC-01: PASS — `~/.omp/agent/RULES.md` defines resumed, small, medium, and large task procedures.
- AC-02: PASS — Advisor remains opt-in; commit is authorization-gated; push requires separate authorization.
- AC-03: PASS — `omp config get task.maxConcurrency && omp config get advisor.enabled` exited 0; outputs `3` and `false`.
- AC-04: PASS — final delivery policy makes repair/re-verification conditional and requires acceptance evidence.
- AC-05: PASS — targeted status check shows this work record as the only project file changed; policy/config changes are confined to the intended files under `~/.omp`.
- No application tests/builds run; only policy/config behavior was changed.

Next safe action: apply this workflow to subsequent tasks; commit or push only when explicitly authorized.

## Assumptions and contingencies
The user’s explicit approval authorizes these policy/config edits, not future repository commits or pushes. Existing unrelated work must remain untouched. Main remains sole writer of this record.
