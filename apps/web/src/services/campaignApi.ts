import {
  CampaignCalculationResponse,
  CampaignEditLockInfo,
  CampaignListItem,
  CampaignPrintImage,
  CampaignRecord,
  CampaignSupportingDocument,
  CampaignSubmitResponse,
  CampaignUpsertPayload,
} from '@flowiq/shared';
import { generatePrintIQVisuals } from './printIQVisuals';
import { buildApiUrl } from './apiBase';
import { apiFetchJson, getApiAuthToken } from './apiClient';

function withTenant(path: string, tenantId?: string | null) {
  if (!tenantId) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}tenantId=${encodeURIComponent(tenantId)}`;
}

export async function fetchCampaigns(tenantId?: string | null) {
  return apiFetchJson<{ campaigns: CampaignListItem[] }>(withTenant('/api/campaigns', tenantId));
}

export async function createCampaign(payload: CampaignUpsertPayload, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant('/api/campaigns', tenantId), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function createSubCampaign(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/sub-campaigns`, tenantId), {
    method: 'POST',
  });
}

export async function cloneCampaign(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/clone`, tenantId), {
    method: 'POST',
  });
}

export async function fetchCampaign(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}`, tenantId));
}

export async function deleteCampaign(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ deleted: boolean }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}`, tenantId), {
    method: 'DELETE',
  });
}

export async function updateCampaign(campaignId: string, payload: CampaignUpsertPayload, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}`, tenantId), {
    method: 'PUT',
    body: JSON.stringify(payload),
  });
}

export async function appendCampaignPrintImages(campaignId: string, images: CampaignPrintImage[], tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/print-images`, tenantId), {
    method: 'POST',
    body: JSON.stringify({ images }),
  });
}

export async function appendCampaignSupportingDocuments(
  campaignId: string,
  documents: CampaignSupportingDocument[],
  tenantId?: string | null,
) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/supporting-documents`, tenantId), {
    method: 'POST',
    body: JSON.stringify({ documents }),
  });
}

export async function calculatePersistedCampaign(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<CampaignCalculationResponse>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/calculate`, tenantId), {
    method: 'POST',
  });
}

export type CampaignSubmissionProgress = { progress: number; label: string };

export async function submitCampaignToPrintIQ(campaignId: string, tenantId?: string | null, options?: {
  test?: boolean;
  onProgress?: (progress: CampaignSubmissionProgress) => void;
}) {
  const path = withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/submit-to-printiq`, tenantId);
  const testPath = options?.test ? `${path}${path.includes('?') ? '&' : '?'}test=true` : path;
  options?.onProgress?.({ progress: 3, label: 'Preparing campaign visuals' });
  const visuals = await generatePrintIQVisuals(campaignId, tenantId);
  const body = new FormData();
  body.append('visuals', visuals);
  options?.onProgress?.({ progress: 5, label: 'Preparing PrintIQ submission' });
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const poll = async () => {
    controller = new AbortController();
    const timeout = setTimeout(() => controller?.abort(), 5000);
    try {
      const progress = await apiFetchJson<CampaignSubmissionProgress & { totalCalls: number }>(
        withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/submission-progress`, tenantId),
        { signal: controller.signal, cache: 'no-store' },
      );
      if (!stopped && progress.totalCalls > 0) options?.onProgress?.(progress);
    } catch {
      if (!stopped) options?.onProgress?.({ progress: 0, label: 'Submission is running; waiting for a progress update' });
    } finally {
      clearTimeout(timeout);
      if (!stopped) timer = setTimeout(() => void poll(), 1000);
    }
  };
  if (options?.onProgress) void poll();
  try {
    const response = await apiFetchJson<CampaignSubmitResponse>(testPath, { method: 'POST', body });
    stopped = true;
    options?.onProgress?.({ progress: 100, label: 'Submission complete' });
    return response;
  } finally {
    stopped = true;
    clearTimeout(timer);
    controller?.abort();
  }
}

export async function downloadCampaignPurchaseOrder(campaignId: string, tenantId?: string | null): Promise<Blob> {
  const headers = new Headers();
  const token = getApiAuthToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);

  const response = await fetch(buildApiUrl(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/purchase-order/download`, tenantId)), {
    headers,
  });
  if (!response.ok) {
    const responseText = await response.text();
    let message = `Download failed (${response.status})`;
    try {
      const decoded = JSON.parse(responseText) as { error?: string };
      if (decoded.error) message = decoded.error;
    } catch {
      // Keep the status-based error when the response is not JSON.
    }
    throw new Error(message);
  }
  return response.blob();
}

export async function markCampaignSubmitted(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/mark-submitted`, tenantId), {
    method: 'POST',
  });
}

export async function acquireCampaignEditLock(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ lock: CampaignEditLockInfo }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/edit-lock`, tenantId), {
    method: 'POST',
  });
}

export async function releaseCampaignEditLock(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ released: boolean }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/edit-lock`, tenantId), {
    method: 'DELETE',
  });
}

export async function resetCampaignStatus(campaignId: string, tenantId?: string | null) {
  return apiFetchJson<{ campaign: CampaignRecord }>(withTenant(`/api/campaigns/${encodeURIComponent(campaignId)}/reset-status`, tenantId), {
    method: 'POST',
  });
}
