# Private Fork Baseline

This is the reproducible CP-000 baseline for the private `personal` branch. It
records local Git refs and sanitized repository identity only; credentials and
full remote URLs are intentionally excluded. The machine-readable report is
produced by `scripts/private/report-upstream-delta.mjs`.

## Repository state

| Field | Value |
| --- | --- |
| Repository | `Danmoreng/bb` (sanitized fork identity) |
| Default/working branch | `personal` |
| HEAD | `13f458b1f8716c6226147ce2da97e84f101f0d4c` |
| Private commit | `13f458b1f` — `feat(app): add voice toggle shortcut` |
| Upstream ref | `upstream/main` |
| Current local upstream SHA | `d07c1ce289e73b96c13cc76d483c359dd7c279f2` |
| `origin/main` | `d07c1ce289e73b96c13cc76d483c359dd7c279f2` |
| Merge-base | `d07c1ce289e73b96c13cc76d483c359dd7c279f2` |
| Working tree at capture | Only the untracked `bb-control-plane-development-plan/` directory was present. |

The historical plan was written against upstream SHA
`5fcb4b3b19ea3e086829c4b91538f7be1f69c4f6` (11 August 2026). The current
local upstream ref is `d07c1ce289e73b96c13cc76d483c359dd7c279f2`, so CP-000
uses the latter for all implementation decisions. The historical SHA remains
recorded for traceability and is not treated as the current compatibility base.

## Sync and merge procedure

Upstream synchronization is intentionally explicit: fetch the canonical
upstream into a local tracking ref, run the delta report and review conflict
candidates, then perform a deliberate human-approved merge or rebase into
`personal`. No workflow or script automatically merges, rebases, force-pushes,
or changes branches. The report and touchpoint review are required before a
human merge decision.

## Private touchpoints since merge-base

The following nine committed files are the complete private delta from the
merge-base. Their detailed machine-readable audit manifest is
[`private/upstream-touchpoints.json`](../../private/upstream-touchpoints.json).

| Category | File | Purpose | Owner | Conflict risk |
| --- | --- | --- | --- | --- |
| ui | `apps/app/src/components/promptbox/PromptBoxAppShortcuts.test.tsx` | Tests the `voice.toggle` shortcut and promptbox interaction. | app/promptbox | medium |
| ui | `apps/app/src/components/promptbox/PromptBoxInternal.tsx` | Handles `voice.toggle` in the promptbox shortcut flow. | app/promptbox | medium |
| ui | `apps/app/src/lib/app-command-metadata.ts` | Registers metadata for the `voice.toggle` command. | app/commands | low |
| core | `apps/server/src/services/system/app-keybindings.ts` | Adds `voice.toggle` to server-side keybinding definitions. | server/system | low |
| core | `apps/server/test/system/app-keybindings.test.ts` | Verifies the server-side keybinding definition. | server/system | low |
| docs | `docs/configuration.md` | Documents the voice input configuration. | docs/configuration | low |
| core | `packages/domain/src/app-keybindings.ts` | Adds the shared domain command identifier. | domain/app-keybindings | low |
| generated | `packages/plugin-sdk/bundled-types/bb-plugin-sdk.d.ts` | Generated bundled plugin SDK declarations. | plugin-sdk/generated | high |
| generated | `packages/templates/src/generated/plugin-sdk-dts.generated.ts` | Generated plugin scaffold declarations. | templates/generated | high |

The voice-toggle feature is independent of the Control Plane and is to be
preserved during Control Plane work. It is not reused or replaced by the
Control Plane; its promptbox, server keybinding, domain identifier, docs, and
generated declarations remain separately owned touchpoints.

The untracked `bb-control-plane-development-plan/` directory is deliberately
not in this table and is not classified as an upstream touchpoint. The delta
script reports untracked files separately from committed Git deltas.

## Report and manifest semantics

The report is dynamic and always describes the current local refs. The checked-in
`private/upstream-touchpoints.json` is a manually reviewed, immutable audit
snapshot for the baseline above; it is not regenerated implicitly by the
script. A normal report exposes `newPrivateTouchpoints`,
`noLongerPrivateTouchpoints`, category mismatches, missing annotations, and
path-overlap conflict candidates without failing. `--check-manifest` is the
explicit gate for a reviewed snapshot and exits non-zero when it drifts. Update the manifest only
as part of a deliberate baseline review, with purpose, owner, category, and
conflict-risk annotations for every touchpoint.

## Reproducing the report

The script is read-only with respect to Git: it resolves local refs and runs
Git inspection commands only; it never fetches, merges, checks out, resets,
cleans, or modifies Git state. Fetching a fresh upstream ref is a separate,
explicit operator/CI step.

```sh
node scripts/private/report-upstream-delta.mjs --output /tmp/bb-upstream-delta.json
node scripts/private/report-upstream-delta.mjs --check-manifest --require-upstream --output /tmp/bb-upstream-delta.json
```

Use `--upstream-ref` for an explicit local ref and `--output -` to emit JSON to
stdout. A checkout with no local `upstream/*` ref is reported as `degraded`
rather than being treated as an empty or invented comparison.

## Follow-up

- Re-run the report after every intentional private or upstream sync.
- Review and explicitly update `private/upstream-touchpoints.json` when a
  private touchpoint is added, removed, or changes purpose/ownership/risk.
- Keep Control Plane implementation files out of bb core unless a later spike
  and the M9 patch gate explicitly justify a small, removable hook.
