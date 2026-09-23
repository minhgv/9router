# Durable planning and execution records

Status: completed
Owner: Main (Pi)
Created: 2026-09-16

## Context
Persist multi-step work as a project Markdown record that survives completed todo lists and new sessions. User approved global policy plus per-project records, native plan autosave where supported, and explicit scout model gemini-3.7-flash-medium.
Scope: OMP configuration/policy under ~/.omp and this record. Excluded: gateway code, core patches, extensions, HUD tuning, manual indexes, historical plan migration.

## Approach
- Bind ~/.omp/agent/agents/scout.md explicitly to google-antigravity/gemini-3.7-flash-medium:medium before any scout dispatch; existing modelRoles.scout alone does not bind this agent.
- Amend ~/.omp/agent/RULES.md: one docs/plans/<work-id>.md per multi-step work item, stable AC/task IDs, Main-only record updates, proof and handoff retention, discovery/read-before-resume. Split epic records only when needed.
- Align blueprint headings with native Context / Approach / Critical files / Verification / Assumptions. Scope exclusions remain inside Context; constraints and invariants inside Approach; no implementation pasted into the plan.
- Verify installed CLI support, then enable global plan.autosave without changing autosaveDir or HUD settings. Native approved-plan copies are backup; the project work record remains authoritative.
- Verify with real CLI/config behavior and a fresh read-only scout context; distinguish fresh subagent context from an actual independent main session.
- Review actual policy/config changes, not this plan. Keep evidence and unresolved limits here.

## Critical files and ownership
| File | Owner | Purpose |
|---|---|---|
| ~/.omp/agent/agents/scout.md | Main | Explicit scout model |
| ~/.omp/agent/RULES.md | Policy worker | Durable record policy and unified blueprint |
| ~/.omp/agent/config.yml | Main | Native autosave setting |
| docs/plans/2026-09-16-durable-planning.md | Main | Spec, checklist, evidence, handoff |

## Verification
| AC | Observable acceptance | Check |
|---|---|---|
| AC-01 | Scout dispatch resolves requested Gemini medium, not default/task model | Runtime dispatch metadata where available; explicit frontmatter and configured model |
| AC-02 | Record exists before implementation; contains scope, contracts, AC and checklist | This record predates configuration/policy edits |
| AC-03 | Global policy requires Main-owned per-task updates, AC evidence, retention and read-before-resume | Consolidated review of applied policy |
| AC-04 | Blueprint headings are compatible with native planning mode | Compare local policy with official native prompt |
| AC-05 | Installed CLI recognizes plan.autosave and saved value is true | test-runner CLI config inspection; native approval smoke if available |
| AC-06 | Fresh context can find this record and identify exact completed/pending work without chat history | Fresh-context read-only scout receipt; independent CLI session if safe/available |
| AC-07 | Completed work retains checklist/evidence and other work cannot overwrite it by convention | Final file remains; policy forbids reuse/export-overwrite; review receipt |

## Execution checklist
- [x] T-01 — Gán scout đúng model người dùng yêu cầu — AC-01
- [x] T-02 — Lưu kế hoạch triển khai và tiêu chí nghiệm thu — AC-02
- [x] T-03 — Bổ sung policy hồ sơ Markdown toàn cục — AC-03
- [x] T-04 — Thống nhất template local với native planning — AC-04
- [x] T-05 — Xác minh hỗ trợ và bật native autosave — AC-05
- [x] T-06 — Kiểm chứng checklist và tiếp tục session mới — AC-06
- [x] T-07 — Rà soát thay đổi và lưu bằng chứng — AC-07

## Evidence and handoff
- AC-02: Record created before the first policy/config edit. No runtime code changes.
- Baseline: ~/.omp/agent/config.yml modelRoles.scout is google-antigravity/gemini-3.7-flash-medium:medium; scout.md frontmatter has no model; plan.autosave is not explicitly configured.
- Official model priority: task.agentModelOverrides, agent frontmatter, configured task/session fallback. Source: https://github.com/can1357/oh-my-pi/blob/main/docs/tools/task.md
- AC-01: scout.md explicitly binds google-antigravity/gemini-3.7-flash-medium:medium. PlanningScout runtime session recorded canonical model google-antigravity/gemini-3.7-flash, thinkingLevel medium, resolvedModelIsFallback=false (model_change/thinking_level_change entries). This is runtime normalization, not default-model scouting.
- AC-03/04: PolicyWriter applied durable record lifecycle and unified sections; PolicyReview found no blocking defects. Main clarified that native drafts follow the native prompt, while the project record extends it with tracking. Main also made Markdown authority over session todo explicit, with required work ID/status/next action.
- AC-05: RuntimeProbe verified omp/18.2.1 recognizes plan.autosave; after edit `omp config get plan.autosave` returned true, exit 0. autosaveDir remains unset (native default), HUD remains 60. Native interactive approval/write was not exercised; this verifies supported configuration, not the approval UI.
- AC-06: An independent CLI process with no prior chat history discovered this record and correctly reported in_progress, T-01..T-04 completed and T-05..T-07 pending at the snapshot it read. It quoted the new read-before-resume policy and proposed the correct next action. Exit 0, 10.73s. Canonical Gemini flash with medium thinking, resolvedModelIsFallback=false.
- Reproducible read-only check: `omp -p --no-extensions --no-skills --tools read,grep,glob --model google-antigravity/gemini-3.7-flash-medium --thinking medium --max-time 120s --session-dir ~/.omp/agent/sessions/durable-planning-acceptance "Read-only scout: discover docs/plans records for durable planning; report path, status, completed/pending IDs and next safe action. Read governing resume policy. Do not modify files, spawn agents, or access outside cwd and ~/.omp."` Inspect the actual output against the current checklist rather than pinning historic counts.
- Durable session evidence: ~/.omp/agent/sessions/durable-planning-acceptance/2026-09-16T16-17-36-571Z_01a0ab02-673b-71a0-bbf3-3c9871d48f8a.jsonl (only acceptance-probe content).
- AC-07: Consolidated PolicyReview completed: no blocking defects; template wording clarified in one repair pass. Pre-existing concurrency mismatch (rule cap 3 vs config 4) left unchanged, outside scope. Completed checklist remains in this file; no index, extension, application-code change or temporary script was introduced. Runnable read-only smoke command is retained above.
- Final smoke PASS: independent CLI after repair, exit 0 in 14.58s; discovered completed record, 7/7 checked, zero pending, explicitly said not to resume implementation, correctly distinguished native draft/project record and Markdown authority. `omp config get plan.autosave` still true, exit 0. Session: ~/.omp/agent/sessions/durable-planning-acceptance/2026-09-16T16-29-12-737Z_01a0ab0d-06a1-73e5-98aa-381671c6bcdb.jsonl; canonical Gemini flash, thinking medium, fallback=false.
- Next safe action: no implementation remains for this work. New work gets a new work-id record. Native interactive approve/save UI remains unexercised; configuration support and independent-session discoverability were exercised. No application tests/builds run because no application code changed.

## Assumptions and contingencies
Policy guides agents; it is not event-driven autosync. Native autosave covers approved native plans, not arbitrary chat blueprints. Existing sessions may require reload/new session to load changed policy/settings. Do not claim independent-session or native approval verification unless actually exercised. Access restricted to project and ~/.omp; ask before inspecting installed source outside these roots. No automatic rollback of unrelated edits; reverse only this work's targeted additions if necessary.
