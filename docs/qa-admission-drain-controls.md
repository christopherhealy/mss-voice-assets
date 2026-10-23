# Migration-free QA drain bootstrap — corrected local review

## Decision and corrections

The original c94c1cc / 8b15a6d proposal is **not safe to install unchanged**: missing state immediately restricted QA, and a frozen-process restart with lost local state could restore completion access. Both are corrected here without changing schema, ownership, authentication, billing or provider callback contracts.

Ingle bootstrap starts from last verified deployed QA **0955c1be5eb9aecb17b94be20c40d91be82153d0**, not the full authorization release. It contains only the control delta. It does not include or require either capability/attribution migration. Voice starts from last-known remote **6b9bffdaffc0aa69053e39a64a1b7f6f350931ce**, whose only difference from deployed d5e215c is the existing QA R2-preflight regression test. The reviewed 8b15a6d control delta and safety corrections are included; no remote work is discarded. Original candidates/worktrees are untouched.

All existing Ingle Member/OTP, Experience/Journal/Progress Lab, Member-pool, Minutes-ledger and Live finalization business files retain baseline bytes except the explicit reservation/redemption admission checks. No private-media or ownership-hardening implementation is imported. Existing legacy access limitations remain for the subsequent bounded security release; the bootstrap does not claim to repair them.

## Passive install and explicit arming

New operator configuration keys (NOT set by this task):

| Key | Default | Meaning |
|---|---|---|
| INGLE_QA_DRAIN_ARMED | unset / false | Passive install: existing requests, providers and workers pass through; the state file is not read. |
| INGLE_QA_DRAIN_ARMED=true | explicit operator change | Enforce QA admission/worker state. Invalid non-false values fail closed rather than opening admissions. |
| INGLE_QA_DRAIN_BOOT_PHASE=drain | default while armed | Restart/lost state holds new admissions/nonessential work closed but preserves trusted completion. |
| INGLE_QA_DRAIN_BOOT_PHASE=freeze | explicit post-drain checkpoint | Restart/lost state holds application SQL, callbacks and workers frozen. Set only after independently verified idle. |

Only exact platform names mss-ingle-qa / mss-voice-assets-qa recognize these settings. Production ignores them even if armed/freeze values exist. A read-only current_database identity check is bounded to five seconds; failure prevents arming but does not make a passive install a request outage.

State files are private operator files, not browser settings. /tmp/ingle-qa-drain-state.json must be regular/non-symlink, owned by the service UID, mode 0600, and have the exact version/service/instance/boolean/expiry fields. The generated instance UUID changes on restart. Old open state cannot be reused after restart. Active leases are at most one hour; uncertainty remains admission-closed. Durable boot phase is platform configuration, not ephemeral filesystem state.

The durable freeze setting is itself a privileged safety transition and may restart the service. Never set it or restart Voice while any supervisor/provider/request/worker remains active. The CLI refuses freeze unless BOTH the Shell and serving process report the durable freeze boot phase, then checks local counters and canonical SQL obligations before acknowledging state. The CLI cannot protect against an administrator deliberately misconfiguring the platform. Never clear the armed/freeze settings to recover availability during migrations.

## Authorization and commands

There is no HTTP setter. Ordinary Members, Student identifiers, cookies, host headers and public/private URLs cannot change mode. GET /_qa/drain/status requires the existing server service secret and returns aggregate status only; POST and ordinary Member cookies receive non-disclosing rejection. Actual state changes require the authenticated QA operator Shell AND explicit armed platform setting. No new secret is required.

In each verified instance, with armed=true and boot_phase=drain:

```sh
node scripts/qa-drain-control.mjs drain
node scripts/qa-drain-control.mjs pause
node scripts/qa-drain-control.mjs renew
```

drain closes admission; pause independently pauses nonessential work without changing admission. Existing supervisors/streams/tasks are not cancelled. Essential closure recovery remains enabled. All hostnames share the middleware/SQL/provider boundary. Direct reserve/redeem calls recheck before commit. Existing redeemed reservations are untouched until provider-confirmed, idempotent settlement. New nonessential background claims stop; external uninstrumented processes are not fenced.

After zero provider/stream/SQL/background obligations and separately authorized durable freeze configuration:

```sh
node scripts/qa-drain-control.mjs freeze
```

