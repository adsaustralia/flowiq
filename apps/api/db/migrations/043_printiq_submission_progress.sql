CREATE TABLE printiq_submission_progress (
    id uuid PRIMARY KEY,
    campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id uuid NOT NULL REFERENCES tenants(id),
    data jsonb NOT NULL,
    recorded_markets jsonb NOT NULL DEFAULT '{}'::jsonb,
    completed boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX printiq_submission_progress_active
    ON printiq_submission_progress(campaign_id) WHERE NOT completed;
