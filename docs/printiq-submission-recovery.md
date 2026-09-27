# PrintIQ campaign submission recovery

Applies to Type A campaign submissions. Type B orders use their separate flow.

## Deployment

Apply migration `043_printiq_submission_progress.sql` with the normal API migration command before accepting new submissions on the updated API:

```bash
docker compose -f infra/docker/docker-compose.yml -f infra/docker/docker-compose.do.yml exec -T api ./flowiq-api migrate
```

Take the normal pre-deployment database backup. Missing progress tables cause submission to fail closed before any PrintIQ call. No production migration or deployment is performed by these code changes.

## What a retry does

The first submission freezes its market plans, artwork URLs, PO, visuals and creator name in PostgreSQL. Each PrintIQ call is marked pending before it is sent, then its response is saved. Quote creation, product creation, acceptance and successful uploads are replayed from those records on the next Submit; they are not sent again. Successful markets are recorded once transactionally. Campaign/PO changes or changing test mode while a submission is unfinished are rejected, rather than mixed into existing jobs.

Uploads are sequential, with a one-second delay before each actual upload. Failed attachments do not stop later attachments in that market. Each explicitly rejected upload gets one automatic retry on the same job and URL, after a two-second backoff plus the normal one-second upload pacing. If the retry also fails, later attachments are still attempted and the unresolved upload is reported. The limit is one automatic retry per failed upload per Submit attempt; a later manual Submit can try the unresolved upload again. Timeouts, network/HTTP failures and persistence failures do not trigger automatic retries. The progress label identifies the automatic retry. A PostgreSQL advisory lock prevents concurrent submissions for the same campaign across tabs and API instances.

Network errors, HTTP failures, application timeouts and a process dying during a call leave an uncertain/pending step. They are never blindly resent: even an HTTP 200 timeout response can occur after PrintIQ has attached the file. A database write failure after a response is also treated as uncertain. The saved payload identifies the exact job and URL.

## Reconcile an uncertain attachment

The Submit/Test progress bar polls `GET /api/campaigns/{campaignId}/submission-progress` once per second while submitting. This tenant-scoped endpoint returns only counts and a display label, and is available to normal campaign users. Each completed PrintIQ call has weight 1; each attachment upload has weight 5. The denominator includes every planned market, delivery job and attachment (including PO and visuals). Preparation uses the first 5%, PrintIQ work uses 90%, and the final 5% completes only when the submit request succeeds. Failed/uncertain calls do not count as completed; saved successful steps count on resume. Percentages indicate completed work, not elapsed time or upload bytes.

Use an authenticated **super admin** session with the intended managed tenant. Both endpoints use normal FlowIQ Bearer authentication and `tenantId` query selection. They do not call PrintIQ or modify another tenant.

1. `GET /api/campaigns/{campaignId}/printiq-progress?tenantId={tenantId}` returns the submission ID, step keys, original payloads, states, and reconciliation history.
2. Inspect the exact job and attachment in PrintIQ. HTTP status alone is not proof of success.
3. `POST /api/campaigns/{campaignId}/printiq-progress/resolve-upload?tenantId={tenantId}` with:

```json
{
  "submissionId": "ID_FROM_GET",
  "stepKey": "KEY_FROM_GET",
  "action": "confirmed_uploaded",
  "confirmedInPrintIQ": true,
  "note": "Verified the exact PDF on the specified PrintIQ job"
}
```

Use `confirmed_missing` only after checking that PrintIQ did not attach the file; the next Submit retries that upload. `confirmed_uploaded` skips it. The action, operator and note are retained. Reconciliation is rejected while a submission is running. Only unresolved UploadArtworkURL steps can be resolved this way; these endpoints cannot authorize another quote creation or acceptance.

4. Submit again to finish the saved attempt. Resuming keeps the saved original URLs even if the UI generates a new visuals document.

Uncertain quote creation/product creation/acceptance requires engineering reconciliation using PrintIQ's actual response; do not delete the progress row and resubmit. Keeping a pending state intentionally prevents duplicate jobs.

## Historical failures

Older failed attempts have abbreviated file logs but no durable full-response checkpoints. Until a campaign has a completed durable submission, new submissions check the retained campaign logs and block a new quote if the latest historical attempt failed or ended during a call. Completed database records supersede old log errors from reconciled attempts. This protection only covers retained logs; historical errors outside retention must still be checked manually.

For RSPCA Q51145/Q51146, resolve which existing quote to retain and finish its missing attachments with ADS/PrintIQ before any new submission. The new flow does not automatically import those historical attempts or retry existing production jobs. Do not delete historical logs to bypass this guard.

## Validation

`go test ./...` exercises checkpoint replay, restart recovery, changed payload rejection, explicit upload failure continuation, uncertain-call protection, and timeout reconciliation against a mock PrintIQ server. Set `FLOWIQ_TEST_DATABASE_URL` to a local test database to also exercise migrations and persistence in disposable schemas; never point it at production.