Status acknowledgement must be from the same instance and match requested state. Failure after atomic state write is uncertain: inspect status; do not assume success or automatically reopen. Original callback handlers still authenticate and validate grant/session identity. During final freeze, delayed callbacks receive retryable 503 and reservations remain held; after controlled resume the same event settles once.

Short controlled resume after compatible code/schema verification:

```sh
node scripts/qa-drain-control.mjs resume-workers
# Completion resumes; admission remains closed. Check queues/ledger/health.
node scripts/qa-drain-control.mjs resume
```

resume refuses while frozen/paused; it does not automatically follow drain/pause/freeze. The durable freeze checkpoint remains a fail-closed restart default until separately changed. While armed, renew leases before expiry. A permanent return to passive QA is a separate authorized platform resume: with Ingle admission still closed and all providers idle, restore Voice to armed=false first, then Ingle last. Config changes can restart services; do not open admissions and then restart active Voice to clear flags. Do not enable any previously disabled adaptation/audio/HeyGen flag.

## Schema and callback compatibility

Only existing current_database and six existing queue/grant tables are referenced by control SQL: ingle_live_grants, ingle_live_lifecycle_events, ingle_vox_retry_queue, fluently_scene_adaptation_jobs, ingle_character_generations and ingle_gallery_video_jobs. All exist in the captured actual QA schema (192 tables). No new column/index/extension/ownership table is required. No migration or live database query was executed here. Fresh schema/role drift and SELECT privileges must still be checked before deployment/activation.

Tests exercise the real lifecycle HTTP client against real callback handlers with synthetic SQL adapters for both Ingle and Fluently grants, with neither bootstrap, Ingle-only, Voice-only and both. Passive and admission-draining combinations retain the same session-started/session-closed payload/auth/ledger contracts. Duplicate closures debit once. A callback cannot create a new grant or session. Full frozen startup permits only the exact internal database identity query, not general application SQL.

## Exact deployment order — future approval only

1. Recheck Render/Git identities, source SHAs, dependency locks, all replicas, operator access and unarmed settings. Ingle target: mss-ingle-qa / srv-db76i4bbc2fs73fespf0, branch qa/gpt-live-2026-10-13. Voice target: mss-voice-assets-qa / srv-db7ll5q5b2lc738d9upg, same branch name in its own repository. Stop on any unreviewed drift; no force push or implicit latest-commit substitution.
2. Deploy the corrected **migration-free Ingle bootstrap only**, with armed unset/false. Do not deploy c94c1cc/full authorization release before its migrations. Keep the old Voice process/supervisors untouched. Verify health, canonical Member/OTP including StorySisters, existing access and callbacks. This install must not activate drain.
3. Separately authorize Ingle arming (armed=true, boot_phase=drain), then issue/verify drain in every instance. This closes canonical authorization and redemption for BOTH products, including direct/private Voice Live starts. Existing Voice supervisors and outgoing closure callbacks remain alive. Do NOT enable Ingle maintenance.
4. Establish an explicit no-new-work window for old Voice TTS/private callers and Help/StorySisters/other writers. Optional authorized **Voice-only** public maintenance can suppress new public requests while its outgoing sideband/closure traffic continues; it does not stop private callers or background work and is not proof of idle. This is a partial bootstrap Live quarantine, NOT a database-wide AI/write freeze.
5. Let existing provider sessions close normally and durable usage settle exactly once. Use fresh independent read-only SQL observations plus trusted provider/stream/worker evidence; browser absence is irrelevant. Expired unredeemed grants are inert; redeemed/unconfirmed grants must not be released. Any unknown/overdue/manual-review obligation => STOP. Also establish old Voice stream/persistence idle, not just zero Live grants.
6. Only after verified idle and canonical admission held closed, deploy corrected Voice bootstrap passively. An old Voice process restart is forbidden before this checkpoint. Verify compatible callbacks/health without creating paid sessions. Arm Voice under a separate approved configuration change while still idle; verify drain/pause on every instance. Do not install intermediate unsafe 8b15a6d.
7. Drain all remaining tasks and pause nonessential workers. Independently stop/inventory external database writers (below). Run the authoritative aggregate/catalog queries in qa-drain-verification.readonly.sql; sufficient stats visibility is mandatory. Counts and same-row watermarks alone do not prove no sleeping jobs or remote providers.
8. With confirmed zero obligations and all writers accounted for, separately approve durable freeze boot settings/restarts while idle, acknowledge freeze locally, and repeat independent SQL/lock/queue verification. Do not rely on Render maintenance to fence private or background access. Establish a fresh recoverable pre-DDL checkpoint.
9. The later bounded Member/Experience release must incorporate these corrected control files into a newly reviewed full candidate. c94c1cc's old state parser/freeze behavior must NOT replace this bootstrap. Approved migrations remain byte-identical. No migration is part of bootstrap deployment.

