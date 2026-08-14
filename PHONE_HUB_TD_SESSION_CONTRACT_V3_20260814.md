# META ROSE Phone Hub ↔ TD Session Contract V3

**Status:** release candidate

**Date:** 2026-08-14

**Applies to:** Phone Hub, Supabase, MAIN1, SUB1, SUB2, and every later TD adapter

This is the shared operational contract for all exhibition computers. A module
may change its visuals, effects, particles, timing, and artistic logic without
changing this contract.

## 1. Non-negotiable identity invariant

For one visitor, all five values below must be the same UUID:

```text
Phone Hub UI session id
= Phone Hub DB-local session id
= Supabase sessions.id
= Supabase station_presence.session_id
= TouchDesigner active().session_id
```

If any value differs, the station is **not connected**. Never guess, reuse an
older row, or show `CONNECTED` optimistically.

## 2. Control plane and data plane

### Control plane activation: online and server-confirmed only

- session creation
- canonical color, language, and emotional-name update
- station entry (`station_presence` insert)

`station_presence` activation is never stored in the offline retry queue. A
delayed activation is more dangerous than a visible connection failure because
it could start TD after the visitor has already left.

Station exit is closed directly and read back before the phone leaves a work.
An exact close keyed by `client_ref`, and an exact session-end update keyed by
UUID, may remain in the retry queue because both operations can only deactivate
old state; they can never start a station.

### Data plane: local-first and retryable

- phone UI events and batched analytics
- survey answers
- artifact metadata
- TD interaction events and trace summaries
- TD local CSV logs and local captures

These records keep their original action timestamps and may upload later. A
network failure must not stop a TD render or erase the local TD log.

## 3. Station entry sequence

```text
NFC / QR
→ latest Safari tab claims ownership
→ UI UUID equals DB UUID
→ server session exists, is owned, active, and recent
→ color / language / name are written and read back
→ previous exact client_ref is closed, if any
→ new presence is inserted directly
→ the same client_ref + UUID + station is read back
→ only now Phone Hub shows CONNECTED
→ TD sees the same UUID through v_active_at_station
```

If any step fails, the new station remains disconnected. If the old station
could not be closed, the phone continues to show that old confirmed station.

## 4. Supabase active-station rule

`v_active_at_station` must:

1. rank the newest presence for each station first;
2. then require that row to be open;
3. require its session to have `status = 'active'`;
4. require a recent presence and recent session;
5. return no row when the newest row is invalid.

It must never filter invalid rows first and then resurrect an older open row.
Apply:

```text
supabase_migration_20260814_station_revisit_active_view.sql
```

Do not rerun the full schema on the existing project.

## 5. TouchDesigner rules on every computer

- Read `v_active_at_station` with the TD secret/service credential only.
- A zero-row response, request error, expired row, or wrong station means IDLE.
- Do not retain an old active visitor after a newer poll resolves to IDLE.
- Gate captures and session-attributed events on a current active UUID.
- Keep network work off the TD render thread.
- Write raw interaction events to local CSV even when Supabase is unavailable.
- Send only required live control data to Phone Hub/Supabase; upload or summarize
  the remaining interaction data at checkpoints and idle periods.
- Keep bridge/capture adapter nodes separate from artistic visual nodes.

Station mapping:

| Station | Work | TD source |
|---|---|---|
| `01` | MAIN1 / 명명 | `td_main1` |
| `02` | SUB1 / 개입 | `td_sub1` |
| `03` | SUB2 / 목격 | `td_sub2` |
| `04` | 기록 | adapter only if later required |
| `05` | EXIT | Phone Hub only |

Do not rename, delete, bypass, or directly wire artistic edits into the module's
`META_ROSE_DATA_BRIDGE`, capture adapter/controller, config, local log writer,
or Supabase queue components. Change visuals downstream of their published
outputs/callbacks.

## 6. Privacy and local-only mode

`VIEW THE GUIDE WITHOUT A RECORD` is guide-only. It does not create a Supabase
session and therefore cannot start TD or return a capture. The visitor may later
choose `CREATE AN ANONYMOUS ROSE NUMBER AND CONNECT`; only then is the remote
control session created.

No module may silently turn a local-only visitor into a remote session.

## 7. One-time upgrade procedure

1. Apply the dedicated Supabase migration.
2. Deploy the current Phone Hub files.
3. On every development/test phone, open once:

   ```text
   https://minnie427.github.io/metarose-funeral/?reset=1
   ```

4. Create a new rose and note its full UUID in Supabase.
5. Tag station `01` by the physical NFC tag.
6. Confirm the same UUID in `sessions`, latest open `station_presence`,
   `v_active_at_station`, and MAIN1 `active()`.
7. Trigger Rose12 once.
8. Confirm one capture belongs to that UUID and appears on the same phone.
9. Leave the station and confirm the view returns no station `01` row.

Existing historical rows are not deleted. The migration only ends stale
sessions and closes their open presence lifecycle rows.

## 8. Release gate

Release is allowed only when all are true:

- [ ] Supabase migration succeeds.
- [ ] `v_active_at_station` definition is latest-first and active-only.
- [ ] Browser session-control smoke test passes with queue `0`.
- [ ] Physical NFC station `01` returns the exact new UUID to MAIN1.
- [ ] Rose12 capture returns to the same phone.
- [ ] Station exit makes MAIN1 IDLE.
- [ ] No service/secret key exists in the public repository.
