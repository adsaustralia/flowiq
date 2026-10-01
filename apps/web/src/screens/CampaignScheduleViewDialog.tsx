import { shippingLinesWithCreatives } from '../services/shippingCreatives';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CopyPlus, LoaderCircle, ShoppingCart } from 'lucide-react';
import { CampaignRecord, CustomPrintCostRecord, formatKeys, MarketAssetPrintingCostRecord, MarketAssetShippingCostRecord, MarketShippingRateRecord } from '@flowiq/shared';
import { Button, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@flowiq/ui';
import { useAuth } from '../context/AuthContext';
import { submitCampaignToPrintIQ } from '../services/campaignApi';
import { fetchCampaignCustomPrintCosts, fetchCampaignMarketAssetPrintingCosts, fetchCampaignMarketAssetShippingCosts, fetchCampaignMarketDeliveryAddresses, fetchCampaignMarketShippingRates } from '../services/marketDeliveryApi';
import { fetchCampaignSheetNameOverrides } from '../services/sheetNameApi';
import { canonicalKeyForFormat, toCanonicalSheetNameKey } from '../services/sheetNameOverrides';

const QUOTE_AUTOMATION_RESULT_EVENT = 'flowiq:quote-automation-result';

type CampaignScheduleViewDialogProps = {
  open: boolean;
  loading: boolean;
  error: string;
  editLockNotice?: string;
  campaign: CampaignRecord | null;
  tenantId?: string | null;
  onOpenChange: (open: boolean) => void;
  onClose: () => void;
  onClone: () => void;
  cloning?: boolean;
  onEdit: () => void;
};

function formatCampaignDate(value: string) {
  if (!value) return 'TBC';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB');
}

function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`;
}

function toNumber(value: unknown) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function calculateShippingCost(units: number, perBoxPrice: number, postersPerBox: number) {
  if (units <= 0 || perBoxPrice <= 0) return 0;
  const safePostersPerBox = Math.max(1, Math.floor(postersPerBox || 60));
  const boxCount = Math.ceil(units / safePostersPerBox);
  return boxCount * perBoxPrice;
}

function calculatePosterShippingForSheeter(posters: number, pricePerBox: number, postersPerSet: number, setsPerBox: number) {
  if (posters <= 0 || pricePerBox <= 0) return 0;
  const safePostersPerSet = Math.max(1, Math.floor(postersPerSet || 1));
  const safeSetsPerBox = Math.max(1, Math.floor(setsPerBox || 15));
  const sets = posters / safePostersPerSet;
  const boxes = Math.ceil(sets / safeSetsPerBox);
  return boxes * pricePerBox;
}

function quantityForSheetKey(breakdown: Record<string, number>, sheetKey: string) {
  if (typeof breakdown[sheetKey] === 'number') return breakdown[sheetKey];
  const matchingKey = Object.keys(breakdown).find((key) => toCanonicalSheetNameKey(key) === sheetKey);
  return matchingKey ? breakdown[matchingKey] ?? 0 : 0;
}

function assetSheetCostFlagKey(assetId: string, sheetKey: string) {
  return `asset:${assetId}|sheet:${sheetKey}`;
}

function resolveArtworkUrl(imageUrl?: string, thumbUrl?: string) {
  const candidate = thumbUrl || imageUrl || '';
  if (!candidate) return '';
  if (candidate.startsWith('/uploads/campaign-images/')) {
    return candidate.replace('/uploads/campaign-images/', '/api/campaign-images/');
  }
  return candidate;
}

function formatBreakdownLabel(key: string) {
  if (key === 'DOT M') return 'DOT Mega';
  if (key === 'MP') return 'Mega Portrait';
  if (key === 'FF') return 'Ferro Film';
  return key;
}

function deliveryContactName(address: string) {
  const lines = address
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return '';
  const first = lines[0];
  if (first.toUpperCase().startsWith('VIM ') && lines[1]) return lines[1];
  return first;
}

type QuoteAutomationAction = 'download-visuals' | 'download-installs' | 'send-email-to-ads';
type PendingQuoteAutomation = {
  action: QuoteAutomationAction;
};

export function CampaignScheduleViewDialog({
  open,
  loading,
  error,
  editLockNotice = '',
  campaign,
  tenantId,
  onOpenChange,
  onClose,
  onClone,
  cloning = false,
  onEdit,
}: CampaignScheduleViewDialogProps) {
  const { session } = useAuth();
  type AttachedArtworkRow = {
    imageId: string;
    frameCount: number;
    type: string;
  };
  const [selectedArtworkAsset, setSelectedArtworkAsset] = useState<{ title: string; rows: AttachedArtworkRow[] } | null>(null);
  const [selectedAssetDetails, setSelectedAssetDetails] = useState<{
    title: string;
    market: string;
    assetName: string;
    selectedWeeks: number[];
    deliveryAddress: string;
    imageIds: string[];
    attachedArtworkRows: AttachedArtworkRow[];
    posterBreakdown: Record<string, number>;
    frameBreakdown: Record<string, number>;
    postersTotal: number;
    framesTotal: number;
  } | null>(null);
  const [shippingRates, setShippingRates] = useState<MarketShippingRateRecord[]>([]);
  const [assetPrintingCosts, setAssetPrintingCosts] = useState<MarketAssetPrintingCostRecord[]>([]);
  const [customPrintCosts, setCustomPrintCosts] = useState<CustomPrintCostRecord[]>([]);
  const [customPrintCostFormats, setCustomPrintCostFormats] = useState<Record<string, boolean>>({});
  const [customSheetSizeFormats, setCustomSheetSizeFormats] = useState<Record<string, boolean>>({});
  const [assetShippingCosts, setAssetShippingCosts] = useState<MarketAssetShippingCostRecord[]>([]);
  const [marketDeliveryAddresses, setMarketDeliveryAddresses] = useState<Array<{ market: string; deliveryAddress: string }>>([]);
  const [downloadingVisuals, setDownloadingVisuals] = useState(false);
  const [downloadingInstalls, setDownloadingInstalls] = useState(false);
  const [sendingAdsEmail, setSendingAdsEmail] = useState(false);
  const [submittingOrder, setSubmittingOrder] = useState(false);
  const [pendingAutomation, setPendingAutomation] = useState<PendingQuoteAutomation | null>(null);
  const [automationFrameUrl, setAutomationFrameUrl] = useState('');
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');
  const [emailSubmitted, setEmailSubmitted] = useState(false);
  const automationFrameRef = useRef<HTMLIFrameElement | null>(null);
  const hasMappedCreatives = useMemo(() => {
    if (!campaign) return false;
    return campaign.values.campaignMarkets.some((market) =>
      market.assets.some((asset) => {
        const hasFormatMapping = Object.values(asset.creativeImageIds ?? {}).some((imageId) => Boolean((imageId || '').trim()));
        if (hasFormatMapping) return true;
        const hasMultiFormatMapping = Object.values(asset.artworkMaterialAssignments ?? {}).some((assignments) =>
          (assignments ?? []).some((assignment) => Boolean((assignment.artworkImageId || '').trim())),
        );
        if (hasMultiFormatMapping) return true;
        return Boolean((asset.creativeImageId || '').trim());
      }),
    );
  }, [campaign]);
  const hasUploadedPurchaseOrder = Boolean((campaign?.purchaseOrder?.originalName || '').trim());
  const hasDeliveryDueDate = Boolean(campaign?.values.campaignMarkets.length) && (campaign?.values.campaignMarkets.every((market) => Boolean(market.dueDate?.trim())) ?? false);
  const isSubmittedCampaign = (campaign?.status === 'submitted') || emailSubmitted;
  const isEditLockedByOtherUser = Boolean(editLockNotice.trim());
  const canCloneCampaign = campaign?.status === 'submitted';
  const canSubmitSubmittedCampaign = session?.user.role === 'super_admin';

  function startQuoteAutomation(action: QuoteAutomationAction) {
    if (!campaign || typeof window === 'undefined') return;
    if (downloadingVisuals || downloadingInstalls || sendingAdsEmail) return;

    if (action === 'download-visuals' || action === 'download-installs') {
      if (!hasDeliveryDueDate) {
        setActionSuccess('');
        setActionError(action === 'download-installs' ? 'Add a due date for each market before downloading the installation sheet.' : 'Add a due date for each market before downloading visuals.');
        return;
      }
      if (!hasMappedCreatives) {
        setActionSuccess('');
        setActionError(action === 'download-installs' ? 'Map at least one creative to a market asset before downloading the installation sheet' : 'Map at least one creative to a market asset before downloading visuals');
        return;
      }
    } else {
      if (!hasDeliveryDueDate) {
        setActionSuccess('');
        setActionError('Add a due date for each market before sending email to ADS.');
        return;
      }
      if (!hasUploadedPurchaseOrder) {
        setActionSuccess('');
        setActionError('Upload a purchase order file before sending email to ADS');
        return;
      }
      if (!hasMappedCreatives) {
        setActionSuccess('');
        setActionError('Map at least one creative to a market asset before sending email to ADS');
        return;
      }
    }

    setActionError('');
    setActionSuccess('');
    setDownloadingVisuals(action === 'download-visuals');
    setDownloadingInstalls(action === 'download-installs');
    setSendingAdsEmail(action === 'send-email-to-ads');

    const currentParams = new URLSearchParams(window.location.search);
    const nextParams = new URLSearchParams();
    nextParams.set('view', 'quote');
    nextParams.set('campaignId', campaign.id);
    const currentTenantId = tenantId ?? currentParams.get('tenantId');
    if (currentTenantId) nextParams.set('tenantId', currentTenantId);
    if (action === 'download-visuals') {
      nextParams.set('downloadVisuals', '1');
    } else if (action === 'download-installs') {
      nextParams.set('downloadInstalls', '1');
    } else {
      nextParams.set('sendEmailToAds', '1');
    }

    setPendingAutomation({ action });
    setAutomationFrameUrl(`${window.location.origin}${window.location.pathname}?${nextParams.toString()}`);
  }

  useEffect(() => {
    if (!open || !campaign) return;
    let active = true;

    async function loadCosts() {
      try {
        const [ratesResponse, printingResponse, shippingResponse, deliveryAddressesResponse, customCostResponse, sheetResponse] = await Promise.all([
          fetchCampaignMarketShippingRates(tenantId),
          fetchCampaignMarketAssetPrintingCosts(tenantId),
          fetchCampaignMarketAssetShippingCosts(tenantId),
          fetchCampaignMarketDeliveryAddresses(tenantId),
          fetchCampaignCustomPrintCosts(tenantId),
          fetchCampaignSheetNameOverrides(tenantId),
        ]);
        if (!active) return;
        setShippingRates(ratesResponse.rates);
        setAssetPrintingCosts(printingResponse.costs);
        setAssetShippingCosts(shippingResponse.costs);
        setMarketDeliveryAddresses(deliveryAddressesResponse.addresses);
        setCustomPrintCosts(customCostResponse.costs);
        setCustomPrintCostFormats(sheetResponse.settings.customPrintCostFormats ?? {});
        setCustomSheetSizeFormats(sheetResponse.settings.customSheetSizeFormats ?? {});
      } catch {
        if (!active) return;
        setShippingRates([]);
        setAssetPrintingCosts([]);
        setAssetShippingCosts([]);
        setMarketDeliveryAddresses([]);
        setCustomPrintCosts([]);
        setCustomPrintCostFormats({});
        setCustomSheetSizeFormats({});
      }
    }

    void loadCosts();
    return () => {
      active = false;
    };
  }, [campaign?.id, campaign?.summary, open, tenantId]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!pendingAutomation) return;
      const data = event.data as {
        type?: string;
        action?: QuoteAutomationAction;
        status?: 'success' | 'error';
        message?: string;
      };
      if (data?.type !== QUOTE_AUTOMATION_RESULT_EVENT) return;
      if (data.action !== pendingAutomation.action) return;
      if (event.source !== automationFrameRef.current?.contentWindow) return;

      const failed = data.status !== 'success';
      setDownloadingVisuals(false);
      setDownloadingInstalls(false);
      setSendingAdsEmail(false);
      setPendingAutomation(null);
      setAutomationFrameUrl('');
      if (failed) {
        setActionSuccess('');
        setActionError(data.message || (data.action === 'send-email-to-ads' ? 'Unable to send email. Open campaign in Edit and try again.' : 'Unable to download files. Please try again.'));
        return;
      }
      if (data.action === 'download-visuals' || data.action === 'download-installs') {
        setActionError('');
        setActionSuccess('Downloaded');
      } else if (data.action === 'send-email-to-ads') {
        setEmailSubmitted(true);
        setActionError('');
        setActionSuccess('Email sent to ADS.');
      }
    };

    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
    };
  }, [pendingAutomation]);

  useEffect(() => {
    setEmailSubmitted(false);
  }, [campaign?.id]);

  useEffect(() => {
    if (!pendingAutomation) return undefined;
    const timeoutId = window.setTimeout(() => {
      setDownloadingVisuals(false);
      setDownloadingInstalls(false);
      setSendingAdsEmail(false);
      setPendingAutomation(null);
      setAutomationFrameUrl('');
      setActionSuccess('');
      setActionError('Action timed out. Open campaign in Edit and try again.');
    }, 180000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [pendingAutomation]);

  useEffect(() => {
    if (!actionSuccess) return undefined;
    const timeoutId = window.setTimeout(() => {
      setActionSuccess('');
    }, 4000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [actionSuccess]);

  const latestDeliveryAddressByMarketAndName = useMemo(() => {
    const index = new Map<string, Map<string, string[]>>();
    marketDeliveryAddresses.forEach((entry) => {
      const marketKey = normalizeToken(entry.market || '');
      if (!marketKey) return;
      const nameKey = deliveryContactName(entry.deliveryAddress || '').trim().toLowerCase();
      if (!nameKey) return;
      const byName = index.get(marketKey) ?? new Map<string, string[]>();
      byName.set(nameKey, [...(byName.get(nameKey) ?? []), entry.deliveryAddress]);
      index.set(marketKey, byName);
    });
    return index;
  }, [marketDeliveryAddresses]);

  function resolveAssetDeliveryAddress(marketName: string, currentAddress: string) {
    const trimmed = (currentAddress || '').trim();
    if (!trimmed) return 'N/A';
    const marketKey = normalizeToken(marketName || '');
    const byName = latestDeliveryAddressByMarketAndName.get(marketKey);
    if (!byName) return trimmed;
    const nameKey = deliveryContactName(trimmed).trim().toLowerCase();
    if (!nameKey) return trimmed;
    const matches = byName.get(nameKey) ?? [];
    if (matches.length !== 1) return trimmed;
    return matches[0];
  }

  const printingCostByMarketAsset = useMemo(
    () => new Map(assetPrintingCosts.map((entry) => [`${entry.market}\x00${entry.assetId}`, entry.costs])),
    [assetPrintingCosts],
  );
  const customPrintCostByAssetSheet = useMemo(
    () => new Map(customPrintCosts.map((entry) => [entry.sheetKey, entry])),
    [customPrintCosts],
  );
  const shippingCostByMarketAsset = useMemo(
    () => new Map(assetShippingCosts.map((entry) => [`${entry.market}\x00${entry.assetId}`, entry])),
    [assetShippingCosts],
  );
  const marketShippingRateByMarket = useMemo(() => new Map(shippingRates.map((entry) => [entry.market, entry])), [shippingRates]);
  const marketShippingRateIndex = useMemo(() => {
    const index = new Map<string, MarketShippingRateRecord>();
    shippingRates.forEach((entry) => {
      const key = normalizeToken(entry.market || '');
      if (!key || index.has(key)) return;
      index.set(key, entry);
    });
    return index;
  }, [shippingRates]);

  const printingCostIndex = useMemo(() => {
    const index = new Map<string, Map<string, MarketAssetPrintingCostRecord['costs']>>();
    assetPrintingCosts.forEach((entry) => {
      const marketKey = normalizeToken(entry.market || '');
      if (!index.has(marketKey)) index.set(marketKey, new Map());
      const bucket = index.get(marketKey)!;
      const keys = [entry.assetId, entry.asset, entry.label].map((value) => normalizeToken(value || '')).filter(Boolean);
      keys.forEach((key) => {
        if (!bucket.has(key)) bucket.set(key, entry.costs);
      });
    });
    return index;
  }, [assetPrintingCosts]);

  const shippingCostIndex = useMemo(() => {
    const index = new Map<string, Map<string, MarketAssetShippingCostRecord>>();
    assetShippingCosts.forEach((entry) => {
      const marketKey = normalizeToken(entry.market || '');
      if (!index.has(marketKey)) index.set(marketKey, new Map());
      const bucket = index.get(marketKey)!;
      const keys = [entry.assetId, entry.asset, entry.label].map((value) => normalizeToken(value || '')).filter(Boolean);
      keys.forEach((key) => {
        if (!bucket.has(key)) bucket.set(key, entry);
      });
    });
    return index;
  }, [assetShippingCosts]);

  const globalPrintingCostIndex = useMemo(() => {
    const index = new Map<string, MarketAssetPrintingCostRecord['costs']>();
    assetPrintingCosts.forEach((entry) => {
      [entry.assetId, entry.asset, entry.label]
        .map((value) => normalizeToken(value || ''))
        .filter(Boolean)
        .forEach((key) => {
          if (!index.has(key)) index.set(key, entry.costs);
        });
    });
    return index;
  }, [assetPrintingCosts]);

  const globalShippingCostIndex = useMemo(() => {
    const index = new Map<string, MarketAssetShippingCostRecord>();
    assetShippingCosts.forEach((entry) => {
      [entry.assetId, entry.asset, entry.label]
        .map((value) => normalizeToken(value || ''))
        .filter(Boolean)
        .forEach((key) => {
          if (!index.has(key)) index.set(key, entry);
        });
    });
    return index;
  }, [assetShippingCosts]);
  const selectedAssetByLineId = useMemo(() => {
    const byLineId = new Map<string, { market: string; assetId: string; assetSearch: string; id: string }>();
    campaign?.values.campaignMarkets.forEach((market) => {
      market.assets.forEach((asset) => {
        byLineId.set(asset.id, { market: market.market, assetId: asset.assetId, assetSearch: asset.assetSearch || '', id: asset.id });
      });
    });
    return byLineId;
  }, [campaign?.values.campaignMarkets]);
  const summaryLineByLineId = useMemo(
    () => new Map((campaign?.summary?.lines ?? []).map((line) => [line.id, line])),
    [campaign?.summary?.lines],
  );

  function findPrintingCostsForAsset(marketName: string, candidates: string[]) {
    const bucket = printingCostIndex.get(normalizeToken(marketName || ''));
    if (!bucket) {
      for (const candidate of candidates) {
        const key = normalizeToken(candidate || '');
        if (!key) continue;
        const costs = globalPrintingCostIndex.get(key);
        if (costs) return costs;
      }
      return null;
    }
    for (const candidate of candidates) {
      const key = normalizeToken(candidate || '');
      if (!key) continue;
      const costs = bucket.get(key);
      if (costs) return costs;
      const globalCosts = globalPrintingCostIndex.get(key);
      if (globalCosts) return globalCosts;
    }
    return null;
  }

  function findShippingCostsForAsset(marketName: string, candidates: string[]) {
    const bucket = shippingCostIndex.get(normalizeToken(marketName || ''));
    if (!bucket) {
      for (const candidate of candidates) {
        const key = normalizeToken(candidate || '');
        if (!key) continue;
        const shipping = globalShippingCostIndex.get(key);
        if (shipping) return shipping;
      }
      return null;
    }
    for (const candidate of candidates) {
      const key = normalizeToken(candidate || '');
      if (!key) continue;
      const shipping = bucket.get(key);
      if (shipping) return shipping;
      const globalShipping = globalShippingCostIndex.get(key);
      if (globalShipping) return globalShipping;
    }
    return null;
  }

  function findShippingRateForMarket(marketName: string) {
    const exact = marketShippingRateByMarket.get(marketName);
    if (exact) return exact;
    return marketShippingRateIndex.get(normalizeToken(marketName || '')) ?? null;
  }

  function findMarketAssetForLine(
    marketAssets: CampaignRecord['values']['campaignMarkets'][number]['assets'],
    line: NonNullable<CampaignRecord['summary']>['lines'][number],
  ) {
    const lineId = (line.id || '').trim().toLowerCase();
    const lineLabel = (line.assetLabel || '').trim().toLowerCase();
    const tokenizedLineId = normalizeToken(line.id || '');
    const tokenizedLineLabel = normalizeToken(line.assetLabel || '');
    return marketAssets.find((asset) => {
      const candidateId = (asset.id || '').trim().toLowerCase();
      const candidateAssetId = (asset.assetId || '').trim().toLowerCase();
      const candidateSearch = (asset.assetSearch || '').trim().toLowerCase();
      const tokenizedCandidateId = normalizeToken(asset.id || '');
      const tokenizedCandidateAssetId = normalizeToken(asset.assetId || '');
      const tokenizedCandidateSearch = normalizeToken(asset.assetSearch || '');
      return (
        candidateId === lineId ||
        candidateAssetId === lineId ||
        candidateSearch === lineLabel ||
        candidateAssetId === lineLabel ||
        candidateSearch === lineId ||
        tokenizedCandidateId === tokenizedLineId ||
        tokenizedCandidateAssetId === tokenizedLineId ||
        tokenizedCandidateSearch === tokenizedLineLabel ||
        tokenizedCandidateAssetId === tokenizedLineLabel ||
        tokenizedCandidateSearch === tokenizedLineId
      );
    }) ?? null;
  }

  const totalPrintingCost = useMemo(() => {
    if (!campaign?.summary) return 0;
    return campaign.summary.lines.reduce((total, line) => {
      const selectedAsset = selectedAssetByLineId.get(line.id);
      const costs = selectedAsset
        ? printingCostByMarketAsset.get(`${selectedAsset.market}\x00${selectedAsset.assetId}`)
          ?? findPrintingCostsForAsset(selectedAsset.market, [selectedAsset.assetId, selectedAsset.assetSearch, selectedAsset.id, line.assetLabel, line.id])
        : findPrintingCostsForAsset(line.market, [line.id, line.assetLabel]);
      const posterRate = toNumber(costs?.['8-sheet']);
      const customCost = Object.entries(line.breakdown as Record<string, number>).reduce((sum, [rawKey, rawPages]) => {
        const sheetKey = toCanonicalSheetNameKey(rawKey);
        if (customSheetSizeFormats[sheetKey]) return sum;
        const isStandardFormat = (formatKeys as readonly string[]).includes(rawKey);
        if (isStandardFormat) return sum;
        const pages = Math.max(0, toNumber(rawPages));
        if (pages === 0) return sum;
        return sum + pages * posterRate;
      }, 0);
      if (!costs) return total + customCost;
      const qa0Units = toNumber(line.breakdown.QA0);
      const eightSheetRate = toNumber(costs['8-sheet']);
      const lineCost =
        formatKeys.reduce((sum, key) => {
          if (customSheetSizeFormats[toCanonicalSheetNameKey(key)] || key === 'QA0') return sum;
          return sum + toNumber(line.breakdown[key]) * toNumber(costs[key]);
        }, 0) + qa0Units * eightSheetRate;
      const customSheetCost = Object.keys(customSheetSizeFormats).reduce((sum, sheetKey) => {
        if (!customSheetSizeFormats[sheetKey]) return sum;
        if (!selectedAsset) return sum;
        const pages = Math.max(0, quantityForSheetKey(line.breakdown as Record<string, number>, sheetKey));
        if (pages === 0) return sum;
        const flagKey = assetSheetCostFlagKey(selectedAsset.assetId, sheetKey);
        if (customPrintCostFormats[flagKey]) {
          const rates = customPrintCostByAssetSheet.get(flagKey);
          const customRate = rates
            ? pages >= 10
              ? rates.tenPlusPageCost
              : pages >= 5
                ? rates.fivePageCost
                : pages >= 2
                  ? rates.twoPageCost
                  : rates.onePageCost
            : 0;
          return sum + customRate;
        }
        const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
        const rate = costs[sheetKey] ?? (formatKey ? costs[formatKey] : undefined);
        return sum + pages * toNumber(rate);
      }, 0);
      return total + lineCost + customCost + customSheetCost;
    }, 0);
  }, [campaign, customPrintCostByAssetSheet, customPrintCostFormats, customSheetSizeFormats, findPrintingCostsForAsset, printingCostByMarketAsset, selectedAssetByLineId]);

  const totalShippingCost = useMemo(() => {
    if (!campaign?.summary) return 0;
    const uniqueMarkets = Array.from(new Set(campaign.summary.lines.map((line) => line.market)));
    return uniqueMarkets.reduce((marketTotal, marketName) => {
      const marketRate = findShippingRateForMarket(marketName);
      if (!marketRate) return marketTotal;
      const marketLines = shippingLinesWithCreatives(campaign.summary!.lines.filter((line) => (line.market || '').trim().toLowerCase() === (marketName || '').trim().toLowerCase()), campaign.values.campaignMarkets);
      if (marketRate.useMarketFlatRate) {
        return marketTotal + (marketLines.some((line) => Object.values(line.breakdown).some((quantity) => quantity > 0)) ? marketRate.marketFlatRate ?? 0 : 0);
      }

      const twoPrice = marketRate.twoSheeterPrice ?? 0;
      const fourPrice = marketRate.fourSheeterPrice ?? 0;
      const sixPrice = marketRate.sixSheeterPrice ?? 0;
      const eightPrice = marketRate.eightSheeterPrice ?? 0;
      const twoSets = marketRate.twoSheeterSetsPerBox ?? marketRate.sheeterSetsPerBox ?? 15;
      const fourSets = marketRate.fourSheeterSetsPerBox ?? marketRate.sheeterSetsPerBox ?? 15;
      const sixSets = marketRate.sixSheeterSetsPerBox ?? marketRate.sheeterSetsPerBox ?? 15;
      const eightSets = marketRate.eightSheeterSetsPerBox ?? marketRate.sheeterSetsPerBox ?? 15;
      const megasPerBox = marketRate.megasPerBox ?? 1;
      const useFlatRateSheeters = marketRate.useFlatRateSheeters ?? marketRate.useFlatRate ?? false;
      const useFlatRateMegas = marketRate.useFlatRateMegas ?? marketRate.useFlatRate ?? false;
      const isCustomSheetFormat = (key: string) => Boolean(customSheetSizeFormats[toCanonicalSheetNameKey(key)]);
      const customSheetTotal = marketLines.reduce((total, line) => (
        total + Object.entries(line.breakdown as Record<string, number>).reduce((lineTotal, [rawKey, rawQuantity]) => {
          if (isCustomSheetFormat(rawKey)) return lineTotal;
          if ((formatKeys as readonly string[]).includes(rawKey)) return lineTotal;
          return lineTotal + Math.max(0, toNumber(rawQuantity));
        }, 0)
      ), 0);
      const shippingRateForSheetKey = (assetShipping: MarketAssetShippingCostRecord | null | undefined, sheetKey: string) => {
        const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
        if (formatKey === '2-sheet') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.['2-sheet'] ?? twoPrice);
        if (formatKey === '4-sheet') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.['4-sheet'] ?? fourPrice);
        if (formatKey === '6-sheet') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.['6-sheet'] ?? sixPrice);
        if (formatKey === '8-sheet') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.['8-sheet'] ?? eightPrice);
        if (formatKey === 'QA0') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.QA0 ?? eightPrice);
        if (formatKey === 'Mega') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.Mega ?? assetShipping?.megaShippingRate ?? marketRate.megaShippingRate ?? 0);
        if (formatKey === 'DOT M') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.['DOT M'] ?? assetShipping?.dotMShippingRate ?? marketRate.dotMShippingRate ?? 0);
        if (formatKey === 'MP') return toNumber(assetShipping?.costs?.[sheetKey] ?? assetShipping?.costs?.MP ?? assetShipping?.mpShippingRate ?? marketRate.mpShippingRate ?? 0);
        return toNumber(assetShipping?.costs?.[sheetKey] ?? 0);
      };
      const shippingBoxSizeForSheetKey = (sheetKey: string) => {
        const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
        if (formatKey === '2-sheet') return twoSets;
        if (formatKey === '4-sheet') return fourSets;
        if (formatKey === '6-sheet') return sixSets;
        if (formatKey === '8-sheet' || formatKey === 'QA0') return eightSets;
        return megasPerBox;
      };
      const customSheetShipping = marketLines.reduce((sum, line) => {
        const selectedAsset = selectedAssetByLineId.get(line.id);
        const assetShipping = selectedAsset
          ? shippingCostByMarketAsset.get(`${selectedAsset.market}\x00${selectedAsset.assetId}`)
            ?? findShippingCostsForAsset(selectedAsset.market, [selectedAsset.assetId, selectedAsset.assetSearch, selectedAsset.id, line.assetLabel, line.id])
          : null;
        // Carry the market total through each asset so flat freight is charged once.
        return Object.keys(customSheetSizeFormats).reduce((lineSum, sheetKey) => {
          if (!customSheetSizeFormats[sheetKey]) return lineSum;
          const quantity = Math.max(0, quantityForSheetKey(line.breakdown as Record<string, number>, sheetKey));
          if (quantity === 0) return lineSum;
          const rate = shippingRateForSheetKey(assetShipping, sheetKey);
          return useFlatRateMegas ? Math.max(lineSum, rate)
            : lineSum + calculateShippingCost(quantity, rate, shippingBoxSizeForSheetKey(sheetKey));
        }, sum);
      }, 0);

      const hasCustomSheets = marketLines.some((line) => Object.keys(customSheetSizeFormats).some((key) =>
        customSheetSizeFormats[key] && quantityForSheetKey(line.breakdown as Record<string, number>, key) > 0));
      const standardQuantity = (key: string) => isCustomSheetFormat(key) ? 0
        : marketLines.reduce((sum, line) => sum + ((line.breakdown as Record<string, number>)[key] ?? 0), 0);
      const sheeterShipping = (posters: number, price: number, postersPerSet: number, setsPerBox: number) => {
        if (posters <= 0) return 0;
        const boxCapacity = postersPerSet * Math.max(1, Math.floor(setsPerBox || 15));
        if (hasCustomSheets && posters < boxCapacity) return 0;
        if (useFlatRateSheeters) return price;
        // Custom-sheet freight covers the remainder; charge only full standard-sheet boxes.
        if (hasCustomSheets) return Math.floor(posters / boxCapacity) * price;
        return calculatePosterShippingForSheeter(posters, price, postersPerSet, setsPerBox);
      };
      const posterShipping = sheeterShipping(standardQuantity('8-sheet') + standardQuantity('QA0') + customSheetTotal, eightPrice, 4, eightSets)
        + sheeterShipping(standardQuantity('6-sheet'), sixPrice, 3, sixSets)
        + sheeterShipping(standardQuantity('4-sheet'), fourPrice, 2, fourSets)
        + sheeterShipping(standardQuantity('2-sheet'), twoPrice, 1, twoSets);

      return marketTotal + posterShipping + customSheetShipping;
    }, 0);
  }, [campaign, customSheetSizeFormats, marketShippingRateByMarket, marketShippingRateIndex, selectedAssetByLineId, shippingCostByMarketAsset, shippingCostIndex, globalShippingCostIndex]);

  const imageById = useMemo(() => new Map((campaign?.values.printImages ?? []).map((image) => [image.id, image])), [campaign?.values.printImages]);

  const selectedArtworkImages = useMemo(() => {
    if (!selectedArtworkAsset) return [];
    return selectedArtworkAsset.rows
      .map((row) => row.imageId)
      .map((id) => imageById.get(id))
      .filter((image): image is NonNullable<typeof image> => Boolean(image));
  }, [imageById, selectedArtworkAsset]);
  const selectedArtworkRows = useMemo(() => {
    if (!selectedArtworkAsset) return [];
    return selectedArtworkAsset.rows.map((row) => ({
      ...row,
      image: imageById.get(row.imageId) ?? null,
    }));
  }, [imageById, selectedArtworkAsset]);

  function downloadVisualsViaQuoteBuilder() {
    startQuoteAutomation('download-visuals');
  }

  function downloadInstallsViaQuoteBuilder() {
    startQuoteAutomation('download-installs');
  }

  async function handleSubmitOrder() {
    if (!campaign || isEditLockedByOtherUser || (isSubmittedCampaign && !canSubmitSubmittedCampaign) || submittingOrder || downloadingVisuals || downloadingInstalls || sendingAdsEmail) return;
    setActionError('');
    setActionSuccess('');
    if (!hasUploadedPurchaseOrder) {
      setActionError('Upload a purchase order file before submitting.');
      return;
    }
    setSubmittingOrder(true);
    try {
      const response = await submitCampaignToPrintIQ(campaign.id, tenantId);
      const jobNumbers = response.jobNos?.length ? response.jobNos.join(', ') : response.jobNo;
      const quoteNumbers = response.quoteNos?.length ? response.quoteNos.join(', ') : response.quoteNo;
      const printIQNumbers = [quoteNumbers ? `Quote${(response.quoteNos?.length ?? 0) > 1 ? 's' : ''}: ${quoteNumbers}` : '', jobNumbers ? `Jobs: ${jobNumbers}` : ''].filter(Boolean).join(', ');
      if (response.campaign.status === 'submitted') setEmailSubmitted(true);
      setActionSuccess(printIQNumbers ? `Order submitted to PrintIQ. ${printIQNumbers}` : 'Order submitted to PrintIQ.');
      onOpenChange(false);
    } catch (submitError) {
      setActionError(submitError instanceof Error ? submitError.message : 'Unable to submit order to PrintIQ.');
    } finally {
      setSubmittingOrder(false);
    }
  }

  function normalizeToken(value: string) {
    return (value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function formatArtworkType(typeKey: string) {
    if (typeKey === '8-sheet' || typeKey === '6-sheet' || typeKey === '4-sheet' || typeKey === '2-sheet') return 'Quad';
    if (typeKey === 'DOT M') return 'DOT Mega';
    if (typeKey === 'MP') return 'Mega Portrait';
    if (typeKey === 'FF') return 'Ferro Film';
    return typeKey;
  }

  function buildAttachedArtworkRows(asset: CampaignRecord['values']['campaignMarkets'][number]['assets'][number]) {
    const rowsByImageAndType = new Map<string, { imageId: string; frameCount: number; type: string }>();
    const standardFormatKeys = ['8-sheet', '6-sheet', '4-sheet', '2-sheet', 'QA0', 'Mega', 'DOT M', 'MP', 'FF'];
    const assignedFormatKeys = Array.from(new Set([
      ...standardFormatKeys,
      ...Object.keys(asset.creativeImageIds ?? {}),
      ...Object.keys(asset.artworkMaterialAssignments ?? {}),
    ]));

    const pushArtwork = (rawImageId: string, typeKey: string, frameCount: number) => {
      const imageId = (rawImageId || '').trim();
      if (!imageId || frameCount <= 0) return;
      const type = formatArtworkType(typeKey);
      const rowKey = `${imageId}\x00${type}`;
      if (!rowsByImageAndType.has(rowKey)) {
        rowsByImageAndType.set(rowKey, { imageId, frameCount: 0, type });
      }
      const row = rowsByImageAndType.get(rowKey)!;
      row.frameCount += frameCount;
    };

    assignedFormatKeys.forEach((typeKey) => {
      const combinedAssignments = asset.artworkMaterialAssignments?.[typeKey] ?? [];
      if (combinedAssignments.some((assignment) => Boolean((assignment.artworkImageId || '').trim()))) {
        combinedAssignments.forEach((assignment) => pushArtwork(assignment.artworkImageId, typeKey, assignment.frameCount));
        return;
      }
      const singleAssigned = (asset.creativeImageIds?.[typeKey] || '').trim();
      if (singleAssigned) {
        pushArtwork(singleAssigned, typeKey, 1);
      }
    });

    const hasTypedAssignments = assignedFormatKeys.some((typeKey) => Boolean((asset.creativeImageIds?.[typeKey] || '').trim()))
      || assignedFormatKeys.some((typeKey) => (asset.artworkMaterialAssignments?.[typeKey] ?? []).some((assignment) => Boolean((assignment.artworkImageId || '').trim())));
    if (!hasTypedAssignments && (asset.creativeImageId || '').trim()) {
      pushArtwork(asset.creativeImageId, '8-sheet', 1);
    }

    return Array.from(rowsByImageAndType.values());
  }

  function findSummaryLineForAsset(marketName: string, assetId: string, assetSearch: string) {
    const lines = campaign?.summary?.lines ?? [];
    const normalizedAssetSearch = (assetSearch || '').trim().toLowerCase();
    const normalizedAssetId = (assetId || '').trim().toLowerCase();
    const tokenizedSearch = normalizeToken(assetSearch || '');
    const tokenizedAssetId = normalizeToken(assetId || '');
    const normalizedMarket = (marketName || '').trim().toLowerCase();

    const byId = lines.find((line) => {
      const lineId = (line.id || '').trim().toLowerCase();
      return lineId === normalizedAssetId || lineId === normalizedAssetSearch;
    });
    if (byId) return byId;

    const byMarketAndLabel = lines.find((line) => {
      if ((line.market || '').trim().toLowerCase() !== normalizedMarket) return false;
      const label = (line.assetLabel || '').trim().toLowerCase();
      const tokenizedLabel = normalizeToken(label);
      return (
        label === normalizedAssetSearch ||
        label === normalizedAssetId ||
        label.includes(normalizedAssetSearch) ||
        normalizedAssetSearch.includes(label) ||
        tokenizedLabel === tokenizedSearch ||
        tokenizedLabel === tokenizedAssetId ||
        tokenizedLabel.includes(tokenizedSearch) ||
        tokenizedSearch.includes(tokenizedLabel)
      );
    });
    if (byMarketAndLabel) return byMarketAndLabel;

    return lines.find((line) => (line.market || '').trim().toLowerCase() === normalizedMarket) || null;
  }

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[100dvh] w-screen max-w-none flex-col overflow-hidden border-0 bg-[#181433]/95 p-0 shadow-2xl shadow-black/50 sm:h-[92vh] sm:w-[92vw] sm:rounded-xl sm:border sm:border-white/10 md:h-[85vh] md:w-[96vw] md:max-w-[1800px] lg:min-w-[1320px] lg:w-[84vw]">
        <DialogHeader className="sticky top-0 z-20 space-y-3 border-b border-white/10 bg-gradient-to-b from-[#241b45] to-[#181433] px-7 py-5 backdrop-blur-sm">
          <div className="flex items-start justify-between gap-4">
            <DialogTitle className="text-2xl font-semibold text-white">Campaign Schedule Details</DialogTitle>
            <div className="hidden items-center gap-2 md:flex">
              <Button className="h-9 rounded-md border border-white/10 bg-slate-900/50 px-4 text-xs text-slate-100 hover:bg-slate-800/70" onClick={onClose} type="button" variant="ghost">
                Close
              </Button>
              <Button
                className="h-9 rounded-md border border-violet-300/25 bg-violet-500/10 px-4 text-xs text-violet-100 hover:bg-violet-500/20"
                disabled={!canCloneCampaign || cloning}
                onClick={onClone}
                title={canCloneCampaign ? 'Clone campaign' : 'Only submitted campaigns can be cloned'}
                type="button"
                variant="ghost"
              >
                {cloning ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-200" /> : <CopyPlus className="h-4 w-4" />}
                {cloning ? 'Cloning...' : 'Clone'}
              </Button>
              <Button
                className="h-9 px-4 btn-theme-primary"
                disabled={isSubmittedCampaign || isEditLockedByOtherUser}
                onClick={onEdit}
                title={isEditLockedByOtherUser ? 'This campaign is currently being edited by another user' : (isSubmittedCampaign ? 'Submitted campaigns cannot be edited' : 'Edit schedule')}
                type="button"
              >
                Edit Schedule
              </Button>
            </div>
          </div>
        </DialogHeader>
        {loading ? (
          <div className="flex min-h-[220px] flex-1 items-center justify-center">
            <LoaderCircle className="h-6 w-6 animate-spin text-violet-300" />
          </div>
        ) : error ? (
          <div className="m-6 rounded-md border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-200">{error}</div>
        ) : campaign ? (
          <>
            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-7 sm:py-6">
              <div className="grid gap-6">
                {editLockNotice ? (
                  <div className="rounded-md border border-rose-400/35 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-100">
                    {editLockNotice}
                  </div>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  <div className="rounded-lg border border-white/10 bg-slate-900/45 p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">Start Date</p>
                    <p className="mt-2 text-base font-semibold text-white">{formatCampaignDate(campaign.values.campaignStartDate)}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-slate-900/45 p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">Weeks</p>
                    <p className="mt-2 text-base font-semibold text-white">{campaign.values.numberOfWeeks || '0'}</p>
                  </div>
                  <div className="rounded-lg border border-white/10 bg-slate-900/45 p-4">
                    <p className="text-[11px] uppercase tracking-[0.14em] text-slate-400">Markets</p>
                    <p className="mt-2 text-base font-semibold text-white">{campaign.values.campaignMarkets.length}</p>
                  </div>
                </div>

                <div className="grid gap-6 xl:grid-cols-[minmax(0,2.5fr)_minmax(280px,0.72fr)]">
                  <div className="space-y-4">
                    <div className="rounded-xl border border-white/10 bg-slate-900/35 p-5 shadow-inner shadow-black/20">
                      <div className="mb-4 flex items-center justify-between gap-3">
                        <h3 className="text-sm font-semibold uppercase tracking-[0.12em] text-slate-300">Schedule Components</h3>
                        <p className="text-xs text-slate-400">{campaign.values.campaignName || `Untitled Campaign ${campaign.id.slice(0, 6)}`}</p>
                      </div>
                      <div className="space-y-4">
                        {campaign.values.campaignMarkets.length === 0 ? (
                          <div className="rounded-lg border border-dashed border-white/15 bg-slate-900/30 p-5 text-sm text-slate-400">No market components in this schedule.</div>
                        ) : (
                          campaign.values.campaignMarkets.map((market) => (
                            <div key={market.id} className="py-1">
                              <div className="mb-3 flex items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                  <span className="h-2 w-2 rounded-full bg-violet-300 shadow-[0_0_12px_rgba(145, 118, 224,0.65)]" />
                                  <p className="text-sm font-semibold uppercase tracking-[0.12em] text-violet-300">{market.market}</p>
                                </div>
                                <span className="text-xs text-slate-400">Due Date: {formatCampaignDate(market.dueDate)} | {market.assets.length} assets</span>
                              </div>
                              {market.assets.length === 0 ? (
                                <p className="text-sm text-slate-400">No assets selected.</p>
                              ) : (
                                <div>
                                  <div className="grid gap-4 border-b border-white/10 px-4 py-3 text-[11px] uppercase tracking-[0.12em] text-slate-500 md:grid-cols-[1.45fr_1fr_1.9fr]">
                                    <p>Asset</p>
                                    <p>Selected Weeks</p>
                                    <p>Delivery Address</p>
                                  </div>
                                  {market.assets.map((asset) => {
                            const line = summaryLineByLineId.get(asset.id)
                              ?? findSummaryLineForAsset(market.market, asset.assetId, asset.assetSearch || asset.assetId);
                            const posterBreakdown = { ...((line?.breakdown ?? {}) as Record<string, number>) };
                            const frameBreakdown = { ...posterBreakdown };
                            frameBreakdown['8-sheet'] = Math.ceil((posterBreakdown['8-sheet'] ?? 0) / 4);
                            frameBreakdown['6-sheet'] = Math.ceil((posterBreakdown['6-sheet'] ?? 0) / 3);
                            frameBreakdown['4-sheet'] = Math.ceil((posterBreakdown['4-sheet'] ?? 0) / 2);
                            frameBreakdown['2-sheet'] = posterBreakdown['2-sheet'] ?? 0;
                            frameBreakdown.QA0 = Math.ceil((posterBreakdown.QA0 ?? 0) / 4);
                            const specialFormatKeys = new Set(['Mega', 'DOT M', 'MP', 'FF']);
                            const posters = Object.entries(posterBreakdown).reduce((total, [key, quantity]) =>
                              specialFormatKeys.has(key) ? total : total + (quantity ?? 0), 0);
                            const frames = Object.entries(frameBreakdown).reduce((total, [key, quantity]) =>
                              specialFormatKeys.has(key) ? total : total + (quantity ?? 0), 0);
                            const attachedArtworkRows = buildAttachedArtworkRows(asset);
                            const attachedImageIds = attachedArtworkRows.map((row) => row.imageId);
                            const resolvedDeliveryAddress = resolveAssetDeliveryAddress(market.market, asset.deliveryAddress || '');
                            return (
                                    <button
                                      key={asset.id}
                                      className="grid w-full gap-4 border-b border-white/5 px-4 py-4 text-left transition-colors hover:bg-slate-800/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70 last:border-b-0 md:grid-cols-[1.45fr_1fr_1.9fr]"
                                      onClick={() =>
                                        setSelectedAssetDetails({
                                          title: `${market.market} - ${asset.assetSearch || asset.assetId}`,
                                          market: market.market,
                                          assetName: asset.assetSearch || asset.assetId,
                                          selectedWeeks: asset.selectedWeeks,
                                          deliveryAddress: resolvedDeliveryAddress,
                                          imageIds: attachedImageIds,
                                          attachedArtworkRows,
                                          posterBreakdown,
                                          frameBreakdown,
                                          postersTotal: posters,
                                          framesTotal: frames,
                                        })
                                      }
                                      type="button"
                                    >
                              <div>
                                <p className="mt-0.5 text-sm text-slate-100">{asset.assetSearch || asset.assetId}</p>
                              </div>
                              <div>
                                <p className="mt-0.5 text-sm text-slate-100">{asset.selectedWeeks.length > 0 ? asset.selectedWeeks.join(', ') : 'None'}</p>
                              </div>
                              <div>
                                <p className="mt-0.5 line-clamp-2 text-sm text-slate-100">{resolvedDeliveryAddress}</p>
                              </div>
                            </button>
                          );
                                  })}
                                </div>
                              )}
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  </div>

                  <aside className="space-y-4">
                    <div className="rounded-xl border border-white/10 bg-gradient-to-b from-slate-900/55 to-slate-900/35 p-5 backdrop-blur-sm">
                      <div className="flex items-center gap-2 text-sm font-semibold text-white">
                        <ShoppingCart className="h-4 w-4 text-violet-300" />
                        <span>Order Assets Summary</span>
                      </div>
                      <div className="mt-4 space-y-3">
                        <div className="flex items-center justify-between rounded-md border border-white/10 bg-slate-950/40 px-3 py-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-slate-400">Artwork</p>
                          <p className="text-sm font-semibold text-white">{campaign.values.printImages.length}</p>
                        </div>
                        <div className="flex items-center justify-between rounded-md border border-white/10 bg-slate-950/40 px-3 py-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-slate-400">Printing</p>
                          <p className="text-sm font-semibold text-white">{formatCurrency(totalPrintingCost)}</p>
                        </div>
                        <div className="flex items-center justify-between rounded-md border border-white/10 bg-slate-950/40 px-3 py-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-slate-400">Shipping</p>
                          <p className="text-sm font-semibold text-white">{formatCurrency(totalShippingCost)}</p>
                        </div>
                        <div className="flex items-center justify-between rounded-md border border-violet-400/30 bg-violet-500/10 px-3 py-2">
                          <p className="text-xs uppercase tracking-[0.1em] text-violet-200">Total</p>
                          <p className="text-sm font-semibold text-violet-100">{formatCurrency(totalPrintingCost + totalShippingCost)}</p>
                        </div>
                      </div>
                    </div>
                  </aside>
                </div>
              </div>
            </div>
            <div className="shrink-0 border-t border-white/10 bg-gradient-to-b from-[#21193f] to-[#16122f] px-5 py-4 sm:px-7">
              <div className="flex items-center justify-between gap-4">
                <div className="min-h-[1.5rem] flex-1">
                  {actionError ? (
                    <p className="px-1 py-1 text-sm text-rose-200" role="alert">
                      {actionError}
                    </p>
                  ) : actionSuccess ? (
                    <p className="px-1 py-1 text-sm text-slate-300" role="status">
                      {actionSuccess}
                    </p>
                  ) : null}
                </div>
                <div className="flex items-center justify-end gap-2.5">
                <Button
                  className="h-9 rounded-md border border-violet-300/25 bg-violet-500/10 px-4 text-xs text-violet-100 hover:bg-violet-500/20"
                  disabled={!canCloneCampaign || cloning || downloadingVisuals || downloadingInstalls || sendingAdsEmail || submittingOrder}
                  onClick={onClone}
                  title={canCloneCampaign ? 'Clone campaign' : 'Only submitted campaigns can be cloned'}
                  type="button"
                  variant="ghost"
                >
                  {cloning ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-200" /> : <CopyPlus className="h-4 w-4" />}
                  {cloning ? 'Cloning...' : 'Clone'}
                </Button>
                <Button
                  className="h-9 rounded-md border border-white/10 bg-slate-900/50 px-4 text-xs text-slate-100 hover:bg-slate-800/70"
                  disabled={downloadingVisuals || downloadingInstalls || sendingAdsEmail || submittingOrder}
                  onClick={downloadVisualsViaQuoteBuilder}
                  type="button"
                >
                  {downloadingVisuals ? 'Generating...' : 'Download Visuals'}
                </Button>
                <Button
                  className="h-9 rounded-md border border-white/10 bg-slate-900/50 px-4 text-xs text-slate-100 hover:bg-slate-800/70"
                  disabled={downloadingVisuals || downloadingInstalls || sendingAdsEmail || submittingOrder}
                  onClick={downloadInstallsViaQuoteBuilder}
                  type="button"
                >
                  {downloadingInstalls ? 'Generating...' : 'Download Installs'}
                </Button>
                <Button
                  className="h-9 px-4 btn-theme-primary"
                  disabled={isEditLockedByOtherUser || (isSubmittedCampaign && !canSubmitSubmittedCampaign) || downloadingVisuals || downloadingInstalls || sendingAdsEmail || submittingOrder}
                  onClick={() => void handleSubmitOrder()}
                  title={isEditLockedByOtherUser ? 'This campaign is currently being edited by another user' : 'Submit order to PrintIQ'}
                  type="button"
                >
                  {submittingOrder ? 'Submitting...' : 'Submit Order'}
                </Button>
                </div>
              </div>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
    {automationFrameUrl ? (
      <iframe
        aria-hidden
        className="hidden"
        ref={automationFrameRef}
        src={automationFrameUrl}
        title="quote-automation"
      />
    ) : null}
    <Dialog
      open={Boolean(selectedAssetDetails)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedAssetDetails(null);
      }}
    >
      <DialogContent className="max-h-[90vh] w-[95vw] max-w-[95vw] overflow-y-auto border border-white/10 bg-[#181433] md:w-[66vw] md:max-w-[66vw]">
        <DialogHeader>
          <DialogTitle className="text-white">Asset Details</DialogTitle>
          <DialogDescription className="text-slate-300">{selectedAssetDetails?.title || ''}</DialogDescription>
        </DialogHeader>
        {selectedAssetDetails ? (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-lg border border-white/10 bg-slate-900/40 p-4 md:grid-cols-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Asset</p>
                <p className="mt-1 text-sm text-slate-100">{selectedAssetDetails.assetName}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Selected Weeks</p>
                <p className="mt-1 text-sm text-slate-100">{selectedAssetDetails.selectedWeeks.length > 0 ? selectedAssetDetails.selectedWeeks.join(', ') : 'None'}</p>
              </div>
              <div>
                <p className="text-[11px] uppercase tracking-[0.12em] text-slate-500">Delivery Address</p>
                <p className="mt-1 text-sm text-slate-100">{selectedAssetDetails.deliveryAddress}</p>
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
                <p className="text-sm font-semibold text-white">Poster Breakdown</p>
                <p className="mt-1 text-xs text-slate-400">Total: {selectedAssetDetails.postersTotal}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-200">
                  {Object.entries(selectedAssetDetails.posterBreakdown).map(([k, v]) => (
                    <p key={`poster-${k}`}>{formatBreakdownLabel(k)}: {v}</p>
                  ))}
                </div>
              </div>
              <div className="rounded-lg border border-white/10 bg-slate-900/40 p-4">
                <p className="text-sm font-semibold text-white">Frame Breakdown</p>
                <p className="mt-1 text-xs text-slate-400">Total: {selectedAssetDetails.framesTotal}</p>
                <div className="mt-3 grid grid-cols-2 gap-2 text-sm text-slate-200">
                  {Object.entries(selectedAssetDetails.frameBreakdown).map(([k, v]) => (
                    <p key={`frame-${k}`}>{formatBreakdownLabel(k)}: {v}</p>
                  ))}
                </div>
              </div>
            </div>
            <button
              className="w-full rounded-lg border border-violet-400/35 bg-violet-500/10 p-4 text-left transition-colors hover:border-violet-300/60 hover:bg-violet-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-300/80"
              onClick={() => setSelectedArtworkAsset({ title: selectedAssetDetails.title, rows: selectedAssetDetails.attachedArtworkRows })}
              type="button"
            >
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold text-violet-100">Attached Artwork</p>
                <p className="text-sm font-semibold text-violet-100">{selectedAssetDetails.imageIds.length}</p>
              </div>
            </button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
    <Dialog
      open={Boolean(selectedArtworkAsset)}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setSelectedArtworkAsset(null);
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto border border-white/10 bg-[#181433] p-6"
        style={{ width: '70vw', maxWidth: '70vw', maxHeight: '90vh' }}
      >
        <DialogHeader>
          <DialogTitle className="text-white">Attached Artwork</DialogTitle>
          <DialogDescription className="text-slate-300">{selectedArtworkAsset?.title || ''}</DialogDescription>
        </DialogHeader>
        {selectedArtworkAsset && selectedArtworkRows.length === 0 ? (
          <div className="rounded-md border border-white/10 bg-slate-900/40 px-4 py-6 text-sm text-slate-400">No artwork is attached to this asset.</div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-slate-700 bg-slate-900/65">
            <table className="w-full table-auto border-collapse text-sm">
              <colgroup>
                <col className="w-[52px]" />
                <col className="w-[120px]" />
                <col className="w-[160px]" />
                <col className="w-[120px]" />
                <col className="w-[120px]" />
                <col className="w-auto" />
              </colgroup>
              <thead>
                <tr className="bg-slate-950 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-300">
                  <th className="border border-slate-700 px-3 py-2 text-left">No</th>
                  <th className="border border-slate-700 px-3 py-2 text-center">Thumbnail</th>
                  <th className="border border-slate-700 px-3 py-2 text-left">Name</th>
                  <th className="border border-slate-700 px-3 py-2 text-center">Frame Count</th>
                  <th className="border border-slate-700 px-3 py-2 text-left">Type</th>
                  <th className="border border-slate-700 px-3 py-2 text-left">Filename</th>
                </tr>
              </thead>
              <tbody>
                {selectedArtworkRows.map((row, index) => {
                  const image = row.image;
                  const previewSrc = image ? resolveArtworkUrl(image.imageUrl, image.thumbnailUrl) : '';
                  return (
                    <tr key={`attached-artwork-row-${row.imageId}-${index}`} className="border-t border-slate-700/70 bg-slate-800/65">
                      <td className="border border-slate-700 px-3 py-2 text-slate-200">{index + 1}</td>
                      <td className="border border-slate-700 px-3 py-2">
                        <div className="mx-auto h-14 w-14 overflow-hidden rounded border border-slate-700 bg-slate-900">
                          {previewSrc ? (
                            <img alt={image?.name || image?.fileName || `Artwork ${index + 1}`} className="h-full w-full object-cover" loading="lazy" src={previewSrc} />
                          ) : null}
                        </div>
                      </td>
                      <td className="border border-slate-700 px-3 py-2 text-slate-100">{`Creative${index + 1}`}</td>
                      <td className="border border-slate-700 px-3 py-2 text-center text-slate-100">{row.frameCount}</td>
                      <td className="border border-slate-700 px-3 py-2 text-slate-100">{row.type || '-'}</td>
                      <td className="border border-slate-700 px-3 py-2 text-slate-100">
                        <p className="whitespace-normal break-all leading-snug">{image?.fileName || '-'}</p>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