## Rollback and failure handling

- Before activation, a failed passive Ingle install may be reverted under explicit QA rollback approval to the verified pre-bootstrap baseline only if no ownership/security/schema release has been installed. Existing access/authentication is unchanged by this bootstrap. Never use this exception to roll back the later authorization release or its migrations.
- While draining, keep canonical admissions closed and trusted completion available. Prefer a reviewed forward fix/compatible control build; do not remove the barrier, terminate supervisors or abandon/release reservations. Never restart active Voice as rollback.
- If Voice install fails after verified idle, keep canonical admission closed and Voice unavailable until a compatible build is ready. Do not reopen uncontrolled direct Voice render/generation paths as a shortcut. Database/schema is unchanged by this bootstrap.
- During freeze or after any migration, retain armed=true and durable freeze. Unknown state/restart must remain unavailable. Do not roll back to 8b15a6d/d5/0955 while that would remove the freeze or later ownership protection. Do not automatically reverse migrations or repoint/restore a database.
- A pending/late callback under freeze is a stop condition for DDL. Preserve its durable event and reservation; explicitly restore completion under closed admission when the schema/application pair is safe, then rerun verification. Conflicting usage requires reviewed reconciliation, never fabricated totals.
- Inventory/drain or platform changes require separate authorization; this document executes none.

## Writer inventory and remaining blockers

| Component | Coverage / evidence |
|---|---|
| Ingle QA service srv-db76i4bbc2fs73fespf0 | Request, fetch, Pool/Client SQL and registered Vox task controls. Replica count/replacements need live verification. |
| Voice QA service srv-db7ll5q5b2lc738d9upg | New-session, stream-persistence, supervisor and essential recovery controls. Old processes are not instrumented until safe install. Replica count and actual idle remain unverified. |
| Fluently Vercel Preview | Proxies to guarded backends; no frontend change needed. Ephemeral invocation state must drain; it is not a process-wide database fence. |
| Help QA srv-db8c0nhsrm7s73e4e940 | Local services/ai-usage.js, ai-registry.js and help-router.js can write usage, registry and translations directly via DATABASE_URL. Not covered by this bootstrap. Verify actual QA target and pause independently. |
| StorySisters QA | render.yaml explicitly references ingle-qa-db; local database/families/storytelling modules write shared database rows directly. Not covered. Its canonical OTP proxy is covered by Ingle, but that does not fence family writes. Live deployed feature/schema version and service/replica inventory need verification. |
| Ingle Member component | No independent DB writer found in local component source; canonical requests flow through Ingle. This is not proof of every deployed service. |
| Live recovery queue/supervisors | Embedded Voice process; keep alive during drain, pause only after terminal/ledger proof. No browser counter substitutes for provider closure. |
| Vox retry/manual scripts, avatar/video/adaptation queues | In-process registered tasks guarded; external/manual invokers and other processes require inventory/stop. Pending rows are not permission to redispatch. |
| Stripe deliveries, OAuth/OTP/handoffs, operator jobs | Ingle handlers retain safeguards; final freeze makes delivery retryable/unavailable. External queues and jobs can outlive browser traffic. |
| PostgreSQL schedulers/other roles/hosts | No database-wide fencing added. Current connections, stats visibility, pg_cron/pgAgent, prepared transactions and remote workers were NOT inspected in this local-only task. |

Previous dashboard evidence listed no one-off jobs in Ingle/Voice and four resources in the original QA project; it is historical evidence, not a current exhaustive instance/worker inventory. Help and StorySisters are concrete uncovered writers. Process-local controls cannot certify database-wide quiescence.

Local application/schema compatibility is satisfied for a passive Ingle bootstrap. A combined two-service deployment is **NO-GO pending fresh deployment/instance/configuration checks and proven Voice idle under canonical admission closure**. Activation/freeze/migrations additionally require the external-writer plan and separately approved operations. No QA/Production database, configuration, provider session or release candidate was modified by this review.
