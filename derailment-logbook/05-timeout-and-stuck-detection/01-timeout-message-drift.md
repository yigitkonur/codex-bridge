# 05 / 01 — Timeout behavior observations

**Scenarios under test:**
- `Scenario: Auto-review turn exceeds timeout`
- `Scenario: No events received for idle timeout period`
- SKILL.md "Timeout: If no terminal tag … within 10 minutes, the task may be stuck."

---

## [BROKE] Gherkin timeout message shape disagrees with actual emission

Expected (Gherkin line 61): `ERROR notification should contain "Auto-review exceeded 300s"`

Actual (observed in `019d9a86-....events`):
```
[ERROR] 019d9a86-... failed | ClientTimeout
  auto-review exceeded 300000ms
```

Capitalization (`auto-review` vs `Auto-review`) and unit (`300000ms` vs `300s`) both drift. A grep matcher written against the spec text will miss the real event.

**Fix target:** Normalize to seconds in the user-facing emission (`auto-review exceeded 300s`) or update the Gherkin to match the millisecond format.

---

## [GUESSED] SKILL.md 10-minute "stuck" advice conflicts with the 120 s idle watchdog

SKILL.md reads: *"If no terminal tag … appears within 10 minutes, the task may be stuck."*

Gherkin timeout table: `no-event idle = 120s`. The internal idle watchdog fires at 120 s and produces `[ERROR]`, so the task would never silently reach 10 minutes unless some bug suppresses the watchdog.

An executor reading SKILL.md will wait 10 minutes when the system will actually have surfaced a `[ClientTimeout]` after 2. Doing the right thing (watching for `[ERROR]`) supersedes the wait.

**Fix target:** SKILL.md `## How It Works` timeout bullet — drop the 10-minute figure or phrase it as "if the CLI hasn't exited and no tag appears for ≥2 min, prefer `status <job-id>` over continued waiting."

---

## [NICE] `status`/`cancel` on bogus job-id return clean `JOB_NOT_FOUND` exit 3

Keep this. The suggestion `"Run status to list known jobs."` is actionable.

---

## [GUESSED] Heartbeat snippet assumes a feature branch

SKILL.md `## Advanced` heartbeat:
```bash
C=$(git log --oneline main..HEAD 2>/dev/null | wc -l | tr -d ' ')
```

If the operator is *on* `main` (my current environment, for example), `main..HEAD` is empty and the heartbeat reports `commits=0` forever. For rebased or tagged workflows this gives misleading zero-signal.

**Fix target:** Use `HEAD@{1}..HEAD` or accept a `$BASE_REF` env var. `monitor-patterns.md` Preset C correctly parameterizes `BASE_REF`; SKILL.md should either link to it or copy the parameterized form.
