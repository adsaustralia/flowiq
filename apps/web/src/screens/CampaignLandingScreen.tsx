import { NavigationLink, navigationUrl } from '../components/NavigationLink';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CopyPlus, Download, Eye, FolderKanban, LoaderCircle, Pencil, Plus, RotateCcw, Search, Trash2 } from 'lucide-react';
import { CampaignListItem, CampaignRecord, TenantRecord } from '@flowiq/shared';
import { buttonVariants, cn, Button, Card, CardContent, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@flowiq/ui';
import { useAuth } from '../context/AuthContext';
import { acquireCampaignEditLock, calculatePersistedCampaign, cloneCampaign, createSubCampaign, deleteCampaign, downloadCampaignPurchaseOrder, fetchCampaign, fetchCampaigns, resetCampaignStatus } from '../services/campaignApi';
import { CampaignScheduleViewDialog } from './CampaignScheduleViewDialog';

type CampaignLandingScreenProps = {
  onOpenCampaign: (campaignId: string | null) => void;
  selectedTenantId?: string | null;
  showHero?: boolean;
  initialPreviewCampaignId?: string;
  tenantOptions?: TenantRecord[];
  requiresTenantSelection?: boolean;
  onTenantChange?: (tenantId: string) => void;
};

const LANDING_NOTICE_KEY = 'flowiq:landing-notice';

function formatCampaignDate(value: string) {
  if (!value) return 'TBC';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB');
}

function formatCampaignStatus(status: CampaignListItem['status']) {
  if (status === 'in_progress') return 'In Progress';
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function WorkflowIllustration() {
  return (
    <div className="relative h-[180px] w-full bg-transparent p-0 sm:h-[196px] lg:h-[218px] xl:h-[235px]">
      <svg className="relative h-full w-full" fill="none" viewBox="34 14 548 280" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="nodeFill" x1="0" x2="1" y1="0" y2="1">
            <stop offset="0%" stopColor="#1e163c" />
            <stop offset="100%" stopColor="#161231" />
          </linearGradient>
          <linearGradient id="flowLine" x1="0" x2="1" y1="0" y2="0">
            <stop offset="0%" stopColor="#38BDF8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="var(--primary-500)" stopOpacity="0.72" />
          </linearGradient>
        </defs>

        <rect fill="url(#nodeFill)" height="78" rx="14" stroke="rgba(255,255,255,0.14)" width="138" x="24" y="34" />
        <text fill="#F9FAFB" fontFamily="Inter, Geist, sans-serif" fontSize="14" fontWeight="600" x="40" y="62">Asset Plan</text>
        <text fill="#9CA3AF" fontFamily="Inter, Geist, sans-serif" fontSize="11" x="40" y="84">Campaign inventory</text>
        <circle cx="132" cy="52" fill="var(--primary-500)" fillOpacity="0.32" r="8" />

        <rect fill="url(#nodeFill)" height="78" rx="14" stroke="rgba(255,255,255,0.14)" width="138" x="236" y="116" />
        <text fill="#F9FAFB" fontFamily="Inter, Geist, sans-serif" fontSize="14" fontWeight="600" x="252" y="144">Schedule</text>
        <text fill="#9CA3AF" fontFamily="Inter, Geist, sans-serif" fontSize="11" x="252" y="166">Campaign timeline</text>
        <circle cx="342" cy="134" fill="#38BDF8" fillOpacity="0.32" r="8" />

        <rect fill="url(#nodeFill)" height="78" rx="14" stroke="rgba(255,255,255,0.14)" width="162" x="434" y="198" />
        <text fill="#F9FAFB" fontFamily="Inter, Geist, sans-serif" fontSize="14" fontWeight="600" x="452" y="226">ADS Output</text>
        <text fill="#9CA3AF" fontFamily="Inter, Geist, sans-serif" fontSize="11" x="452" y="248">Quote-ready export</text>
        <circle cx="564" cy="216" fill="var(--primary-500)" fillOpacity="0.36" r="8" />

        <path d="M162 74 C214 74, 206 124, 236 134" stroke="url(#flowLine)" strokeWidth="2.4" />
        <path d="M374 156 C426 168, 430 214, 434 224" stroke="url(#flowLine)" strokeWidth="2.4" />

        <circle cx="90" cy="212" fill="#161231" r="46" stroke="rgba(255,255,255,0.1)" />
        <path d="M66 212 L90 188 L114 212 L90 236 Z" stroke="#38BDF8" strokeOpacity="0.75" strokeWidth="1.6" />
        <circle cx="90" cy="212" fill="var(--primary-500)" fillOpacity="0.18" r="12" />
        <text fill="#9CA3AF" fontFamily="Inter, Geist, sans-serif" fontSize="10" x="52" y="272">Market map</text>
      </svg>
    </div>
  );
}

export function CampaignLandingScreen({ onOpenCampaign, selectedTenantId, initialPreviewCampaignId, showHero = false, tenantOptions = [], requiresTenantSelection = false, onTenantChange }: CampaignLandingScreenProps) {
  const { session } = useAuth();
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [resettingCampaignId, setResettingCampaignId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [campaignPendingDelete, setCampaignPendingDelete] = useState<CampaignListItem | null>(null);
  const [deletingCampaign, setDeletingCampaign] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [campaignPendingClone, setCampaignPendingClone] = useState<{ id: string; campaignName: string } | null>(null);
  const [viewDialogOpen, setViewDialogOpen] = useState(false);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState('');
  const [viewEditLockNotice, setViewEditLockNotice] = useState('');
  const [campaignForView, setCampaignForView] = useState<CampaignRecord | null>(null);
  const [viewCampaignId, setViewCampaignId] = useState<string | null>(null);
  const [landingNotice, setLandingNotice] = useState('');
  const [creatingSubCampaignId, setCreatingSubCampaignId] = useState<string | null>(null);
  const [cloningCampaignId, setCloningCampaignId] = useState<string | null>(null);
  const [downloadingPurchaseOrderId, setDownloadingPurchaseOrderId] = useState<string | null>(null);
  const [bottomBarHost, setBottomBarHost] = useState<HTMLElement | null>(null);
  const openedPreview = useRef<string | null>(null);
  useEffect(() => {
    if (!initialPreviewCampaignId || (requiresTenantSelection && !selectedTenantId)) return;
    const key = `${selectedTenantId}:${initialPreviewCampaignId}`;
    if (openedPreview.current === key) return;
    openedPreview.current = key;
    void handleOpenCampaignView(initialPreviewCampaignId);
  }, [initialPreviewCampaignId, selectedTenantId, requiresTenantSelection]);

  const isSuperAdmin = session?.user.role === 'super_admin';

  const loadCampaigns = useCallback(async () => {
    if (requiresTenantSelection && !selectedTenantId) {
      setCampaigns([]);
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      setError('');
      const response = await fetchCampaigns(selectedTenantId);
      setCampaigns(response.campaigns);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Unable to load campaign schedules');
    } finally {
      setLoading(false);
    }
  }, [requiresTenantSelection, selectedTenantId]);

  useEffect(() => {
    void loadCampaigns();
  }, [loadCampaigns]);

  useEffect(() => {
    setBottomBarHost(document.getElementById('workspace-bottom-bar-slot'));
    try {
      const message = window.sessionStorage.getItem(LANDING_NOTICE_KEY) || '';
      if (message.trim()) {
        setLandingNotice(message);
        window.sessionStorage.removeItem(LANDING_NOTICE_KEY);
      }
    } catch {
      // Ignore storage errors.
    }
  }, []);

  useEffect(() => {
    if (!landingNotice) return undefined;
    const timeoutId = window.setTimeout(() => {
      setLandingNotice('');
    }, 4000);
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [landingNotice]);

  function handleCreateCampaign() {
    setError('');
    if (requiresTenantSelection && !selectedTenantId) {
      setError('Select a tenant before creating a campaign.');
      return;
    }
    onOpenCampaign(null);
  }

  async function handleResetCampaignStatus(campaign: CampaignListItem) {
    if (!isSuperAdmin || campaign.status !== 'submitted' || resettingCampaignId) return;
    setResettingCampaignId(campaign.id);
    setError('');
    try {
      const response = await resetCampaignStatus(campaign.id, selectedTenantId);
      setCampaigns((current) => current.map((item) => item.id === campaign.id
        ? { ...item, status: response.campaign.status, updatedAt: response.campaign.updatedAt }
        : item));
      setLandingNotice('Campaign status reset to In Progress.');
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Unable to reset campaign status');
    } finally {
      setResettingCampaignId(null);
    }
  }

  async function handleOpenCampaign(campaignId: string, status: CampaignListItem['status']) {
    setError('');
    if (status === 'submitted') {
      setError('Submitted campaigns cannot be edited');
      return;
    }
    try {
      await acquireCampaignEditLock(campaignId, selectedTenantId);
      onOpenCampaign(campaignId);
    } catch (lockError) {
      setError(lockError instanceof Error ? lockError.message : 'Unable to open campaign for editing');
    }
  }

  async function handleOpenCampaignView(campaignId: string) {
    setViewDialogOpen(true);
    setViewCampaignId(campaignId);
    setViewLoading(true);
    setViewError('');
    setViewEditLockNotice('');
    setCampaignForView(null);
    try {
      const response = await fetchCampaign(campaignId, selectedTenantId);
      setCampaignForView(response.campaign);
      if (response.campaign.status === 'submitted') {
        return;
      }
      try {
        await calculatePersistedCampaign(campaignId, selectedTenantId);
      } catch (calculateError) {
        const message = calculateError instanceof Error ? calculateError.message : 'Unable to calculate campaign details';
        if (message.toLowerCase().includes('currently being edited')) {
          setViewEditLockNotice(message);
          return;
        }
        throw calculateError;
      }
      const refreshedResponse = await fetchCampaign(campaignId, selectedTenantId);
      setCampaignForView(refreshedResponse.campaign);
    } catch (loadError) {
      setViewError(loadError instanceof Error ? loadError.message : 'Unable to load campaign details');
    } finally {
      setViewLoading(false);
    }
  }

  async function handleEditFromView() {
    if (!viewCampaignId || !campaignForView) return;
    if (viewEditLockNotice.trim()) return;
    if (campaignForView.status === 'submitted') {
      setError('Submitted campaigns cannot be edited');
      return;
    }
    setViewDialogOpen(false);
    setCampaignForView(null);
    setViewError('');
    setViewEditLockNotice('');
    await handleOpenCampaign(viewCampaignId, campaignForView.status);
  }

  function campaignDisplayName(campaign: Pick<CampaignListItem, 'campaignName' | 'id'>) {
    return campaign.campaignName || `Untitled Campaign ${campaign.id.slice(0, 6)}`;
  }

  function openCloneDialog(campaign: { id: string; campaignName?: string; status?: CampaignListItem['status'] }) {
    if (cloningCampaignId) return;
    if (campaign.status !== 'submitted') return;
    setError('');
    setViewError('');
    setViewEditLockNotice('');
    setCampaignPendingClone({ id: campaign.id, campaignName: campaign.campaignName || `Untitled Campaign ${campaign.id.slice(0, 6)}` });
    setCloneDialogOpen(true);
  }

  async function handleCreateSubCampaign(campaign: CampaignListItem) {
    setError('');
    setCreatingSubCampaignId(campaign.id);
    try {
      const response = await createSubCampaign(campaign.id, selectedTenantId);
      await acquireCampaignEditLock(response.campaign.id, selectedTenantId);
      onOpenCampaign(response.campaign.id);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Unable to create sub campaign');
    } finally {
      setCreatingSubCampaignId(null);
    }
  }

  async function handleCloneCampaign(campaignId: string) {
    if (cloningCampaignId) return;
    setError('');
    setViewError('');
    setViewEditLockNotice('');
    setCloningCampaignId(campaignId);
    try {
      const response = await cloneCampaign(campaignId, selectedTenantId);
      await acquireCampaignEditLock(response.campaign.id, selectedTenantId);
      setViewDialogOpen(false);
      setCampaignForView(null);
      setViewEditLockNotice('');
      setViewCampaignId(null);
      onOpenCampaign(response.campaign.id);
    } catch (cloneError) {
      const message = cloneError instanceof Error ? cloneError.message : 'Unable to clone campaign';
      if (viewDialogOpen) {
        setViewError(message);
      } else {
        setError(message);
      }
    } finally {
      setCloningCampaignId(null);
    }
  }

  async function handleConfirmCloneCampaign() {
    if (!campaignPendingClone) return;
    const campaignId = campaignPendingClone.id;
    setCloneDialogOpen(false);
    setCampaignPendingClone(null);
    await handleCloneCampaign(campaignId);
  }

  function openDeleteDialog(campaign: CampaignListItem) {
    setCampaignPendingDelete(campaign);
    setDeleteDialogOpen(true);
  }

  async function handleConfirmDeleteCampaign() {
    if (!campaignPendingDelete) return;
    setDeletingCampaign(true);
    setError('');
    try {
      await deleteCampaign(campaignPendingDelete.id, selectedTenantId);
      setCampaigns((current) => current.filter((item) => item.id !== campaignPendingDelete.id));
      setDeleteDialogOpen(false);
      setCampaignPendingDelete(null);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Unable to delete campaign');
    } finally {
      setDeletingCampaign(false);
    }
  }

  async function handleDownloadPurchaseOrder(campaign: CampaignListItem) {
    if (!campaign.purchaseOrder || downloadingPurchaseOrderId) return;
    setDownloadingPurchaseOrderId(campaign.id);
    setError('');
    try {
      const blob = await downloadCampaignPurchaseOrder(campaign.id, selectedTenantId);
      downloadBlob(blob, campaign.purchaseOrder.originalName || `${campaignDisplayName(campaign)} - Purchase Order`);
    } catch (downloadError) {
      setError(downloadError instanceof Error ? downloadError.message : 'Unable to download purchase order');
    } finally {
      setDownloadingPurchaseOrderId(null);
    }
  }

  const filteredCampaigns = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return campaigns;
    return campaigns.filter((campaign) => {
      const name = (campaign.campaignName || `Untitled Campaign ${campaign.id.slice(0, 6)}`).toLowerCase();
      return name.includes(query);
    });
  }, [campaigns, searchQuery]);

  return (
    <main className="dashboard-default-scale dense-main flex h-full min-h-0 w-full flex-col gap-4 overflow-hidden">
      {showHero ? (
        <section className="relative shrink-0 overflow-hidden rounded-xl border border-[rgba(255,255,255,0.08)] bg-black px-5 pb-2.5 pt-1.5 shadow-[0_24px_70px_rgba(2,6,23,0.42)] backdrop-blur-xl sm:px-6 sm:pb-3 sm:pt-2 xl:px-6 xl:pb-4 xl:pt-3">
          <div className="pointer-events-none absolute inset-y-0 right-0 w-[48%] bg-gradient-to-l from-violet-600/20 via-violet-500/8 to-transparent" />
          <div className="relative grid min-h-[190px] items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] lg:items-start xl:min-h-[213px] xl:gap-9">
            <div className="max-w-2xl pt-1.5 lg:self-stretch lg:flex lg:flex-col">
              <div className="mb-4 w-fit max-w-full">
                <img
                  alt="Revolution360"
                  className="h-auto w-[282px] max-w-full md:w-[343px] xl:w-[405px]"
                  src="/images/revolution360-wordmark-white.png"
                />
                <p className="-mt-0.5 text-right text-[8px] font-semibold uppercase tracking-[0.2em] text-slate-400">POWERED BY ADS</p>
              </div>
              <h1 className="mt-2 pl-2.5 overflow-hidden text-ellipsis whitespace-nowrap text-[22px] font-semibold leading-tight tracking-tight text-[#F9FAFB] md:text-[25px] xl:text-[29px]">Plan Outdoor Campaigns Faster</h1>
              <p className="mt-2 max-w-xl pl-2.5 text-[12px] leading-relaxed text-[#9CA3AF] xl:text-[13px]">Build schedules, review poster quantities, and generate ADS-ready orders.</p>
              <div className="mt-10 flex flex-wrap items-center gap-2.5 pl-2.5 lg:mt-auto">
                <Button
                  className="h-9 px-5 text-[11px] btn-theme-primary"
                  onClick={handleCreateCampaign}
                  type="button"
                >
                  Create Campaign
                </Button>
                <div className="flex h-9 w-[220px] items-center gap-2 rounded-md border border-white/15 bg-[#15122b]/90 px-3 text-slate-200 shadow-[0_6px_20px_rgba(2,6,23,0.25)]">
                  <Search className="h-4 w-4 shrink-0 text-slate-400" />
                  <input
                    className="w-full bg-transparent text-[11px] text-slate-100 placeholder:text-slate-500 focus:outline-none"
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search campaign"
                    type="text"
                    value={searchQuery}
                  />
                </div>
                {tenantOptions.length > 0 ? (
                  <div className="flex h-9 w-[220px] items-center overflow-hidden rounded-md border border-violet-300/25 bg-[#15122b]/90 text-slate-200 shadow-[0_6px_20px_rgba(2,6,23,0.25)]">
                    <span className="flex h-full items-center border-r border-white/10 bg-violet-500/10 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-violet-200">
                      Tenant
                    </span>
                    <select
                      aria-label="Select tenant"
                      className="h-full min-w-0 flex-1 bg-transparent px-3 text-[11px] font-semibold text-slate-100 outline-none"
                      onChange={(event) => onTenantChange?.(event.target.value)}
                      value={selectedTenantId ?? ''}
                    >
                      {tenantOptions.map((tenant) => (
                        <option key={`dashboard-tenant-${tenant.id}`} className="bg-slate-900 text-slate-100" value={tenant.id}>
                          {tenant.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>
            </div>
            <WorkflowIllustration />
          </div>
        </section>
      ) : null}

      {error ? <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-[11px] font-medium text-rose-200">{error}</div> : null}

      {loading ? (
        <div className="flex items-center justify-center rounded-md border border-slate-700 bg-slate-900/90 px-6 py-20">
          <LoaderCircle className="h-6 w-6 animate-spin text-violet-300" />
        </div>
      ) : filteredCampaigns.length === 0 ? (
        <Card className="border-white/10 bg-[#1a1733]">
          <CardContent className="flex flex-col items-center gap-4 px-6 py-16 text-center">
            <FolderKanban className="h-12 w-12 text-violet-300" />
            <div className="space-y-2">
              <h2 className="text-xl font-black text-white">{campaigns.length === 0 ? 'No campaign schedules yet' : 'No matching campaigns'}</h2>
              <p className="max-w-xl text-[11px] leading-6 text-slate-400">
                {campaigns.length === 0
                  ? 'Create your first campaign to start building a schedule, calculate totals, and submit it to PrintIQ.'
                  : 'Try another campaign name in the search box.'}
              </p>
            </div>
            <Button className="h-10 rounded-xl border border-violet-300/35 bg-violet-600 px-[18px] text-[11px] font-semibold text-white" onClick={handleCreateCampaign}>
              <Plus className="h-4 w-4" />
              Create Campaign
            </Button>
          </CardContent>
        </Card>
      ) : (
        <section className="min-h-0 flex-1 overflow-auto rounded-md border border-white/10 bg-[#1a1733] shadow-[0_10px_24px_rgba(2,6,23,0.22)]">
          <table className="campaign-dashboard-table dense-table w-full border-collapse text-[10.5px]">
            <colgroup>
              <col className="w-[35%]" />
              <col className="w-[10%]" />
              <col className="w-[10%]" />
              <col className="w-[6%]" />
              <col className="w-[6%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
              <col className="w-[5%]" />
              <col className="w-[7%]" />
              <col className="w-[7%]" />
            </colgroup>
            <thead>
              <tr className="bg-slate-950/65 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-slate-200">
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-left backdrop-blur">Campaign</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-left backdrop-blur">Created By</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-left backdrop-blur">Created At</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-center backdrop-blur">Markets</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-center backdrop-blur">Assets</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-left backdrop-blur">Start</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-center backdrop-blur">Weeks</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-center backdrop-blur">Status</th>
                <th className="sticky top-0 z-10 border-b border-white/10 bg-slate-950/82 px-5 py-2.5 text-center backdrop-blur">Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredCampaigns.map((campaign, rowIndex) => (
                <tr
                  key={`campaign-table-${campaign.id}`}
                  className={`border-t border-white/5 align-middle transition-[background-color,border-color] duration-200 ${
                    campaign.parentCampaignId
                      ? 'border-l-2 border-l-violet-400/60 bg-[#18223d]/80'
                      : rowIndex % 2 === 0 ? 'bg-[#241c45]/70' : 'bg-[#1a1733]'
                  } hover:bg-[#1d2a40]`}
                >
                  <td className="px-5 py-2.5 font-semibold text-white">
                    <div className={campaign.parentCampaignId ? 'flex min-w-0 items-center gap-2 pl-5' : 'flex min-w-0 items-center gap-2'}>
                      {campaign.parentCampaignId ? (
                        <span className="shrink-0 text-violet-300" title={`Child of ${campaign.parentCampaignName || 'parent campaign'}`}>↳</span>
                      ) : null}
                      <NavigationLink
                        className="block min-w-0 truncate whitespace-nowrap text-left text-white transition hover:text-violet-200"
                        href={navigationUrl('landing', { tenantId: selectedTenantId, previewCampaignId: campaign.id })}
                        onNavigate={() => void handleOpenCampaignView(campaign.id)}
                        title={campaignDisplayName(campaign)}
                      >
                        {campaignDisplayName(campaign)}
                      </NavigationLink>
                      {campaign.parentCampaignId ? (
                        <span className="shrink-0 rounded-full border border-violet-300/30 bg-violet-500/15 px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-violet-200">
                          Sub
                        </span>
                      ) : campaign.childCampaignCount > 0 ? (
                        <span className="shrink-0 rounded-full border border-sky-300/30 bg-sky-500/15 px-2 py-0.5 text-[8px] font-semibold uppercase tracking-[0.08em] text-sky-200">
                          {campaign.childCampaignCount} Sub
                        </span>
                      ) : null}
                    </div>
                    {campaign.parentCampaignId ? (
                      <p className="mt-1 truncate pl-10 text-[9px] font-medium text-slate-400">
                        Child of {campaign.parentCampaignName || 'parent campaign'}
                      </p>
                    ) : null}
                  </td>
                  <td className="px-5 py-2.5 text-slate-300">{campaign.createdBy || 'N/A'}</td>
                  <td className="px-5 py-2.5 text-slate-300">{new Date(campaign.createdAt).toLocaleString('en-GB')}</td>
                  <td className="px-5 py-2.5 text-center font-semibold text-white">{campaign.marketCount}</td>
                  <td className="px-5 py-2.5 text-center font-semibold text-white">{campaign.assetCount}</td>
                  <td className="px-5 py-2.5 text-slate-300">{formatCampaignDate(campaign.campaignStartDate)}</td>
                  <td className="px-5 py-2.5 text-center text-slate-300">{campaign.numberOfWeeks || '0'}</td>
                  <td className="px-5 py-2.5 text-center">
                    <span className={campaign.status === 'submitted'
                      ? 'inline-flex rounded-full border border-emerald-300/35 bg-emerald-500/15 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-emerald-200'
                      : 'inline-flex rounded-full border border-amber-300/35 bg-amber-500/15 px-2.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em] text-amber-200'}
                    >
                      {formatCampaignStatus(campaign.status)}
                    </span>
                  </td>
                  <td className="px-5 py-2.5">
                    <div className="flex justify-center gap-1.5">
                      <NavigationLink aria-label="View campaign" className={cn(buttonVariants({ variant: 'ghost' }), "h-7 w-7 rounded-md border border-white/10 p-0 text-slate-200", "aria-disabled:opacity-50")} href={navigationUrl('landing', { tenantId: selectedTenantId, previewCampaignId: campaign.id })} onNavigate={() => void handleOpenCampaignView(campaign.id)} title="View campaign">
                        <Eye className="h-3.5 w-3.5" />
                      </NavigationLink>
                      {isSuperAdmin ? (
                        <Button
                          aria-label="Download purchase order"
                          className="h-7 w-7 rounded-md border border-white/10 p-0 text-sky-200 disabled:text-slate-500"
                          disabled={!campaign.purchaseOrder || downloadingPurchaseOrderId === campaign.id}
                          onClick={() => void handleDownloadPurchaseOrder(campaign)}
                          title={campaign.purchaseOrder ? 'Download purchase order' : 'No PO uploaded'}
                          type="button"
                          variant="ghost"
                        >
                          {downloadingPurchaseOrderId === campaign.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-sky-200" /> : <Download className="h-3.5 w-3.5" />}
                        </Button>
                      ) : null}
                      {isSuperAdmin ? (
                        <Button
                          aria-label="Reset campaign status to In Progress"
                          className="h-7 w-7 rounded-md border border-white/10 p-0 text-amber-200 disabled:text-slate-500"
                          disabled={campaign.status !== 'submitted' || resettingCampaignId !== null}
                          onClick={() => void handleResetCampaignStatus(campaign)}
                          title={campaign.status === 'submitted' ? 'Reset status to In Progress' : 'Only submitted campaigns can be reset'}
                          type="button"
                          variant="ghost"
                        >
                          {resettingCampaignId === campaign.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                        </Button>
                      ) : null}
                      <Button
                        aria-label="Clone campaign"
                        className="h-7 w-7 rounded-md border border-white/10 p-0 text-violet-200"
                        disabled={campaign.status !== 'submitted' || cloningCampaignId === campaign.id}
                        onClick={() => openCloneDialog(campaign)}
                        title={campaign.status === 'submitted' ? 'Clone campaign' : 'Only submitted campaigns can be cloned'}
                        type="button"
                        variant="ghost"
                      >
                        {cloningCampaignId === campaign.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-violet-200" /> : <CopyPlus className="h-3.5 w-3.5" />}
                      </Button>
                      {!campaign.parentCampaignId ? (
                        <Button
                          aria-label="Add Sub Campaign"
                          className="h-7 w-7 rounded-md border border-white/10 p-0 text-emerald-200"
                          disabled={campaign.status === 'submitted' || creatingSubCampaignId === campaign.id}
                          onClick={() => void handleCreateSubCampaign(campaign)}
                          title={campaign.status === 'submitted' ? 'Submitted campaigns cannot be edited' : 'Add Sub Campaign'}
                          type="button"
                          variant="ghost"
                        >
                          {creatingSubCampaignId === campaign.id ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-emerald-200" /> : <Plus className="h-3.5 w-3.5" />}
                        </Button>
                      ) : null}
                      <NavigationLink
                        aria-label="Edit campaign"
                        className={cn(buttonVariants({ variant: 'ghost' }), "h-7 w-7 rounded-md border border-white/10 p-0 text-slate-200", "aria-disabled:opacity-50")}
                        disabled={campaign.status === 'submitted'}
                        href={navigationUrl('quote', { tenantId: selectedTenantId, campaignId: campaign.id })} onNavigate={() => void handleOpenCampaign(campaign.id, campaign.status)}
                        title={campaign.status === 'submitted' ? 'Submitted campaigns cannot be edited' : 'Edit campaign'}


                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </NavigationLink>
                      <Button
                        aria-label="Delete campaign"
                        className="h-7 w-7 rounded-md border border-white/10 p-0 text-rose-300"
                        disabled={campaign.status === 'submitted'}
                        onClick={() => openDeleteDialog(campaign)}
                        title={campaign.status === 'submitted' ? 'Submitted campaigns cannot be edited' : 'Delete campaign'}
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <CampaignScheduleViewDialog
        campaign={campaignForView}
        error={viewError}
        editLockNotice={viewEditLockNotice}
        loading={viewLoading}
        tenantId={selectedTenantId}
        onClose={() => setViewDialogOpen(false)}
        onClone={() => {
          if (viewCampaignId) openCloneDialog({ id: viewCampaignId, campaignName: campaignForView?.values.campaignName, status: campaignForView?.status });
        }}
        cloning={Boolean(viewCampaignId && cloningCampaignId === viewCampaignId)}
        onEdit={() => void handleEditFromView()}
        onOpenChange={(open) => {
          setViewDialogOpen(open);
          if (!open) {
            void loadCampaigns();
            setViewLoading(false);
            setViewError('');
            setViewEditLockNotice('');
            setCampaignForView(null);
            setViewCampaignId(null);
          }
        }}
        open={viewDialogOpen}
      />

      {landingNotice
        ? (bottomBarHost
            ? createPortal(
                <div className="z-20 border-t border-slate-800/90 bg-slate-950/92 backdrop-blur">
                  <div className="w-full px-3 py-2 sm:px-4 lg:px-5">
                    <div className="px-1 py-1 text-sm text-slate-300" role="status">{landingNotice}</div>
                  </div>
                </div>,
                bottomBarHost,
              )
            : null)
        : null}

      <Dialog
        open={cloneDialogOpen}
        onOpenChange={(open) => {
          if (cloningCampaignId) return;
          setCloneDialogOpen(open);
          if (!open) setCampaignPendingClone(null);
        }}
      >
        <DialogContent>
          <DialogHeader className="pb-2">
            <DialogTitle>Clone Campaign</DialogTitle>
            <DialogDescription className="pt-1 leading-6">
              {campaignPendingClone
                ? `Clone "${campaignPendingClone.campaignName}" and open the new editable copy?`
                : 'Clone this campaign and open the new editable copy?'}
            </DialogDescription>
          </DialogHeader>
          <div className="pt-2">
            <div className="flex justify-end gap-3">
              <Button
                disabled={Boolean(cloningCampaignId)}
                onClick={() => {
                  setCloneDialogOpen(false);
                  setCampaignPendingClone(null);
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={Boolean(cloningCampaignId)} onClick={() => void handleConfirmCloneCampaign()}>
                {cloningCampaignId ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : <CopyPlus className="h-4 w-4" />}
                {cloningCampaignId ? 'Cloning...' : 'Clone Campaign'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (deletingCampaign) return;
          setDeleteDialogOpen(open);
          if (!open) setCampaignPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader className="pb-2">
            <DialogTitle>Delete Campaign</DialogTitle>
            <DialogDescription className="pt-1 leading-6">
              {campaignPendingDelete
                ? `Delete "${campaignPendingDelete.campaignName || `Untitled Campaign ${campaignPendingDelete.id.slice(0, 6)}`}"? This action cannot be undone.`
                : 'Delete this campaign? This action cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          <div className="pt-2">
            <div className="flex justify-end gap-3">
              <Button
                disabled={deletingCampaign}
                onClick={() => {
                  setDeleteDialogOpen(false);
                  setCampaignPendingDelete(null);
                }}
                type="button"
                variant="ghost"
              >
                Cancel
              </Button>
              <Button disabled={deletingCampaign} onClick={() => void handleConfirmDeleteCampaign()}>
                {deletingCampaign ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : <Trash2 className="h-4 w-4" />}
                {deletingCampaign ? 'Deleting...' : 'Delete Campaign'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </main>
  );
}
