import { loadArtworkExportPreview, prepareArtworkExportPreviews } from '../services/artworkExportPreview';
import { shippingLinesWithCreatives } from '../services/shippingCreatives';
import { Fragment, type Dispatch, type DragEvent, type SetStateAction, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronUp, CircleAlert, Download, Eye, GripVertical, LayoutGrid, LoaderCircle, Maximize2, Pencil, Plus, Search, Table2, Trash2, Upload, X } from 'lucide-react';
import {
  CampaignAsset,
  CampaignPrintImage,
  CampaignSupportingDocument,
  CampaignRecord,
  CampaignCalculationSummary,
  CustomPrintCostRecord,
  CampaignLine,
  CampaignMarket,
  MarketAssetPrintingCostRecord,
  MarketAssetShippingCostRecord,
  CampaignTotals,
  MarketMetadata,
  MarketDeliveryAddressRecord,
  MaterialRecord,
  MarketShippingRateRecord,
  OrderFormValues,
  QuantityBreakdown,
  SheetNameOverrides,
  createCampaignAsset,
  createCampaignMarket,
  createDefaultFormValues,
  FormatKey,
  formatKeys,
} from '@flowiq/shared';
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, Input, Label, Textarea, cn } from '@flowiq/ui';
import { createPortal } from 'react-dom';
import { useAuth } from '../context/AuthContext';
import { useArtworkUploads } from '../context/ArtworkUploadContext';
import { OneDriveArtworkImportDialog } from '../components/OneDriveArtworkImportDialog';
import { OneDriveSelection } from '../services/oneDriveApi';
import { buildApiUrl } from '../services/apiBase';
import { acquireCampaignEditLock, appendCampaignSupportingDocuments, createCampaign, downloadCampaignPurchaseOrder, fetchCampaign, markCampaignSubmitted, releaseCampaignEditLock, submitCampaignToPrintIQ, updateCampaign as updateStoredCampaign } from '../services/campaignApi';
import { deleteCampaignImage, downloadCampaignImage, uploadCampaignImage } from '../services/campaignImageApi';
import { calculateCampaign, fetchCalculatorMetadata } from '../services/calculatorApi';
import { sendEmailToAds } from '../services/finalizeApi';
import { fetchCampaignCustomPrintCosts, fetchCampaignMaterials, fetchCampaignMarketAssetPrintingCosts, fetchCampaignMarketAssetShippingCosts, fetchCampaignMarketDeliveryAddresses, fetchCampaignMarketShippingRates } from '../services/marketDeliveryApi';
import { uploadPurchaseOrderFile } from '../services/purchaseOrderApi';
import { fetchCampaignSheetNameOverrides } from '../services/sheetNameApi';
import { fetchTenant } from '../services/tenantApi';
import { canonicalKeyForFormat, resolveFormatName, resolveSheetName, sanitizeSheetNameOverrides, toCanonicalSheetNameKey } from '../services/sheetNameOverrides';
import ExcelJS from 'exceljs';
import { Document as WordDocument, ExternalHyperlink, ImageRun, LineRuleType, Packer, Paragraph, TextRun, UnderlineType } from 'docx';
import fontkit from '@pdf-lib/fontkit';
import { PDFArray, PDFDocument, PDFName, PDFString, rgb } from 'pdf-lib';

const ACTIVE_CAMPAIGN_ID_KEY = 'adsconnect-active-campaign-id';
const REVIEW_DRAWER_OPEN_KEY = 'adsconnect-review-drawer-open';
const REVIEW_DRAWER_MODE_KEY = 'adsconnect-review-drawer-mode';
const VISUALS_EXPORT_MODE = parseVisualsExportMode(process.env.EXPORT_EXCEL);
const QUOTE_AUTOMATION_RESULT_EVENT = 'flowiq:quote-automation-result';
const LANDING_NOTICE_KEY = 'flowiq:landing-notice';

type VisualsExportMode = 'excel' | 'pdf';
type ArtworkExportPurpose = 'visuals' | 'installs';
type ReviewDrawerMode = 'high-level' | 'detailed';

type GeneratedVisualExportFile = {
  fileName: string;
  blob: Blob;
  mimeType: string;
};

type AutomatedQuoteAction = 'download-visuals' | 'download-installs' | 'send-email-to-ads';
type AutomatedQuoteActionStatus = 'success' | 'error';
type UploadedPurchaseOrder = NonNullable<CampaignRecord['purchaseOrder']>;

function parseVisualsExportMode(value: string | undefined): VisualsExportMode {
  const normalized = (value || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized) ? 'excel' : 'pdf';
}

function activeCampaignStorageKey(tenantId?: string | null) {
  return tenantId ? `${ACTIVE_CAMPAIGN_ID_KEY}:${tenantId}` : ACTIVE_CAMPAIGN_ID_KEY;
}

async function setStoredCampaignId(value: string | null, tenantId?: string | null) {
  if (typeof window === 'undefined') return;
  const storageKey = activeCampaignStorageKey(tenantId);
  if (value === null) window.localStorage.removeItem(storageKey);
  else window.localStorage.setItem(storageKey, value);
}

async function getStoredCampaignId(tenantId?: string | null) {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(activeCampaignStorageKey(tenantId));
}

function applyCampaignToScreen(
  campaign: CampaignRecord,
  setValues: Dispatch<SetStateAction<OrderFormValues>>,
  setSummary: Dispatch<SetStateAction<CampaignCalculationSummary | null>>,
  setUploadedPurchaseOrderName: Dispatch<SetStateAction<string>>,
  setUploadedPurchaseOrder: Dispatch<SetStateAction<UploadedPurchaseOrder | null>>,
  setCampaignId: Dispatch<SetStateAction<string | null>>,
  setCampaignStatus: Dispatch<SetStateAction<CampaignRecord['status']>>,
  setParentCampaignId: Dispatch<SetStateAction<string>>,
) {
  setValues(normalizeFormValues(campaign.values));
  setSummary(campaign.summary);
  setUploadedPurchaseOrderName(campaign.purchaseOrder?.originalName || '');
  setUploadedPurchaseOrder(campaign.purchaseOrder);
  setCampaignId(campaign.id);
  setCampaignStatus(campaign.status);
  setParentCampaignId(campaign.parentCampaignId || '');
}

function BreakdownTable({ breakdown, inverse = false }: { breakdown: QuantityBreakdown; inverse?: boolean }) {
  const displayLabel: Partial<Record<keyof QuantityBreakdown, string>> = {
    'DOT M': 'DOT Mega',
    MP: 'Mega Portrait',
    FF: 'Ferro Film',
  };
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {formatKeys.map((key) => (
        <div key={key} className={cn('rounded-md border px-4 py-3', inverse ? 'border-slate-700 bg-slate-900' : 'border-slate-700/70 bg-slate-800/80')}>
          <p className={cn('text-xs font-bold uppercase tracking-[0.18em]', inverse ? 'text-violet-200' : 'text-slate-300')}>{displayLabel[key] ?? key}</p>
          <p className="mt-2 text-xl font-black text-white">{breakdown[key]}</p>
        </div>
      ))}
    </div>
  );
}

function buildReviewRows(totals: CampaignTotals) {
  const breakdownRecord = totals.breakdown as Record<string, number>;
  const computedPosterTotal = Object.values(breakdownRecord).reduce((sum, value) => sum + (value ?? 0), 0);
  const frameBreakdown: QuantityBreakdown = {
    ...(totals.frameBreakdown ?? totals.breakdown as Record<string, number>),
  } as QuantityBreakdown;
  const dynamicFrameBreakdown = frameBreakdown as Record<string, number>;
  if (!totals.frameBreakdown) {
    dynamicFrameBreakdown['8-sheet'] = Math.ceil(breakdownValueForKey(totals.breakdown, '8-sheet') / 4);
    dynamicFrameBreakdown['6-sheet'] = Math.ceil(breakdownValueForKey(totals.breakdown, '6-sheet') / 3);
    dynamicFrameBreakdown['4-sheet'] = Math.ceil(breakdownValueForKey(totals.breakdown, '4-sheet') / 2);
    dynamicFrameBreakdown['2-sheet'] = breakdownValueForKey(totals.breakdown, '2-sheet');
    dynamicFrameBreakdown.QA0 = Math.ceil(breakdownValueForKey(totals.breakdown, 'QA0') / 4);
  }
  const computedFrameTotal = Object.values(dynamicFrameBreakdown).reduce((sum, value) => sum + (value ?? 0), 0);

  return [
    { label: 'Posters', breakdown: totals.breakdown, total: computedPosterTotal, shippingCost: 0 },
    { label: 'Frames', breakdown: frameBreakdown, total: computedFrameTotal, shippingCost: null },
  ] as const;
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

function formatCurrency(value: number) {
  return `$${value.toFixed(2)}`;
}

function formatKeyLabel(key: (typeof formatKeys)[number], overrides: SheetNameOverrides = {}) {
  const resolved = resolveFormatName(key, overrides);
  if (key === 'Mega') return resolved;
  if (key === 'DOT M') return resolved;
  if (key === 'MP') return resolved;
  return resolved;
}

function isKnownFormatKey(key: string): key is (typeof formatKeys)[number] {
  return (formatKeys as readonly string[]).includes(key);
}

function breakdownValueForKey(breakdown: QuantityBreakdown, key: string) {
  return (breakdown as Record<string, number>)[key] ?? 0;
}

function quantityForSheetKey(breakdown: Record<string, number>, sheetKey: string) {
  if (typeof breakdown[sheetKey] === 'number') return breakdown[sheetKey];
  const matchingKey = Object.keys(breakdown).find((key) => toCanonicalSheetNameKey(key) === sheetKey);
  return matchingKey ? breakdown[matchingKey] ?? 0 : 0;
}

function assetSheetCostFlagKey(assetId: string, sheetKey: string) {
  return `asset:${assetId}|sheet:${sheetKey}`;
}

function formatBreakdownKeyLabel(key: string, overrides: SheetNameOverrides = {}) {
  if (isKnownFormatKey(key)) {
    return formatKeyLabel(key, overrides);
  }
  return resolveSheetName(key, overrides);
}

function visibleBreakdownKeys(breakdown: QuantityBreakdown) {
  const dynamicKeys = Object.keys((breakdown ?? {}) as Record<string, number>);
  const all = Array.from(new Set([...formatKeys, ...dynamicKeys]));
  return all.filter((key) => breakdownValueForKey(breakdown, key) > 0);
}

const creativeFormatKeys = ['8-sheet', '6-sheet', '4-sheet', '2-sheet', 'QA0', 'Mega', 'DOT M', 'MP', 'FF'] as const;
type CreativeFormatKey = (typeof creativeFormatKeys)[number];
const formatToFrameDivisor: Record<CreativeFormatKey, number> = {
  '8-sheet': 4,
  '6-sheet': 3,
  '4-sheet': 2,
  '2-sheet': 1,
  QA0: 4,
  Mega: 1,
  'DOT M': 1,
  MP: 1,
  FF: 1,
};

function frameCountForFormat(breakdown: QuantityBreakdown | null | undefined, formatKey: CreativeFormatKey) {
  const quantity = breakdown ? breakdownValueForKey(breakdown, formatKey) : 0;
  const divisor = formatToFrameDivisor[formatKey] ?? 1;
  return Math.max(1, Math.ceil(Math.max(0, quantity) / Math.max(1, divisor)));
}

type MultiArtworkRecord = { id: string; imageId: string; materialId: string; frameCount: number };
type MultiMaterialRecord = { id: string; materialId: string; frameCount: number };
const MARKET_PLANNING_THEMES = [
  {
    card: 'border-white/10 bg-slate-900/70',
    cardActive: 'border-violet-300/45 shadow-[0_0_0_1px_rgba(119, 87, 217,0.14)]',
    accent: 'bg-violet-300/70',
    header: 'bg-slate-900/92 text-slate-300',
  },
  {
    card: 'border-white/10 bg-slate-900/70',
    cardActive: 'border-violet-300/45 shadow-[0_0_0_1px_rgba(119, 87, 217,0.14)]',
    accent: 'bg-violet-300/70',
    header: 'bg-slate-900/92 text-slate-300',
  },
  {
    card: 'border-white/10 bg-slate-900/70',
    cardActive: 'border-violet-300/45 shadow-[0_0_0_1px_rgba(119, 87, 217,0.14)]',
    accent: 'bg-violet-300/70',
    header: 'bg-slate-900/92 text-slate-300',
  },
  {
    card: 'border-white/10 bg-slate-900/70',
    cardActive: 'border-violet-300/45 shadow-[0_0_0_1px_rgba(119, 87, 217,0.14)]',
    accent: 'bg-violet-300/70',
    header: 'bg-slate-900/92 text-slate-300',
  },
] as const;

const TOP_FORM_THEME =
  'rounded-xl border border-white/10 bg-slate-900/75 p-5 shadow-[0_10px_22px_rgba(2,6,23,0.22)]';

function creativeFormatLabel(key: CreativeFormatKey, overrides: SheetNameOverrides = {}) {
  return formatKeyLabel(key, overrides);
}

function toCreativeFormatKey(key: keyof QuantityBreakdown): CreativeFormatKey {
  return key as CreativeFormatKey;
}

function normalizeCreativeImageIds(asset: CampaignAsset): Record<string, string> {
  const normalized: Record<string, string> = {};
  Object.entries(asset.creativeImageIds ?? {}).forEach(([key, imageId]) => {
    const mapped = (imageId || '').trim();
    if (mapped) {
      normalized[key] = mapped;
    }
  });

  const legacyCreativeId = (asset.creativeImageId || '').trim();
  if (legacyCreativeId && Object.keys(normalized).length === 0) {
    creativeFormatKeys.forEach((key) => {
      normalized[key] = legacyCreativeId;
    });
  }
  return normalized;
}

function normalizeArtworkMaterialAssignments(asset: CampaignAsset) {
  const normalized: NonNullable<CampaignAsset['artworkMaterialAssignments']> = {};
  Object.entries(asset.artworkMaterialAssignments ?? {}).forEach(([key, rawAssignments]) => {
    const assignments = (rawAssignments ?? [])
      .map((assignment) => ({
        artworkImageId: (assignment.artworkImageId || '').trim(),
        materialId: (assignment.materialId || '').trim(),
        frameCount: Math.max(0, Math.floor(assignment.frameCount || 0)),
      }))
      .filter((assignment) => assignment.frameCount > 0);
    if (assignments.length > 0) normalized[key] = assignments;
  });
  return normalized;
}

function artworkMaterialAssignmentsForFormat(asset: CampaignAsset, formatKey: CreativeFormatKey) {
  return normalizeArtworkMaterialAssignments(asset)[formatKey] ?? [];
}

function expandedArtworkImageIdsForFormat(asset: CampaignAsset, formatKey: CreativeFormatKey) {
  return artworkMaterialAssignmentsForFormat(asset, formatKey).flatMap((assignment) =>
    Array.from({ length: assignment.frameCount }, () => assignment.artworkImageId).filter(Boolean),
  );
}

function hasAssignedMaterialForFormat(asset: CampaignAsset, formatKey: CreativeFormatKey) {
  return artworkMaterialAssignmentsForFormat(asset, formatKey).some((assignment) => Boolean(assignment.materialId));
}

function getCreativeImageIdForFormat(asset: CampaignAsset, format: CreativeFormatKey) {
  const mapped = (asset.creativeImageIds?.[format] || '').trim();
  if (mapped) return mapped;
  if (format === 'QA0') {
    // Backward compatibility: legacy mappings often stored QA0 artwork in the 8-sheet slot.
    const legacyQa0Mapped = (asset.creativeImageIds?.['8-sheet'] || '').trim();
    if (legacyQa0Mapped) return legacyQa0Mapped;
  }
  const hasExplicitFormatMappings = Object.values(asset.creativeImageIds ?? {}).some((value) => (value || '').trim().length > 0);
  if (hasExplicitFormatMappings) return '';
  return (asset.creativeImageId || '').trim();
}

function getCreativeFormatsForBreakdown(breakdown: QuantityBreakdown | null | undefined) {
  const formats = new Set<CreativeFormatKey>();
  if (!breakdown) return [];
  (Object.keys(breakdown) as Array<keyof QuantityBreakdown>).forEach((key) => {
    if ((breakdown[key] ?? 0) > 0) {
      formats.add(toCreativeFormatKey(key));
    }
  });
  return Array.from(formats);
}

function parseDateOnly(value: string) {
  if (!value) return null;
  const parts = value.split('-').map((part) => Number(part));
  if (parts.length !== 3 || parts.some((part) => Number.isNaN(part))) return null;
  const [year, month, day] = parts;
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  return parsed;
}

function previousWednesday(value: string) {
  const startDate = parseDateOnly(value);
  if (!startDate) return '';
  const daysSinceWednesday = (startDate.getDay() - 3 + 7) % 7;
  startDate.setDate(startDate.getDate() - (daysSinceWednesday || 7));
  const year = String(startDate.getFullYear());
  const month = String(startDate.getMonth() + 1).padStart(2, '0');
  const day = String(startDate.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function getTodayDateInputValue() {
  const now = new Date();
  const year = String(now.getFullYear());
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isDateBeforeToday(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return false;
  parsed.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return parsed < today;
}

function formatWeekLabel(week: number, startDate: string) {
  const parsedStartDate = parseDateOnly(startDate);
  if (!parsedStartDate) return `Week ${week}`;
  const weekDate = new Date(parsedStartDate);
  weekDate.setDate(parsedStartDate.getDate() + (week - 1) * 7);
  return weekDate.toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
  });
}

function createAllWeeks(weekCount: number) {
  const safeWeekCount = Math.max(1, Math.floor(weekCount || 1));
  return Array.from({ length: safeWeekCount }, (_, index) => index + 1);
}

function toFileBaseName(fileName: string) {
  return fileName.replace(/\.[^.]+$/, '');
}

function isPdfFile(file: File) {
  const lowerName = file.name.toLowerCase();
  return file.type === 'application/pdf' || lowerName.endsWith('.pdf');
}

function normalizeCreativeNameAssignments(input?: Record<string, string>) {
  const normalized: Record<string, string> = {};
  Object.entries(input ?? {}).forEach(([creativeName, imageId]) => {
    const safeCreativeName = (creativeName || '').trim();
    const safeImageId = (imageId || '').trim();
    if (!safeCreativeName || !safeImageId) return;
    normalized[safeCreativeName] = safeImageId;
  });
  return normalized;
}

function normalizeArtworkCodes(input?: Record<string, string>) {
  const normalized: Record<string, string> = {};
  Object.entries(input ?? {}).forEach(([imageId, code]) => {
    const safeImageId = (imageId || '').trim();
    const safeCode = (code || '').trim();
    if (!safeImageId || !safeCode) return;
    normalized[safeImageId] = safeCode;
  });
  return normalized;
}

function normalizeFormValues(values: OrderFormValues): OrderFormValues {
  const normalizeCampaignImageUrl = (url?: string) =>
    url && url.startsWith('/uploads/campaign-images/')
      ? url.replace('/uploads/campaign-images/', '/api/campaign-images/')
      : url;

  return {
    ...values,
    purchaseOrderNumber: values.purchaseOrderNumber ?? '',
    clientName: values.clientName ?? '',
    productCode: values.productCode || createDefaultFormValues().productCode,
    campaignMarkets: (values.campaignMarkets ?? []).map((market) => ({
      ...market,
      assets: (market.assets ?? []).map((asset) => {
        const creativeImageIds = normalizeCreativeImageIds(asset);
        return {
          ...asset,
          creativeImageIds,
          artworkMaterialAssignments: normalizeArtworkMaterialAssignments(asset),
          creativeImageId: getCreativeImageIdForFormat({ ...asset, creativeImageIds }, '8-sheet') || asset.creativeImageId || '',
        };
      }),
    })),
    printImages: (values.printImages ?? []).map((image) => ({
      id: image.id,
      name: image.name,
      fileName: image.fileName,
      mimeType: image.mimeType,
      storedName: image.storedName,
      imageUrl: normalizeCampaignImageUrl(image.imageUrl),
      thumbnailFileName: image.thumbnailFileName,
      thumbnailStoredName: image.thumbnailStoredName,
      thumbnailUrl: normalizeCampaignImageUrl(image.thumbnailUrl),
      previewFileName: image.previewFileName,
      previewStoredName: image.previewStoredName,
      previewUrl: normalizeCampaignImageUrl(image.previewUrl),
      sourcePdfFileName: image.sourcePdfFileName,
      sourcePdfStoredName: image.sourcePdfStoredName,
      sourcePdfUrl: normalizeCampaignImageUrl(image.sourcePdfUrl),
    })),
    supportingDocuments: (values.supportingDocuments ?? []).map((document) => ({ ...document })),
    creativeNameAssignments: normalizeCreativeNameAssignments(values.creativeNameAssignments),
    artworkCodes: normalizeArtworkCodes(values.artworkCodes),
  };
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatDocumentDate(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return 'TBC';
  return parsed.toLocaleDateString('en-GB');
}

function formatUploadDate(value: string) {
  if (!value) return '-';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-GB');
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function formatDateInputDisplay(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return '';
  const day = String(parsed.getDate()).padStart(2, '0');
  const month = String(parsed.getMonth() + 1).padStart(2, '0');
  const year = String(parsed.getFullYear());
  return `${day}/${month}/${year}`;
}

function parseDisplayDateToIso(value: string) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  const parsed = new Date(year, month - 1, day);
  if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return null;
  const normalizedDay = String(day).padStart(2, '0');
  const normalizedMonth = String(month).padStart(2, '0');
  return `${year}-${normalizedMonth}-${normalizedDay}`;
}

function toOrdinalDay(day: number) {
  const remainder = day % 10;
  const teens = day % 100;
  if (teens >= 11 && teens <= 13) return `${day}th`;
  if (remainder === 1) return `${day}st`;
  if (remainder === 2) return `${day}nd`;
  if (remainder === 3) return `${day}rd`;
  return `${day}th`;
}

function formatDeliveryDeadline(value: string) {
  const parsed = parseDateOnly(value);
  if (!parsed) return 'the due date';
  const weekday = parsed.toLocaleDateString('en-AU', { weekday: 'long' });
  const month = parsed.toLocaleDateString('en-AU', { month: 'long' });
  return `${weekday} the ${toOrdinalDay(parsed.getDate())} of ${month}`;
}

function formatDeliveryAddressOptionLabel(address: string) {
  const lines = address
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const name = lines[0] || 'Address';
  const localityLine = lines.find((line) => /\b\d{4}\b/.test(line)) || '';
  const postcodeMatch = localityLine.match(/\b(\d{4})\b/);
  const postcode = postcodeMatch ? postcodeMatch[1] : '';
  return postcode ? `${name} - ${postcode}` : name;
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

function formatDeliveryDestinationForExport(address: string, fallbackState: ExportState | null): { fullAddress: string; contactName: string } {
  const lines = address
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const normalizedLines = lines.length > 0
    ? lines
    : (fallbackState ? [`VIM ${fallbackState}`] : ['DELIVERY']);
  const firstLineUpper = normalizedLines[0].toUpperCase();
  const contactName = firstLineUpper.startsWith('VIM ') && normalizedLines[1]
    ? normalizedLines[1]
    : normalizedLines[0];
  return {
    fullAddress: normalizedLines.join(', '),
    contactName: contactName || (fallbackState ? `VIM ${fallbackState}` : 'DELIVERY'),
  };
}

type AddressFormState = {
  name: string;
  unitStreetNumber: string;
  suburb: string;
  state: string;
  postcode: string;
  phoneNumber: string;
  deliveryTime: string;
  deliveryPoint: string;
  deliveryNotes: string;
};

function emptyAddressForm(): AddressFormState {
  return {
    name: '',
    unitStreetNumber: '',
    suburb: '',
    state: '',
    postcode: '',
    phoneNumber: '',
    deliveryTime: '',
    deliveryPoint: '',
    deliveryNotes: '',
  };
}

function formatAddressLine(form: AddressFormState) {
  return form.unitStreetNumber.trim();
}

function formatDeliveryAddress(form: AddressFormState) {
  const lines = [
    form.name.trim(),
    formatAddressLine(form),
    [form.suburb.trim(), form.state.trim(), form.postcode.trim()].filter(Boolean).join(' '),
    `Phone: ${form.phoneNumber.trim()}`,
    `Delivery time: ${form.deliveryTime.trim()}`,
    `Delivery point: ${form.deliveryPoint.trim()}`,
    `Notes: ${form.deliveryNotes.trim().replaceAll('\n', ' ')}`,
    'Australia',
  ];
  return lines.join('\n');
}

const exportStates = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
type ExportState = (typeof exportStates)[number];

function normalizeExportState(value: string) {
  const normalized = value.trim().toUpperCase();
  if (normalized.includes('NSW') || normalized.includes('SYD')) return 'NSW' as const;
  if (normalized.includes('VIC') || normalized.includes('MEL')) return 'VIC' as const;
  if (normalized.includes('QLD') || normalized.includes('BRIS')) return 'QLD' as const;
  if (normalized.includes('WA') || normalized.includes('PERTH')) return 'WA' as const;
  if (normalized.includes('SA') || normalized.includes('ADELAIDE')) return 'SA' as const;
  if (normalized.includes('TAS') || normalized.includes('HOBART')) return 'TAS' as const;
  if (normalized.includes('ACT') || normalized.includes('CANBERRA')) return 'ACT' as const;
  if (normalized.includes('NT') || normalized.includes('DARWIN')) return 'NT' as const;
  return null;
}

function inferStateFromMarket(marketName: string) {
  return normalizeExportState(marketName);
}

function marketShortLabelForState(state: ExportState) {
  const labelByState: Record<ExportState, string> = {
    NSW: 'Syd',
    VIC: 'Melb',
    QLD: 'Bris',
    WA: 'Perth',
    SA: 'Adel',
    TAS: 'Hob',
    ACT: 'Canb',
    NT: 'Darwin',
  };
  return labelByState[state];
}

function sanitizeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, '').trim();
}

function buildCreativeCode(state: ExportState, creativeNumber: number) {
  const prefixByState: Record<ExportState, string> = {
    NSW: 'CS',
    VIC: 'CM',
    QLD: 'CB',
    WA: 'CW',
    SA: 'CA',
    TAS: 'CT',
    ACT: 'CC',
    NT: 'CN',
  };
  const prefix = prefixByState[state] ?? 'CS';
  return `${prefix}${creativeNumber}`;
}

function getCreativeNumberFromCode(creativeCode: string) {
  const numeric = creativeCode.replace(/^[A-Z]+/, '');
  const parsed = Number.parseInt(numeric, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function downloadBlobWithFileName(blob: Blob, fileName: string) {
  const objectUrl = window.URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  // Some browsers need a small delay before revoking object URLs, otherwise
  // the saved file may end up with a temporary name/extension.
  window.setTimeout(() => {
    window.URL.revokeObjectURL(objectUrl);
    anchor.remove();
  }, 1500);
}

function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(new Error('Unable to read image blob'));
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBytes(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex < 0) return null;
  const meta = dataUrl.slice(0, commaIndex).toLowerCase();
  const encoded = dataUrl.slice(commaIndex + 1);
  if (!meta.includes(';base64')) return null;
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const extension = meta.includes('image/jpeg') || meta.includes('image/jpg') ? 'jpg' : 'png';
  return { bytes, extension } as const;
}

const WORD_FOLDER_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAqklEQVR4AeyWSwqAIBRFrf3UOCKifUWjaAW1oCiIdlUq+AYS+E0nN7r+8HM8I0uW+csP0LbN45kzhrwQAx0HD4YggH0/mG3meVGXFxC+BuU6AlA7pq4JYBh6ZptpGiVnVdXW1nS7cgNeEABvO/3i8HXdnNZ8TSYAndDUj3G4ACIA0ckRAMAADMAADMAADMAADJAB2xdxrHnq+UcAaiB1XV7XXeTM7wZMRl8AAAD//5quy1QAAAAGSURBVAMANKD4Qc3tQ0sAAAAASUVORK5CYII=';
const WORD_PDF_ICON_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAB0klEQVR4AcyXT04CMRTGyyxm58pjTHBt0DEY74BXwEROYFgRT4CJ4AVE7mAkTiQewB7DlQfAfk0eKa9l2mmGGQgf/fO+tr++Ngwkgr16vfNNpAo2VVDTAgga5TZdKvDKEHsBVqtPESLGUhliLwCb2Nvsds/IUwmiNoDp9EnEQNQGgO3HQNQKEANRO0BVCAtgvf7uQGmadkIEL8S98/mLngcxpRxgLlkALtMh+5Lf/GLTptrPAKX35P1DNCla93gyQET9/pUwNZs9U0iXZozq3AMjxcwS/VzODEwmj/pBhFJKKfgC6KcHFerwjEb3fG6BGPlQWgbV4QRQ/fqd57kYDG7FYvGq264PePAVjBgHRZ9PpQC+wWbcB2p6zboXYLl8M59y5lhvXcoffXzITFG4f6s4AcbjB4EzxQXCKpRi1KtIqvtDfqlgqG6WTgA815FSXJzQxbEAxpmTY47h8E6QzBjVnQAYiMtFppASFzXLshDrjscJsOPwNHC+OC7sHjv12K1wFADuCO4HJNU5Y+ehR8UJLACce1n6ETeFhV07h6dsHgKxACjQVLkF+Lu5Fk2KNrgFoI6my+S0+Oq0qfYzwFOu/mDG/jsOGsfXO3gG+IK8/Q8AAP//tC16dwAAAAZJREFUAwClos9YP/kZEAAAAABJRU5ErkJggg==';
const WORD_FOLDER_ICON = dataUrlToBytes(WORD_FOLDER_ICON_DATA_URL);
const WORD_PDF_ICON = dataUrlToBytes(WORD_PDF_ICON_DATA_URL);

function createWordIconRun(kind: 'folder' | 'pdf') {
  const icon = kind === 'folder' ? WORD_FOLDER_ICON : WORD_PDF_ICON;
  if (!icon) return null;
  return new ImageRun({
    type: icon.extension,
    data: icon.bytes,
    transformation: { width: 16, height: 16 },
  });
}

function createWordIconChildren(kind: 'folder' | 'pdf'): Array<ImageRun | TextRun> {
  const iconRun = createWordIconRun(kind);
  if (!iconRun) return [];
  return [iconRun, new TextRun(' ')];
}

function toAbsoluteUrl(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (typeof window !== 'undefined') {
    try {
      return new URL(trimmed, window.location.origin).toString();
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function buildArtworkFolderUrl(campaignId: string | null | undefined, tenantId: string | null | undefined) {
  const cleanedCampaignId = (campaignId || '').trim();
  if (!cleanedCampaignId) return '';
  const params = new URLSearchParams({
    view: 'artwork',
    campaignId: cleanedCampaignId,
  });
  const cleanedTenantId = (tenantId || '').trim();
  if (cleanedTenantId) params.set('tenantId', cleanedTenantId);
  return toAbsoluteUrl(`/?${params.toString()}`);
}

function withCampaignImageProxy(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return trimmed;
  try {
    const parsed = new URL(trimmed, window.location.origin);
    if (parsed.pathname.startsWith('/api/campaign-images/')) {
      parsed.searchParams.set('proxy', '1');
    }
    return parsed.toString();
  } catch {
    return trimmed;
  }
}

function campaignImageFetchCandidates(url: string) {
  const proxyUrl = withCampaignImageProxy(url);
  try {
    const parsed = new URL(url, window.location.origin);
    const prefix = '/api/campaign-images/';
    if (!parsed.pathname.startsWith(prefix)) return [proxyUrl];
    const storedName = parsed.pathname.slice(prefix.length);
    if (!storedName || storedName.includes('/')) return [proxyUrl];
    return [new URL(`/campaign-artwork-cdn/${storedName}`, window.location.origin).toString(), proxyUrl];
  } catch {
    return [proxyUrl];
  }
}

function detectStateMarkerColumns(sheet: any, headerRow: number, fromColumn: number, toColumn: number) {
  const markerColumnByState = new Map<ExportState, number>();
  for (let col = fromColumn; col <= toColumn; col += 1) {
    const cell = sheet.getCell(headerRow, col);
    const text = String(cell?.text ?? cell?.value ?? '').trim();
    const state = normalizeExportState(text);
    if (state && !markerColumnByState.has(state)) {
      markerColumnByState.set(state, col);
    }
  }
  return markerColumnByState;
}

function stripSharedFormulaClones(workbook: any) {
  workbook.worksheets.forEach((sheet: any) => {
    sheet.eachRow({ includeEmpty: true }, (row: any) => {
      row.eachCell({ includeEmpty: true }, (cell: any) => {
        const value = cell.value as
          | {
              sharedFormula?: string;
              result?: unknown;
            }
          | null;
        if (!value || typeof value !== 'object') return;
        if (!('sharedFormula' in value) || !value.sharedFormula) return;
        // Shared-formula clones in templates can break after row inserts.
        // Keep export stable by materializing clone results as static values.
        cell.value = value.result ?? null;
      });
    });
  });
}

async function pdfFirstPageToDataUrl(blob: Blob, maxWidth = 560, signal?: AbortSignal) {
  const pdfjs = await loadPdfJsRuntime();

  const objectUrl = URL.createObjectURL(blob);
  const loadingTask = pdfjs.getDocument({ url: objectUrl });
  const cancel = () => { void loadingTask.destroy().catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    signal?.throwIfAborted();
    const pdf = await loadingTask.promise;
    const page = await pdf.getPage(1);
    const initialViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(1, maxWidth / initialViewport.width);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // Exports also run in a hidden iframe, where animation frames are paused.
    // Print intent makes PDF.js render without requestAnimationFrame scheduling.
    await page.render({ canvas, viewport, intent: 'print' }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    signal?.removeEventListener('abort', cancel);
    try {
      await loadingTask.destroy();
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }
}

async function loadPdfJsRuntime() {
  const pdfjs = await (new Function("return import('/pdf.min.mjs')")() as Promise<any>);
  (pdfjs as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
    '/pdf.worker.min.mjs';
  return pdfjs;
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType = 'image/png', quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Unable to render artwork image'));
          return;
        }
        resolve(blob);
      },
      mimeType,
      quality,
    );
  });
}

function TextField({
  id,
  label,
  value,
  onChange,
  type = 'text',
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: React.HTMLInputTypeAttribute;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode={inputMode} type={type} value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}

function SearchableSelect({
  label,
  selectedValue,
  selectedLabel,
  items,
  onValueChange,
  placeholder,
  emptyMessage,
  actionLabel,
  onAction,
  actionDisabled = false,
  disabled = false,
  triggerClassName,
  menuItemClassName,
  menuClassName,
  pickerMode = 'dropdown',
  dialogTitle = 'Select item',
}: {
  label: string;
  selectedValue: string;
  selectedLabel?: string;
  items: Array<{ label: string; value: string }>;
  onValueChange: (value: string) => void;
  placeholder: string;
  emptyMessage: string;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
  disabled?: boolean;
  triggerClassName?: string;
  menuItemClassName?: string;
  menuClassName?: string;
  pickerMode?: 'dropdown' | 'dialog';
  dialogTitle?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const containerRef = useRef<HTMLDivElement | null>(null);
  const displayLabel = selectedLabel || items.find((item) => item.value === selectedValue)?.label || placeholder;
  const filteredItems = useMemo(() => {
    const nextQuery = query.trim().toLowerCase();
    if (!nextQuery) return items;
    return items.filter((item) => item.label.toLowerCase().includes(nextQuery));
  }, [items, query]);
  const useWideDialogGrid = pickerMode === 'dialog' && filteredItems.length > 20;

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (pickerMode === 'dialog') return;

    function handlePointerDown(event: MouseEvent) {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('mousedown', handlePointerDown);
    return () => document.removeEventListener('mousedown', handlePointerDown);
  }, [open, pickerMode]);

  const trigger = (
    <button
      className={cn('flex h-10 w-full items-center justify-between rounded-md border border-slate-600 bg-slate-800 px-3 text-left text-sm text-slate-100 transition hover:border-slate-500 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-slate-600', triggerClassName)}
      disabled={disabled}
      onClick={() => setOpen((current) => !current)}
      type="button"
    >
      <span className={cn('truncate', !selectedValue && !selectedLabel ? 'text-slate-500' : 'text-slate-50')}>{displayLabel}</span>
      <ChevronDown className={cn('h-4 w-4 text-slate-400 transition-transform', open ? 'rotate-180' : '')} />
    </button>
  );

  return (
    <div ref={containerRef} className="relative space-y-2">
      {label ? <Label>{label}</Label> : null}
      {trigger}
      {pickerMode === 'dialog' ? (
        <Dialog open={open && !disabled} onOpenChange={(nextOpen) => setOpen(disabled ? false : nextOpen)}>
          <DialogContent
            className={cn('flex flex-col gap-0 p-0', useWideDialogGrid ? 'max-h-[96vh] overflow-visible' : 'max-h-[88vh] overflow-hidden')}
            style={{ width: useWideDialogGrid ? 'min(calc(100vw - 2rem), 76rem)' : 'min(calc(100vw - 2rem), 54rem)' }}
          >
            <DialogHeader className="shrink-0 border-b border-slate-700 px-4 py-3">
              <DialogTitle className="text-sm">{dialogTitle}</DialogTitle>
            </DialogHeader>
            <div className={cn('min-h-0 flex-1 space-y-2 px-4 py-3', useWideDialogGrid ? 'overflow-visible' : 'overflow-y-auto')}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" />
                <Input
                  autoFocus
                  className="h-8 pl-8 text-[10px]"
                  placeholder={`Search ${label || 'items'}`}
                  style={{ fontSize: '10px' }}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
              {filteredItems.length > 0 ? (
                <div className={cn('grid grid-cols-1 gap-1.5 sm:grid-cols-2', useWideDialogGrid ? 'lg:grid-cols-3' : '')}>
                  {filteredItems.map((item) => {
                    const active = item.value === selectedValue;
                    return (
                      <button
                        key={item.value}
                        className={cn(
                          'flex min-h-8 w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[10px] transition',
                          active ? 'border-violet-400 bg-violet-500/10 text-white' : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500',
                          menuItemClassName,
                        )}
                        style={{ fontSize: '10px' }}
                        onClick={() => {
                          onValueChange(item.value);
                          setOpen(false);
                        }}
                        type="button"
                      >
                        <span className="min-w-0 truncate">{item.label}</span>
                        {active ? <Check className="ml-2 h-4 w-4 shrink-0 text-violet-300" /> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="rounded-md border border-slate-700 bg-slate-900 px-3 py-4 text-center text-sm text-slate-400">{emptyMessage}</p>
              )}
            </div>
          </DialogContent>
        </Dialog>
      ) : open ? (
        <div className={cn('absolute left-0 right-0 top-full z-50 mt-2 rounded-md border border-slate-700 bg-slate-950 p-4 shadow-2xl shadow-slate-950/60', menuClassName)}>
          <div className="space-y-2.5">
            <Input autoFocus className="h-8 text-[11px]" placeholder={`Search ${label || 'items'}`} value={query} onChange={(event) => setQuery(event.target.value)} />
            <div className="max-h-[260px] space-y-1.5 overflow-auto pr-1">
              {filteredItems.map((item) => {
                const active = item.value === selectedValue;
                return (
                  <button
                    key={item.value}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition',
                      active ? 'border-violet-400 bg-violet-500/10 text-white' : 'border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500',
                      menuItemClassName,
                    )}
                    onClick={() => {
                      onValueChange(item.value);
                      setOpen(false);
                    }}
                    type="button"
                  >
                    <span>{item.label}</span>
                    {active ? <Check className="h-4 w-4 text-violet-300" /> : null}
                  </button>
                );
              })}
              {filteredItems.length === 0 ? <p className="rounded-md border border-slate-700 bg-slate-900 px-3 py-4 text-center text-sm text-slate-400">{emptyMessage}</p> : null}
            </div>
            {actionLabel && onAction ? (
              <Button
                className="w-full"
                disabled={actionDisabled}
                onClick={() => {
                  onAction();
                  setOpen(false);
                }}
                type="button"
                variant="secondary"
              >
                <Plus className="h-4 w-4" />
                {actionLabel}
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function WeekSelector({
  weekCount,
  selectedWeeks,
  startDate,
  compact = false,
  small = false,
  readOnly = false,
  onToggleWeek,
}: {
  weekCount: number;
  selectedWeeks: number[];
  startDate: string;
  compact?: boolean;
  small?: boolean;
  readOnly?: boolean;
  onToggleWeek?: (week: number) => void;
}) {
  return (
    <div className={cn('flex', compact ? 'gap-1.5 whitespace-nowrap' : 'flex-wrap gap-1.5')}>
      {Array.from({ length: weekCount }, (_, index) => index + 1).map((week) => {
        const selected = selectedWeeks.includes(week);
        return (
          <button
            key={week}
            className={cn(
              'rounded-full border font-semibold transition',
              compact ? 'px-2 py-0.5 text-[10px]' : small ? 'px-1.5 py-0.5 text-[10px]' : 'px-2.5 py-1 text-xs',
              selected ? 'border-violet-400 bg-violet-500 text-white' : 'border-slate-600 bg-slate-900 text-slate-300 hover:border-slate-500',
            )}
            aria-pressed={selected}
            disabled={readOnly}
            onClick={() => onToggleWeek?.(week)}
            type="button"
          >
            {formatWeekLabel(week, startDate)}
          </button>
        );
      })}
    </div>
  );
}

function ConfirmationDialog({
  open,
  title,
  description,
  descriptionClassName = 'break-all whitespace-normal text-left',
  confirmLabel,
  cancelLabel = 'Cancel',
  confirming = false,
  confirmingLabel,
  warningText = 'This action is permanent and cannot be undone.',
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  descriptionClassName?: string;
  confirmLabel: string;
  cancelLabel?: string;
  confirming?: boolean;
  confirmingLabel?: string;
  warningText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !confirming) onCancel();
      }}
    >
      <DialogContent className="[&>button]:hidden overflow-x-hidden" style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
        <DialogHeader>
          {title ? <DialogTitle>{title}</DialogTitle> : null}
          {description ? (
            <DialogDescription className={descriptionClassName}>{description}</DialogDescription>
          ) : null}
        </DialogHeader>
        {warningText ? (
          <div className="flex items-start gap-3 rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
            <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <p className="break-words whitespace-normal">{warningText}</p>
          </div>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end sm:gap-3">
          <Button className="w-full sm:w-auto" disabled={confirming} onClick={onCancel} type="button" variant="ghost">
            {cancelLabel}
          </Button>
          <Button className="w-full sm:w-auto" disabled={confirming} onClick={onConfirm} type="button" variant="destructive">
            {confirming ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : null}
            {confirming ? confirmingLabel ?? 'Confirming...' : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function truncateForDialog(value: string, maxLength = 44) {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function normalizeCampaignMarkets(campaignMarkets: CampaignMarket[], maxWeeks: number): CampaignMarket[] {
  const allWeeks = createAllWeeks(maxWeeks);
  return campaignMarkets.map((market) => ({
    ...market,
    // Frame counts are derived from posters. Drop historical frame overrides
    // when a campaign is loaded so they cannot influence later calculations.
    quantityOverrides: market.quantityOverrides?.posters
      ? { posters: { ...market.quantityOverrides.posters } }
      : undefined,
    assets: market.assets.map((asset) => {
      const creativeImageIds = normalizeCreativeImageIds(asset);
      const normalizedSelectedWeeks = Array.isArray(asset.selectedWeeks)
        ? Array.from(
            new Set(
              asset.selectedWeeks
                .map((week) => Number(week))
                .filter((week) => Number.isInteger(week) && week >= 1 && week <= maxWeeks),
            ),
          ).sort((left, right) => left - right)
        : allWeeks;
      return {
        ...asset,
        creativeImageId: getCreativeImageIdForFormat({ ...asset, creativeImageIds }, '8-sheet') || '',
        creativeImageIds,
        quantityOverrides: asset.quantityOverrides?.posters
          ? { posters: { ...asset.quantityOverrides.posters } }
          : undefined,
        deliveryAddress: asset.deliveryAddress || '',
        selectedWeeks: normalizedSelectedWeeks,
      };
    }),
  }));
}

const defaultValues = createDefaultFormValues();
const MAX_CAMPAIGN_WEEKS = 52;

function toStableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => toStableValue(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    Object.keys(record)
      .sort((left, right) => left.localeCompare(right))
      .forEach((key) => {
        sorted[key] = toStableValue(record[key]);
      });
    return sorted;
  }
  return value;
}

function stableSerialize(value: unknown) {
  return JSON.stringify(toStableValue(value));
}

function campaignLinesFromMarkets(markets: CampaignMarket[]): CampaignLine[] {
  return markets.flatMap((market) => market.assets.map((asset) => ({
    ...asset,
    market: market.market,
    marketQuantityOverrides: market.quantityOverrides,
  })));
}

export function QuoteBuilderScreen({
  campaignId: selectedCampaignId,
  tenantId,
  startFresh = false,
  autoDownloadVisuals = false,
  printIQVisualsRequestId,
  autoDownloadInstalls = false,
  closeAfterVisualsDownload = false,
  autoSendEmailToAds = false,
  closeAfterEmailSend = false,
  onBack,
  onOpenAdmin,
}: {
  campaignId?: string | null;
  tenantId?: string | null;
  startFresh?: boolean;
  autoDownloadVisuals?: boolean;
  printIQVisualsRequestId?: string;
  autoDownloadInstalls?: boolean;
  closeAfterVisualsDownload?: boolean;
  autoSendEmailToAds?: boolean;
  closeAfterEmailSend?: boolean;
  onBack?: () => void;
  onOpenAdmin?: () => void;
}) {
  const { session } = useAuth();
  const { dismissUploadJobs, enqueueArtworkFiles, enqueueOneDriveFiles, jobs: artworkUploadJobs, removeQueuedUpload } = useArtworkUploads();
  const effectiveTenantId = tenantId ?? session?.user.tenantId ?? null;
  const [values, setValues] = useState<OrderFormValues>(() => defaultValues);
  const [campaignStartDateInput, setCampaignStartDateInput] = useState('');
  const [dueDateInput, setDueDateInput] = useState('');
  const [campaignId, setCampaignId] = useState<string | null>(selectedCampaignId ?? null);
  const [campaignStatus, setCampaignStatus] = useState<CampaignRecord['status']>('in_progress');
  const [parentCampaignId, setParentCampaignId] = useState('');
  const [markets, setMarkets] = useState<MarketMetadata[]>([]);
  const [marketDeliveryAddresses, setMarketDeliveryAddresses] = useState<MarketDeliveryAddressRecord[]>([]);
  const [marketShippingRates, setMarketShippingRates] = useState<MarketShippingRateRecord[]>([]);
  const [marketAssetPrintingCosts, setMarketAssetPrintingCosts] = useState<MarketAssetPrintingCostRecord[]>([]);
  const [customPrintCosts, setCustomPrintCosts] = useState<CustomPrintCostRecord[]>([]);
  const [materials, setMaterials] = useState<MaterialRecord[]>([]);
  const [sheetNameOverrides, setSheetNameOverrides] = useState<SheetNameOverrides>({});
  const [sheetNamesLoaded, setSheetNamesLoaded] = useState(false);
  const [multipleArtworkFormats, setMultipleArtworkFormats] = useState<Record<string, boolean>>({});
  const [customPrintCostFormats, setCustomPrintCostFormats] = useState<Record<string, boolean>>({});
  const [customSheetSizeFormats, setCustomSheetSizeFormats] = useState<Record<string, boolean>>({});
  const [marketAssetShippingCosts, setMarketAssetShippingCosts] = useState<MarketAssetShippingCostRecord[]>([]);
  const [metadataError, setMetadataError] = useState('');
  const [loadingMetadata, setLoadingMetadata] = useState(true);
  const [loadingCampaign, setLoadingCampaign] = useState(true);
  const [savingCampaign, setSavingCampaign] = useState(false);
  const [summary, setSummary] = useState<CampaignCalculationSummary | null>(null);
  const [activeMarketId, setActiveMarketId] = useState<string | null>(null);
  const [calculating, setCalculating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [testSubmitting, setTestSubmitting] = useState(false);
  const [submitProgress, setSubmitProgress] = useState({ progress: 0, label: '' });
  const [quoteResponseMessage, setQuoteResponseMessage] = useState('');
  const [quoteResponseStatus, setQuoteResponseStatus] = useState<'success' | 'error'>('success');
  const [submitConfirmationOpen, setSubmitConfirmationOpen] = useState(false);
  const [pendingSubmitOptions, setPendingSubmitOptions] = useState<{ test?: boolean } | null>(null);
  const [purchaseOrderNumberSubmitAttempted, setPurchaseOrderNumberSubmitAttempted] = useState(false);
  const [error, setError] = useState('');
  const [exportingTemplates, setExportingTemplates] = useState(false);
  const [visualsDownloadError, setVisualsDownloadError] = useState('');
  const [installDownloadError, setInstallDownloadError] = useState('');
  const [sendingAdsEmail, setSendingAdsEmail] = useState(false);
  const [exportProgressMessage, setExportProgressMessage] = useState('');
  const [selectedPurchaseOrderFile, setSelectedPurchaseOrderFile] = useState<File | null>(null);
  const [uploadingPurchaseOrder, setUploadingPurchaseOrder] = useState(false);
  const [uploadedPurchaseOrderName, setUploadedPurchaseOrderName] = useState('');
  const [uploadedPurchaseOrder, setUploadedPurchaseOrder] = useState<UploadedPurchaseOrder | null>(null);
  const [uploadingSupportingDocuments, setUploadingSupportingDocuments] = useState(false);
  const [purchaseOrderUploadSuccessOpen, setPurchaseOrderUploadSuccessOpen] = useState(false);
  const [purchaseOrderUploadSuccessMessage, setPurchaseOrderUploadSuccessMessage] = useState('');
  const [manageUploadsOpen, setManageUploadsOpen] = useState(false);
  const [manageUploadsError, setManageUploadsError] = useState('');
  const [downloadingPurchaseOrder, setDownloadingPurchaseOrder] = useState(false);
  const [downloadingSupportingDocumentName, setDownloadingSupportingDocumentName] = useState('');
  const [assignArtworkDialogOpen, setAssignArtworkDialogOpen] = useState(false);
  const [assignArtworkTarget, setAssignArtworkTarget] = useState<{ marketId: string; assetId: string; formatKey: CreativeFormatKey; slotIndex?: number } | null>(null);
  const [multiArtworkDialogOpen, setMultiArtworkDialogOpen] = useState(false);
  const [multiArtworkTarget, setMultiArtworkTarget] = useState<{ marketId: string; assetId: string; formatKey: CreativeFormatKey; totalFrames: number } | null>(null);
  const [multiArtworkRecords, setMultiArtworkRecords] = useState<MultiArtworkRecord[]>([]);
  const [multiArtworkMaterialSelectionIndex, setMultiArtworkMaterialSelectionIndex] = useState<number | null>(null);
  const [previewArtworkDialogOpen, setPreviewArtworkDialogOpen] = useState(false);
  const [previewArtworkTarget, setPreviewArtworkTarget] = useState<{ marketId: string; assetId: string; formatKey: CreativeFormatKey } | null>(null);
  const [previewArtworkFullLoaded, setPreviewArtworkFullLoaded] = useState(false);
  const [materialDialogOpen, setMaterialDialogOpen] = useState(false);
  const [materialDialogMode, setMaterialDialogMode] = useState<'manage' | 'select'>('manage');
  const [materialTarget, setMaterialTarget] = useState<{ marketId: string; assetId: string; formatKey: CreativeFormatKey; totalFrames: number } | null>(null);
  const [multiMaterialRecords, setMultiMaterialRecords] = useState<MultiMaterialRecord[]>([]);
  const [materialSelectionRecordIndex, setMaterialSelectionRecordIndex] = useState<number | null>(null);
  const [materialSearchQuery, setMaterialSearchQuery] = useState('');
  const [uploadManagerOpen, setUploadManagerOpen] = useState(false);
  const [oneDriveImportOpen, setOneDriveImportOpen] = useState(false);
  const [isDraggingArtworkFiles, setIsDraggingArtworkFiles] = useState(false);
  const [hasChosenArtworkInSession, setHasChosenArtworkInSession] = useState(false);
  const [draggingDraftAssetId, setDraggingDraftAssetId] = useState<string | null>(null);
  const [dragOverDraftAssetId, setDragOverDraftAssetId] = useState<string | null>(null);
  const [artworkSearchQuery, setArtworkSearchQuery] = useState('');
  const [artworkUploadSuccessOpen, setArtworkUploadSuccessOpen] = useState(false);
  const [artworkUploadSuccessMessage, setArtworkUploadSuccessMessage] = useState('');
  const [deletingArtworkIds, setDeletingArtworkIds] = useState<string[]>([]);
  const [deleteArtworkCandidate, setDeleteArtworkCandidate] = useState<CampaignPrintImage | null>(null);
  const [confirmingArtworkDelete, setConfirmingArtworkDelete] = useState(false);
  const [artworkDialogError, setArtworkDialogError] = useState('');
  const [creativeNameAssignments, setCreativeNameAssignments] = useState<Record<string, string>>({});
  const [editingCreativeFileName, setEditingCreativeFileName] = useState<string | null>(null);
  const [artworkAssignmentMarketByCreativeName, setArtworkAssignmentMarketByCreativeName] = useState<Record<string, string>>({});
  const [draggingCreativeName, setDraggingCreativeName] = useState<string | null>(null);
  const [creativeDropTarget, setCreativeDropTarget] = useState<{ name: string; position: 'above' | 'below' } | null>(null);
  const [recentCreativeSwap, setRecentCreativeSwap] = useState<{ source: string; target: string } | null>(null);
  const [unsavedDialogOpen, setUnsavedDialogOpen] = useState(false);
  const [newAddressDialogOpen, setNewAddressDialogOpen] = useState(false);
  const [addMarketDialogOpen, setAddMarketDialogOpen] = useState(false);
  const [draftMarket, setDraftMarket] = useState<CampaignMarket | null>(null);
  const [draftMarketSummary, setDraftMarketSummary] = useState<CampaignCalculationSummary['perMarket'][number] | null>(null);
  const [draftMarketLines, setDraftMarketLines] = useState<CampaignCalculationSummary['lines']>([]);
  const [draftMarketCalculating, setDraftMarketCalculating] = useState(false);
  const [editingMarketId, setEditingMarketId] = useState<string | null>(null);
  const [hiddenInlineMarketIds, setHiddenInlineMarketIds] = useState<string[]>([]);
  const [treatDefaultMarketAsPlaceholder, setTreatDefaultMarketAsPlaceholder] = useState(false);
  const [marketPopupManagedFlow, setMarketPopupManagedFlow] = useState(false);
  const [hasSavedMarketViaPopup, setHasSavedMarketViaPopup] = useState(false);
  const [expandedMarketId, setExpandedMarketId] = useState<string | null>(null);
  const [reviewDrawerOpen, setReviewDrawerOpen] = useState(false);
  const [reviewDrawerMode, setReviewDrawerMode] = useState<ReviewDrawerMode>('high-level');
  const [reviewActionError, setReviewActionError] = useState('');
  const [reviewActionNeedsDueDate, setReviewActionNeedsDueDate] = useState(false);
  const [newAddressTarget, setNewAddressTarget] = useState<{ marketId: string; assetId: string; marketName: string } | null>(null);
  const [newAddressForm, setNewAddressForm] = useState<AddressFormState>(() => emptyAddressForm());
  const [newAddressError, setNewAddressError] = useState('');
  const [topBarCenterHost, setTopBarCenterHost] = useState<HTMLElement | null>(null);
  const [topBarActionsHost, setTopBarActionsHost] = useState<HTMLElement | null>(null);
  const [bottomBarHost, setBottomBarHost] = useState<HTMLElement | null>(null);
  const purchaseOrderInputRef = useRef<HTMLInputElement | null>(null);
  const supportingDocumentInputRef = useRef<HTMLInputElement | null>(null);
  const campaignStartPickerRef = useRef<HTMLInputElement | null>(null);
  const dueDatePickerRef = useRef<HTMLInputElement | null>(null);
  const artworkPdfInputRef = useRef<HTMLInputElement | null>(null);
  const artworkEnqueuePromiseRef = useRef<Promise<void> | null>(null);
  const campaignIdRef = useRef<string | null>(campaignId);
  const editLockHeldRef = useRef(false);
  const leavingCampaignRef = useRef(false);
  const campaignHydratedRef = useRef(false);
  const autoDownloadTriggeredRef = useRef(false);
  const autoSendEmailTriggeredRef = useRef(false);
  const lastPersistedValuesRef = useRef('');
  const lastAutoSaveFailedValuesRef = useRef<string | null>(null);
  const autoSaveTimeoutRef = useRef<number | null>(null);
  const creativeSwapFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSubCampaign = Boolean(parentCampaignId);
  const campaignArtworkUploadJobs = useMemo(
    () => (campaignId ? artworkUploadJobs.filter((job) => job.campaignId === campaignId) : []),
    [artworkUploadJobs, campaignId],
  );
  const queuedArtworkUploadJobs = campaignArtworkUploadJobs.filter((job) => job.status === 'queued');
  const queuedArtworkFileNames = queuedArtworkUploadJobs.map((job) => job.fileName);
  const pendingArtworkUploadCount = queuedArtworkUploadJobs.length;
  const uploadingArtworkPages = campaignArtworkUploadJobs.some((job) => job.status === 'queued' || job.status === 'uploading');
  const isSubmittedCampaign = campaignStatus === 'submitted';
  const isReadOnlyExportAutomation = autoDownloadVisuals || autoDownloadInstalls || Boolean(printIQVisualsRequestId);
  const isSuperAdmin = session?.user.role === 'super_admin';
  const isPrintIQSubmitting = submitting || testSubmitting;

  function reportQuoteAutomationResult(action: AutomatedQuoteAction, status: AutomatedQuoteActionStatus, message?: string) {
    if (typeof window === 'undefined') return;
    const payload = {
      type: QUOTE_AUTOMATION_RESULT_EVENT,
      action,
      status,
      message,
    };
    try {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, window.location.origin);
      }
    } catch {
      // Best effort only.
    }
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage(payload, window.location.origin);
      }
    } catch {
      // Best effort only.
    }
  }

  useEffect(() => {
    return () => {
      if (creativeSwapFeedbackTimerRef.current) {
        clearTimeout(creativeSwapFeedbackTimerRef.current);
        creativeSwapFeedbackTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const nextAssignments = normalizeCreativeNameAssignments(values.creativeNameAssignments);
    if (stableSerialize(nextAssignments) === stableSerialize(creativeNameAssignments)) return;
    setCreativeNameAssignments(nextAssignments);
  }, [creativeNameAssignments, values.creativeNameAssignments]);

  useEffect(() => {
    setCampaignStartDateInput(formatDateInputDisplay(values.campaignStartDate));
  }, [values.campaignStartDate]);

  useEffect(() => {
    campaignIdRef.current = campaignId;
  }, [campaignId]);

  useEffect(() => {
    setDueDateInput(formatDateInputDisplay(values.dueDate));
  }, [values.dueDate]);

  useEffect(() => {
    const jobsByBatch = new Map<string, typeof campaignArtworkUploadJobs>();
    campaignArtworkUploadJobs.forEach((job) => {
      const key = job.batchId || job.id;
      jobsByBatch.set(key, [...(jobsByBatch.get(key) ?? []), job]);
    });
    const terminalJobs = Array.from(jobsByBatch.values()).flatMap((batchJobs) => {
      const expectedSize = batchJobs[0]?.batchSize ?? 1;
      const batchComplete = batchJobs.length >= expectedSize
        && batchJobs.every((job) => job.status === 'completed' || job.status === 'error');
      return batchComplete ? batchJobs : [];
    });
    if (terminalJobs.length === 0) return;

    const completedJobs = terminalJobs.filter((job) => job.status === 'completed');
    const uploadedImages = completedJobs.flatMap((job) => job.images);
    if (uploadedImages.length > 0) {
      const mergeImages = (currentImages: CampaignPrintImage[]) => {
        const byId = new Map(currentImages.map((image) => [image.id, image]));
        uploadedImages.forEach((image) => byId.set(image.id, image));
        return Array.from(byId.values());
      };
      setValues((current) => ({ ...current, printImages: mergeImages(current.printImages) }));
      if (lastPersistedValuesRef.current) {
        try {
          const persistedValues = JSON.parse(lastPersistedValuesRef.current) as OrderFormValues;
          persistedValues.printImages = mergeImages(persistedValues.printImages ?? []);
          lastPersistedValuesRef.current = stableSerialize(persistedValues);
        } catch {
          // The next autosave will reconcile the local values if the snapshot cannot be parsed.
        }
      }
      const uploadedPdfCount = completedJobs.length;
      setArtworkUploadSuccessMessage(
        `${uploadedPdfCount} PDF file${uploadedPdfCount === 1 ? '' : 's'} uploaded successfully (${uploadedImages.length} artwork page${uploadedImages.length === 1 ? '' : 's'} generated).`,
      );
      setArtworkUploadSuccessOpen(true);
    }
    const failedJob = terminalJobs.find((job) => job.status === 'error');
    if (failedJob?.error) setArtworkDialogError(`${failedJob.fileName}: ${failedJob.error}`);
    dismissUploadJobs(terminalJobs.map((job) => job.id));
  }, [campaignArtworkUploadJobs, dismissUploadJobs]);

  async function releaseActiveCampaignLock(targetCampaignId?: string | null) {
    const id = targetCampaignId ?? campaignIdRef.current;
    if (!id || !editLockHeldRef.current) return;
    editLockHeldRef.current = false;
    try {
      await releaseCampaignEditLock(id, effectiveTenantId);
    } catch {
      // Best-effort cleanup only; lock will also expire automatically.
    }
  }

  useEffect(() => {
    let active = true;

    async function bootstrapCampaign() {
      try {
        const storedCampaignId = startFresh ? null : selectedCampaignId || (await getStoredCampaignId(effectiveTenantId));
        if (!active) return;

        if (storedCampaignId) {
          try {
            if (!isReadOnlyExportAutomation) {
              await acquireCampaignEditLock(storedCampaignId, effectiveTenantId);
              editLockHeldRef.current = true;
            }
            if (!active) return;
            const response = await fetchCampaign(storedCampaignId, effectiveTenantId);
            if (!active) return;
            applyCampaignToScreen(response.campaign, setValues, setSummary, setUploadedPurchaseOrderName, setUploadedPurchaseOrder, setCampaignId, setCampaignStatus, setParentCampaignId);
            setTreatDefaultMarketAsPlaceholder(false);
            setMarketPopupManagedFlow(false);
            setHasSavedMarketViaPopup(true);
            lastPersistedValuesRef.current = stableSerialize(response.campaign.values);
            campaignHydratedRef.current = true;
            if (!isReadOnlyExportAutomation) {
              await setStoredCampaignId(response.campaign.id, effectiveTenantId);
            }
            return;
          } catch (loadError) {
            if (!active) return;
            const message = loadError instanceof Error ? loadError.message : 'Unable to load campaign';
            setError(message);
            if (selectedCampaignId) {
              await setStoredCampaignId(null, effectiveTenantId);
              setLoadingCampaign(false);
              onBack?.();
              return;
            }
            await setStoredCampaignId(null, effectiveTenantId);
          }
        }
        const [tenantResponse, sheetSettingsResponse] = await Promise.all([
          fetchTenant(effectiveTenantId),
          fetchCampaignSheetNameOverrides(effectiveTenantId),
        ]);
        if (!active) return;
        const tenantDefaultValues = createDefaultFormValues(
          tenantResponse.tenant.code,
          sheetSettingsResponse.settings.productCodes?.['2-sheet'] ?? '',
        );
        setValues(tenantDefaultValues);
        setSummary(null);
        setUploadedPurchaseOrderName('');
        setUploadedPurchaseOrder(null);
        setCampaignId(null);
        setCampaignStatus('in_progress');
        setParentCampaignId('');
        setTreatDefaultMarketAsPlaceholder(true);
        setMarketPopupManagedFlow(true);
        setHasSavedMarketViaPopup(false);
        lastPersistedValuesRef.current = stableSerialize(tenantDefaultValues);
        campaignHydratedRef.current = true;
        await setStoredCampaignId(null, effectiveTenantId);
      } catch {
        if (active) setError('Unable to load campaign');
      } finally {
        if (active) setLoadingCampaign(false);
      }
    }

    void bootstrapCampaign();
    return () => {
      active = false;
    };
  }, [effectiveTenantId, isReadOnlyExportAutomation, onBack, selectedCampaignId, startFresh]);

  useEffect(() => {
    if (!campaignId || isReadOnlyExportAutomation || !editLockHeldRef.current) return;

    let active = true;
    const intervalId = window.setInterval(async () => {
      if (leavingCampaignRef.current) return;
      try {
        await acquireCampaignEditLock(campaignId, effectiveTenantId);
        editLockHeldRef.current = true;
      } catch (lockError) {
        if (!active) return;
        setError(lockError instanceof Error ? lockError.message : 'Campaign lock expired');
      }
    }, 30000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [campaignId, effectiveTenantId, isReadOnlyExportAutomation]);

  useEffect(() => {
    if (!campaignId || isReadOnlyExportAutomation) return;
    return () => {
      void releaseActiveCampaignLock(campaignId);
    };
  }, [campaignId, effectiveTenantId, isReadOnlyExportAutomation]);

  useEffect(() => {
    let active = true;

    async function loadMetadata() {
      try {
        const response = await fetchCalculatorMetadata(effectiveTenantId);
        if (!active) return;
        setMarkets(response.markets);
      } catch (loadError) {
        if (active) setMetadataError(loadError instanceof Error ? loadError.message : 'Unable to load campaign metadata');
      } finally {
        if (active) setLoadingMetadata(false);
      }
    }

    void loadMetadata();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadCustomPrintCosts() {
      try {
        const response = await fetchCampaignCustomPrintCosts(effectiveTenantId);
        if (active) setCustomPrintCosts(response.costs);
      } catch {
        if (active) setCustomPrintCosts([]);
      }
    }
    void loadCustomPrintCosts();
    return () => { active = false; };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadMaterials() {
      try {
        const response = await fetchCampaignMaterials(effectiveTenantId);
        if (active) setMaterials(response.materials);
      } catch {
        if (active) setMaterials([]);
      }
    }
    void loadMaterials();
    return () => { active = false; };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadMarketAssetShippingCosts() {
      try {
        const response = await fetchCampaignMarketAssetShippingCosts(effectiveTenantId);
        if (!active) return;
        setMarketAssetShippingCosts(response.costs);
      } catch {
        if (!active) return;
        setMarketAssetShippingCosts([]);
      }
    }
    void loadMarketAssetShippingCosts();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadMarketAddresses() {
      try {
        const response = await fetchCampaignMarketDeliveryAddresses(effectiveTenantId);
        if (!active) return;
        setMarketDeliveryAddresses(response.addresses);
      } catch {
        if (!active) return;
        setMarketDeliveryAddresses([]);
      }
    }
    void loadMarketAddresses();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadMarketShippingRates() {
      try {
        const response = await fetchCampaignMarketShippingRates(effectiveTenantId);
        if (!active) return;
        setMarketShippingRates(response.rates);
      } catch {
        if (!active) return;
        setMarketShippingRates([]);
      }
    }
    void loadMarketShippingRates();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadMarketAssetPrintingCosts() {
      try {
        const response = await fetchCampaignMarketAssetPrintingCosts(effectiveTenantId);
        if (!active) return;
        setMarketAssetPrintingCosts(response.costs);
      } catch {
        if (!active) return;
        setMarketAssetPrintingCosts([]);
      }
    }
    void loadMarketAssetPrintingCosts();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  useEffect(() => {
    let active = true;
    async function loadSheetNameOverrides() {
      setSheetNamesLoaded(false);
      try {
        const response = await fetchCampaignSheetNameOverrides(effectiveTenantId);
        if (!active) return;
        setSheetNameOverrides(sanitizeSheetNameOverrides(response.settings.overrides));
        setMultipleArtworkFormats(response.settings.multipleArtworkFormats ?? {});
        setCustomPrintCostFormats(response.settings.customPrintCostFormats ?? {});
        setCustomSheetSizeFormats(response.settings.customSheetSizeFormats ?? {});
      } catch {
        if (!active) return;
        setSheetNameOverrides({});
        setMultipleArtworkFormats({});
        setCustomPrintCostFormats({});
        setCustomSheetSizeFormats({});
      } finally {
        if (active) setSheetNamesLoaded(true);
      }
    }
    void loadSheetNameOverrides();
    return () => {
      active = false;
    };
  }, [effectiveTenantId]);

  const normalizedSheetNameOverrides = useMemo(
    () => sanitizeSheetNameOverrides(sheetNameOverrides),
    [sheetNameOverrides],
  );
  const normalizedMultipleArtworkFormats = useMemo(() => {
    const normalized: Record<string, boolean> = {};
    Object.entries(multipleArtworkFormats).forEach(([key, enabled]) => {
      if (enabled) normalized[key] = true;
    });
    return normalized;
  }, [multipleArtworkFormats]);
  const canAddAddressInFinalize = session?.user.role === 'admin' || session?.user.role === 'super_admin';
  const numberOfWeeks = Math.max(1, Math.min(MAX_CAMPAIGN_WEEKS, Math.floor(Number(values.numberOfWeeks) || 1)));
  const marketNames = useMemo(() => markets.map((market) => market.name), [markets]);
  const isDefaultPlaceholderMarket = useMemo(
    () => (market: CampaignMarket) => {
      if (!treatDefaultMarketAsPlaceholder) return false;
      if (market.market !== 'Sydney') return false;
      if (market.assets.length !== 1) return false;
      const onlyAsset = market.assets[0];
      return !onlyAsset.assetId && !onlyAsset.assetSearch && !onlyAsset.deliveryAddress;
    },
    [treatDefaultMarketAsPlaceholder],
  );
  const effectiveCampaignMarkets = useMemo(
    () => values.campaignMarkets.filter((market) => !isDefaultPlaceholderMarket(market)),
    [isDefaultPlaceholderMarket, values.campaignMarkets],
  );
  const selectedMarketsForPopup = useMemo(() => {
    if (marketPopupManagedFlow && !hasSavedMarketViaPopup) return [];
    return effectiveCampaignMarkets;
  }, [effectiveCampaignMarkets, hasSavedMarketViaPopup, marketPopupManagedFlow]);
  const remainingMarketNames = useMemo(() => {
    const selectedMarketNames = new Set(selectedMarketsForPopup.map((market) => market.market));
    return marketNames.filter((marketName) => !selectedMarketNames.has(marketName));
  }, [marketNames, selectedMarketsForPopup]);
  const canAddMarket = remainingMarketNames.length > 0;
  const canAddMarketInPlanning = useMemo(() => {
    const selected = new Set(values.campaignMarkets.map((market) => market.market.trim()).filter(Boolean));
    return marketNames.some((marketName) => !selected.has(marketName));
  }, [marketNames, values.campaignMarkets]);
  const addMarketDisabledReason = loadingMetadata
    ? 'Market options are still loading.'
    : markets.length === 0
      ? 'No markets are available.'
      : 'All available markets have already been added.';
  const activeMarket = useMemo(() => {
    if (values.campaignMarkets.length === 0) return null;
    return values.campaignMarkets.find((market) => market.id === activeMarketId) ?? values.campaignMarkets[0];
  }, [activeMarketId, values.campaignMarkets]);
  const hiddenInlineMarketIdSet = useMemo(
    () => new Set([...hiddenInlineMarketIds, ...values.campaignMarkets.map((market) => market.id)]),
    [hiddenInlineMarketIds, values.campaignMarkets],
  );
  const visiblePlanningMarkets = useMemo(
    () => values.campaignMarkets.filter((market) => !hiddenInlineMarketIdSet.has(market.id)),
    [hiddenInlineMarketIdSet, values.campaignMarkets],
  );
  const marketSummaryByName = useMemo(() => {
    if (!summary) return new Map<string, CampaignCalculationSummary['perMarket'][number]>();
    return new Map(summary.perMarket.map((entry) => [entry.market, entry]));
  }, [summary]);
  const selectedCampaignMarketNames = useMemo(
    () => new Set(effectiveCampaignMarkets.map((market) => market.market.trim()).filter(Boolean)),
    [effectiveCampaignMarkets],
  );
  const visibleReviewMarkets = useMemo(
    () => (summary ? summary.perMarket.filter((entry) => selectedCampaignMarketNames.has(entry.market)) : []),
    [selectedCampaignMarketNames, summary],
  );
  const detailedReviewFormatKeys = useMemo(() => {
    const keys = new Set<string>();
    visibleReviewMarkets.forEach((marketSummary) => {
      buildReviewRows(marketSummary).forEach((row) => {
        Object.entries(row.breakdown as Record<string, number>).forEach(([key, value]) => {
          if ((value ?? 0) > 0) keys.add(key);
        });
      });
    });
    return Array.from(keys);
  }, [visibleReviewMarkets]);
  const grandReviewRows = useMemo(
    () => (summary ? buildReviewRows(summary.grandTotal) : null),
    [summary],
  );
  const reviewButtonTotals = useMemo(() => {
    if (!grandReviewRows) return null;
    const posterRow = grandReviewRows.find((row) => row.label === 'Posters');
    const frameRow = grandReviewRows.find((row) => row.label === 'Frames');
    return {
      posters: posterRow?.total ?? 0,
      frames: frameRow?.total ?? 0,
    };
  }, [grandReviewRows]);
  const detailedDrawerWidth = useMemo(() => {
    const extraColumns = Math.max(0, detailedReviewFormatKeys.length - 3);
    const calculated = 472 + (extraColumns * 74);
    return Math.min(920, Math.max(472, calculated));
  }, [detailedReviewFormatKeys.length]);
  const twoSheeterPriceByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.twoSheeterPrice ?? 0])),
    [marketShippingRates],
  );
  const fourSheeterPriceByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.fourSheeterPrice ?? 0])),
    [marketShippingRates],
  );
  const sixSheeterPriceByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.sixSheeterPrice ?? 0])),
    [marketShippingRates],
  );
  const eightSheeterPriceByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.eightSheeterPrice ?? 0])),
    [marketShippingRates],
  );
  const twoSheeterSetsPerBoxByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.twoSheeterSetsPerBox ?? entry.sheeterSetsPerBox ?? 15])),
    [marketShippingRates],
  );
  const fourSheeterSetsPerBoxByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.fourSheeterSetsPerBox ?? entry.sheeterSetsPerBox ?? 15])),
    [marketShippingRates],
  );
  const sixSheeterSetsPerBoxByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.sixSheeterSetsPerBox ?? entry.sheeterSetsPerBox ?? 15])),
    [marketShippingRates],
  );
  const eightSheeterSetsPerBoxByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.eightSheeterSetsPerBox ?? entry.sheeterSetsPerBox ?? 15])),
    [marketShippingRates],
  );
  const useFlatRateSheetersByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.useFlatRateSheeters ?? entry.useFlatRate ?? false])),
    [marketShippingRates],
  );
  const useFlatRateMegasByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.useFlatRateMegas ?? entry.useFlatRate ?? false])),
    [marketShippingRates],
  );
  const printingCostByMarketAsset = useMemo(
    () => new Map(marketAssetPrintingCosts.map((entry) => [`${entry.market}\x00${entry.assetId}`, entry.costs])),
    [marketAssetPrintingCosts],
  );
  const customPrintCostByAssetSheet = useMemo(
    () => new Map(customPrintCosts.map((entry) => [entry.sheetKey, entry])),
    [customPrintCosts],
  );
  const selectedAssetByLineId = useMemo(() => {
    const byLineId = new Map<string, { market: string; assetId: string }>();
    values.campaignMarkets.forEach((market) => {
      market.assets.forEach((asset) => {
        byLineId.set(asset.id, { market: market.market, assetId: asset.assetId });
      });
    });
    return byLineId;
  }, [values.campaignMarkets]);
  const summaryLineByAssetId = useMemo(() => new Map((summary?.lines ?? []).map((line) => [line.id, line])), [summary]);
  const defaultMaterialId = useMemo(() => materials.find((material) => material.isDefault)?.id ?? '', [materials]);
  const materialIdForFormat = useCallback((formatKey: CreativeFormatKey) => {
    const categoryName = formatBreakdownKeyLabel(formatKey, normalizedSheetNameOverrides).trim().toLowerCase();
    return materials.find((material) => material.name.trim().toLowerCase() === categoryName)?.id ?? defaultMaterialId;
  }, [materials, normalizedSheetNameOverrides, defaultMaterialId]);

  useEffect(() => {
    if (loadingCampaign || !sheetNamesLoaded || materials.length === 0 || summaryLineByAssetId.size === 0) return;
    setValues((current) => {
      let changed = false;
      const campaignMarkets = current.campaignMarkets.map((market) => ({
        ...market,
        assets: market.assets.map((asset) => {
          const line = summaryLineByAssetId.get(asset.id);
          if (!line) return asset;
          const assignmentsByFormat = normalizeArtworkMaterialAssignments(asset);
          let assetChanged = false;
          getCreativeFormatsForBreakdown(line.breakdown).forEach((formatKey) => {
            const totalFrames = frameCountForFormat(line.breakdown, formatKey);
            const hasExplicitAssignment = Object.prototype.hasOwnProperty.call(asset.artworkMaterialAssignments ?? {}, formatKey);
            if (totalFrames <= 0 || hasExplicitAssignment) return;
            assignmentsByFormat[formatKey] = [{
              artworkImageId: getCreativeImageIdForFormat(asset, formatKey),
              materialId: materialIdForFormat(formatKey),
              frameCount: totalFrames,
            }];
            assetChanged = true;
          });
          if (!assetChanged) return asset;
          changed = true;
          return { ...asset, artworkMaterialAssignments: assignmentsByFormat };
        }),
      }));
      return changed ? { ...current, campaignMarkets } : current;
    });
  }, [materialIdForFormat, materials.length, sheetNamesLoaded, loadingCampaign, summaryLineByAssetId]);

  const megasPerBoxByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.megasPerBox ?? 1])),
    [marketShippingRates],
  );
  const megaShippingRateByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.megaShippingRate ?? 0])),
    [marketShippingRates],
  );
  const dotMShippingRateByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.dotMShippingRate ?? 0])),
    [marketShippingRates],
  );
  const mpShippingRateByMarket = useMemo(
    () => new Map(marketShippingRates.map((entry) => [entry.market, entry.mpShippingRate ?? 0])),
    [marketShippingRates],
  );
  const shippingCostByMarketAsset = useMemo(
    () => new Map(marketAssetShippingCosts.map((entry) => [`${entry.market}\x00${entry.assetId}`, entry])),
    [marketAssetShippingCosts],
  );
  const preferredDeliveryAddressByMarket = useMemo(() => {
    const byMarket = new Map<string, string>();
    marketDeliveryAddresses.forEach((entry) => {
      if (entry.isDefault) {
        byMarket.set(entry.market, entry.deliveryAddress);
        return;
      }
      if (!byMarket.has(entry.market)) {
        byMarket.set(entry.market, entry.deliveryAddress);
      }
    });
    return byMarket;
  }, [marketDeliveryAddresses]);
  const hasUnsavedChanges = !loadingCampaign && stableSerialize(values) !== lastPersistedValuesRef.current;
  const hasMappedCreatives = useMemo(() => {
    return values.campaignMarkets.some((market) =>
      market.assets.some((asset) => {
        const hasFormatMapping = Object.values(normalizeCreativeImageIds(asset)).some((imageId) => Boolean((imageId || '').trim()));
        if (hasFormatMapping) return true;
        const hasMultiFormatMapping = Object.values(normalizeArtworkMaterialAssignments(asset)).some((assignments) =>
          assignments.some((assignment) => Boolean(assignment.artworkImageId)),
        );
        if (hasMultiFormatMapping) return true;
        return Boolean((asset.creativeImageId || '').trim());
      }),
    );
  }, [values.campaignMarkets]);
  const hasUploadedPurchaseOrder = uploadedPurchaseOrderName.trim().length > 0;
  const hasPurchaseOrderNumber = values.purchaseOrderNumber.trim().length > 0;
  const showPurchaseOrderNumberRequired = purchaseOrderNumberSubmitAttempted && !hasPurchaseOrderNumber;
  const hasCampaignStartDate = values.campaignStartDate.trim().length > 0;
  const hasDeliveryDueDate = values.dueDate.trim().length > 0;
  const isCampaignStartDatePast = hasCampaignStartDate && isDateBeforeToday(values.campaignStartDate);
  const isDeliveryDueDatePast = hasDeliveryDueDate && isDateBeforeToday(values.dueDate);
  const hasValidCampaignStartDate = hasCampaignStartDate && !isCampaignStartDatePast;
  const hasValidDeliveryDueDate = hasDeliveryDueDate && !isDeliveryDueDatePast;
  const canAdvanceFromCreative = hasValidCampaignStartDate && hasValidDeliveryDueDate;
  const minSelectableDate = getTodayDateInputValue();
  const activeCampaignName = values.campaignName.trim() || (campaignId ? `Untitled Campaign ${campaignId.slice(0, 6)}` : 'Untitled Campaign');
  const selectedArtworkImageIdForTarget = useMemo(() => {
    if (!assignArtworkTarget) return '';
    const targetMarket = values.campaignMarkets.find((market) => market.id === assignArtworkTarget.marketId);
    const targetAsset = targetMarket?.assets.find((asset) => asset.id === assignArtworkTarget.assetId);
    if (!targetAsset) return '';
    if (assignArtworkTarget.slotIndex != null) {
      const assignments = artworkMaterialAssignmentsForFormat(targetAsset, assignArtworkTarget.formatKey);
      return assignments[assignArtworkTarget.slotIndex]?.artworkImageId || '';
    }
    return getCreativeImageIdForFormat(targetAsset, assignArtworkTarget.formatKey);
  }, [assignArtworkTarget, values.campaignMarkets]);
  const filteredArtworkImages = useMemo(() => {
    const query = artworkSearchQuery.trim().toLowerCase();
    if (!query) return values.printImages;
    return values.printImages.filter((image) => {
      const name = (image.name || image.fileName || '').toLowerCase();
      return name.includes(query);
    });
  }, [artworkSearchQuery, values.printImages]);
  const creativeNames = useMemo(
    () => Array.from({ length: Math.max(values.printImages.length, 1) }, (_, index) => `Creative${index + 1}`),
    [values.printImages.length],
  );
  const artworkImageById = useMemo(() => {
    const map = new Map<string, CampaignPrintImage>();
    values.printImages.forEach((image) => map.set(image.id, image));
    return map;
  }, [values.printImages]);
  const resolvedCreativeNameAssignments = useMemo(() => {
    const resolved: Record<string, string> = {};
    const usedImageIds = new Set<string>();

    creativeNames.forEach((creativeName) => {
      const mappedId = creativeNameAssignments[creativeName];
      if (mappedId && artworkImageById.has(mappedId) && !usedImageIds.has(mappedId)) {
        resolved[creativeName] = mappedId;
        usedImageIds.add(mappedId);
      }
    });

    const unassignedImages = values.printImages.filter((image) => !usedImageIds.has(image.id));
    let unassignedIndex = 0;
    creativeNames.forEach((creativeName) => {
      if (resolved[creativeName]) return;
      const nextImage = unassignedImages[unassignedIndex];
      if (!nextImage) return;
      resolved[creativeName] = nextImage.id;
      usedImageIds.add(nextImage.id);
      unassignedIndex += 1;
    });
    return resolved;
  }, [artworkImageById, creativeNameAssignments, creativeNames, values.printImages]);
  const filteredCreativeNames = useMemo(() => {
    const query = artworkSearchQuery.trim().toLowerCase();
    if (!query) return creativeNames;
    return creativeNames.filter((creativeName) => {
      const imageId = resolvedCreativeNameAssignments[creativeName] || '';
      const image = imageId ? artworkImageById.get(imageId) ?? null : null;
      const searchable = [
        creativeName,
        image?.name || '',
        image?.fileName || '',
      ].join(' ').toLowerCase();
      return searchable.includes(query);
    });
  }, [artworkImageById, artworkSearchQuery, creativeNames, resolvedCreativeNameAssignments]);
  const assignedAssetRefsByArtworkImageId = useMemo(() => {
    const refsByImageId = new Map<string, Array<{ marketId: string; assetId: string }>>();
    const pushRef = (imageId: string, marketId: string, assetId: string) => {
      const trimmedImageId = (imageId || '').trim();
      if (!trimmedImageId) return;
      const currentRefs = refsByImageId.get(trimmedImageId) ?? [];
      if (!currentRefs.some((ref) => ref.marketId === marketId && ref.assetId === assetId)) {
        currentRefs.push({ marketId, assetId });
      }
      refsByImageId.set(trimmedImageId, currentRefs);
    };

    values.campaignMarkets.forEach((market) => {
      market.assets.forEach((asset) => {
        Object.values(normalizeCreativeImageIds(asset)).forEach((imageId) => pushRef(imageId, market.id, asset.id));
        Object.values(normalizeArtworkMaterialAssignments(asset)).forEach((assignments) => {
          assignments.forEach((assignment) => pushRef(assignment.artworkImageId, market.id, asset.id));
        });
        pushRef(asset.creativeImageId, market.id, asset.id);
      });
    });
    return refsByImageId;
  }, [values.campaignMarkets]);
  const artworkAssignedAssetKeySetByImageId = useMemo(() => {
    const index = new Map<string, Set<string>>();
    assignedAssetRefsByArtworkImageId.forEach((refs, imageId) => {
      index.set(imageId, new Set(refs.map((ref) => `${ref.marketId}\x00${ref.assetId}`)));
    });
    return index;
  }, [assignedAssetRefsByArtworkImageId]);
  const defaultArtworkAssignmentMarketByCreativeName = useMemo(() => {
    const defaults: Record<string, string> = {};
    creativeNames.forEach((creativeName) => {
      const imageId = resolvedCreativeNameAssignments[creativeName] || '';
      const firstAssignedRef = imageId ? assignedAssetRefsByArtworkImageId.get(imageId)?.[0] : null;
      defaults[creativeName] = firstAssignedRef?.marketId || values.campaignMarkets[0]?.id || '';
    });
    return defaults;
  }, [assignedAssetRefsByArtworkImageId, creativeNames, resolvedCreativeNameAssignments, values.campaignMarkets]);
  const creativeNumberByImageId = useMemo(() => {
    const next = new Map<string, number>();
    values.printImages.forEach((image, index) => {
      next.set(image.id, index + 1);
    });
    Object.entries(resolvedCreativeNameAssignments).forEach(([creativeName, imageId]) => {
      const match = /^Creative(\d+)$/i.exec((creativeName || '').trim());
      if (!match) return;
      const parsed = Number.parseInt(match[1] || '', 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return;
      if (!imageId) return;
      next.set(imageId, parsed);
    });
    return next;
  }, [resolvedCreativeNameAssignments, values.printImages]);
  const previewArtworkImage = useMemo(() => {
    if (!previewArtworkTarget) return null;
    const targetMarket = values.campaignMarkets.find((market) => market.id === previewArtworkTarget.marketId);
    const targetAsset = targetMarket?.assets.find((asset) => asset.id === previewArtworkTarget.assetId);
    if (!targetAsset) return null;
    const assignedImageId = getCreativeImageIdForFormat(targetAsset, previewArtworkTarget.formatKey);
    if (!assignedImageId) return null;
    return values.printImages.find((image) => image.id === assignedImageId) ?? null;
  }, [previewArtworkTarget, values.campaignMarkets, values.printImages]);
  const previewArtworkThumbnailSrc = useMemo(
    () => (previewArtworkImage?.thumbnailUrl ? buildApiUrl(previewArtworkImage.thumbnailUrl) : ''),
    [previewArtworkImage],
  );
  const previewArtworkFullSrc = useMemo(
    () => (previewArtworkImage?.imageUrl ? buildApiUrl(previewArtworkImage.imageUrl) : ''),
    [previewArtworkImage],
  );
  const assignedArtworkIdSet = useMemo(() => {
    const assignedIds = new Set<string>();
    values.campaignMarkets.forEach((market) => {
      market.assets.forEach((asset) => {
        const mappedCreativeImageIds = normalizeCreativeImageIds(asset);
        const mappedArtworkMaterialAssignments = normalizeArtworkMaterialAssignments(asset);
        Object.values(mappedCreativeImageIds).forEach((imageId) => {
          const mappedId = (imageId || '').trim();
          if (mappedId) assignedIds.add(mappedId);
        });
        Object.values(mappedArtworkMaterialAssignments).forEach((assignments) => {
          assignments.forEach((assignment) => {
            const trimmed = assignment.artworkImageId;
            if (trimmed) assignedIds.add(trimmed);
          });
        });
        const legacyMappedId = (asset.creativeImageId || '').trim();
        if (legacyMappedId) assignedIds.add(legacyMappedId);
      });
    });
    return assignedIds;
  }, [values.campaignMarkets]);

  useEffect(() => {
    setTopBarCenterHost(document.getElementById('workspace-topbar-center-slot'));
    setTopBarActionsHost(document.getElementById('workspace-topbar-actions-slot'));
    setBottomBarHost(document.getElementById('workspace-bottom-bar-slot'));
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const savedValue = window.localStorage.getItem(REVIEW_DRAWER_OPEN_KEY);
      setReviewDrawerOpen(savedValue === '1');
      const savedMode = window.localStorage.getItem(REVIEW_DRAWER_MODE_KEY);
      if (savedMode === 'detailed' || savedMode === 'high-level') {
        setReviewDrawerMode(savedMode);
      }
    } catch {
      setReviewDrawerOpen(false);
      setReviewDrawerMode('high-level');
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(REVIEW_DRAWER_OPEN_KEY, reviewDrawerOpen ? '1' : '0');
      window.localStorage.setItem(REVIEW_DRAWER_MODE_KEY, reviewDrawerMode);
    } catch {
      // Ignore storage access issues.
    }
  }, [reviewDrawerMode, reviewDrawerOpen]);

  useEffect(() => {
    const normalizedError = error.trim().toLowerCase();
    const hasPastDateError =
      normalizedError.includes('campaign start date cannot be in the past')
      || normalizedError.includes('delivery due date cannot be in the past');
    const hasMissingDueDateActionError =
      normalizedError.includes('add a due date before downloading visuals')
      || normalizedError.includes('add a due date before sending email to ads');
    const hasMissingPurchaseOrderNumberActionError = normalizedError.includes('enter a purchase order number');
    if (hasPastDateError && !isCampaignStartDatePast && !isDeliveryDueDatePast) {
      setError('');
    }
    if (hasMissingDueDateActionError && hasDeliveryDueDate) {
      setError('');
    }
    if (hasMissingPurchaseOrderNumberActionError && hasPurchaseOrderNumber) {
      setError('');
    }
  }, [error, hasDeliveryDueDate, hasPurchaseOrderNumber, isCampaignStartDatePast, isDeliveryDueDatePast]);

  useEffect(() => {
    if (!hasDeliveryDueDate && reviewActionNeedsDueDate) return;
    if (reviewActionError.toLowerCase().includes('purchase order number') && !hasPurchaseOrderNumber) return;
    if (!reviewActionError) return;
    setReviewActionError('');
    setReviewActionNeedsDueDate(false);
  }, [hasDeliveryDueDate, hasPurchaseOrderNumber, reviewActionError, reviewActionNeedsDueDate]);

  const setReviewValidationError = (message: string, options?: { dueDate?: boolean }) => {
    setError(message);
    setReviewActionError(message);
    setReviewActionNeedsDueDate(Boolean(options?.dueDate));
  };

  const focusDueDateField = () => {
    setReviewDrawerOpen(false);
    window.setTimeout(() => {
      const dueDateInput = document.getElementById('due-date') as HTMLInputElement | null;
      dueDateInput?.focus();
    }, 80);
  };

  useEffect(() => {
    setPreviewArtworkFullLoaded(false);
  }, [previewArtworkImage?.id]);

  useEffect(() => {
    if (loadingCampaign) return;

    setValues((current) => {
      const normalizedMarkets = normalizeCampaignMarkets(current.campaignMarkets, numberOfWeeks);
      const flattenWeeks = (nextMarkets: CampaignMarket[]) => nextMarkets.flatMap((market) => market.assets.flatMap((asset) => asset.selectedWeeks)).join(',');
      const changed = flattenWeeks(normalizedMarkets) !== flattenWeeks(current.campaignMarkets);

      return changed ? { ...current, campaignMarkets: normalizedMarkets } : current;
    });
  }, [loadingCampaign, numberOfWeeks]);

  useEffect(() => {
    if (loadingCampaign) return;
    if (preferredDeliveryAddressByMarket.size === 0) return;

    setValues((current) => {
      let changed = false;
      const nextCampaignMarkets = current.campaignMarkets.map((market) => {
        const preferredAddress = preferredDeliveryAddressByMarket.get(market.market);
        if (!preferredAddress) return market;

        let marketChanged = false;
        const nextAssets = market.assets.map((asset) => {
          if (asset.deliveryAddress) return asset;
          changed = true;
          marketChanged = true;
          return {
            ...asset,
            deliveryAddress: preferredAddress,
          };
        });

        return marketChanged ? { ...market, assets: nextAssets } : market;
      });

      return changed ? { ...current, campaignMarkets: nextCampaignMarkets } : current;
    });
  }, [loadingCampaign, preferredDeliveryAddressByMarket]);

  useEffect(() => {
    if (loadingCampaign) return;
    if (marketDeliveryAddresses.length === 0) return;

    setValues((current) => {
      let changed = false;
      const nextCampaignMarkets = current.campaignMarkets.map((market) => {
        const marketAddressEntries = marketDeliveryAddresses
          .filter((entry) => entry.market === market.market)
          .map((entry) => entry.deliveryAddress)
          .filter((address) => Boolean(address.trim()));
        if (marketAddressEntries.length === 0) return market;

        const byName = new Map<string, string[]>();
        marketAddressEntries.forEach((address) => {
          const nameKey = deliveryContactName(address).trim().toLowerCase();
          if (!nameKey) return;
          byName.set(nameKey, [...(byName.get(nameKey) ?? []), address]);
        });

        let marketChanged = false;
        const nextAssets = market.assets.map((asset) => {
          const currentAddress = (asset.deliveryAddress || '').trim();
          if (!currentAddress) return asset;
          const nameKey = deliveryContactName(currentAddress).trim().toLowerCase();
          if (!nameKey) return asset;
          const matches = byName.get(nameKey) ?? [];
          if (matches.length !== 1) return asset;
          const latestAddress = matches[0];
          if (latestAddress === asset.deliveryAddress) return asset;
          changed = true;
          marketChanged = true;
          return {
            ...asset,
            deliveryAddress: latestAddress,
          };
        });

        return marketChanged ? { ...market, assets: nextAssets } : market;
      });

      return changed ? { ...current, campaignMarkets: nextCampaignMarkets } : current;
    });
  }, [loadingCampaign, marketDeliveryAddresses]);

  useEffect(() => {
    if (values.campaignMarkets.length === 0) {
      setActiveMarketId(null);
      return;
    }

    if (!activeMarketId || !values.campaignMarkets.some((market) => market.id === activeMarketId)) {
      setActiveMarketId(values.campaignMarkets[0].id);
    }
  }, [activeMarketId, values.campaignMarkets]);

  useEffect(() => {
    if (loadingCampaign || loadingMetadata || metadataError) return;
    if (values.campaignMarkets.length === 0) {
      setSummary(null);
      setCalculating(false);
      setValues((current) => ({ ...current, quantity: '0' }));
      setError('');
      return;
    }

    let active = true;
    const timeoutId = setTimeout(async () => {
      try {
        setCalculating(true);
        const flatLines = campaignLinesFromMarkets(values.campaignMarkets);
        const result = await calculateCampaign(flatLines, effectiveTenantId);
        if (!active) return;
        setSummary(result);
        setValues((current) => ({ ...current, quantity: String(result.grandTotal.totalUnits) }));
        setError('');
      } catch (calculationError) {
        if (active) setError(calculationError instanceof Error ? calculationError.message : 'Unable to calculate campaign');
      } finally {
        if (active) setCalculating(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [effectiveTenantId, loadingCampaign, loadingMetadata, metadataError, values.campaignMarkets]);

  useEffect(() => {
    if (!addMarketDialogOpen || !draftMarket || loadingCampaign || loadingMetadata || metadataError) {
      setDraftMarketCalculating(false);
      return;
    }

    let active = true;
    setDraftMarketCalculating(true);
    const timeoutId = window.setTimeout(async () => {
      try {
        const allMarkets = editingMarketId
          ? values.campaignMarkets.map((market) => (market.id === editingMarketId ? draftMarket : market))
          : [...values.campaignMarkets, draftMarket];
        const flatLines = campaignLinesFromMarkets(allMarkets);
        const result = await calculateCampaign(flatLines, effectiveTenantId);
        if (!active) return;
        const nextSummary = result.perMarket.find((entry) => entry.market === draftMarket.market) ?? null;
        setDraftMarketSummary(nextSummary);
        const draftAssetIds = new Set(draftMarket.assets.map((asset) => asset.id));
        setDraftMarketLines(result.lines.filter((line) => draftAssetIds.has(line.id)));
      } catch {
        if (active) {
          setDraftMarketSummary(null);
          setDraftMarketLines([]);
        }
      } finally {
        if (active) setDraftMarketCalculating(false);
      }
    }, 250);

    return () => {
      active = false;
      clearTimeout(timeoutId);
    };
  }, [addMarketDialogOpen, draftMarket, editingMarketId, effectiveTenantId, loadingCampaign, loadingMetadata, metadataError, values.campaignMarkets]);

  function updateField<K extends keyof OrderFormValues>(field: K, value: OrderFormValues[K]) {
    if (isSubmittedCampaign) return;
    setValues((current) => ({ ...current, [field]: value }));
  }

  function updateCampaignStartDate(value: string) {
    if (isSubmittedCampaign) return;
    const automaticDueDate = previousWednesday(value);
    setValues((current) => ({
      ...current,
      campaignStartDate: value,
      ...(automaticDueDate ? { dueDate: automaticDueDate } : {}),
    }));
  }

  function updateWeekCount(nextValue: number) {
    const normalized = Math.max(1, Math.min(MAX_CAMPAIGN_WEEKS, Math.floor(nextValue)));
    updateField('numberOfWeeks', String(normalized));
  }

  function openDatePicker(ref: React.RefObject<HTMLInputElement | null>) {
    if (isSubmittedCampaign) return;
    const input = ref.current;
    if (!input) return;
    if (typeof input.showPicker === 'function') {
      input.showPicker();
      return;
    }
    input.click();
  }

  function updateCampaignMarket(marketId: string, updater: (market: CampaignMarket) => CampaignMarket) {
    if (isSubmittedCampaign) return;
    setValues((current) => ({ ...current, campaignMarkets: current.campaignMarkets.map((market) => (market.id === marketId ? updater(market) : market)) }));
  }

  function openAddMarketDialog() {
    if (isSubmittedCampaign) return;
    if (!canAddMarket) return;
    const nextMarketName = remainingMarketNames[0] || '';
    const nextMarket = createCampaignMarket(`market-draft-${Date.now()}`);
    const preferredAddress = preferredDeliveryAddressByMarket.get(nextMarketName) || '';
    setDraftMarket({
      ...nextMarket,
      market: nextMarketName,
      assets: nextMarket.assets.map((asset) => ({
        ...asset,
        deliveryAddress: preferredAddress,
        selectedWeeks: [],
      })),
    });
    setEditingMarketId(null);
    setDraftMarketSummary(null);
    setDraftMarketLines([]);
    setAddMarketDialogOpen(true);
  }

  function openEditMarketDialog(marketId: string) {
    if (isSubmittedCampaign) return;
    const targetMarket = values.campaignMarkets.find((market) => market.id === marketId);
    if (!targetMarket) return;
    setDraftMarket({
      ...targetMarket,
      assets: targetMarket.assets.map((asset) => ({
        ...asset,
        selectedWeeks: [...asset.selectedWeeks],
        creativeImageIds: { ...(asset.creativeImageIds ?? {}) },
        quantityOverrides: asset.quantityOverrides?.posters
          ? { posters: { ...asset.quantityOverrides.posters } }
          : undefined,
        artworkMaterialAssignments: Object.fromEntries(
          Object.entries(asset.artworkMaterialAssignments ?? {}).map(([key, assignments]) => [key, assignments?.map((assignment) => ({ ...assignment })) ?? []]),
        ),
      })),
    });
    setEditingMarketId(marketId);
    setDraftMarketSummary(null);
    setDraftMarketLines([]);
    setAddMarketDialogOpen(true);
  }

  function handleSaveAddMarket() {
    if (isSubmittedCampaign) return;
    if (!draftMarket) return;
    const savedDraftMarketId = draftMarket.id;
    setValues((current) => {
      const realMarkets = current.campaignMarkets.filter((market) => !isDefaultPlaceholderMarket(market));

      if (editingMarketId) {
        const selectedInOtherMarkets = new Set(realMarkets.filter((market) => market.id !== editingMarketId).map((market) => market.market));
        if (!draftMarket.market.trim() || selectedInOtherMarkets.has(draftMarket.market)) return current;
        const hasTarget = realMarkets.some((market) => market.id === editingMarketId);
        const nextMarkets = hasTarget
          ? realMarkets.map((market) => (market.id === editingMarketId ? draftMarket : market))
          : [...realMarkets, draftMarket];
        return {
          ...current,
          campaignMarkets: nextMarkets,
        };
      }

      if (!canAddMarket) return current;
      const selectedMarketNames = new Set(
        marketPopupManagedFlow && !hasSavedMarketViaPopup ? [] : realMarkets.map((market) => market.market),
      );
      if (!draftMarket.market.trim() || selectedMarketNames.has(draftMarket.market)) return current;
      return {
        ...current,
        campaignMarkets: marketPopupManagedFlow && !hasSavedMarketViaPopup ? [draftMarket] : [...realMarkets, draftMarket],
      };
    });
    setHiddenInlineMarketIds((current) => (current.includes(savedDraftMarketId) ? current : [...current, savedDraftMarketId]));
    setTreatDefaultMarketAsPlaceholder(false);
    setHasSavedMarketViaPopup(true);
    setEditingMarketId(null);
    setAddMarketDialogOpen(false);
    setDraftMarket(null);
    setDraftMarketSummary(null);
    setDraftMarketLines([]);
  }

  function handleDeleteMarket(marketId: string) {
    if (isSubmittedCampaign) return;
    const remainingRealMarketsCount = values.campaignMarkets.filter((market) => !isDefaultPlaceholderMarket(market) && market.id !== marketId).length;
    setValues((current) => ({
      ...current,
      campaignMarkets: current.campaignMarkets.filter((market) => market.id !== marketId),
    }));
    setHiddenInlineMarketIds((current) => current.filter((id) => id !== marketId));
    if (remainingRealMarketsCount === 0) {
      setHasSavedMarketViaPopup(false);
    }
    if (editingMarketId === marketId) {
      setAddMarketDialogOpen(false);
      setEditingMarketId(null);
      setDraftMarket(null);
      setDraftMarketSummary(null);
      setDraftMarketLines([]);
    }
  }

  function updateDraftMarket(updater: (market: CampaignMarket) => CampaignMarket) {
    if (isSubmittedCampaign) return;
    setDraftMarket((current) => (current ? updater(current) : current));
  }

  function updateDraftAssetFrameOverride(assetId: string, key: string, rawValue: string) {
    if (isSubmittedCampaign) return;
    const parsedValue = Number.parseInt(rawValue || '0', 10);
    const frameValue = Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0;
    const divisor = isKnownFormatKey(key) ? (formatToFrameDivisor[toCreativeFormatKey(key)] ?? 1) : 1;
    const posterValue = frameValue * Math.max(1, divisor);
    updateDraftMarket((market) => ({
      ...market,
      // Once an asset is edited, migrate any legacy market override to the
      // per-asset values currently returned by the calculator.
      quantityOverrides: undefined,
      assets: market.assets.map((asset) => {
        const calculatedLine = draftMarketLines.find((line) => line.id === asset.id);
        const migratedOverrides = market.quantityOverrides?.posters && calculatedLine
          ? { ...(calculatedLine.breakdown as Record<string, number>) }
          : (asset.quantityOverrides?.posters ?? {});
        return asset.id === assetId
          ? { ...asset, quantityOverrides: { posters: { ...migratedOverrides, [key]: posterValue } } }
          : market.quantityOverrides?.posters && calculatedLine
            ? { ...asset, quantityOverrides: { posters: migratedOverrides } }
            : asset;
      }),
    }));
  }

  function updateDraftAsset(assetId: string, updater: (asset: CampaignAsset) => CampaignAsset) {
    updateDraftMarket((market) => ({
      ...market,
      assets: market.assets.map((asset) => (asset.id === assetId ? updater(asset) : asset)),
    }));
  }

  function toggleDraftAssetWeek(assetId: string, week: number) {
    updateDraftAsset(assetId, (asset) => {
      const selectedWeekSet = new Set(asset.selectedWeeks);
      if (selectedWeekSet.has(week)) selectedWeekSet.delete(week);
      else selectedWeekSet.add(week);
      return { ...asset, selectedWeeks: Array.from(selectedWeekSet).sort((left, right) => left - right) };
    });
  }

  function addDraftAsset() {
    updateDraftMarket((market) => {
      const availableAssets = assetsForMarket(market.market);
      const nextAsset = availableAssets[0];
      if (!nextAsset) return market;
      const preferredAddress = preferredDeliveryAddressByMarket.get(market.market) || '';
      return {
        ...market,
        assets: [
          ...market.assets,
          {
            ...createCampaignAsset(`asset-${Date.now()}`, numberOfWeeks),
            assetId: nextAsset.id,
            assetSearch: nextAsset.label,
            selectedWeeks: [],
            deliveryAddress: preferredAddress,
          },
        ],
      };
    });
  }

  function removeDraftAsset(assetId: string) {
    updateDraftMarket((market) => ({
      ...market,
      assets: market.assets.length === 1 ? market.assets : market.assets.filter((asset) => asset.id !== assetId),
    }));
  }

  function reorderDraftAssets(sourceAssetId: string, targetAssetId: string) {
    if (sourceAssetId === targetAssetId) return;
    updateDraftMarket((market) => {
      const sourceIndex = market.assets.findIndex((asset) => asset.id === sourceAssetId);
      const targetIndex = market.assets.findIndex((asset) => asset.id === targetAssetId);
      if (sourceIndex === -1 || targetIndex === -1) return market;
      const nextAssets = [...market.assets];
      const [movedAsset] = nextAssets.splice(sourceIndex, 1);
      nextAssets.splice(targetIndex, 0, movedAsset);
      return {
        ...market,
        assets: nextAssets,
      };
    });
  }

  function removeCampaignMarket(marketId: string) {
    if (isSubmittedCampaign) return;
    setValues((current) => ({
      ...current,
      campaignMarkets: current.campaignMarkets.length === 1 ? current.campaignMarkets : current.campaignMarkets.filter((market) => market.id !== marketId),
    }));
  }

  function addCampaignAsset(marketId: string) {
    if (isSubmittedCampaign) return;
    updateCampaignMarket(marketId, (market) => {
      const availableAssets = assetsForMarket(market.market);
      const nextAsset = availableAssets[0];
      if (!nextAsset) return market;
      const preferredAddress = preferredDeliveryAddressByMarket.get(market.market) || '';

      return {
        ...market,
        assets: [
          ...market.assets,
          {
            ...createCampaignAsset(`asset-${Date.now()}`, numberOfWeeks),
            assetId: nextAsset.id,
            assetSearch: nextAsset.label,
            selectedWeeks: [],
            deliveryAddress: preferredAddress,
          },
        ],
      };
    });
  }

  function removeCampaignAsset(marketId: string, assetId: string) {
    if (isSubmittedCampaign) return;
    updateCampaignMarket(marketId, (market) => ({ ...market, assets: market.assets.length === 1 ? market.assets : market.assets.filter((asset) => asset.id !== assetId) }));
  }

  function updateCampaignAsset(marketId: string, assetId: string, updater: (asset: CampaignAsset) => CampaignAsset) {
    if (isSubmittedCampaign) return;
    updateCampaignMarket(marketId, (market) => ({ ...market, assets: market.assets.map((asset) => (asset.id === assetId ? updater(asset) : asset)) }));
  }

  function toggleCampaignAssetWeek(marketId: string, assetId: string, week: number) {
    if (isSubmittedCampaign) return;
    updateCampaignAsset(marketId, assetId, (asset) => {
      const selectedWeekSet = new Set(asset.selectedWeeks);
      if (selectedWeekSet.has(week)) selectedWeekSet.delete(week);
      else selectedWeekSet.add(week);
      const nextSelectedWeeks = Array.from(selectedWeekSet).sort((left, right) => left - right);
      return { ...asset, selectedWeeks: nextSelectedWeeks };
    });
  }

  function openAssignArtworkDialog(marketId: string, assetId: string, formatKey: CreativeFormatKey, slotIndex?: number) {
    if (isSubmittedCampaign) return;
    setAssignArtworkTarget({ marketId, assetId, formatKey, slotIndex });
    setArtworkDialogError('');
    setAssignArtworkDialogOpen(true);
  }

  function openMaterialDialog(marketId: string, assetId: string, formatKey: CreativeFormatKey, totalFrames: number) {
    if (isSubmittedCampaign) return;
    const safeTotalFrames = Math.max(1, totalFrames);
    const targetAsset = values.campaignMarkets.find((market) => market.id === marketId)?.assets.find((asset) => asset.id === assetId);
    const assignments = targetAsset ? artworkMaterialAssignmentsForFormat(targetAsset, formatKey) : [];
    const records = assignments.map((assignment, index) => ({
      id: `multi-material-record-${Date.now()}-${index}`,
      materialId: assignment.materialId,
      frameCount: assignment.frameCount,
    }));
    setMultiMaterialRecords(records.length > 0 ? records : [{ id: `multi-material-record-${Date.now()}-0`, materialId: materialIdForFormat(formatKey), frameCount: safeTotalFrames }]);
    setMaterialTarget({ marketId, assetId, formatKey, totalFrames: safeTotalFrames });
    setMaterialDialogMode('manage');
    setMaterialSelectionRecordIndex(null);
    setMaterialSearchQuery('');
    setMaterialDialogOpen(true);
  }

  function closeMaterialDialog() {
    setMaterialDialogOpen(false);
    setMaterialTarget(null);
    setMultiMaterialRecords([]);
    setMaterialSelectionRecordIndex(null);
    setMaterialDialogMode('manage');
    setMaterialSearchQuery('');
  }

  function syncMultiMaterialRecordsToAsset(records: MultiMaterialRecord[]) {
    if (isSubmittedCampaign) return;
    if (!materialTarget) return;
    updateCampaignAsset(materialTarget.marketId, materialTarget.assetId, (current) => {
      const existingAssignments = artworkMaterialAssignmentsForFormat(current, materialTarget.formatKey);
      const singleArtworkImageId = getCreativeImageIdForFormat(current, materialTarget.formatKey);
      const nextArtworkMaterialAssignments = {
        ...normalizeArtworkMaterialAssignments(current),
        [materialTarget.formatKey]: records.map((record, index) => ({
          artworkImageId: existingAssignments[index]?.artworkImageId || singleArtworkImageId,
          materialId: (record.materialId || '').trim(),
          frameCount: Math.max(0, Math.floor(record.frameCount || 0)),
        })).filter((record) => record.frameCount > 0),
      };
      return { ...current, artworkMaterialAssignments: nextArtworkMaterialAssignments };
    });
  }

  function updateMultiMaterialRecord(recordIndex: number, updates: Partial<Pick<MultiMaterialRecord, 'materialId' | 'frameCount'>>) {
    if (isSubmittedCampaign) return;
    setMultiMaterialRecords((current) => {
      if (!materialTarget || recordIndex < 0 || recordIndex >= current.length) return current;
      const usedByOthers = current.reduce((sum, record, index) => sum + (index === recordIndex ? 0 : Math.max(0, Math.floor(record.frameCount || 0))), 0);
      const maxForRow = Math.max(0, materialTarget.totalFrames - usedByOthers);
      const next = current.map((record, index) => index === recordIndex
        ? { ...record, ...updates, frameCount: updates.frameCount === undefined ? record.frameCount : Math.min(maxForRow, Math.max(0, Math.floor(updates.frameCount))) }
        : record);
      syncMultiMaterialRecordsToAsset(next);
      return next;
    });
  }

  function selectMaterialForRecord(materialId: string) {
    if (isSubmittedCampaign) return;
    if (materialSelectionRecordIndex === null) return;
    updateMultiMaterialRecord(materialSelectionRecordIndex, { materialId });
    setMaterialDialogMode('manage');
    setMaterialSelectionRecordIndex(null);
    setMaterialSearchQuery('');
  }

  function addMultiMaterialRecord() {
    if (isSubmittedCampaign) return;
    setMultiMaterialRecords((current) => {
      const used = current.reduce((sum, record) => sum + Math.max(0, Math.floor(record.frameCount || 0)), 0);
      const remaining = Math.max(0, (materialTarget?.totalFrames ?? 0) - used);
      const next = [...current, { id: `multi-material-record-${Date.now()}-${current.length}`, materialId: '', frameCount: remaining }];
      syncMultiMaterialRecordsToAsset(next);
      return next;
    });
  }

  function removeMultiMaterialRecord(recordIndex: number) {
    if (isSubmittedCampaign) return;
    setMultiMaterialRecords((current) => {
      if (current.length <= 1) {
        const next = current.map((record) => ({ ...record, materialId: '' }));
        syncMultiMaterialRecordsToAsset(next);
        return next;
      }
      const next = current.filter((_, index) => index !== recordIndex);
      syncMultiMaterialRecordsToAsset(next);
      return next;
    });
  }

  function openMultiArtworkDialog(marketId: string, assetId: string, formatKey: CreativeFormatKey, totalFrames: number) {
    if (isSubmittedCampaign) return;
    const safeTotalFrames = Math.max(1, totalFrames);
    const targetMarket = values.campaignMarkets.find((market) => market.id === marketId);
    const targetAsset = targetMarket?.assets.find((asset) => asset.id === assetId);
    const persistedAssignments = targetAsset?.artworkMaterialAssignments?.[formatKey] ?? [];
    const hasExplicitAssignments = Object.prototype.hasOwnProperty.call(targetAsset?.artworkMaterialAssignments ?? {}, formatKey);
    let recordsFromAsset: MultiArtworkRecord[];
    if (hasExplicitAssignments) {
      recordsFromAsset = persistedAssignments.map((assignment, index) => ({
        id: `multi-artwork-record-${Date.now()}-${index}`,
        imageId: (assignment.artworkImageId || '').trim(),
        materialId: (assignment.materialId || '').trim(),
        frameCount: Math.max(0, Math.floor(assignment.frameCount || 0)),
      })).filter((assignment) => assignment.frameCount > 0);
    } else {
      recordsFromAsset = [{ id: `multi-artwork-record-${Date.now()}-0`, imageId: '', materialId: materialIdForFormat(formatKey), frameCount: safeTotalFrames }];
    }
    setMultiArtworkRecords(recordsFromAsset);
    setMultiArtworkTarget({ marketId, assetId, formatKey, totalFrames: safeTotalFrames });
    setMultiArtworkMaterialSelectionIndex(null);
    setMaterialSearchQuery('');
    setMultiArtworkDialogOpen(true);
  }

  function openArtworkPreviewDialog(marketId: string, assetId: string, formatKey: CreativeFormatKey) {
    setPreviewArtworkTarget({ marketId, assetId, formatKey });
    setPreviewArtworkFullLoaded(false);
    setPreviewArtworkDialogOpen(true);
  }

  function closeArtworkPreviewDialog() {
    setPreviewArtworkDialogOpen(false);
    setPreviewArtworkTarget(null);
    setPreviewArtworkFullLoaded(false);
  }

  function openChangeArtworkFromPreview() {
    if (!previewArtworkTarget) return;
    const { marketId, assetId, formatKey } = previewArtworkTarget;
    openAssignArtworkDialog(marketId, assetId, formatKey);
  }

  function openArtworkManagerDialog() {
    if (isSubmittedCampaign) return;
    setAssignArtworkTarget(null);
    setArtworkDialogError('');
    setAssignArtworkDialogOpen(true);
  }

  function removeArtworkFromPreview() {
    if (isSubmittedCampaign) return;
    if (!previewArtworkTarget) return;
    const { marketId, assetId, formatKey } = previewArtworkTarget;
    assignArtworkToFormat(marketId, assetId, formatKey, '');
    closeArtworkPreviewDialog();
  }

  function closeAssignArtworkDialog() {
    setAssignArtworkDialogOpen(false);
    setAssignArtworkTarget(null);
    setArtworkDialogError('');
    setArtworkSearchQuery('');
    setEditingCreativeFileName(null);
    setDraggingCreativeName(null);
    setCreativeDropTarget(null);
    setRecentCreativeSwap(null);
    if (creativeSwapFeedbackTimerRef.current) {
      clearTimeout(creativeSwapFeedbackTimerRef.current);
      creativeSwapFeedbackTimerRef.current = null;
    }
    if (artworkPdfInputRef.current) {
      artworkPdfInputRef.current.value = '';
    }
  }

  function showCreativeSwapFeedback(sourceCreativeName: string, targetCreativeName: string) {
    setRecentCreativeSwap({ source: sourceCreativeName, target: targetCreativeName });
    if (creativeSwapFeedbackTimerRef.current) {
      clearTimeout(creativeSwapFeedbackTimerRef.current);
    }
    creativeSwapFeedbackTimerRef.current = setTimeout(() => {
      setRecentCreativeSwap(null);
      creativeSwapFeedbackTimerRef.current = null;
    }, 650);
  }

  function reorderCreativeAssignments(sourceCreativeName: string, targetCreativeName: string, position: 'above' | 'below') {
    if (isSubmittedCampaign) return;
    if (sourceCreativeName === targetCreativeName) return;
    const orderedImageIds = creativeNames.map((creativeName) => resolvedCreativeNameAssignments[creativeName] || '');
    const sourceIndex = creativeNames.indexOf(sourceCreativeName);
    const targetIndex = creativeNames.indexOf(targetCreativeName);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const movingImageId = orderedImageIds[sourceIndex];
    if (!movingImageId) return;

    const nextIds = [...orderedImageIds];
    nextIds.splice(sourceIndex, 1);
    let insertIndex = position === 'below' ? targetIndex + 1 : targetIndex;
    if (sourceIndex < insertIndex) insertIndex -= 1;
    nextIds.splice(insertIndex, 0, movingImageId);

    const nextAssignments: Record<string, string> = {};
    creativeNames.forEach((creativeName, index) => {
      const imageId = nextIds[index] || '';
      if (imageId) {
        nextAssignments[creativeName] = imageId;
      }
    });
    setCreativeNameAssignments(nextAssignments);
    setValues((current) => {
      if (current.printImages.length <= 1) return current;
      const imageById = new Map(current.printImages.map((image) => [image.id, image]));
      const reorderedImages: CampaignPrintImage[] = [];
      nextIds.forEach((imageId) => {
        const image = imageById.get(imageId);
        if (!image) return;
        reorderedImages.push(image);
        imageById.delete(imageId);
      });
      if (reorderedImages.length === 0) return current;
      if (imageById.size > 0) reorderedImages.push(...Array.from(imageById.values()));
      const normalizedCurrentAssignments = normalizeCreativeNameAssignments(current.creativeNameAssignments);
      const isSameOrder =
        reorderedImages.length === current.printImages.length
        && reorderedImages.every((image, index) => image.id === current.printImages[index]?.id);
      const isSameAssignments = stableSerialize(normalizedCurrentAssignments) === stableSerialize(nextAssignments);
      if (isSameOrder && isSameAssignments) return current;
      return {
        ...current,
        printImages: reorderedImages,
        creativeNameAssignments: nextAssignments,
      };
    });
    showCreativeSwapFeedback(sourceCreativeName, targetCreativeName);
  }

  function changeCreativeArtworkFile(creativeName: string, nextImageId: string) {
    if (isSubmittedCampaign) return;
    const safeCreativeName = (creativeName || '').trim();
    const safeNextImageId = (nextImageId || '').trim();
    if (!safeCreativeName || !safeNextImageId) return;

    const currentImageId = resolvedCreativeNameAssignments[safeCreativeName] || '';
    if (currentImageId === safeNextImageId) {
      setEditingCreativeFileName(null);
      return;
    }

    const nextAssignments = { ...resolvedCreativeNameAssignments, [safeCreativeName]: safeNextImageId };
    const swappedCreativeName = creativeNames.find((entry) => entry !== safeCreativeName && resolvedCreativeNameAssignments[entry] === safeNextImageId);
    if (swappedCreativeName && currentImageId) {
      nextAssignments[swappedCreativeName] = currentImageId;
    }

    setCreativeNameAssignments(nextAssignments);
    setValues((current) => {
      const normalizedCurrentAssignments = normalizeCreativeNameAssignments(current.creativeNameAssignments);
      const isSameAssignments = stableSerialize(normalizedCurrentAssignments) === stableSerialize(nextAssignments);
      if (isSameAssignments) return current;
      return {
        ...current,
        creativeNameAssignments: nextAssignments,
      };
    });
    if (swappedCreativeName) {
      showCreativeSwapFeedback(safeCreativeName, swappedCreativeName);
    } else {
      showCreativeSwapFeedback(safeCreativeName, safeCreativeName);
    }
    setEditingCreativeFileName(null);
  }

  function updateArtworkCode(imageId: string, code: string) {
    const safeImageId = (imageId || '').trim();
    if (!safeImageId || isSubmittedCampaign) return;
    setValues((current) => {
      const nextCodes = normalizeArtworkCodes(current.artworkCodes);
      const safeCode = code.trim();
      if (safeCode) {
        nextCodes[safeImageId] = safeCode;
      } else {
        delete nextCodes[safeImageId];
      }
      return {
        ...current,
        artworkCodes: nextCodes,
      };
    });
  }

  function artworkFormatsForAsset(asset: CampaignAsset) {
    const summaryFormats = getCreativeFormatsForBreakdown(summaryLineByAssetId.get(asset.id)?.breakdown);
    const explicitFormats = Array.from(new Set([
      ...Object.keys(asset.creativeImageIds ?? {}),
      ...Object.keys(asset.artworkMaterialAssignments ?? {}),
    ])).filter((key): key is CreativeFormatKey => (creativeFormatKeys as readonly string[]).includes(key));
    return summaryFormats.length > 0 ? summaryFormats : explicitFormats;
  }

  function nextLegacyCreativeImageIdForAsset(creativeImageIds: Record<string, string>) {
    return creativeFormatKeys.map((key) => creativeImageIds[key]).find((imageId) => Boolean((imageId || '').trim())) || '';
  }

  function setArtworkAssetAssignment(marketId: string, assetId: string, imageId: string, checked: boolean) {
    if (isSubmittedCampaign) return;
    const safeImageId = (imageId || '').trim();
    if (!safeImageId) return;

    updateCampaignAsset(marketId, assetId, (current) => {
      const formats = artworkFormatsForAsset(current);
      const nextCreativeImageIds = { ...normalizeCreativeImageIds(current) };
      const nextArtworkMaterialAssignments = normalizeArtworkMaterialAssignments(current);

      if (formats.length === 0) {
        if (checked) {
          return { ...current, creativeImageId: safeImageId };
        }
        return current.creativeImageId === safeImageId ? { ...current, creativeImageId: '' } : current;
      }

      formats.forEach((formatKey) => {
        if (checked) {
          nextCreativeImageIds[formatKey] = safeImageId;
          const existingAssignments = artworkMaterialAssignmentsForFormat(current, formatKey);
          if (existingAssignments.length > 0) {
            nextArtworkMaterialAssignments[formatKey] = existingAssignments.map((assignment, index) => ({
              ...assignment,
              artworkImageId: index === 0 || !assignment.artworkImageId ? safeImageId : assignment.artworkImageId,
            }));
          }
          return;
        }

        if (nextCreativeImageIds[formatKey] === safeImageId) {
          delete nextCreativeImageIds[formatKey];
        }
        const existingAssignments = artworkMaterialAssignmentsForFormat(current, formatKey);
        if (existingAssignments.length > 0) {
          nextArtworkMaterialAssignments[formatKey] = existingAssignments.map((assignment) => (
            assignment.artworkImageId === safeImageId ? { ...assignment, artworkImageId: '' } : assignment
          ));
        }
      });

      return {
        ...current,
        creativeImageIds: nextCreativeImageIds,
        creativeImageId: current.creativeImageId === safeImageId && !checked
          ? nextLegacyCreativeImageIdForAsset(nextCreativeImageIds)
          : checked
            ? safeImageId
            : current.creativeImageId,
        artworkMaterialAssignments: nextArtworkMaterialAssignments,
      };
    });
  }

  function assignArtworkImageToTarget(imageId: string) {
    if (isSubmittedCampaign) return;
    if (!assignArtworkTarget) return;
    const { marketId, assetId, formatKey, slotIndex } = assignArtworkTarget;
    if (
      slotIndex !== undefined
      && multiArtworkDialogOpen
      && multiArtworkTarget
      && multiArtworkTarget.marketId === marketId
      && multiArtworkTarget.assetId === assetId
      && multiArtworkTarget.formatKey === formatKey
    ) {
      updateMultiArtworkRecordImage(slotIndex, imageId);
      closeAssignArtworkDialog();
      closeArtworkPreviewDialog();
      return;
    }
    if (slotIndex !== undefined) {
      assignArtworkToFormatSlot(marketId, assetId, formatKey, slotIndex, imageId);
    } else {
      assignArtworkToFormat(marketId, assetId, formatKey, imageId);
    }
    closeAssignArtworkDialog();
    closeArtworkPreviewDialog();
  }

  function assignArtworkToFormatSlot(marketId: string, assetId: string, formatKey: CreativeFormatKey, slotIndex: number, imageId: string) {
    if (isSubmittedCampaign) return;
    updateCampaignAsset(marketId, assetId, (current) => {
      const nextAssignments = [...artworkMaterialAssignmentsForFormat(current, formatKey)];
      while (nextAssignments.length <= slotIndex) {
        nextAssignments.push({ artworkImageId: '', materialId: '', frameCount: 1 });
      }
      nextAssignments[slotIndex] = { ...nextAssignments[slotIndex], artworkImageId: imageId };
      return {
        ...current,
        artworkMaterialAssignments: {
          ...normalizeArtworkMaterialAssignments(current),
          [formatKey]: nextAssignments,
        },
      };
    });
  }

  function syncMultiArtworkRecordsToAsset(records: MultiArtworkRecord[]) {
    if (isSubmittedCampaign) return;
    if (!multiArtworkTarget) return;
    updateCampaignAsset(multiArtworkTarget.marketId, multiArtworkTarget.assetId, (current) => {
      const nextArtworkMaterialAssignments = {
        ...normalizeArtworkMaterialAssignments(current),
        [multiArtworkTarget.formatKey]: records
          .map((record) => ({
            artworkImageId: (record.imageId || '').trim(),
            materialId: (record.materialId || '').trim(),
            frameCount: Math.max(0, Math.floor(record.frameCount || 0)),
          }))
          .filter((record) => record.frameCount > 0),
      };
      return {
        ...current,
        artworkMaterialAssignments: nextArtworkMaterialAssignments,
      };
    });
  }

  function updateMultiArtworkRecordImage(recordIndex: number, imageId: string) {
    if (isSubmittedCampaign) return;
    setMultiArtworkRecords((current) => {
      if (recordIndex < 0 || recordIndex >= current.length) return current;
      const next = current.map((record, index) => (index === recordIndex ? { ...record, imageId } : record));
      syncMultiArtworkRecordsToAsset(next);
      return next;
    });
  }

  function updateMultiArtworkRecordMaterial(recordIndex: number, materialId: string) {
    if (isSubmittedCampaign) return;
    setMultiArtworkRecords((current) => {
      if (recordIndex < 0 || recordIndex >= current.length) return current;
      const next = current.map((record, index) => (index === recordIndex ? { ...record, materialId } : record));
      syncMultiArtworkRecordsToAsset(next);
      return next;
    });
  }

  function updateMultiArtworkRecordFrameCount(recordIndex: number, requestedFrameCount: number) {
    if (isSubmittedCampaign) return;
    setMultiArtworkRecords((current) => {
      if (!multiArtworkTarget || recordIndex < 0 || recordIndex >= current.length) return current;
      const sanitized = Math.max(0, Math.floor(Number.isFinite(requestedFrameCount) ? requestedFrameCount : 0));
      const usedByOthers = current.reduce((sum, record, index) => sum + (index === recordIndex ? 0 : Math.max(0, Math.floor(record.frameCount || 0))), 0);
      const maxForRow = Math.max(0, multiArtworkTarget.totalFrames - usedByOthers);
      const nextValue = Math.max(0, Math.min(sanitized, maxForRow));
      const next = current.map((record, index) => (index === recordIndex ? { ...record, frameCount: nextValue } : record));
      syncMultiArtworkRecordsToAsset(next);
      return next;
    });
  }

  function addMultiArtworkRecord() {
    if (isSubmittedCampaign || !multiArtworkTarget) return;
    setMultiArtworkRecords((current) => {
      const usedFrames = current.reduce((sum, record) => sum + Math.max(0, Math.floor(record.frameCount || 0)), 0);
      const remainingFrames = Math.max(0, (multiArtworkTarget?.totalFrames ?? 0) - usedFrames);
      const previousFrameCount = current.length > 0
        ? Math.max(0, Math.floor(current[current.length - 1].frameCount || 0))
        : remainingFrames;
      const frameCount = Math.min(previousFrameCount, remainingFrames);
      const next = [...current, { id: `multi-artwork-record-${Date.now()}-${current.length}`, imageId: '', materialId: materialIdForFormat(multiArtworkTarget.formatKey), frameCount }];
      syncMultiArtworkRecordsToAsset(next);
      return next;
    });
  }

  function removeMultiArtworkRecord(recordIndex: number) {
    if (isSubmittedCampaign) return;
    setMultiArtworkRecords((current) => {
      if (recordIndex < 0 || recordIndex >= current.length) return current;
      const next = current.filter((_, index) => index !== recordIndex);
      syncMultiArtworkRecordsToAsset(next);
      return next;
    });
  }

  function assignArtworkToFormat(marketId: string, assetId: string, formatKey: CreativeFormatKey, imageId: string) {
    if (isSubmittedCampaign) return;
    updateCampaignAsset(marketId, assetId, (current) => {
      const nextCreativeImageIds = {
        ...normalizeCreativeImageIds(current),
        [formatKey]: imageId,
      };
      if (!imageId) {
        delete nextCreativeImageIds[formatKey];
      }
      const nextLegacyCreativeImageId =
        nextCreativeImageIds['8-sheet']
        || nextCreativeImageIds['6-sheet']
        || nextCreativeImageIds['4-sheet']
        || nextCreativeImageIds['2-sheet']
        || nextCreativeImageIds.QA0
        || nextCreativeImageIds.Mega
        || nextCreativeImageIds['DOT M']
        || nextCreativeImageIds.MP
        || nextCreativeImageIds.FF
        || '';
      const existingAssignments = artworkMaterialAssignmentsForFormat(current, formatKey);
      const nextArtworkMaterialAssignments = normalizeArtworkMaterialAssignments(current);
      if (existingAssignments.length > 0) {
        nextArtworkMaterialAssignments[formatKey] = existingAssignments.map((assignment) => ({
          ...assignment,
          artworkImageId: imageId,
        }));
      }
      return {
        ...current,
        creativeImageIds: nextCreativeImageIds,
        creativeImageId: nextLegacyCreativeImageId,
        artworkMaterialAssignments: nextArtworkMaterialAssignments,
      };
    });
  }

  function isDeleteNotFoundError(error: unknown) {
    if (!(error instanceof Error)) return false;
    const message = error.message.toLowerCase();
    return message.includes('(404)') || message.includes('not found');
  }

  function handleDeleteArtwork(image: CampaignPrintImage) {
    if (isSubmittedCampaign) return;
    if (isSubCampaign) {
      setArtworkDialogError('Artwork deletion is disabled for sub campaigns because files may be referenced by the parent campaign.');
      return;
    }
    if (deletingArtworkIds.includes(image.id)) return;
    if (assignedArtworkIdSet.has(image.id)) {
      setArtworkDialogError('Cannot delete artwork that is assigned to an asset category.');
      return;
    }
    setDeleteArtworkCandidate(image);
  }

  function cancelDeleteArtwork() {
    if (confirmingArtworkDelete) return;
    setDeleteArtworkCandidate(null);
  }

  async function confirmDeleteArtwork() {
    const image = deleteArtworkCandidate;
    if (!image) return;
    if (isSubmittedCampaign) {
      setDeleteArtworkCandidate(null);
      return;
    }
    if (isSubCampaign) {
      setArtworkDialogError('Artwork deletion is disabled for sub campaigns because files may be referenced by the parent campaign.');
      setDeleteArtworkCandidate(null);
      return;
    }

    setConfirmingArtworkDelete(true);
    setDeletingArtworkIds((current) => [...current, image.id]);
    setArtworkDialogError('');
    try {
      const storedNames = Array.from(
        new Set(
          [image.storedName, image.thumbnailStoredName, image.previewStoredName]
            .map((value) => (value || '').trim())
            .filter(Boolean),
        ),
      );
      if (storedNames.length === 0) {
        throw new Error('Unable to delete artwork because storage info is missing.');
      }

      await Promise.all(
        storedNames.map(async (storedName) => {
          try {
            await deleteCampaignImage(storedName);
          } catch (deleteError) {
            if (isDeleteNotFoundError(deleteError)) return;
            throw deleteError;
          }
        }),
      );

      setValues((current) => ({
        ...current,
        printImages: current.printImages.filter((entry) => entry.id !== image.id),
        artworkCodes: Object.fromEntries(
          Object.entries(normalizeArtworkCodes(current.artworkCodes)).filter(([imageId]) => imageId !== image.id),
        ),
      }));

      if (previewArtworkImage?.id === image.id) {
        closeArtworkPreviewDialog();
      }
      setDeleteArtworkCandidate(null);
    } catch (deleteError) {
      setArtworkDialogError(deleteError instanceof Error ? deleteError.message : 'Unable to delete artwork.');
    } finally {
      setConfirmingArtworkDelete(false);
      setDeletingArtworkIds((current) => current.filter((id) => id !== image.id));
    }
  }

  async function handleArtworkPickerFiles(fileList: FileList | null) {
    if (isSubmittedCampaign) return;
    const nextFiles = Array.from(fileList ?? []);
    if (!nextFiles.length) return;
    const validFiles = nextFiles.filter((file) => isPdfFile(file));
    if (validFiles.length !== nextFiles.length) {
      setArtworkDialogError('Only PDF files are allowed.');
    } else {
      setArtworkDialogError('');
    }
    if (!validFiles.length) return;
    setHasChosenArtworkInSession(true);
    setUploadManagerOpen(true);
    setArtworkUploadSuccessOpen(false);
    setArtworkUploadSuccessMessage('');

    const enqueuePromise = (async () => {
      const savedCampaignId = await saveCampaignDraft();
      if (!savedCampaignId) {
        setArtworkDialogError('Save the campaign before uploading artwork.');
        return;
      }
      enqueueArtworkFiles(savedCampaignId, effectiveTenantId, validFiles);
    })();
    artworkEnqueuePromiseRef.current = enqueuePromise;
    try {
      await enqueuePromise;
    } finally {
      if (artworkEnqueuePromiseRef.current === enqueuePromise) artworkEnqueuePromiseRef.current = null;
      if (artworkPdfInputRef.current) artworkPdfInputRef.current.value = '';
    }
  }

  function handleArtworkDragOver(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    if (isSubmittedCampaign) return;
    event.dataTransfer.dropEffect = 'copy';
    setIsDraggingArtworkFiles(true);
  }

  function handleArtworkDragLeave(event: DragEvent<HTMLButtonElement>) {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setIsDraggingArtworkFiles(false);
  }

  function handleArtworkDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setIsDraggingArtworkFiles(false);
    if (isSubmittedCampaign) return;
    void handleArtworkPickerFiles(event.dataTransfer.files);
  }

  function removeQueuedArtworkFileAt(indexToRemove: number) {
    const job = queuedArtworkUploadJobs[indexToRemove];
    if (job) removeQueuedUpload(job.id);
  }

  function openUploadManagerDialog() {
    if (isSubmittedCampaign) return;
    setUploadManagerOpen(true);
  }

  async function ensureCampaignReadyForArtworkUpload() {
    if (isSubmittedCampaign) return false;
    const savedCampaignId = await saveCampaignDraft();
    if (savedCampaignId) return true;
    const message = 'Save the campaign before uploading artwork.';
    setArtworkDialogError(message);
    setError(message);
    return false;
  }

  async function openOneDriveImportDialog() {
    const canUploadArtwork = await ensureCampaignReadyForArtworkUpload();
    if (!canUploadArtwork) return;
    setOneDriveImportOpen(true);
  }

  async function handleOneDriveImport(selections: OneDriveSelection[], accessToken: string) {
    if (isSubmittedCampaign) throw new Error('Submitted campaigns cannot be edited');
    const savedCampaignId = campaignId || await saveCampaignDraft();
    if (!savedCampaignId) throw new Error('Save the campaign before importing artwork.');
    setHasChosenArtworkInSession(true);
    await enqueueOneDriveFiles(savedCampaignId, effectiveTenantId, selections, accessToken);
  }

  async function handleArtworkActionButtonClick() {
    if (isSubmittedCampaign) return;
    const canUploadArtwork = await ensureCampaignReadyForArtworkUpload();
    if (!canUploadArtwork) return;

    if (uploadingArtworkPages) {
      openArtworkManagerDialog();
      return;
    }
    if (values.printImages.length > 0) {
      openArtworkManagerDialog();
      return;
    }
    openArtworkPdfPicker();
  }

  function assetsForMarket(marketName: string) {
    return (markets.find((market) => market.name === marketName)?.assets ?? []).filter((asset) => !asset.isMaintenance);
  }

  function assetOptionsFor(market: CampaignMarket, assetId: string, selectedAssetId: string) {
    const marketAssets = markets.find((entry) => entry.name === market.market)?.assets ?? [];
    return marketAssets
      .filter((asset) => asset.id === selectedAssetId || !asset.isMaintenance)
      .map((asset) => ({ label: asset.label, value: asset.id }));
  }

  function canAddAssetForMarket(market: CampaignMarket) {
    const availableAssets = assetsForMarket(market.market);
    return availableAssets.length > 0;
  }

  function addAssetDisabledReasonForMarket(market: CampaignMarket) {
    const availableAssets = assetsForMarket(market.market);
    if (!market.market) return 'Choose a market before adding assets.';
    if (availableAssets.length === 0) return 'No assets are available for this market.';
    return '';
  }

  function marketOptionsFor(marketId: string, selectedMarket: string) {
    const selectedInOtherRows = new Set(values.campaignMarkets.filter((market) => market.id !== marketId).map((market) => market.market));
    return marketNames.filter((marketName) => marketName === selectedMarket || !selectedInOtherRows.has(marketName)).map((marketName) => ({ label: marketName, value: marketName }));
  }

  function deliveryAddressOptionsFor(marketName: string) {
    const savedOptions = marketDeliveryAddresses
      .filter((entry) => entry.market === marketName)
      .sort((left, right) => Number(right.isDefault) - Number(left.isDefault))
      .map((entry) => ({
        label: entry.isDefault ? `${formatDeliveryAddressOptionLabel(entry.deliveryAddress)} (Default)` : formatDeliveryAddressOptionLabel(entry.deliveryAddress),
        value: entry.deliveryAddress,
      }));
    const campaignOnlyOptions = values.campaignMarkets
      .filter((market) => market.market === marketName)
      .flatMap((market) => market.assets.map((asset) => asset.deliveryAddress.trim()).filter(Boolean))
      .map((deliveryAddress) => ({
        label: formatDeliveryAddressOptionLabel(deliveryAddress),
        value: deliveryAddress,
      }));
    return [...new Map([...campaignOnlyOptions, ...savedOptions].map((option) => [option.value, option])).values()];
  }

  function openAddAddressDialog(marketId: string, assetId: string, marketName: string) {
    if (!canAddAddressInFinalize || !marketName.trim()) return;
    setNewAddressTarget({ marketId, assetId, marketName });
    setNewAddressForm(emptyAddressForm());
    setNewAddressError('');
    setNewAddressDialogOpen(true);
  }

  function handleSaveNewAddress() {
    if (!newAddressTarget) return;
    const requiredFields: Array<{ label: string; value: string }> = [
      { label: 'Name', value: newAddressForm.name },
      { label: 'Unit/Street Number', value: newAddressForm.unitStreetNumber },
      { label: 'Suburb', value: newAddressForm.suburb },
      { label: 'State', value: newAddressForm.state },
      { label: 'Postcode', value: newAddressForm.postcode },
      { label: 'Phone number', value: newAddressForm.phoneNumber },
      { label: 'Delivery time', value: newAddressForm.deliveryTime },
      { label: 'Delivery point', value: newAddressForm.deliveryPoint },
      { label: 'Delivery notes', value: newAddressForm.deliveryNotes },
    ];
    const missingField = requiredFields.find((field) => !field.value.trim());
    if (missingField) {
      setNewAddressError(`${missingField.label} is required`);
      return;
    }
    const nextAddress = formatDeliveryAddress(newAddressForm);
    setNewAddressError('');

    updateCampaignAsset(newAddressTarget.marketId, newAddressTarget.assetId, (current) => ({
      ...current,
      deliveryAddress: nextAddress,
    }));
    setNewAddressDialogOpen(false);
    setNewAddressTarget(null);
    setNewAddressForm(emptyAddressForm());
    setNewAddressError('');
  }

  async function saveCampaignDraft(options?: { fromAutoSave?: boolean }) {
    if (isSubmittedCampaign) {
      return campaignId;
    }
    const fromAutoSave = options?.fromAutoSave ?? false;
    if (fromAutoSave && leavingCampaignRef.current) {
      return campaignId;
    }
    const currentValuesSerialized = stableSerialize(values);
    if (fromAutoSave && lastAutoSaveFailedValuesRef.current === currentValuesSerialized) {
      return null;
    }
    if (campaignId && !hasUnsavedChanges) return campaignId;

    setSavingCampaign(true);
    if (!fromAutoSave) setError('');
    try {
      if (!campaignId) {
        const response = await createCampaign({ values }, effectiveTenantId);
        applyCampaignToScreen(response.campaign, setValues, setSummary, setUploadedPurchaseOrderName, setUploadedPurchaseOrder, setCampaignId, setCampaignStatus, setParentCampaignId);
        campaignIdRef.current = response.campaign.id;
            lastPersistedValuesRef.current = stableSerialize(response.campaign.values);
        lastAutoSaveFailedValuesRef.current = null;
        await setStoredCampaignId(response.campaign.id, effectiveTenantId);
        return response.campaign.id;
      }

      const response = await updateStoredCampaign(campaignId, { values }, effectiveTenantId);
      setCampaignStatus(response.campaign.status);
      setParentCampaignId(response.campaign.parentCampaignId || '');
      setUploadedPurchaseOrderName(response.campaign.purchaseOrder?.originalName || '');
      setUploadedPurchaseOrder(response.campaign.purchaseOrder);
        lastPersistedValuesRef.current = stableSerialize(response.campaign.values);
      lastAutoSaveFailedValuesRef.current = null;
      return campaignId;
    } catch (saveError) {
      if (fromAutoSave) {
        lastAutoSaveFailedValuesRef.current = currentValuesSerialized;
      }
      setError(saveError instanceof Error ? saveError.message : 'Unable to save campaign');
      return null;
    } finally {
      setSavingCampaign(false);
    }
  }

  useEffect(() => {
    if (isSubmittedCampaign || loadingCampaign || savingCampaign || !hasUnsavedChanges || leavingCampaignRef.current) return;

    const timeoutId = window.setTimeout(() => {
      void saveCampaignDraft({ fromAutoSave: true });
    }, 900);
    autoSaveTimeoutRef.current = timeoutId;

    return () => {
      window.clearTimeout(timeoutId);
      if (autoSaveTimeoutRef.current === timeoutId) {
        autoSaveTimeoutRef.current = null;
      }
    };
  }, [campaignId, effectiveTenantId, hasUnsavedChanges, isSubmittedCampaign, loadingCampaign, savingCampaign, values]);

  function clearPendingAutoSave() {
    if (autoSaveTimeoutRef.current === null) return;
    window.clearTimeout(autoSaveTimeoutRef.current);
    autoSaveTimeoutRef.current = null;
  }

  async function handleBackToDashboard() {
    if (!onBack) return;
    leavingCampaignRef.current = true;
    clearPendingAutoSave();
    if (artworkEnqueuePromiseRef.current) {
      await artworkEnqueuePromiseRef.current;
      await releaseActiveCampaignLock();
      onBack();
      return;
    }
    if (isCampaignStartDatePast || isDeliveryDueDatePast) {
      await releaseActiveCampaignLock();
      onBack();
      return;
    }
    if (!hasUnsavedChanges) {
      await releaseActiveCampaignLock();
      onBack();
      return;
    }
    const savedCampaignId = await saveCampaignDraft();
    if (savedCampaignId) {
      await releaseActiveCampaignLock(savedCampaignId);
      onBack();
      return;
    }
    leavingCampaignRef.current = false;
    setUnsavedDialogOpen(true);
  }

  async function handleSaveAndLeave() {
    leavingCampaignRef.current = true;
    clearPendingAutoSave();
    const savedCampaignId = await saveCampaignDraft();
    if (!savedCampaignId) {
      leavingCampaignRef.current = false;
      return;
    }
    setUnsavedDialogOpen(false);
    await releaseActiveCampaignLock(savedCampaignId);
    onBack?.();
  }

  async function handleDiscardAndLeave() {
    leavingCampaignRef.current = true;
    clearPendingAutoSave();
    setUnsavedDialogOpen(false);
    await releaseActiveCampaignLock();
    onBack?.();
  }

  async function handleSubmitQuote(options?: { test?: boolean; confirmed?: boolean }) {
    const isTestSubmission = options?.test === true;
    if (isSubmittedCampaign && !(isTestSubmission && isSuperAdmin)) {
      setQuoteResponseStatus('success');
      setQuoteResponseMessage('This campaign has already been submitted.');
      return;
    }
    if (isTestSubmission && !isSuperAdmin) {
      setQuoteResponseStatus('error');
      setQuoteResponseMessage('Test submit is available only for super admin.');
      return;
    }
    if (!hasUploadedPurchaseOrder) {
      setQuoteResponseStatus('error');
      setQuoteResponseMessage('Upload a purchase order file before submitting.');
      return;
    }
    if (!hasPurchaseOrderNumber) {
      setPurchaseOrderNumberSubmitAttempted(true);
      setQuoteResponseStatus('error');
      setQuoteResponseMessage('Enter a purchase order number before submitting.');
      return;
    }
    if (!options?.confirmed) {
      setPendingSubmitOptions({ test: isTestSubmission });
      setSubmitConfirmationOpen(true);
      return;
    }

    if (isTestSubmission) {
      setTestSubmitting(true);
    } else {
      setSubmitting(true);
    }
    setError('');
    setQuoteResponseMessage('');
    setQuoteResponseStatus('success');
    setSubmitProgress({ progress: 0, label: 'Saving campaign' });

    try {
      const savedCampaignId = isSubmittedCampaign ? campaignId : await saveCampaignDraft();
      if (!savedCampaignId) return;
      const response = await submitCampaignToPrintIQ(savedCampaignId, effectiveTenantId, {
        test: isTestSubmission,
        onProgress: (next) => setSubmitProgress((current) => ({
          progress: Math.max(current.progress, next.progress),
          label: next.label,
        })),
      });
      const jobNumbers = response.jobNos?.length ? response.jobNos.join(', ') : response.jobNo;
      const quoteNumbers = response.quoteNos?.length ? response.quoteNos.join(', ') : response.quoteNo;
      const printIQNumbers = [quoteNumbers ? `Quote${(response.quoteNos?.length ?? 0) > 1 ? 's' : ''}: ${quoteNumbers}` : '', jobNumbers ? `Jobs: ${jobNumbers}` : ''].filter(Boolean).join(', ');
      applyCampaignToScreen(response.campaign, setValues, setSummary, setUploadedPurchaseOrderName, setUploadedPurchaseOrder, setCampaignId, setCampaignStatus, setParentCampaignId);
      lastPersistedValuesRef.current = stableSerialize(response.campaign.values);
      if (isTestSubmission) {
        const successMessage = printIQNumbers ? `Test order submitted to PrintIQ. ${printIQNumbers}` : 'Test order submitted to PrintIQ.';
        setQuoteResponseMessage(successMessage);
        return;
      }
      const successMessage = printIQNumbers ? `Order submitted to PrintIQ. ${printIQNumbers}` : 'Order submitted to PrintIQ.';
      setQuoteResponseMessage(successMessage);
      try {
        window.sessionStorage.setItem(LANDING_NOTICE_KEY, successMessage);
      } catch {
        // Ignore storage errors; navigation should still happen.
      }
      await releaseActiveCampaignLock(response.campaign.id);
      onBack?.();
    } catch (submissionError) {
      const message = submissionError instanceof Error ? submissionError.message : 'Unable to create quote';
      setQuoteResponseStatus('error');
      setQuoteResponseMessage(message);
    } finally {
      if (isTestSubmission) {
        setTestSubmitting(false);
      } else {
        setSubmitting(false);
      }
    }
  }

  function cancelSubmitConfirmation() {
    if (isPrintIQSubmitting) return;
    setSubmitConfirmationOpen(false);
    setPendingSubmitOptions(null);
  }

  async function confirmSubmitQuote() {
    const options = pendingSubmitOptions ?? {};
    setSubmitConfirmationOpen(false);
    setPendingSubmitOptions(null);
    await handleSubmitQuote({ ...options, confirmed: true });
  }

  async function handleUploadPurchaseOrder(fileToUpload?: File | null) {
    if (isSubmittedCampaign) return;
    const purchaseOrderFile = fileToUpload ?? selectedPurchaseOrderFile;
    if (!purchaseOrderFile) {
      setError('Please choose a purchase order file to upload');
      return;
    }

    setUploadingPurchaseOrder(true);
    setError('');
    try {
      const savedCampaignId = await saveCampaignDraft();
      if (!savedCampaignId) return;
      const response = await uploadPurchaseOrderFile(purchaseOrderFile, savedCampaignId, effectiveTenantId);
      setUploadedPurchaseOrderName(response.originalName);
      setUploadedPurchaseOrder(response);
      setPurchaseOrderUploadSuccessMessage(`Purchase order file uploaded successfully: ${response.originalName}`);
      setPurchaseOrderUploadSuccessOpen(true);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload purchase order');
    } finally {
      setUploadingPurchaseOrder(false);
    }
  }

  function openSupportingDocumentPicker() {
    if (isSubmittedCampaign) return;
    supportingDocumentInputRef.current?.click();
  }

  async function handleUploadSupportingDocuments(fileList: FileList | null) {
    if (isSubmittedCampaign) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0 || uploadingSupportingDocuments) return;

    setUploadingSupportingDocuments(true);
    setError('');
    const completedUploads: CampaignSupportingDocument[] = [];
    try {
      const savedCampaignId = await saveCampaignDraft();
      if (!savedCampaignId) return;

      for (const file of files) {
        const upload = await uploadCampaignImage(file);
        completedUploads.push({
          originalName: upload.originalName,
          storedName: upload.storedName,
          mimeType: upload.mimeType || file.type || 'application/octet-stream',
          size: upload.size,
          uploadedAt: upload.uploadedAt,
        });
      }

      const response = await appendCampaignSupportingDocuments(savedCampaignId, completedUploads, effectiveTenantId);
      setValues(normalizeFormValues(response.campaign.values));
      setCampaignStatus(response.campaign.status);
      lastPersistedValuesRef.current = stableSerialize(response.campaign.values);
      setExportProgressMessage(
        `${completedUploads.length} supporting document${completedUploads.length === 1 ? '' : 's'} uploaded for Installs.`,
      );
    } catch (uploadError) {
      await Promise.allSettled(completedUploads.map((document) => deleteCampaignImage(document.storedName)));
      setError(uploadError instanceof Error ? uploadError.message : 'Unable to upload supporting documents');
    } finally {
      setUploadingSupportingDocuments(false);
      if (supportingDocumentInputRef.current) supportingDocumentInputRef.current.value = '';
    }
  }

  function openManageUploadsDialog() {
    setManageUploadsError('');
    setManageUploadsOpen(true);
  }

  async function handleDownloadUploadedPurchaseOrder() {
    if (!campaignId || !uploadedPurchaseOrder || downloadingPurchaseOrder) return;
    setDownloadingPurchaseOrder(true);
    setManageUploadsError('');
    try {
      const blob = await downloadCampaignPurchaseOrder(campaignId, effectiveTenantId);
      downloadBlobWithFileName(blob, uploadedPurchaseOrder.originalName || `${values.campaignName || 'Campaign'} - Purchase Order`);
    } catch (downloadError) {
      setManageUploadsError(downloadError instanceof Error ? downloadError.message : 'Unable to download purchase order');
    } finally {
      setDownloadingPurchaseOrder(false);
    }
  }

  async function handleDownloadSupportingDocument(document: CampaignSupportingDocument) {
    if (downloadingSupportingDocumentName) return;
    setDownloadingSupportingDocumentName(document.storedName);
    setManageUploadsError('');
    try {
      const blob = await downloadCampaignImage(document.storedName, document.originalName);
      downloadBlobWithFileName(blob, document.originalName || document.storedName);
    } catch (downloadError) {
      setManageUploadsError(downloadError instanceof Error ? downloadError.message : 'Unable to download supporting document');
    } finally {
      setDownloadingSupportingDocumentName('');
    }
  }

  function costLinesForMarket(marketName: string) {
    const marketLines = summary?.lines.filter((line) => line.market === marketName) ?? [];
    const targetBreakdown = marketSummaryByName.get(marketName)?.breakdown;
    if (!targetBreakdown || marketLines.length === 0) return marketLines;

    const keys = new Set<string>([
      ...Object.keys(targetBreakdown as Record<string, number>),
      ...marketLines.flatMap((line) => Object.keys(line.breakdown as Record<string, number>)),
    ]);
    const allocatedByLine = marketLines.map(() => ({} as Record<string, number>));

    keys.forEach((key) => {
      const target = Math.max(0, Math.floor(breakdownValueForKey(targetBreakdown, key)));
      const originalValues = marketLines.map((line) => Math.max(0, breakdownValueForKey(line.breakdown, key)));
      const originalTotal = originalValues.reduce((total, value) => total + value, 0);
      if (target === 0) {
        allocatedByLine.forEach((breakdown) => { breakdown[key] = 0; });
        return;
      }
      if (originalTotal === 0) {
        allocatedByLine.forEach((breakdown, index) => { breakdown[key] = index === 0 ? target : 0; });
        return;
      }

      const allocations = originalValues.map((value, index) => {
        const exact = (target * value) / originalTotal;
        return { index, value: Math.floor(exact), remainder: exact - Math.floor(exact) };
      });
      let remaining = target - allocations.reduce((total, allocation) => total + allocation.value, 0);
      allocations
        .slice()
        .sort((left, right) => right.remainder - left.remainder || left.index - right.index)
        .forEach((allocation) => {
          if (remaining <= 0) return;
          allocations[allocation.index].value += 1;
          remaining -= 1;
        });
      allocations.forEach((allocation) => { allocatedByLine[allocation.index][key] = allocation.value; });
    });

    return marketLines.map((line, index) => ({
      ...line,
      breakdown: allocatedByLine[index] as QuantityBreakdown,
    }));
  }

  function calculateMarketShippingCost(marketName: string) {
    const twoSheeterPrice = twoSheeterPriceByMarket.get(marketName) ?? 0;
    const fourSheeterPrice = fourSheeterPriceByMarket.get(marketName) ?? 0;
    const sixSheeterPrice = sixSheeterPriceByMarket.get(marketName) ?? 0;
    const eightSheeterPrice = eightSheeterPriceByMarket.get(marketName) ?? 0;
    const twoSheeterSetsPerBox = twoSheeterSetsPerBoxByMarket.get(marketName) ?? 15;
    const fourSheeterSetsPerBox = fourSheeterSetsPerBoxByMarket.get(marketName) ?? 15;
    const sixSheeterSetsPerBox = sixSheeterSetsPerBoxByMarket.get(marketName) ?? 15;
    const eightSheeterSetsPerBox = eightSheeterSetsPerBoxByMarket.get(marketName) ?? 15;
    const megasPerBox = megasPerBoxByMarket.get(marketName) ?? 1;
    const marketLines = shippingLinesWithCreatives(costLinesForMarket(marketName), values.campaignMarkets);
    const marketRate = marketShippingRates.find((rate) => rate.market === marketName);
    if (marketRate?.useMarketFlatRate) {
      return marketLines.some((line) => Object.values(line.breakdown).some((quantity) => quantity > 0)) ? marketRate.marketFlatRate ?? 0 : 0;
    }
    const useFlatRateSheeters = useFlatRateSheetersByMarket.get(marketName) ?? false;
    const useFlatRateMegas = useFlatRateMegasByMarket.get(marketName) ?? false;
    const isCustomSheetFormat = (key: string) => Boolean(customSheetSizeFormats[toCanonicalSheetNameKey(key)]);
    const customSheetTotal = marketLines.reduce((total, line) => (
      total + Object.entries(line.breakdown as Record<string, number>).reduce((lineTotal, [rawKey, rawQuantity]) => {
        if (isCustomSheetFormat(rawKey)) return lineTotal;
        if ((formatKeys as readonly string[]).includes(rawKey)) return lineTotal;
        return lineTotal + Math.max(0, Number(rawQuantity) || 0);
      }, 0)
    ), 0);
    const shippingRateForSheetKey = (assetShippingCosts: MarketAssetShippingCostRecord | undefined, sheetKey: string) => {
      const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
      if (formatKey === '2-sheet') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.['2-sheet'] ?? twoSheeterPrice;
      if (formatKey === '4-sheet') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.['4-sheet'] ?? fourSheeterPrice;
      if (formatKey === '6-sheet') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.['6-sheet'] ?? sixSheeterPrice;
      if (formatKey === '8-sheet') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.['8-sheet'] ?? eightSheeterPrice;
      if (formatKey === 'QA0') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.QA0 ?? eightSheeterPrice;
      if (formatKey === 'Mega') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.Mega ?? assetShippingCosts?.megaShippingRate ?? (megaShippingRateByMarket.get(marketName) ?? 0);
      if (formatKey === 'DOT M') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.['DOT M'] ?? assetShippingCosts?.dotMShippingRate ?? (dotMShippingRateByMarket.get(marketName) ?? 0);
      if (formatKey === 'MP') return assetShippingCosts?.costs?.[sheetKey] ?? assetShippingCosts?.costs?.MP ?? assetShippingCosts?.mpShippingRate ?? (mpShippingRateByMarket.get(marketName) ?? 0);
      return assetShippingCosts?.costs?.[sheetKey] ?? 0;
    };
    const shippingBoxSizeForSheetKey = (sheetKey: string) => {
      const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
      if (formatKey === '2-sheet') return twoSheeterSetsPerBox;
      if (formatKey === '4-sheet') return fourSheeterSetsPerBox;
      if (formatKey === '6-sheet') return sixSheeterSetsPerBox;
      if (formatKey === '8-sheet' || formatKey === 'QA0') return eightSheeterSetsPerBox;
      return megasPerBox;
    };
    const customSheetShipping = marketLines.reduce((total, line) => {
      const selectedAsset = selectedAssetByLineId.get(line.id);
      if (!selectedAsset) return total;
      const assetShippingCosts = shippingCostByMarketAsset.get(`${selectedAsset.market}\x00${selectedAsset.assetId}`);
      // Carry the market total through each asset so flat freight is charged once.
      return Object.keys(customSheetSizeFormats).reduce((lineTotal, sheetKey) => {
        if (!customSheetSizeFormats[sheetKey]) return lineTotal;
        const quantity = Math.max(0, quantityForSheetKey(line.breakdown as Record<string, number>, sheetKey));
        if (quantity === 0) return lineTotal;
        const rate = shippingRateForSheetKey(assetShippingCosts, sheetKey);
        return useFlatRateMegas ? Math.max(lineTotal, rate)
          : lineTotal + calculateShippingCost(quantity, rate, shippingBoxSizeForSheetKey(sheetKey));
      }, total);
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
    const posterShipping = sheeterShipping(standardQuantity('8-sheet') + standardQuantity('QA0') + customSheetTotal, eightSheeterPrice, 4, eightSheeterSetsPerBox)
      + sheeterShipping(standardQuantity('6-sheet'), sixSheeterPrice, 3, sixSheeterSetsPerBox)
      + sheeterShipping(standardQuantity('4-sheet'), fourSheeterPrice, 2, fourSheeterSetsPerBox)
      + sheeterShipping(standardQuantity('2-sheet'), twoSheeterPrice, 1, twoSheeterSetsPerBox);

    return posterShipping + customSheetShipping;
  }

  function calculateLinePrintingCost(line: CampaignCalculationSummary['lines'][number]) {
    const selectedAsset = selectedAssetByLineId.get(line.id);
    const costs = selectedAsset
      ? printingCostByMarketAsset.get(`${selectedAsset.market}\x00${selectedAsset.assetId}`)
      : undefined;
    const posterRate = costs?.['8-sheet'] ?? 0;
    const customCost = Object.entries(line.breakdown as Record<string, number>).reduce((total, [rawKey, rawPages]) => {
      const sheetKey = toCanonicalSheetNameKey(rawKey);
      if (customSheetSizeFormats[sheetKey]) return total;
      const isStandardFormat = (formatKeys as readonly string[]).includes(rawKey);
      if (isStandardFormat) return total;
      const pages = Math.max(0, Number(rawPages) || 0);
      if (pages === 0) return total;
      return total + pages * posterRate;
    }, 0);
    if (!selectedAsset) return customCost;
    if (!costs) return customCost;
    const qa0Units = line.breakdown.QA0 ?? 0;
    const eightSheetRate = costs['8-sheet'] ?? 0;
    const standardCost = formatKeys.reduce((total, key) => {
      if (customSheetSizeFormats[toCanonicalSheetNameKey(key)] || key === 'QA0') return total;
      return total + (line.breakdown[key] ?? 0) * (costs[key] ?? 0);
    }, 0) + qa0Units * eightSheetRate;
    const customSheetCost = Object.keys(customSheetSizeFormats).reduce((total, sheetKey) => {
      if (!customSheetSizeFormats[sheetKey]) return total;
      if (!selectedAsset) return total;
      const pages = Math.max(0, quantityForSheetKey(line.breakdown as Record<string, number>, sheetKey));
      if (pages === 0) return total;
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
        return total + customRate;
      }
      const formatKey = formatKeys.find((key) => canonicalKeyForFormat(key) === sheetKey);
      const rate = costs[sheetKey] ?? (formatKey ? costs[formatKey] : undefined) ?? 0;
      return total + pages * rate;
    }, 0);
    return standardCost + customCost + customSheetCost;
  }

  function calculateMarketPrintingCost(marketName: string) {
    const marketLines = costLinesForMarket(marketName);
    return marketLines.reduce((total, line) => total + calculateLinePrintingCost(line), 0);
  }

  const totalPrintingCost = useMemo(
    () => visibleReviewMarkets.reduce((total, marketSummary) => total + calculateMarketPrintingCost(marketSummary.market), 0),
    [customPrintCostByAssetSheet, customPrintCostFormats, customSheetSizeFormats, printingCostByMarketAsset, selectedAssetByLineId, visibleReviewMarkets],
  );
  const totalShippingCost = useMemo(
    () => visibleReviewMarkets.reduce((total, marketSummary) => total + calculateMarketShippingCost(marketSummary.market), 0),
    [customSheetSizeFormats, marketShippingRates, marketAssetShippingCosts, selectedAssetByLineId, visibleReviewMarkets],
  );
  const totalEstimateCost = totalPrintingCost + totalShippingCost;

  async function generateArtworkTemplates(
    downloadFiles: boolean,
    exportMode: VisualsExportMode,
    purpose: ArtworkExportPurpose = 'visuals',
    diagnosticId = '',
    summaryOverride: CampaignCalculationSummary | null = null,
  ): Promise<GeneratedVisualExportFile[]> {
    try {
      const ExcelJSRuntime = ExcelJS as any;
      const generationStartedAt = performance.now();
      const logInstallGeneration = (stage: string, details?: Record<string, unknown>) => {
        if (purpose !== 'installs') return;
        console.info('[FlowIQ Installs Generation]', diagnosticId || 'manual', stage, {
          elapsedMs: Math.round(performance.now() - generationStartedAt),
          ...details,
        });
      };
      logInstallGeneration('started', {
        exportMode,
        downloadFiles,
        marketCount: values.campaignMarkets.length,
        printImageCount: values.printImages.length,
      });
      const baseName = sanitizeFileName((values.campaignName || 'Campaign').trim() || 'Campaign');
      const campaignNumber = values.customerReference.trim() || campaignId || '';
      const weekCommencing = parseDateOnly(values.campaignStartDate);
      const weekCount = Math.max(1, Number.parseInt(values.numberOfWeeks || '1', 10) || 1);
      const shouldGenerateExcel = exportMode === 'excel';

      const exportSummary = summaryOverride ?? summary;
      const lineByAssetId = new Map((exportSummary?.lines ?? []).map((line) => [line.id, line]));
      const defaultDeliveryAddressByMarket = new Map<string, string>();
      marketDeliveryAddresses.forEach((entry) => {
        if (!defaultDeliveryAddressByMarket.has(entry.market) || entry.isDefault) {
          defaultDeliveryAddressByMarket.set(entry.market, entry.deliveryAddress);
        }
      });

      const imageById = new Map(
        values.printImages.map((image, index) => [
          image.id,
          { image, creativeNumber: creativeNumberByImageId.get(image.id) ?? (index + 1) },
        ]),
      );
      const mappingOptionByMarketAssetId = new Map<string, MarketMetadata['assets'][number]>();
      const mappingOptionById = new Map<string, MarketMetadata['assets'][number]>();
      markets.forEach((marketMetadata) => {
        marketMetadata.assets.forEach((assetOption) => {
          mappingOptionByMarketAssetId.set(`${marketMetadata.name}\x00${assetOption.id}`, assetOption);
          mappingOptionById.set(assetOption.id, assetOption);
        });
      });
      type InstallWeekRow = {
        week: number;
        state: string;
        asset: string;
        breakdown: Record<string, number>;
        rowOrder: number;
      };
      const hasInstallQuantity = (row: InstallWeekRow) =>
        Object.values(row.breakdown).some((quantity) => quantity > 0);
      const installWeekRows: InstallWeekRow[] = [];
      const allInstallWeeks = Array.from(new Set([
        ...createAllWeeks(weekCount),
        ...values.campaignMarkets.flatMap((market) => market.assets.flatMap((asset) => asset.selectedWeeks)),
      ])).sort((left, right) => left - right);
      let installRowOrder = 0;
      values.campaignMarkets.forEach((market) => {
        market.assets.forEach((campaignAsset) => {
          const baseOption = mappingOptionById.get(campaignAsset.assetId);
          const maintenanceOption = baseOption?.maintenanceAssetId
            ? mappingOptionById.get(baseOption.maintenanceAssetId)
            : null;
          const defaultLabel = campaignAsset.assetSearch || campaignAsset.assetId;
          const selectedWeekSet = new Set(campaignAsset.selectedWeeks);
          const firstSelectedWeek = campaignAsset.selectedWeeks.reduce(
            (earliest, week) => (week > 0 && week < earliest ? week : earliest),
            Number.POSITIVE_INFINITY,
          );
          const state = (
            inferStateFromMarket(market.market)
            ?? normalizeExportState(baseOption?.state || maintenanceOption?.state || '')
            ?? market.market
          ) || '-';
          const displayRows = [
            {
              asset: baseOption?.label || defaultLabel,
              appliesToMaintenanceWeeks: false,
              quantities: baseOption?.quantities ?? ({} as QuantityBreakdown),
            },
            ...(maintenanceOption
              ? [{
                asset: maintenanceOption.label || `${baseOption?.label || defaultLabel} (maintenance)`,
                appliesToMaintenanceWeeks: true,
                quantities: maintenanceOption.quantities ?? ({} as QuantityBreakdown),
              }]
              : []),
          ];

          displayRows.forEach((displayRow) => {
            const rowOrder = installRowOrder++;
            allInstallWeeks.forEach((week) => {
              const usesMaintenanceWeek = Number.isFinite(firstSelectedWeek)
                && week % 2 !== firstSelectedWeek % 2
                && Boolean(maintenanceOption);
              const isSelected = selectedWeekSet.has(week);
              const matchesWeek = displayRow.appliesToMaintenanceWeeks ? usesMaintenanceWeek : !usesMaintenanceWeek;
              const breakdown = isSelected && matchesWeek
                ? Object.fromEntries(
                  Object.entries(displayRow.quantities as Record<string, number>)
                    .map(([key, value]) => [key, Math.max(0, Math.floor(Number(value) || 0))]),
                )
                : {};
              installWeekRows.push({
                week,
                state,
                asset: displayRow.asset,
                breakdown,
                rowOrder,
              });
            });
          });
        });
      });
      logInstallGeneration('install rows prepared', {
        installWeekRowCount: installWeekRows.length,
        installWeekCount: allInstallWeeks.length,
      });
      const printRows = new Map<
        string,
        {
          creativeCode: string;
          creativeNumber: number;
          creativeImageId: string;
          fileName: string;
          state: ExportState;
          quantities: Record<number, number>;
          formatQuantities: Record<string, number>;
        }
      >();
      const deliveryRows = new Map<string, {
        creativeCode: string;
        fileName: string;
        state: ExportState;
        typeLabel: string;
        quantity: number;
        deliveredTo: string;
        deliveredToName: string;
        rolled: boolean;
      }>();
      const creativeSummary = new Map<number, QuantityBreakdown>();
      const materialQuantitiesByCreative = new Map<number, Map<string, number>>();
      const pdfPrintQuantityRows = new Map<string, {
        creativeNumber: number;
        artworkImageId: string;
        sheet: string;
        asset: string;
        material: string;
        count: number;
      }>();
      const materialById = new Map(materials.map((material) => [material.id, material]));
      const deliveryInfoBlocks: string[] = [];
      const seenDeliveryInfo = new Set<string>();
      const pushDeliveryInfo = (address: string, marketName: string, stateHint?: ExportState | null) => {
        const normalizedAddress = address.trim().replace(/\r\n/g, '\n');
        if (!normalizedAddress) return;
        const state = stateHint ?? normalizeExportState(marketName);
        const heading = state ? `VIM ${state}` : `VIM ${marketName.trim().toUpperCase()}`;
        const block = normalizedAddress.toUpperCase().startsWith('VIM ') ? normalizedAddress : `${heading}\n${normalizedAddress}`;
        if (seenDeliveryInfo.has(block)) return;
        seenDeliveryInfo.add(block);
        deliveryInfoBlocks.push(block);
      };

      const updateSummary = (creativeNumber: number, key: keyof QuantityBreakdown, quantity: number) => {
        if (quantity <= 0) return;
        const bucket = creativeSummary.get(creativeNumber) ?? { '8-sheet': 0, '6-sheet': 0, '4-sheet': 0, '2-sheet': 0, QA0: 0, Mega: 0, 'DOT M': 0, MP: 0, FF: 0 };
        const dynamicBucket = bucket as Record<string, number>;
        dynamicBucket[key as string] = (dynamicBucket[key as string] ?? 0) + quantity;
        creativeSummary.set(creativeNumber, bucket);
      };
      const splitQuantityAcrossSlots = (total: number, slots: number) => {
        const safeSlots = Math.max(1, slots);
        const base = Math.floor(total / safeSlots);
        const remainder = total % safeSlots;
        return Array.from({ length: safeSlots }, (_, index) => base + (index < remainder ? 1 : 0));
      };

      const getPrintColumn = (state: ExportState, key: keyof QuantityBreakdown) => {
        if (state === 'QLD') {
          if (key === '8-sheet') return 14;
          if (key === '6-sheet') return 15;
          if (key === '4-sheet') return 16;
          if (key === '2-sheet') return 17;
        }
        if (key === '8-sheet') return 9;
        if (key === '6-sheet') return 10;
        if (key === '4-sheet') return 11;
        if (key === '2-sheet') return 12;
        if (key === 'QA0') return 13;
        if (key === 'Mega') return 18;
        if (key === 'DOT M') return 19;
        if (key === 'MP') return 20;
        return 21;
      };

      const getSizeDisplayName = (key: string) => {
        if (key === '8-sheet') return resolveFormatName('8-sheet', normalizedSheetNameOverrides);
        if (key === '6-sheet') return resolveFormatName('6-sheet', normalizedSheetNameOverrides);
        if (key === '4-sheet') return resolveFormatName('4-sheet', normalizedSheetNameOverrides);
        if (key === '2-sheet') return resolveFormatName('2-sheet', normalizedSheetNameOverrides);
        if (key === 'QA0') return resolveFormatName('QA0', normalizedSheetNameOverrides);
        if (key === 'Mega') return resolveFormatName('Mega', normalizedSheetNameOverrides);
        if (key === 'DOT M') return resolveFormatName('DOT M', normalizedSheetNameOverrides);
        if (key === 'MP') return resolveFormatName('MP', normalizedSheetNameOverrides);
        if (key === 'FF') return resolveFormatName('FF', normalizedSheetNameOverrides);
        return resolveSheetName(key, normalizedSheetNameOverrides);
      };

      const getDeliveryTypeLabel = (state: ExportState, key: keyof QuantityBreakdown) => {
        const isPosterFormat = key === '8-sheet' || key === '6-sheet' || key === '4-sheet' || key === '2-sheet' || key === 'QA0';
        if (isPosterFormat) {
          const marketLabel = marketShortLabelForState(state);
          if (marketLabel) return `${marketLabel} ${getSizeDisplayName(key)}`;
        }
        return getSizeDisplayName(key);
      };

      const getExportQuantityForFormat = (key: keyof QuantityBreakdown, posters: number) => {
        if (exportMode !== 'pdf') return posters;
        const divisor = formatToFrameDivisor[key as CreativeFormatKey] ?? 1;
        return Math.max(0, Math.ceil(Math.max(0, posters) / Math.max(1, divisor)));
      };

      const posterDivisors: Record<keyof QuantityBreakdown, number> = {
        '8-sheet': 4,
        '6-sheet': 3,
        '4-sheet': 2,
        '2-sheet': 1,
        QA0: 4,
        Mega: 1,
        'DOT M': 1,
        MP: 1,
        FF: 1,
      };
      const summaryLabels: Record<keyof QuantityBreakdown, string> = {
        '8-sheet': 'posters',
        '6-sheet': 'posters',
        '4-sheet': 'posters',
        '2-sheet': 'posters',
        QA0: 'posters',
        Mega: resolveFormatName('Mega', normalizedSheetNameOverrides),
        'DOT M': resolveFormatName('DOT M', normalizedSheetNameOverrides),
        MP: resolveFormatName('MP', normalizedSheetNameOverrides),
        FF: resolveFormatName('FF', normalizedSheetNameOverrides),
      };

      // Collect delivery addresses from campaign data regardless of mapped creatives.
      values.campaignMarkets.forEach((market) => {
        market.assets.forEach((asset) => {
          pushDeliveryInfo(asset.deliveryAddress || defaultDeliveryAddressByMarket.get(market.market) || '', market.market);
        });
      });
      if (deliveryInfoBlocks.length === 0) {
        values.campaignMarkets.forEach((market) => {
          pushDeliveryInfo(defaultDeliveryAddressByMarket.get(market.market) || '', market.market);
        });
      }

      values.campaignMarkets.forEach((market) => {
        market.assets.forEach((asset) => {
          const line = lineByAssetId.get(asset.id);
          if (!line) return;

          const state = normalizeExportState(line.state) ?? inferStateFromMarket(market.market);
          if (!state) return;
          Object.entries(line.breakdown as Record<string, number>).forEach(([key, posterQuantity]) => {
            if (posterQuantity <= 0) return;

            const isStandardFormat = isKnownFormatKey(key);
            const exportQuantity = isStandardFormat
              ? getExportQuantityForFormat(key as keyof QuantityBreakdown, posterQuantity)
              : posterQuantity;
            if (exportQuantity <= 0) return;
            const creativeFormat = toCreativeFormatKey(key as keyof QuantityBreakdown);
            let remainingMaterialFrames = exportQuantity;
              artworkMaterialAssignmentsForFormat(asset, creativeFormat).forEach((materialAssignment) => {
                if (remainingMaterialFrames <= 0) return;
                const assignedFrames = Math.min(
                  remainingMaterialFrames,
                  Math.max(0, Math.floor(materialAssignment.frameCount || 0)),
                );
                remainingMaterialFrames -= assignedFrames;
                const materialId = (materialAssignment.materialId || '').trim();
                if (!materialId || assignedFrames <= 0) return;
                const artworkImageId = (materialAssignment.artworkImageId || '').trim()
                  || getCreativeImageIdForFormat(asset, creativeFormat);
                const creative = imageById.get(artworkImageId);
                if (!creative) return;
                const materialName = materialById.get(materialId)?.name.trim() || `Unknown material (${materialId})`;
                const materialKey = `${state}\x00${creativeFormat}\x00${materialName}`;
                const materialBucket = materialQuantitiesByCreative.get(creative.creativeNumber) ?? new Map<string, number>();
                materialBucket.set(materialKey, (materialBucket.get(materialKey) ?? 0) + assignedFrames);
                materialQuantitiesByCreative.set(creative.creativeNumber, materialBucket);
              });
            const multiSlotImageIds = expandedArtworkImageIdsForFormat(asset, creativeFormat)
              .filter((imageId) => Boolean(imageById.get(imageId)));
            const useMultiArtworkForFormat = Boolean(normalizedMultipleArtworkFormats[canonicalKeyForFormat(creativeFormat)]);
            const useMultiArtwork = useMultiArtworkForFormat && multiSlotImageIds.length > 0;

            const creativeAssignments = useMultiArtwork
              ? (() => {
                  const slotCount = Math.max(1, multiSlotImageIds.length);
                  const slotQuantities = splitQuantityAcrossSlots(exportQuantity, slotCount);
                  return multiSlotImageIds.slice(0, slotCount).map((imageId, index) => ({
                    imageId,
                    quantity: slotQuantities[index] ?? 0,
                  })).filter((assignment) => assignment.quantity > 0);
                })()
              : (() => {
                  const creativeImageId = getCreativeImageIdForFormat(asset, creativeFormat);
                  return creativeImageId ? [{ imageId: creativeImageId, quantity: exportQuantity }] : [];
                })();

            if (exportMode === 'pdf') {
              const sheet = getDeliveryTypeLabel(state, key as keyof QuantityBreakdown);
              const assetLabel = (asset.assetSearch || mappingOptionByMarketAssetId.get(`${market.market}\x00${asset.assetId}`)?.label || asset.assetId || '-').trim();
              const formatMaterialAssignments = artworkMaterialAssignmentsForFormat(asset, creativeFormat);
              creativeAssignments.forEach((assignment) => {
                const creative = imageById.get(assignment.imageId);
                if (!creative) return;
                let remainingCount = assignment.quantity;
                formatMaterialAssignments
                  .filter((materialAssignment) => {
                    const assignedArtworkId = (materialAssignment.artworkImageId || '').trim()
                      || getCreativeImageIdForFormat(asset, creativeFormat);
                    return assignedArtworkId === assignment.imageId;
                  })
                  .forEach((materialAssignment) => {
                    if (remainingCount <= 0) return;
                    const count = Math.min(remainingCount, Math.max(0, Math.floor(materialAssignment.frameCount || 0)));
                    if (count <= 0) return;
                    remainingCount -= count;
                    const materialId = (materialAssignment.materialId || '').trim();
                    const materialName = materialId
                      ? materialById.get(materialId)?.name.trim() || `Unknown material (${materialId})`
                      : '-';
                    const rowKey = `${creative.creativeNumber}\x00${assignment.imageId}\x00${sheet}\x00${assetLabel}\x00${materialName}`;
                    const existing = pdfPrintQuantityRows.get(rowKey);
                    pdfPrintQuantityRows.set(rowKey, {
                      creativeNumber: creative.creativeNumber,
                      artworkImageId: assignment.imageId,
                      sheet,
                      asset: assetLabel,
                      material: materialName,
                      count: (existing?.count ?? 0) + count,
                    });
                  });
                if (remainingCount > 0) {
                  const rowKey = `${creative.creativeNumber}\x00${assignment.imageId}\x00${sheet}\x00${assetLabel}\x00-`;
                  const existing = pdfPrintQuantityRows.get(rowKey);
                  pdfPrintQuantityRows.set(rowKey, {
                    creativeNumber: creative.creativeNumber,
                    artworkImageId: assignment.imageId,
                    sheet,
                    asset: assetLabel,
                    material: '-',
                    count: (existing?.count ?? 0) + remainingCount,
                  });
                }
              });
            }

            creativeAssignments.forEach((assignment) => {
              const creative = imageById.get(assignment.imageId);
              if (!creative) return;
              const creativeCode = buildCreativeCode(state, creative.creativeNumber);
              const fileName = toFileBaseName(creative.image.fileName || creative.image.name || asset.assetSearch || asset.assetId || 'Artwork');
              const printRowKey = `${creativeCode}\x00${fileName}`;
              const printRow = printRows.get(printRowKey) ?? {
                creativeCode,
                creativeNumber: creative.creativeNumber,
                creativeImageId: creative.image.id,
                fileName,
                state,
                quantities: {},
                formatQuantities: {},
              };

              if (isStandardFormat) {
                const column = getPrintColumn(state, key as keyof QuantityBreakdown);
                printRow.quantities[column] = (printRow.quantities[column] ?? 0) + assignment.quantity;
              }
              printRow.formatQuantities[key] = (printRow.formatQuantities[key] ?? 0) + assignment.quantity;
              printRows.set(printRowKey, printRow);

              const typeLabel = getDeliveryTypeLabel(state, key as keyof QuantityBreakdown);
              const destination = formatDeliveryDestinationForExport(
                asset.deliveryAddress || defaultDeliveryAddressByMarket.get(market.market) || '',
                state,
              );
              const deliveredTo = destination.fullAddress;
              const rolled = state !== 'NSW';
              const deliveryKey = `${creativeCode}\x00${fileName}\x00${typeLabel}\x00${deliveredTo}`;
              const existingDeliveryRow = deliveryRows.get(deliveryKey);
              if (existingDeliveryRow) {
                existingDeliveryRow.quantity += assignment.quantity;
              } else {
                deliveryRows.set(deliveryKey, {
                  creativeCode,
                  fileName,
                  state,
                  typeLabel,
                  quantity: assignment.quantity,
                  deliveredTo,
                  deliveredToName: destination.contactName,
                  rolled,
                });
              }

              updateSummary(creative.creativeNumber, key as keyof QuantityBreakdown, assignment.quantity);
            });
          });

          pushDeliveryInfo(asset.deliveryAddress || defaultDeliveryAddressByMarket.get(market.market) || '', market.market, state);
        });
      });

      logInstallGeneration('print rows prepared', {
        printRowCount: printRows.size,
        deliveryRowCount: deliveryRows.size,
        pdfPrintQuantityRowCount: pdfPrintQuantityRows.size,
      });

      const creativeSummaryText = Array.from(creativeSummary.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([creativeNumber, breakdown]) => {
          const parts: string[] = [];
          const breakdownRecord = breakdown as Record<string, number>;
          const orderedKeys = Array.from(new Set([...formatKeys, ...Object.keys(breakdownRecord)]));
          orderedKeys.forEach((key) => {
            const quantity = breakdownRecord[key] ?? 0;
            if (quantity <= 0) return;
            const sizeDisplayName = getSizeDisplayName(key);
            if (!isKnownFormatKey(key)) {
              parts.push(`${quantity} x ${sizeDisplayName}`);
              return;
            }
            if (key === 'Mega' || key === 'DOT M' || key === 'MP') {
              parts.push(`${quantity} x ${summaryLabels[key]}`);
              return;
            }
            parts.push(`${quantity} ${summaryLabels[key]} (${quantity / posterDivisors[key]} x ${sizeDisplayName})`);
          });
          return parts.length ? `Creative ${creativeNumber}: ${parts.join(' & ')}` : '';
        })
        .filter(Boolean)
        .join('\n');

      const imageRecordById = new Map(values.printImages.map((image) => [image.id, image]));
      const creativeImageDataUrlById = new Map<string, string>();
      const creativeImageByCreativeFileKey = new Map<string, string>();
      Array.from(printRows.values()).forEach((row) => {
        creativeImageByCreativeFileKey.set(`${row.creativeCode}\x00${row.fileName}`, row.creativeImageId);
      });

      const requiredCreativeImageIds = new Set(Array.from(printRows.values()).map((row) => row.creativeImageId));
      const creativePreviewById = new Map<string, { bytes: Uint8Array; extension: 'png' | 'jpg' }>();
      const detectImageExtension = (mimeType: string, fileName: string): 'png' | 'jpg' => {
        const mime = mimeType.toLowerCase();
        const lowerName = fileName.toLowerCase();
        if (mime.includes('png') || lowerName.endsWith('.png')) return 'png';
        if (mime.includes('jpg') || mime.includes('jpeg') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'jpg';
        return 'png';
      };
      if (exportMode === 'pdf' && purpose === 'visuals') {
        const imageIds = Array.from(requiredCreativeImageIds);
        setExportProgressMessage(`Preparing artwork previews: 0 of ${imageIds.length}`);
        await prepareArtworkExportPreviews(imageIds, async (imageId) => {
          const image = imageRecordById.get(imageId);
          if (!image) throw new Error(`Artwork ${imageId} is missing from the campaign.`);
          const dataUrl = await loadArtworkExportPreview(
            image,
            (url) => campaignImageFetchCandidates(toAbsoluteUrl(buildApiUrl(url))),
            pdfFirstPageToDataUrl,
          );
          const parsed = dataUrlToBytes(dataUrl);
          if (!parsed) throw new Error(`Unable to prepare preview for ${image.fileName}.`);
          creativePreviewById.set(imageId, parsed);
        }, (completed, total) => setExportProgressMessage(`Preparing artwork previews: ${completed} of ${total}`));
      } else if (shouldGenerateExcel) {
        setExportProgressMessage('Preparing artwork previews...');
        await Promise.all(Array.from(requiredCreativeImageIds).map(async (imageId) => {
          const image = imageRecordById.get(imageId);
          if (!image?.imageUrl) return;
          const mimeType = (image.mimeType || '').toLowerCase();
          const isPdf = mimeType === 'application/pdf' || image.fileName.toLowerCase().endsWith('.pdf');
          try {
            const response = await fetch(withCampaignImageProxy(toAbsoluteUrl(buildApiUrl(image.imageUrl))));
            if (!response.ok) return;
            const blob = await response.blob();
            const dataUrl = isPdf ? await pdfFirstPageToDataUrl(blob, 420) : await blobToDataUrl(blob);
            if (dataUrl) creativeImageDataUrlById.set(imageId, dataUrl);
          } catch {
            // Preserve the existing optional image behavior for Excel exports.
          }
        }));
      }
      const fillWordDocument = async (): Promise<GeneratedVisualExportFile> => {
        setExportProgressMessage('Generating PDF document...');
        logInstallGeneration('pdf document setup started');

        const printRowsSorted = Array.from(printRows.values()).sort(
          (a, b) => a.creativeNumber - b.creativeNumber || a.fileName.localeCompare(b.fileName) || a.state.localeCompare(b.state),
        );

        const rowsByCreative = new Map<number, typeof printRowsSorted>();
        printRowsSorted.forEach((row) => {
          const bucket = rowsByCreative.get(row.creativeNumber) ?? [];
          bucket.push(row);
          rowsByCreative.set(row.creativeNumber, bucket);
        });

        const rowTotals = (creativeRows: typeof printRowsSorted) => {
          const totals = new Map<number, number>();
          creativeRows.forEach((row) => {
            Object.entries(row.quantities).forEach(([column, quantity]) => {
              const numericColumn = Number(column);
              totals.set(numericColumn, (totals.get(numericColumn) ?? 0) + quantity);
            });
          });
          return totals;
        };

        const inferCreativeTypeLabel = (creativeRows: typeof printRowsSorted) => {
          const totals = rowTotals(creativeRows);
          const hasEightSheet = (totals.get(9) ?? 0) > 0 || (totals.get(14) ?? 0) > 0;
          const hasSixSheet = (totals.get(10) ?? 0) > 0 || (totals.get(15) ?? 0) > 0;
          const hasFourSheet = (totals.get(11) ?? 0) > 0 || (totals.get(16) ?? 0) > 0;
          const hasTwoSheet = (totals.get(12) ?? 0) > 0 || (totals.get(17) ?? 0) > 0;
          const hasQa0 = (totals.get(13) ?? 0) > 0;
          const hasMegaPortrait = (totals.get(20) ?? 0) > 0;
          const hasDotMega = (totals.get(19) ?? 0) > 0;
          const hasMega = (totals.get(18) ?? 0) > 0;
          const hasFerroFilm = (totals.get(21) ?? 0) > 0;
          if (hasFourSheet) return '4-sheet';
          if (hasTwoSheet) return '2-sheet';
          if (hasSixSheet) return '6-sheet';
          if (hasEightSheet) return '8-sheet';
          if (hasQa0) return 'QA0';
          if (hasMegaPortrait) return 'Mega Portrait';
          if (hasDotMega) return 'DOT Mega';
          if (hasMega) return 'Mega';
          if (hasFerroFilm) return 'FF';
          return 'Artwork';
        };

        const resolveCreativeTypeLabel = (label: string) => {
          if (label === '8-sheet') return resolveFormatName('8-sheet', normalizedSheetNameOverrides);
          if (label === '6-sheet') return resolveFormatName('6-sheet', normalizedSheetNameOverrides);
          if (label === '4-sheet') return resolveFormatName('4-sheet', normalizedSheetNameOverrides);
          if (label === '2-sheet') return resolveFormatName('2-sheet', normalizedSheetNameOverrides);
          if (label === 'QA0') return resolveFormatName('QA0', normalizedSheetNameOverrides);
          if (label === 'Mega') return resolveFormatName('Mega', normalizedSheetNameOverrides);
          if (label === 'DOT Mega') return resolveFormatName('DOT M', normalizedSheetNameOverrides);
          if (label === 'Mega Portrait') return resolveFormatName('MP', normalizedSheetNameOverrides);
          if (label === 'FF') return resolveFormatName('FF', normalizedSheetNameOverrides);
          return resolveSheetName(label, normalizedSheetNameOverrides);
        };

        const formatKeyForPrintColumn = (column: number): keyof QuantityBreakdown | null => {
          if (column === 9 || column === 14) return '8-sheet';
          if (column === 10 || column === 15) return '6-sheet';
          if (column === 11 || column === 16) return '4-sheet';
          if (column === 12 || column === 17) return '2-sheet';
          if (column === 13) return 'QA0';
          if (column === 18) return 'Mega';
          if (column === 19) return 'DOT M';
          if (column === 20) return 'MP';
          if (column === 21) return 'FF';
          return null;
        };

        const quantityLabelForStateAndKey = (state: ExportState, key: keyof QuantityBreakdown) => {
          const base = getSizeDisplayName(key);
          const isPosterFormat = key === '8-sheet' || key === '6-sheet' || key === '4-sheet' || key === '2-sheet' || key === 'QA0';
          const marketLabel = isPosterFormat ? marketShortLabelForState(state) : '';
          return marketLabel ? `${marketLabel} ${base}` : base;
        };

        const creativeTypeByNumber = new Map<number, string>();
        const typeCounts = new Map<string, number>();
        Array.from(rowsByCreative.entries()).sort((a, b) => a[0] - b[0]).forEach(([creativeNumber, creativeRows]) => {
          const typeLabel = inferCreativeTypeLabel(creativeRows);
          const summaryBucket = (creativeSummary.get(creativeNumber) ?? {}) as Record<string, number>;
          const customTypes = Object.entries(summaryBucket).filter(([key, value]) => !isKnownFormatKey(key) && (value ?? 0) > 0);
          const finalTypeLabel = customTypes.length > 0
            ? customTypes.sort((left, right) => right[1] - left[1])[0][0]
            : typeLabel;
          creativeTypeByNumber.set(creativeNumber, finalTypeLabel);
          typeCounts.set(finalTypeLabel, (typeCounts.get(finalTypeLabel) ?? 0) + 1);
        });

        const creativeHeadline = Array.from(typeCounts.entries())
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([label, count]) => `${count} x ${resolveCreativeTypeLabel(label)}`)
          .join(', ') || 'No mapped creatives';

        const quantityPartsByCreative = new Map<number, string[]>();
        Array.from(rowsByCreative.keys()).forEach((creativeNumber) => {
          const creativeRows = rowsByCreative.get(creativeNumber) ?? [];
          const totalsByStateAndKey = new Map<string, number>();
          creativeRows.forEach((row) => {
            Object.entries(row.formatQuantities).forEach(([formatKey, quantity]) => {
              if ((quantity ?? 0) <= 0) return;
              const bucketKey = `${row.state}\x00${formatKey}`;
              totalsByStateAndKey.set(bucketKey, (totalsByStateAndKey.get(bucketKey) ?? 0) + quantity);
            });
          });
          const parts: string[] = [];
          const formatOrder: Array<keyof QuantityBreakdown> = ['8-sheet', 'QA0', '6-sheet', '4-sheet', '2-sheet', 'Mega', 'DOT M', 'MP', 'FF'];
          Array.from(totalsByStateAndKey.entries())
            .sort((left, right) => {
              const [leftState, leftFormat] = left[0].split('\x00') as [ExportState, keyof QuantityBreakdown];
              const [rightState, rightFormat] = right[0].split('\x00') as [ExportState, keyof QuantityBreakdown];
              const leftMarketOrder = leftState === 'NSW' ? 1 : leftState === 'QLD' ? 2 : 0;
              const rightMarketOrder = rightState === 'NSW' ? 1 : rightState === 'QLD' ? 2 : 0;
              if (leftMarketOrder !== rightMarketOrder) return leftMarketOrder - rightMarketOrder;
              const leftFormatOrder = formatOrder.indexOf(leftFormat);
              const rightFormatOrder = formatOrder.indexOf(rightFormat);
              if (leftFormatOrder !== rightFormatOrder) return leftFormatOrder - rightFormatOrder;
              return leftState.localeCompare(rightState);
            })
            .forEach(([compositeKey, quantity]) => {
              if ((quantity ?? 0) <= 0) return;
              const [state, formatKey] = compositeKey.split('\x00') as [ExportState, keyof QuantityBreakdown];
              const quantityLabel = quantityLabelForStateAndKey(state, formatKey);
              parts.push(`${quantity} x ${quantityLabel}`);
            });
          quantityPartsByCreative.set(creativeNumber, parts);
        });

        const normalizePdfFileName = (image: CampaignPrintImage, fallbackBaseName = 'Artwork') => {
          const rawPdfFileName = (image.sourcePdfFileName || '').trim();
          if (rawPdfFileName) return /\.pdf$/i.test(rawPdfFileName) ? rawPdfFileName : `${rawPdfFileName}.pdf`;
          const rawName = (image.name || '').trim().replace(/\s*\(Page\s+\d+\)\s*$/i, '').trim();
          if (rawName) return /\.pdf$/i.test(rawName) ? rawName : `${rawName}.pdf`;
          const rawFileName = (image.fileName || '').trim();
          if (rawFileName) {
            const base = rawFileName.replace(/\.[^.]+$/, '').replace(/-page-\d+$/i, '').trim();
            if (base) return `${base}.pdf`;
          }
          const fallbackBase = fallbackBaseName.replace(/\.[^.]+$/, '').replace(/-page-\d+$/i, '').trim();
          return `${fallbackBase || 'Artwork'}.pdf`;
        };
        const getStoredNameFromUrl = (url: string) => {
          try {
            const resolved = toAbsoluteUrl(buildApiUrl(url || ''));
            const parsed = new URL(resolved);
            const parts = parsed.pathname.split('/').filter(Boolean);
            return parts[parts.length - 1] || '';
          } catch {
            return '';
          }
        };
        const buildPdfDownloadUrl = (storedName: string, fileName: string) => {
          const cleanedStoredName = storedName.trim();
          if (!cleanedStoredName) return '';
          const downloadUrl = new URL(toAbsoluteUrl(buildApiUrl(`/api/campaign-images/${encodeURIComponent(cleanedStoredName)}/download`)));
          downloadUrl.searchParams.set('filename', fileName);
          return downloadUrl.toString();
        };
        const buildCreativePdfLink = (creativeImageId: string, fallbackBaseName: string) => {
          const image = imageRecordById.get(creativeImageId);
          if (!image) return '';
          const storedName = (image.sourcePdfStoredName || '').trim() || getStoredNameFromUrl(image.sourcePdfUrl || image.imageUrl || '');
          const fileName = normalizePdfFileName(image, fallbackBaseName);
          return storedName ? buildPdfDownloadUrl(storedName, fileName) : '';
        };

        const deliveryByDestination = new Map<string, { name: string; creativeMap: Map<number, Map<string, number>> }>();
        Array.from(deliveryRows.values()).forEach((row) => {
          const creativeNumber = getCreativeNumberFromCode(row.creativeCode);
          const destinationKey = row.deliveredTo || 'DELIVERY';
          const destinationBucket = deliveryByDestination.get(destinationKey) ?? { name: row.deliveredToName || destinationKey, creativeMap: new Map<number, Map<string, number>>() };
          const creativeBucket = destinationBucket.creativeMap.get(creativeNumber) ?? new Map<string, number>();
          const label = row.typeLabel;
          creativeBucket.set(label, (creativeBucket.get(label) ?? 0) + row.quantity);
          destinationBucket.creativeMap.set(creativeNumber, creativeBucket);
          deliveryByDestination.set(destinationKey, destinationBucket);
        });

        const deadlineText = formatDeliveryDeadline(values.dueDate);
        const pdfDoc = await PDFDocument.create();
        pdfDoc.registerFontkit(fontkit);
        const pdfPageSize: [number, number] = purpose === 'installs' ? [841.89, 595.28] : [595.28, 841.89];
        let page = pdfDoc.addPage(pdfPageSize);
        logInstallGeneration('pdf document created', { pageSize: pdfPageSize.join('x') });
        const [regularFontResponse, boldFontResponse] = await Promise.all([
          fetch('/fonts/NotoSans-Regular.ttf'),
          fetch('/fonts/NotoSans-Bold.ttf'),
        ]);
        if (!regularFontResponse.ok || !boldFontResponse.ok) {
          throw new Error('Unable to load the Unicode PDF fonts.');
        }
        const [regularFontBytes, boldFontBytes] = await Promise.all([
          regularFontResponse.arrayBuffer(),
          boldFontResponse.arrayBuffer(),
        ]);
        const font = await pdfDoc.embedFont(regularFontBytes, { subset: true });
        const bold = await pdfDoc.embedFont(boldFontBytes, { subset: true });
        logInstallGeneration('fonts embedded');
        let adsLogoPngBytes: Uint8Array | null = null;
        try {
          const logoResponse = await fetch('/ads-logo.webp');
          if (logoResponse.ok) {
            const logoBlob = await logoResponse.blob();
            const logoBitmap = await createImageBitmap(logoBlob);
            try {
              const logoCanvas = document.createElement('canvas');
              logoCanvas.width = Math.max(1, Math.ceil(logoBitmap.width));
              logoCanvas.height = Math.max(1, Math.ceil(logoBitmap.height));
              const logoContext = logoCanvas.getContext('2d');
              if (logoContext) {
                logoContext.drawImage(logoBitmap, 0, 0, logoCanvas.width, logoCanvas.height);
                const logoPngBlob = await canvasToBlob(logoCanvas, 'image/png');
                adsLogoPngBytes = new Uint8Array(await logoPngBlob.arrayBuffer());
              }
            } finally {
              logoBitmap.close();
            }
          }
        } catch {
          adsLogoPngBytes = null;
        }
        const adsLogoImage = adsLogoPngBytes ? await pdfDoc.embedPng(adsLogoPngBytes) : null;
        logInstallGeneration('logo processed', { hasLogo: Boolean(adsLogoImage) });
        const linkColor = rgb(0.05, 0.35, 0.78);
        const brandBlue = rgb(0.05, 0.13, 0.25);
        const brandOrange = rgb(0.95, 0.45, 0.12);
        const titleBg = brandBlue;
        const sectionBg = rgb(0.95, 0.97, 1);
        const sectionBorder = rgb(0.8, 0.86, 0.94);
        const marginX = 42;
        const marginTop = 44;
        const marginBottom = 44;
        const fontSize = 10.5;
        const lineHeight = 14;
        const maxWidth = page.getWidth() - marginX * 2;
        let cursorY = page.getHeight() - marginTop;
        const artworkFolderUrl = buildArtworkFolderUrl(campaignId, effectiveTenantId);

        const addLinkAnnotation = (x: number, y: number, width: number, height: number, url: string) => {
          if (!url) return;
          const annotation = pdfDoc.context.obj({
            Type: 'Annot',
            Subtype: 'Link',
            Rect: [x, y, x + width, y + height],
            Border: [0, 0, 0],
            A: { Type: 'Action', S: 'URI', URI: PDFString.of(url) },
          });
          const annotationRef = pdfDoc.context.register(annotation);
          const annots = page.node.lookup(PDFName.of('Annots'), PDFArray) ?? pdfDoc.context.obj([]);
          annots.push(annotationRef);
          page.node.set(PDFName.of('Annots'), annots);
        };

        const ensureSpace = (requiredHeight: number) => {
          if (cursorY - requiredHeight < marginBottom) {
            page = pdfDoc.addPage(pdfPageSize);
            cursorY = page.getHeight() - marginTop;
          }
        };

        const drawTitleBlock = (title: string, subtitle: string) => {
          const h = 76;
          ensureSpace(h + 10);
          page.drawRectangle({
            x: marginX,
            y: cursorY - h + 8,
            width: maxWidth,
            height: h,
            color: titleBg,
          });
          const titleTextX = marginX + 12;
          if (adsLogoImage) {
            const logoTargetHeight = 38;
            const logoScale = logoTargetHeight / Math.max(1, adsLogoImage.height);
            const logoWidth = Math.max(1, Math.round(adsLogoImage.width * logoScale));
            page.drawImage(adsLogoImage, {
              x: marginX + 12,
              y: cursorY - 52,
              width: logoWidth,
              height: logoTargetHeight,
            });
          }
          page.drawText(title, {
            x: titleTextX + (adsLogoImage ? 56 : 0),
            y: cursorY - 16,
            size: 16,
            font: bold,
            color: rgb(1, 1, 1),
          });
          page.drawText(subtitle, {
            x: titleTextX + (adsLogoImage ? 56 : 0),
            y: cursorY - 34,
            size: 10,
            font,
            color: rgb(0.85, 0.9, 0.97),
          });
          const startLabel = values.campaignStartDate?.trim() ? formatDocumentDate(values.campaignStartDate) : '-';
          const dueLabel = values.dueDate?.trim() ? formatDocumentDate(values.dueDate) : '-';
          page.drawText(`Start Date: ${startLabel}    Due Date: ${dueLabel}`, {
            x: titleTextX + (adsLogoImage ? 56 : 0),
            y: cursorY - 50,
            size: 9.5,
            font,
            color: rgb(0.85, 0.9, 0.97),
          });
          cursorY -= (h + 10);
        };

        const drawSectionHeader = (label: string, spacingAfter = 12) => {
          const h = 22;
          ensureSpace(h + 6);
          page.drawRectangle({
            x: marginX,
            y: cursorY - h + 4,
            width: maxWidth,
            height: h,
            color: sectionBg,
            borderColor: sectionBorder,
            borderWidth: 1,
          });
          page.drawRectangle({
            x: marginX,
            y: cursorY - h + 4,
            width: 4,
            height: h,
            color: brandOrange,
          });
          page.drawText(label, {
            x: marginX + 10,
            y: cursorY - 11,
            size: 10.5,
            font: bold,
            color: rgb(0.1, 0.16, 0.26),
          });
          cursorY -= (h + 6);
          cursorY -= spacingAfter;
        };

        const drawWrappedLine = (
          text: string,
          isBold = false,
          link?: string,
          indent = 0,
          color: ReturnType<typeof rgb> = rgb(0.08, 0.12, 0.18),
        ) => {
          const useFont = isBold ? bold : font;
          const words = text.split(' ');
          let current = '';
          const xBase = marginX + indent;
          const maxWidthForLine = maxWidth - indent;
          const flush = () => {
            ensureSpace(lineHeight);
            const printable = current || ' ';
            const width = useFont.widthOfTextAtSize(printable, fontSize);
            page.drawText(printable, {
              x: xBase,
              y: cursorY,
              size: fontSize,
              font: useFont,
              color: link ? linkColor : color,
            });
            if (link) {
              page.drawLine({ start: { x: xBase, y: cursorY - 1 }, end: { x: xBase + width, y: cursorY - 1 }, thickness: 0.5, color: linkColor });
              addLinkAnnotation(xBase, cursorY - 2, width, lineHeight, link);
            }
            cursorY -= lineHeight;
          };
          words.forEach((word) => {
            const candidate = current ? `${current} ${word}` : word;
            const width = useFont.widthOfTextAtSize(candidate, fontSize);
            if (width <= maxWidthForLine) {
              current = candidate;
            } else {
              flush();
              current = word;
            }
          });
          flush();
        };

        const drawWrappedSegments = (
          segments: Array<{ text: string; isBold?: boolean }>,
          indent = 0,
          color: ReturnType<typeof rgb> = rgb(0.08, 0.12, 0.18),
        ) => {
          const xBase = marginX + indent;
          const maxWidthForLine = maxWidth - indent;
          const tokens: Array<{ text: string; isBold: boolean }> = [];
          segments.forEach((segment) => {
            segment.text.split(/(\s+)/).forEach((part) => {
              if (!part) return;
              tokens.push({ text: part, isBold: Boolean(segment.isBold) });
            });
          });
          let lineTokens: Array<{ text: string; isBold: boolean }> = [];
          const lineWidth = (items: Array<{ text: string; isBold: boolean }>) => items.reduce((sum, item) => {
            const useFont = item.isBold ? bold : font;
            return sum + useFont.widthOfTextAtSize(item.text, fontSize);
          }, 0);
          const flush = () => {
            ensureSpace(lineHeight);
            let cursorX = xBase;
            if (lineTokens.length === 0) {
              cursorY -= lineHeight;
              return;
            }
            lineTokens.forEach((item) => {
              const useFont = item.isBold ? bold : font;
              page.drawText(item.text, {
                x: cursorX,
                y: cursorY,
                size: fontSize,
                font: useFont,
                color,
              });
              cursorX += useFont.widthOfTextAtSize(item.text, fontSize);
            });
            cursorY -= lineHeight;
            lineTokens = [];
          };
          tokens.forEach((token) => {
            const candidate = [...lineTokens, token];
            if (lineTokens.length > 0 && lineWidth(candidate) > maxWidthForLine) {
              flush();
            }
            lineTokens.push(token);
          });
          flush();
        };

        const drawPrintQuantitiesTable = () => {
          const columns = [
            { label: 'Artwork', width: 82 },
            { label: 'Sheet', width: 105 },
            { label: 'Asset', width: 125 },
            { label: 'Material', width: 145 },
            { label: 'Count', width: maxWidth - 457 },
          ];
          const tableFontSize = 8.5;
          const cellPadding = 5;
          const tableLineHeight = 11;
          const splitCellLines = (text: string, width: number) => {
            const words = (text || '-').split(/\s+/);
            const lines: string[] = [];
            let current = '';
            words.forEach((word) => {
              const candidate = current ? `${current} ${word}` : word;
              if (!current || font.widthOfTextAtSize(candidate, tableFontSize) <= width - cellPadding * 2) current = candidate;
              else {
                lines.push(current);
                current = word;
              }
            });
            if (current) lines.push(current);
            return lines.length > 0 ? lines : ['-'];
          };
          const drawTableRow = (values: string[], header = false) => {
            const linesByCell = values.map((value, index) => splitCellLines(value, columns[index].width));
            const rowHeight = Math.max(22, Math.max(...linesByCell.map((lines) => lines.length)) * tableLineHeight + cellPadding * 2);
            if (cursorY - rowHeight < marginBottom) {
              page = pdfDoc.addPage(pdfPageSize);
              cursorY = page.getHeight() - marginTop;
              if (!header) drawTableRow(columns.map((column) => column.label), true);
            }
            let x = marginX;
            columns.forEach((column, index) => {
              page.drawRectangle({
                x,
                y: cursorY - rowHeight,
                width: column.width,
                height: rowHeight,
                color: header ? sectionBg : rgb(1, 1, 1),
                borderColor: sectionBorder,
                borderWidth: 0.75,
              });
              linesByCell[index].forEach((line, lineIndex) => {
                page.drawText(line, {
                  x: x + cellPadding,
                  y: cursorY - cellPadding - tableFontSize - lineIndex * tableLineHeight,
                  size: tableFontSize,
                  font: header ? bold : font,
                  color: rgb(0.08, 0.12, 0.18),
                });
              });
              x += column.width;
            });
            cursorY -= rowHeight;
          };

          drawTableRow(columns.map((column) => column.label), true);
          Array.from(pdfPrintQuantityRows.values())
            .sort((left, right) => left.creativeNumber - right.creativeNumber
              || left.sheet.localeCompare(right.sheet)
              || left.asset.localeCompare(right.asset)
              || left.material.localeCompare(right.material))
            .forEach((row) => drawTableRow([
              `Creative ${row.creativeNumber}`,
              row.sheet,
              row.asset,
              row.material,
              String(row.count),
            ]));
        };

        const installFormatKeysForRows = (rows: InstallWeekRow[]) => Array.from(new Set([
          ...formatKeys,
          ...rows.flatMap((row) => Object.keys(row.breakdown)),
        ])).filter((key) => rows.some((row) => (row.breakdown[key] ?? 0) > 0));
        const installFrameDivisor = (key: string) => formatToFrameDivisor[key as CreativeFormatKey] ?? 1;
        const installFrameCount = (key: string, posters: number) => Math.ceil(posters / Math.max(1, installFrameDivisor(key)));
        const installDateForWeek = (week: number) => {
          if (!weekCommencing) return `Week ${week}`;
          const date = new Date(weekCommencing);
          date.setDate(date.getDate() + (week - 1) * 7);
          const year = String(date.getFullYear());
          const month = String(date.getMonth() + 1).padStart(2, '0');
          const day = String(date.getDate()).padStart(2, '0');
          return `w/c ${formatDocumentDate(`${year}-${month}-${day}`)}`;
        };
        const drawInstallWeekTable = (week: number, rows: InstallWeekRow[]) => {
          const visibleRows = rows.filter(hasInstallQuantity);
          if (visibleRows.length === 0) return;
          const installFormatKeys = installFormatKeysForRows(visibleRows);
          const stateWidth = 44;
          const assetWidth = Math.max(155, maxWidth - stateWidth - installFormatKeys.length * 54);
          const quantityWidth = (maxWidth - stateWidth - assetWidth) / Math.max(1, installFormatKeys.length);
          const columns = [
            { label: 'State', width: stateWidth },
            { label: 'Asset', width: assetWidth },
            ...installFormatKeys.map((key) => ({ label: getSizeDisplayName(key), width: quantityWidth })),
          ];
          const tableFontSize = installFormatKeys.length > 8 ? 7 : 7.8;
          const rowHeight = 21;
          const truncateToWidth = (text: string, available: number, useFont: typeof font) => {
            if (useFont.widthOfTextAtSize(text, tableFontSize) <= available) return text;
            const ellipsis = '...';
            if (useFont.widthOfTextAtSize(ellipsis, tableFontSize) > available) return '';
            let end = text.length;
            while (end > 0) {
              const candidate = `${text.slice(0, end)}${ellipsis}`;
              if (useFont.widthOfTextAtSize(candidate, tableFontSize) <= available) return candidate;
              end -= 1;
            }
            return ellipsis;
          };
          const drawRow = (cells: string[], header = false, total = false) => {
            if (cursorY - rowHeight < marginBottom) {
              page = pdfDoc.addPage(pdfPageSize);
              cursorY = page.getHeight() - marginTop;
              if (!header) drawRow(columns.map((column) => column.label), true);
            }
            let x = marginX;
            columns.forEach((column, index) => {
              page.drawRectangle({
                x,
                y: cursorY - rowHeight,
                width: column.width,
                height: rowHeight,
                color: header ? brandBlue : total ? sectionBg : rgb(1, 1, 1),
                borderColor: sectionBorder,
                borderWidth: 0.7,
              });
              const text = cells[index] || '';
              const useFont = header || total ? bold : font;
              const color = header ? rgb(1, 1, 1) : rgb(0.08, 0.12, 0.18);
              const available = column.width - 8;
              const display = truncateToWidth(text, available, useFont);
              const textWidth = useFont.widthOfTextAtSize(display, tableFontSize);
              page.drawText(display, {
                x: index >= 2 ? x + Math.max(4, (column.width - textWidth) / 2) : x + 4,
                y: cursorY - 14,
                size: tableFontSize,
                font: useFont,
                color,
              });
              x += column.width;
            });
            cursorY -= rowHeight;
          };
          drawSectionHeader(`Install Schedule - ${installDateForWeek(week)}`, 0);
          cursorY += 10;
          drawRow(columns.map((column) => column.label), true);
          const orderedRows = [...visibleRows].sort((left, right) => left.rowOrder - right.rowOrder);
          let lastState = '';
          orderedRows.forEach((row) => {
            const showState = row.state !== lastState;
            drawRow([
              showState ? row.state : '',
              row.asset,
              ...installFormatKeys.map((key) => String(row.breakdown[key] ?? 0)),
            ]);
            lastState = row.state;
          });
          const states = orderedRows.reduce<string[]>((list, row) => {
            if (!list.includes(row.state)) list.push(row.state);
            return list;
          }, []);
          states.forEach((state) => {
            const stateRows = orderedRows.filter((row) => row.state === state);
            const totals = Object.fromEntries(installFormatKeys.map((key) => [
              key,
              stateRows.reduce((sum, row) => sum + (row.breakdown[key] ?? 0), 0),
            ]));
            drawRow([state, 'Posters', ...installFormatKeys.map((key) => String(totals[key] ?? 0))], false, true);
            drawRow(['', 'Frames', ...installFormatKeys.map((key) => String(installFrameCount(key, totals[key] ?? 0)))], false, true);
          });
          cursorY -= 20;
        };

        drawTitleBlock(
          purpose === 'installs' ? `${values.campaignName.trim() || 'Campaign'} - Installation Sheet` : values.campaignName.trim() || 'Artwork',
          purpose === 'installs'
            ? `Weekly installation schedule${campaignNumber ? ` - ${campaignNumber}` : ''}`
            : `Creative Mix: ${creativeHeadline}`,
        );
        logInstallGeneration('title block drawn');
        if (purpose === 'installs') {
          drawSectionHeader('Job Details');
          drawWrappedSegments([
            { text: 'Job / Campaign Number: ', isBold: true },
            { text: campaignNumber || '-' },
          ], 16);
          if (values.jobDescription.trim()) {
            drawWrappedSegments([
              { text: 'Description: ', isBold: true },
              { text: values.jobDescription.trim() },
            ], 16);
          }
          if (values.notes.trim()) {
            drawWrappedSegments([
              { text: 'Installation Notes: ', isBold: true },
              { text: values.notes.trim() },
            ], 16);
          }
          logInstallGeneration('job details drawn');
          cursorY -= 4;
          const hasInstallSchedule = installWeekRows.some(hasInstallQuantity);
          logInstallGeneration('install schedule drawing started', {
            hasInstallSchedule,
            installWeekCount: allInstallWeeks.length,
            installWeekRowCount: installWeekRows.length,
          });
          if (hasInstallSchedule) {
            allInstallWeeks.forEach((week) => {
              const rows = installWeekRows.filter((row) => row.week === week);
              drawInstallWeekTable(week, rows);
            });
          } else {
            drawWrappedLine('No scheduled installs are available for this campaign.', false, undefined, 16);
          }
          logInstallGeneration('install schedule drawn', { pageCount: pdfDoc.getPageCount() });
        } else {
        if (artworkFolderUrl) {
          drawSectionHeader('Resources');
          drawWrappedLine('Artwork Folder', false, artworkFolderUrl, 16);
          cursorY -= 4;
        }
        drawSectionHeader('Print Quantities');
        drawPrintQuantitiesTable();
        cursorY -= 18;
        drawSectionHeader('Creative Files & Thumbnails');
        for (const [creativeNumber, creativeRows] of Array.from(rowsByCreative.entries()).sort((a, b) => a[0] - b[0])) {
          const creativeTypeLabel = resolveCreativeTypeLabel(creativeTypeByNumber.get(creativeNumber) ?? 'Artwork');
          drawWrappedLine(`Creative ${creativeNumber} (${creativeTypeLabel}):`, true, undefined, 16);
          const seenCreativeFileNames = new Set<string>();
          for (const row of creativeRows) {
            const normalizedFileName = `${row.fileName}.pdf`;
            if (seenCreativeFileNames.has(normalizedFileName)) continue;
            seenCreativeFileNames.add(normalizedFileName);
            const link = buildCreativePdfLink(row.creativeImageId, row.fileName || 'Artwork');
            drawWrappedLine(normalizedFileName, false, link || undefined, 32);
          }
          const firstImageId = creativeRows[0]?.creativeImageId || '';
          const preview = creativePreviewById.get(firstImageId);
          if (preview) {
            try {
              const embedded = preview.extension === 'png'
                ? await pdfDoc.embedPng(preview.bytes)
                : await pdfDoc.embedJpg(preview.bytes);
              const maxThumbWidth = 230;
              const scale = Math.min(1, maxThumbWidth / embedded.width);
              const width = Math.max(1, Math.round(embedded.width * scale));
              const height = Math.max(1, Math.round(embedded.height * scale));
              ensureSpace(height + 16);
              page.drawImage(embedded, {
                x: marginX + 28,
                y: cursorY - height + 6,
                width,
                height,
              });
              cursorY -= (height + 14);
            } catch {
              // Ignore thumbnail render failures.
            }
          }
          drawWrappedLine('');
        }
        drawSectionHeader('Delivery Instructions');
        Array.from(deliveryByDestination.entries()).sort((a, b) => a[0].localeCompare(b[0])).forEach(([destination, destinationEntry]) => {
          const destinationName = (destinationEntry.name || '').trim() || 'DELIVERY';
          const fullDestination = (destination || '').trim();
          const fullLower = fullDestination.toLowerCase();
          const nameLower = destinationName.toLowerCase();
          const hasNamePrefix = Boolean(nameLower) && fullLower.startsWith(nameLower);
          const destinationRemainder = hasNamePrefix
            ? fullDestination.slice(destinationName.length).replace(/^[,\s-]+/, '')
            : fullDestination;
          drawWrappedSegments([
            { text: '• Deliver to ' },
            { text: destinationName, isBold: true },
            { text: destinationRemainder ? `, ${destinationRemainder} by ` : ' by ' },
            { text: deadlineText, isBold: true },
            { text: ' by COB:' },
          ],
            16,
            rgb(0.09, 0.2, 0.35),
          );
          cursorY -= 2;
          Array.from(destinationEntry.creativeMap.entries()).sort((a, b) => a[0] - b[0]).forEach(([creativeNumber, quantityMap]) => {
            const creativeTypeLabel = resolveCreativeTypeLabel(creativeTypeByNumber.get(creativeNumber) ?? 'Artwork');
            const parts = Array.from(quantityMap.entries()).map(([quantityLabel, quantity]) => `${quantity} x ${quantityLabel}`);
            drawWrappedLine(`• Creative ${creativeNumber} (${creativeTypeLabel}): ${parts.join(' & ')}`, false, undefined, 32);
          });
          cursorY -= 6;
        });
        }

        const generatedAt = new Date().toLocaleString('en-AU', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        const allPages = pdfDoc.getPages();
        const totalPages = allPages.length;
        logInstallGeneration('footer drawing started', { pageCount: totalPages });
        allPages.forEach((pdfPage, index) => {
          const footerY = 20;
          const pageWidth = pdfPage.getWidth();
          pdfPage.drawLine({
            start: { x: marginX, y: footerY + 10 },
            end: { x: pageWidth - marginX, y: footerY + 10 },
            thickness: 0.8,
            color: sectionBorder,
          });
          pdfPage.drawText(`Generated: ${generatedAt}`, {
            x: marginX,
            y: footerY,
            size: 8.5,
            font,
            color: rgb(0.38, 0.45, 0.58),
          });
          const pageLabel = `Page ${index + 1} of ${totalPages}`;
          const labelWidth = font.widthOfTextAtSize(pageLabel, 8.5);
          pdfPage.drawText(pageLabel, {
            x: pageWidth - marginX - labelWidth,
            y: footerY,
            size: 8.5,
            font,
            color: brandBlue,
          });
        });
        logInstallGeneration('footer drawn', { pageCount: totalPages });

        logInstallGeneration('pdf save started', { pageCount: totalPages });
        const pdfBytes = await pdfDoc.save();
        logInstallGeneration('pdf save completed', { byteLength: pdfBytes.byteLength });
        const pdfArrayBuffer = new ArrayBuffer(pdfBytes.byteLength);
        new Uint8Array(pdfArrayBuffer).set(pdfBytes);
        const blob = new Blob([pdfArrayBuffer], { type: 'application/pdf' });
        const fileName = `${baseName} - ${purpose === 'installs' ? 'Installation Sheet' : 'Visuals'}.pdf`;
        if (downloadFiles) {
          downloadBlobWithFileName(blob, fileName);
        }
        logInstallGeneration('blob prepared', { fileName, size: blob.size });
        return {
          fileName,
          blob,
          mimeType: 'application/pdf',
        };
      };

      const fillPrintWorkbook = async () => {
        setExportProgressMessage('Generating Print Quantities file...');
        const response = await fetch('/templates/26-233_PrintQuantities.xlsx');
        if (!response.ok) throw new Error('Unable to load print quantities template');
        const arrayBuffer = await response.arrayBuffer();
        const workbook = new ExcelJSRuntime.Workbook();
        await workbook.xlsx.load(arrayBuffer as ArrayBuffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) throw new Error('Print quantities sheet is missing');
        sheet.getColumn(2).width = 33.83203125;
        // Keep the purchase-order instruction header block aligned with template sizing.
        const purchaseOrderHeaderHeights: Array<[number, number]> = [
          [2, 34],
          [3, 27],
          [4, 27],
          [5, 27],
          [6, 27],
          [7, 157],
          [8, 27],
        ];
        purchaseOrderHeaderHeights.forEach(([row, height]) => {
          sheet.getRow(row).height = height;
        });
        sheet.views = [
          {
            state: 'frozen',
            ySplit: 10,
            topLeftCell: 'A11',
            activeCell: 'A1',
          },
        ];

        sheet.getCell('C3').value = values.campaignName || '';
        sheet.getCell('C4').value = campaignNumber;
        if (weekCommencing) sheet.getCell('C5').value = weekCommencing;
        sheet.getCell('C7').value = creativeSummaryText;
        const masterArtworkFolderCell = sheet.getCell('B8');
        const masterArtworkFolderLabel = (masterArtworkFolderCell.text || '').trim() || 'MASTER ARTWORK FOLDER';
        const artworkFolderUrl = buildArtworkFolderUrl(campaignId, effectiveTenantId);
        // Keep template styling while wiring the campaign artwork-folder link when campaign id is available.
        masterArtworkFolderCell.value = artworkFolderUrl
          ? { text: masterArtworkFolderLabel, hyperlink: artworkFolderUrl }
          : masterArtworkFolderLabel;
        const worksheetModel = sheet.model as { hyperlinks?: Array<{ ref?: string }> };
        if (Array.isArray(worksheetModel.hyperlinks)) {
          worksheetModel.hyperlinks = worksheetModel.hyperlinks.filter((entry) => {
            const ref = (entry.ref || '').toUpperCase();
            return ref !== 'B8' && ref !== 'B8:I8';
          });
        }
        if (artworkFolderUrl) {
          const hyperlinks = Array.isArray(worksheetModel.hyperlinks) ? worksheetModel.hyperlinks : [];
          hyperlinks.push({ ref: 'B8', target: artworkFolderUrl } as { ref?: string; target?: string });
          worksheetModel.hyperlinks = hyperlinks;
        }

        const rows = Array.from(printRows.values()).sort((a, b) => a.creativeCode.localeCompare(b.creativeCode));
        const customFormatKeys = Array.from(new Set(
          rows.flatMap((row) => Object.keys(row.formatQuantities).filter((key) => !isKnownFormatKey(key))),
        )).sort((left, right) => left.localeCompare(right));
        if (customFormatKeys.length > 0) {
          sheet.spliceColumns(22, 0, ...customFormatKeys.map(() => []));
        }
        const customColumnByFormat = new Map(customFormatKeys.map((key, index) => [key, 22 + index]));
        const lastQuantityColumn = 21 + customFormatKeys.length;
        customColumnByFormat.forEach((column, key) => {
          const headerCell = sheet.getCell(10, column);
          headerCell.value = getSizeDisplayName(key);
          headerCell.style = { ...sheet.getCell(10, 21).style };
          headerCell.alignment = { ...(headerCell.alignment ?? {}), wrapText: true, horizontal: 'center', vertical: 'middle' };
          sheet.getColumn(column).width = Math.max(12, Math.min(24, getSizeDisplayName(key).length + 3));
        });
        const usedQuantityColumns = new Set<number>();
        const columnTotals = new Map<number, number>();
        for (let col = 9; col <= lastQuantityColumn; col += 1) {
          columnTotals.set(col, 0);
        }
        const stateMarkerColumnByState = detectStateMarkerColumns(sheet, 10, 1, 30);
        const stateMarkerColumns = Array.from(new Set([...stateMarkerColumnByState.values()]));
        const baseDataRows = 3;
        const startRow = 11;
        const templateTotalsRow = 15;
        const rowDelta = rows.length - baseDataRows;
        if (rowDelta > 0) {
          sheet.spliceRows(templateTotalsRow, 0, ...Array.from({ length: rowDelta }, () => []));
        }

        const dataEndRow = Math.max(startRow + rows.length - 1, startRow + baseDataRows - 1);
        for (let row = startRow; row <= dataEndRow; row += 1) {
          sheet.getRow(row).height = 141;
          // Keep template stable: hide unused template data rows instead of deleting them.
          sheet.getRow(row).hidden = row >= startRow + rows.length && row < startRow + baseDataRows;
          sheet.getCell(row, 2).value = null;
          sheet.getCell(row, 3).value = null;
          sheet.getCell(row, 4).value = null;
          sheet.getCell(row, 5).value = null;
          sheet.getCell(row, 6).value = null;
          sheet.getCell(row, 7).value = null;
          for (let col = 9; col <= lastQuantityColumn; col += 1) {
            const cell = sheet.getCell(row, col);
            cell.value = null;
            if (col > 21) cell.style = { ...sheet.getCell(row, 21).style };
          }
        }

        rows.forEach((entry, index) => {
          const row = startRow + index;
          sheet.getCell(row, 2).value = entry.creativeCode;
          sheet.getCell(row, 4).value = entry.fileName;
          (stateMarkerColumns.length > 0 ? stateMarkerColumns : [5, 6, 7]).forEach((col) => {
            sheet.getCell(row, col).value = null;
          });
          const stateMarkerColumn = stateMarkerColumnByState.get(entry.state);
          if (stateMarkerColumn) {
            const stateMarkerCell = sheet.getCell(row, stateMarkerColumn);
            stateMarkerCell.value = '\u2605';
            stateMarkerCell.font = {
              ...(stateMarkerCell.font ?? {}),
              name: 'Segoe UI Symbol',
              size: 14,
              color: { argb: 'FFC9A227' },
            };
            stateMarkerCell.alignment = {
              ...(stateMarkerCell.alignment ?? {}),
              horizontal: 'center',
              vertical: 'middle',
            };
          }
          const dataUrl = creativeImageDataUrlById.get(entry.creativeImageId);
          if (dataUrl) {
            try {
              const imageRecord = imageRecordById.get(entry.creativeImageId);
              const extension = detectImageExtension(imageRecord?.mimeType ?? '', imageRecord?.fileName ?? '');
              const imageId = workbook.addImage({ base64: dataUrl, extension });
              sheet.addImage(imageId, {
                tl: { col: 2.1, row: row - 1 + 0.05 },
                ext: { width: 140, height: 130 },
              });
            } catch (imageError) {
              console.error('Unable to embed creative image in print sheet', imageError);
            }
          }
          Object.entries(entry.quantities).forEach(([column, quantity]) => {
            const numericColumn = Number(column);
            sheet.getCell(row, numericColumn).value = quantity;
            if (quantity > 0) {
              usedQuantityColumns.add(numericColumn);
            }
            columnTotals.set(numericColumn, (columnTotals.get(numericColumn) ?? 0) + quantity);
          });
          Object.entries(entry.formatQuantities).forEach(([formatKey, quantity]) => {
            const customColumn = customColumnByFormat.get(formatKey);
            if (!customColumn) return;
            sheet.getCell(row, customColumn).value = quantity;
            if (quantity > 0) usedQuantityColumns.add(customColumn);
            columnTotals.set(customColumn, (columnTotals.get(customColumn) ?? 0) + quantity);
          });
        });

        // Show only quantity columns that actually contain values in this export.
        for (let col = 9; col <= lastQuantityColumn; col += 1) {
          sheet.getColumn(col).hidden = !usedQuantityColumns.has(col);
        }

        const renderedDataRows = Math.max(rows.length, baseDataRows);
        const totalRow = startRow + renderedDataRows + 1;
        const setsRow = totalRow + 1;
        const lastDataRow = Math.max(startRow, startRow + rows.length - 1);
        const setsDivisorByColumn = new Map<number, number>([
          // NSW/VIC/WA/SA/TAS/ACT/NT poster columns.
          [9, 4],  // 8-sheet
          [10, 3], // 6-sheet
          [11, 2], // 4-sheet
          [12, 1], // 2-sheet
          [13, 4], // QA0
          // QLD poster columns.
          [14, 4], // 8-sheet
          [15, 3], // 6-sheet
          [16, 2], // 4-sheet
          [17, 1], // 2-sheet
          // Mega formats are already in sets.
          [18, 1], // Mega
          [19, 1], // DOT M
          [20, 1], // MP
          [21, 1], // FF
        ]);
        for (let col = 9; col <= lastQuantityColumn; col += 1) {
          const columnLetter = sheet.getColumn(col).letter;
          const totalValue = columnTotals.get(col) ?? 0;
          const setDivisor = setsDivisorByColumn.get(col) ?? 1;
          if (col > 21) {
            sheet.getCell(totalRow, col).style = { ...sheet.getCell(totalRow, 21).style };
            sheet.getCell(setsRow, col).style = { ...sheet.getCell(setsRow, 21).style };
          }
          sheet.getCell(totalRow, col).value = {
            formula: `SUM(${columnLetter}${startRow}:${columnLetter}${lastDataRow})`,
            result: totalValue,
          };
          sheet.getCell(setsRow, col).value = {
            formula: `${columnLetter}${totalRow}/${setDivisor}`,
            result: totalValue / setDivisor,
          };
        }

        stripSharedFormulaClones(workbook);
        const outputBuffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([outputBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const fileName = `${baseName} - Print Quantities.xlsx`;
        if (downloadFiles) {
          downloadBlobWithFileName(blob, fileName);
        }
        return {
          fileName,
          blob,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
      };

      const fillDeliveryWorkbook = async () => {
        setExportProgressMessage('Generating Delivery Instructions file...');
        const response = await fetch('/templates/26-233_Delivery_Instructions.xlsx');
        if (!response.ok) throw new Error('Unable to load delivery instructions template');
        const arrayBuffer = await response.arrayBuffer();
        const workbook = new ExcelJSRuntime.Workbook();
        await workbook.xlsx.load(arrayBuffer as ArrayBuffer);
        const sheet = workbook.worksheets[0];
        if (!sheet) throw new Error('Delivery instructions sheet is missing');
        sheet.getColumn(2).width = 33.83203125;
        // Match Delivery Instructions template header sizing for the purchase-order section.
        const purchaseOrderHeaderHeights: Array<[number, number]> = [
          [2, 34],
          [3, 27],
          [4, 27],
          [5, 27],
          [6, 27],
          [7, 27],
          [8, 126],
        ];
        purchaseOrderHeaderHeights.forEach(([row, height]) => {
          sheet.getRow(row).height = height;
        });
        sheet.views = [
          {
            state: 'frozen',
            ySplit: 10,
            topLeftCell: 'A11',
            activeCell: 'A1',
          },
        ];

        const stateMarkerColumnByState = detectStateMarkerColumns(sheet, 10, 1, 30);
        const stateMarkerColumns = Array.from(new Set([...stateMarkerColumnByState.values()]));

        sheet.getCell('C3').value = values.campaignName || '';
        sheet.getCell('C4').value = campaignNumber;
        sheet.getCell('C5').value = `${weekCount} WEEK${weekCount === 1 ? '' : 'S'}`;
        if (weekCommencing) sheet.getCell('C6').value = weekCommencing;
        sheet.getCell('C8').value = creativeSummaryText;

        const rows = Array.from(deliveryRows.values()).sort((a, b) => a.creativeCode.localeCompare(b.creativeCode) || a.typeLabel.localeCompare(b.typeLabel));
        const baseDataRows = 5;
        const startRow = 11;
        const templateInfoHeaderRow = 17;
        const rowDelta = rows.length - baseDataRows;
        if (rowDelta > 0) {
          sheet.spliceRows(templateInfoHeaderRow, 0, ...Array.from({ length: rowDelta }, () => []));
        }

        const dataEndRow = Math.max(startRow + rows.length - 1, startRow + baseDataRows - 1);
        for (let row = startRow; row <= dataEndRow; row += 1) {
          sheet.getRow(row).height = 102;
          // Keep template stable: hide unused template data rows instead of deleting them.
          sheet.getRow(row).hidden = row >= startRow + rows.length && row < startRow + baseDataRows;
          sheet.getCell(row, 2).value = null;
          sheet.getCell(row, 3).value = null;
          sheet.getCell(row, 4).value = null;
          sheet.getCell(row, 5).value = null;
          sheet.getCell(row, 7).value = null;
          sheet.getCell(row, 8).value = null;
          sheet.getCell(row, 9).value = null;
          sheet.getCell(row, 11).value = null;
          sheet.getCell(row, 12).value = null;
          sheet.getCell(row, 13).value = null;
          sheet.getCell(row, 14).value = null;
        }

        rows.forEach((entry, index) => {
          const row = startRow + index;
          sheet.getCell(row, 2).value = entry.creativeCode;
          (stateMarkerColumns.length > 0 ? stateMarkerColumns : [3, 4, 5]).forEach((col) => {
            const markerCell = sheet.getCell(row, col);
            markerCell.value = null;
          });
          const stateMarkerColumn = stateMarkerColumnByState.get(entry.state);
          if (stateMarkerColumn) {
            const selectedMarkerCell = sheet.getCell(row, stateMarkerColumn);
            selectedMarkerCell.value = '\u2605';
            selectedMarkerCell.font = {
              ...(selectedMarkerCell.font ?? {}),
              name: 'Segoe UI Symbol',
              size: 14,
              color: { argb: 'FFC9A227' },
            };
            selectedMarkerCell.alignment = {
              ...(selectedMarkerCell.alignment ?? {}),
              horizontal: 'center',
              vertical: 'middle',
            };
          }
          const creativeImageId = creativeImageByCreativeFileKey.get(`${entry.creativeCode}\x00${entry.fileName}`);
          if (creativeImageId) {
            const dataUrl = creativeImageDataUrlById.get(creativeImageId);
            if (dataUrl) {
              try {
                const imageRecord = imageRecordById.get(creativeImageId);
                const extension = detectImageExtension(imageRecord?.mimeType ?? '', imageRecord?.fileName ?? '');
                const imageId = workbook.addImage({ base64: dataUrl, extension });
                sheet.addImage(imageId, {
                  tl: { col: 6.1, row: row - 1 + 0.05 },
                  ext: { width: 120, height: 92 },
                });
              } catch (imageError) {
                console.error('Unable to embed creative image in delivery sheet', imageError);
              }
            }
          }
          sheet.getCell(row, 8).value = entry.fileName;
          sheet.getCell(row, 9).value = entry.typeLabel;
          sheet.getCell(row, 11).value = entry.quantity;
          sheet.getCell(row, 12).value = entry.rolled;
          sheet.getCell(row, 13).value = entry.deliveredTo;
        });

        const infoHeaderRow = templateInfoHeaderRow + Math.max(0, rowDelta);
        const infoStartRow = infoHeaderRow + 1;
        const infoTemplateRow = 18;
        const infoTemplateRowHeight = sheet.getRow(infoTemplateRow).height ?? 134;
        const baseInfoRows = 3;
        const requiredInfoRows = Math.max(baseInfoRows, deliveryInfoBlocks.length);
        if (requiredInfoRows > baseInfoRows) {
          sheet.spliceRows(infoStartRow + baseInfoRows, 0, ...Array.from({ length: requiredInfoRows - baseInfoRows }, () => []));
        }
        sheet.getCell(infoHeaderRow, 2).value = 'DELIVERY INFORMATION:';
        for (let offset = 0; offset < requiredInfoRows; offset += 1) {
          const row = infoStartRow + offset;
          sheet.getRow(row).hidden = false;
          sheet.getRow(row).height = infoTemplateRowHeight;
          const mergeRef = `B${row}:P${row}`;
          try {
            sheet.mergeCells(mergeRef);
          } catch {
            // Ignore when already merged in template rows.
          }
          for (let col = 2; col <= 16; col += 1) {
            sheet.getCell(row, col).value = null;
          }
        }
        deliveryInfoBlocks.forEach((block, index) => {
          const row = infoStartRow + index;
          const cell = sheet.getCell(row, 2);
          cell.value = block;
          cell.alignment = {
            ...(cell.alignment ?? {}),
            wrapText: true,
            vertical: 'top',
          };
        });

        stripSharedFormulaClones(workbook);
        const outputBuffer = await workbook.xlsx.writeBuffer();
        const blob = new Blob([outputBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const fileName = `${baseName} - Delivery Instructions.xlsx`;
        if (downloadFiles) {
          downloadBlobWithFileName(blob, fileName);
        }
        return {
          fileName,
          blob,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
      };

      if (!shouldGenerateExcel) {
        const wordFile = await fillWordDocument();
        return [wordFile];
      }

      const printWorkbookFile = await fillPrintWorkbook();
      const deliveryWorkbookFile = await fillDeliveryWorkbook();
      return [printWorkbookFile, deliveryWorkbookFile];
    } catch (exportError) {
      throw exportError instanceof Error ? exportError : new Error('Unable to generate export files. Please try again.');
    }
  }

  async function downloadArtworkVisuals() {
    if (exportingTemplates || sendingAdsEmail) return false;
    if (!hasDeliveryDueDate) {
      setReviewValidationError('Add a due date before downloading visuals.', { dueDate: true });
      return false;
    }
    if (!hasMappedCreatives) {
      setReviewValidationError('Map at least one creative to a market asset before downloading visuals');
      return false;
    }

    setError('');
    setReviewActionError('');
    setReviewActionNeedsDueDate(false);
    setVisualsDownloadError('');
    setExportingTemplates(true);
    setExportProgressMessage('Preparing export...');

    try {
      const exportSummary = await ensureExportSummary();
      if (exportSummary === false) return false;
      await generateArtworkTemplates(true, VISUALS_EXPORT_MODE, 'visuals', '', exportSummary);
      setExportProgressMessage('Download started. Check your browser download bar.');
      setError('');
      setReviewActionError('');
      setReviewActionNeedsDueDate(false);
      return true;
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Unable to download visual export. Please try again.';
      setReviewValidationError(message);
      setVisualsDownloadError(message);
      setExportProgressMessage('');
      return false;
    } finally {
      setExportingTemplates(false);
    }
  }

  async function ensureExportSummary(): Promise<CampaignCalculationSummary | null | false> {
    if (summary?.lines?.length) return summary;
    if (values.campaignMarkets.length === 0) return null;

    try {
      setCalculating(true);
      const result = await calculateCampaign(campaignLinesFromMarkets(values.campaignMarkets), effectiveTenantId);
      setSummary(result);
      setValues((current) => ({ ...current, quantity: String(result.grandTotal.totalUnits) }));
      return result;
    } catch (calculationError) {
      const message = calculationError instanceof Error ? calculationError.message : 'Unable to calculate campaign';
      setReviewValidationError(message);
      return false;
    } finally {
      setCalculating(false);
    }
  }

  async function downloadInstallationSheet() {
    if (exportingTemplates || sendingAdsEmail) return false;
    const installDownloadRequestId = `installs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const installDownloadStartedAt = performance.now();
    if (!hasDeliveryDueDate) {
      console.warn('[FlowIQ Installs Download]', installDownloadRequestId, 'blocked: missing due date', { campaignId, tenantId: effectiveTenantId });
      setReviewValidationError('Add a due date before downloading the installation sheet.', { dueDate: true });
      return false;
    }
    if (!hasMappedCreatives) {
      console.warn('[FlowIQ Installs Download]', installDownloadRequestId, 'blocked: no mapped creatives', { campaignId, tenantId: effectiveTenantId });
      setReviewValidationError('Map at least one creative to a market asset before downloading the installation sheet');
      return false;
    }

    setError('');
    setReviewActionError('');
    setReviewActionNeedsDueDate(false);
    setInstallDownloadError('');
    setExportingTemplates(true);
    setExportProgressMessage('Preparing Installs files...');

    try {
      console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'started', {
        campaignId,
        tenantId: effectiveTenantId,
        campaignName: values.campaignName,
        printImageCount: values.printImages.length,
        supportingDocumentCount: values.supportingDocuments?.length ?? 0,
        marketCount: values.campaignMarkets.length,
      });
      const pdfGenerationStartedAt = performance.now();
      const exportSummary = await ensureExportSummary();
      if (exportSummary === false) return false;
      const generatedFiles = await generateArtworkTemplates(false, 'pdf', 'installs', installDownloadRequestId, exportSummary);
      console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'installation PDF generated', {
        elapsedMs: Math.round(performance.now() - pdfGenerationStartedAt),
        fileCount: generatedFiles.length,
        files: generatedFiles.map((file) => ({ fileName: file.fileName, size: file.blob.size, type: file.mimeType })),
      });
      const installationSheet = generatedFiles[0];
      if (!installationSheet) throw new Error('Installation sheet generation did not produce a PDF');

      downloadBlobWithFileName(installationSheet.blob, installationSheet.fileName);
      console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'installation PDF download triggered', {
        fileName: installationSheet.fileName,
        size: installationSheet.blob.size,
      });
      const usedDocumentNames = new Set<string>([installationSheet.fileName.toLocaleLowerCase()]);
      const uniqueDocumentName = (originalName: string) => {
        const safeName = originalName
          .replace(/[\\/\u0000-\u001f\u007f]/g, '_')
          .replace(/^\.+/, '')
          .trim() || 'Supporting Document';
        const extensionIndex = safeName.lastIndexOf('.');
        const base = extensionIndex > 0 ? safeName.slice(0, extensionIndex) : safeName;
        const extension = extensionIndex > 0 ? safeName.slice(extensionIndex) : '';
        let candidate = safeName;
        let suffix = 2;
        while (usedDocumentNames.has(candidate.toLocaleLowerCase())) {
          candidate = `${base} (${suffix})${extension}`;
          suffix += 1;
        }
        usedDocumentNames.add(candidate.toLocaleLowerCase());
        return candidate;
      };

      const supportingDocuments = values.supportingDocuments ?? [];
      for (const [documentIndex, document] of supportingDocuments.entries()) {
        const documentStartedAt = performance.now();
        setExportProgressMessage(`Downloading supporting document: ${document.originalName}`);
        console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'supporting document fetch started', {
          index: documentIndex + 1,
          total: supportingDocuments.length,
          originalName: document.originalName,
          storedName: document.storedName,
          size: document.size,
          mimeType: document.mimeType,
        });
        const documentBlob = await downloadCampaignImage(document.storedName, document.originalName);
        const fileName = uniqueDocumentName(document.originalName);
        console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'supporting document fetched', {
          index: documentIndex + 1,
          originalName: document.originalName,
          storedName: document.storedName,
          downloadName: fileName,
          blobSize: documentBlob.size,
          elapsedMs: Math.round(performance.now() - documentStartedAt),
        });
        downloadBlobWithFileName(documentBlob, fileName);
      }

      setExportProgressMessage('Installs file downloads started. Check your browser download bar.');
      console.info('[FlowIQ Installs Download]', installDownloadRequestId, 'completed', {
        elapsedMs: Math.round(performance.now() - installDownloadStartedAt),
      });
      return true;
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : 'Unable to download the Installs files. Please try again.';
      console.error('[FlowIQ Installs Download]', installDownloadRequestId, 'failed', {
        elapsedMs: Math.round(performance.now() - installDownloadStartedAt),
        error: exportError,
        message,
      });
      setReviewValidationError(message);
      setInstallDownloadError(message);
      setExportProgressMessage('');
      return false;
    } finally {
      setExportingTemplates(false);
    }
  }

  useEffect(() => {
    if (!printIQVisualsRequestId) return;
    window.parent.postMessage({
      type: 'flowiq:printiq-visuals-progress',
      requestId: printIQVisualsRequestId,
      phase: exportProgressMessage || 'loading campaign data and export settings',
    }, window.location.origin);
  }, [printIQVisualsRequestId, exportProgressMessage]);

  useEffect(() => {
    if (!printIQVisualsRequestId || autoDownloadTriggeredRef.current) return;
    if (loadingMetadata || loadingCampaign || !campaignHydratedRef.current || !campaignId || !sheetNamesLoaded) return;
    autoDownloadTriggeredRef.current = true;
    void (async () => {
      const visualsRequestId = printIQVisualsRequestId;
      if (visualsRequestId) {
        try {
          const exportSummary = await ensureExportSummary();
          if (exportSummary === false) throw new Error('Unable to calculate the campaign for the Visuals PDF.');
          const files = await generateArtworkTemplates(false, 'pdf', 'visuals', '', exportSummary);
          const pdf = files.find((file) => file.mimeType === 'application/pdf');
          if (!pdf) throw new Error('The Visuals PDF could not be generated.');
          window.parent.postMessage({ type: 'flowiq:printiq-visuals-result', requestId: visualsRequestId, file: pdf.blob, fileName: pdf.fileName }, window.location.origin);
        } catch (error) {
          window.parent.postMessage({ type: 'flowiq:printiq-visuals-result', requestId: visualsRequestId, error: error instanceof Error ? error.message : 'Unable to generate the Visuals PDF.' }, window.location.origin);
        }
        return;
      }
    })();
  }, [printIQVisualsRequestId, loadingMetadata, loadingCampaign, campaignId, sheetNamesLoaded]);

  useEffect(() => {
    if (!autoDownloadVisuals || printIQVisualsRequestId || autoDownloadTriggeredRef.current) return;
    if (loadingMetadata || loadingCampaign) return;
    if (!campaignHydratedRef.current) return;
    if (!campaignId) return;
    autoDownloadTriggeredRef.current = true;

    void (async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const success = await downloadArtworkVisuals();
      reportQuoteAutomationResult('download-visuals', success ? 'success' : 'error');
      if (!success) return;
      if (!closeAfterVisualsDownload) return;
      window.setTimeout(() => {
        window.close();
      }, 1200);
    })();
  }, [autoDownloadVisuals, closeAfterVisualsDownload, loadingMetadata, loadingCampaign, campaignId]);

  useEffect(() => {
    if (!autoDownloadInstalls || autoDownloadTriggeredRef.current) return;
    if (loadingMetadata || loadingCampaign) return;
    if (!campaignHydratedRef.current) return;
    if (!campaignId) return;
    autoDownloadTriggeredRef.current = true;

    void (async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const success = await downloadInstallationSheet();
      reportQuoteAutomationResult('download-installs', success ? 'success' : 'error');
      if (!success) return;
      if (!closeAfterVisualsDownload) return;
      window.setTimeout(() => {
        window.close();
      }, 1200);
    })();
  }, [autoDownloadInstalls, closeAfterVisualsDownload, loadingMetadata, loadingCampaign, campaignId]);

  useEffect(() => {
    if (!autoSendEmailToAds || autoSendEmailTriggeredRef.current) return;
    if (loadingMetadata || loadingCampaign) return;
    if (!campaignHydratedRef.current) return;
    if (!campaignId) return;
    autoSendEmailTriggeredRef.current = true;
    void (async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 180));
      const success = await sendArtworkEmailToAds();
      reportQuoteAutomationResult('send-email-to-ads', success ? 'success' : 'error');
    })();
  }, [autoSendEmailToAds, loadingMetadata, loadingCampaign, campaignId]);

  async function sendArtworkEmailToAds() {
    if (sendingAdsEmail || exportingTemplates) return false;
    if (!hasDeliveryDueDate) {
      setReviewValidationError('Add a due date before sending email to ADS.', { dueDate: true });
      return false;
    }
    if (!hasUploadedPurchaseOrder) {
      setReviewValidationError('Upload a purchase order file before sending email to ADS');
      return false;
    }
    if (!hasPurchaseOrderNumber) {
      setPurchaseOrderNumberSubmitAttempted(true);
      setReviewValidationError('Enter a purchase order number before sending email to ADS');
      return false;
    }
    if (!hasMappedCreatives) {
      setReviewValidationError('Map at least one creative to a market asset before sending email to ADS');
      return false;
    }

    setError('');
    setReviewActionError('');
    setReviewActionNeedsDueDate(false);
    setSendingAdsEmail(true);
    setExportProgressMessage('Preparing export for email...');

    try {
      const generatedFiles = await generateArtworkTemplates(false, VISUALS_EXPORT_MODE);
      const files = generatedFiles.map(
        (generatedFile) =>
          new File([generatedFile.blob], generatedFile.fileName, {
            type: generatedFile.mimeType,
          }),
      );
      const usedCreativeImageIds = new Set(
        values.campaignMarkets.flatMap((market) =>
          market.assets.flatMap((asset) => {
            const mapped = Object.values(normalizeCreativeImageIds(asset))
              .filter((imageId) => Boolean(imageId.trim()));
            const multiMapped = Object.values(normalizeArtworkMaterialAssignments(asset)).flatMap((assignments) =>
              assignments.flatMap((assignment) =>
                Array.from({ length: assignment.frameCount }, () => assignment.artworkImageId).filter(Boolean),
              ),
            );
            const legacyMapped = (asset.creativeImageId || '').trim();
            return Array.from(new Set([...mapped, ...multiMapped, ...(legacyMapped ? [legacyMapped] : [])]));
          }),
        ),
      );
      const toCreativeFileGroupKey = (fileName: string) => {
        const normalizedFileName = (fileName || '').trim();
        const fromFile = normalizedFileName.replace(/\.[^.]+$/, '').replace(/-page-\d+$/i, '').trim();
        return (fromFile || 'artwork').toLowerCase();
      };
      const normalizePdfFileName = (image: CampaignPrintImage, fallbackBaseName = 'Artwork') => {
        const rawPdfFileName = (image.sourcePdfFileName || '').trim();
        if (rawPdfFileName) {
          return /\.pdf$/i.test(rawPdfFileName) ? rawPdfFileName : `${rawPdfFileName}.pdf`;
        }
        const rawName = (image.name || '').trim().replace(/\s*\(Page\s+\d+\)\s*$/i, '').trim();
        if (rawName) {
          return /\.pdf$/i.test(rawName) ? rawName : `${rawName}.pdf`;
        }
        const rawFileName = (image.fileName || '').trim();
        if (rawFileName) {
          const base = rawFileName.replace(/\.[^.]+$/, '').replace(/-page-\d+$/i, '').trim();
          if (base) return `${base}.pdf`;
        }
        const fallbackBase = fallbackBaseName.replace(/\.[^.]+$/, '').replace(/-page-\d+$/i, '').trim();
        return `${fallbackBase || 'Artwork'}.pdf`;
      };
      const getStoredNameFromUrl = (url: string) => {
        const resolved = toAbsoluteUrl(buildApiUrl(url || ''));
        if (!resolved) return '';
        try {
          const parsed = new URL(resolved, window.location.origin);
          const segments = parsed.pathname.split('/').filter(Boolean);
          const storedName = segments[segments.length - 1] || '';
          return decodeURIComponent(storedName);
        } catch {
          const segments = resolved.split('/').filter(Boolean);
          return decodeURIComponent(segments[segments.length - 1] || '');
        }
      };
      const buildPdfDownloadUrl = (storedName: string, fileName: string) => {
        const cleanedStoredName = storedName.trim();
        if (!cleanedStoredName) return '';
        const downloadUrl = new URL(toAbsoluteUrl(buildApiUrl(`/api/campaign-images/${encodeURIComponent(cleanedStoredName)}/download`)));
        downloadUrl.searchParams.set('filename', fileName);
        return downloadUrl.toString();
      };
      const sourcePdfByGroupKey = new Map<string, { fileName: string; url: string; storedName: string }>();
      values.printImages.forEach((image) => {
        const sourceStoredName = (image.sourcePdfStoredName || '').trim()
          || getStoredNameFromUrl(image.sourcePdfUrl || '');
        if (!sourceStoredName) return;
        const sourceName = normalizePdfFileName(image, image.fileName || image.name || 'Artwork');
        const sourceUrl = buildPdfDownloadUrl(sourceStoredName, sourceName);
        if (!sourceUrl) return;
        const key = toCreativeFileGroupKey(image.fileName || image.name || '');
        if (!sourcePdfByGroupKey.has(key)) {
          sourcePdfByGroupKey.set(key, { fileName: sourceName, url: sourceUrl, storedName: sourceStoredName });
        }
      });
      const creativeLinksByUrl = new Map<string, { name: string; url: string }>();
      values.printImages
        .filter((image) => usedCreativeImageIds.has(image.id))
        .forEach((image) => {
          const sourceStoredName = (image.sourcePdfStoredName || '').trim()
            || getStoredNameFromUrl(image.sourcePdfUrl || '');
          const sourceFileName = normalizePdfFileName(image, image.fileName || image.name || 'Artwork');
          const directSourceUrl = sourceStoredName ? buildPdfDownloadUrl(sourceStoredName, sourceFileName) : '';
          const key = toCreativeFileGroupKey(image.fileName || image.name || '');
          const groupedSource = sourcePdfByGroupKey.get(key);

          const linkUrl = directSourceUrl || groupedSource?.url || '';
          if (!linkUrl.trim()) {
            return;
          }
          const linkName = sourceStoredName ? sourceFileName : (groupedSource?.fileName || sourceFileName);
          if (!creativeLinksByUrl.has(linkUrl)) {
            creativeLinksByUrl.set(linkUrl, { name: linkName, url: linkUrl });
          }
        });
      const creativeLinks = Array.from(creativeLinksByUrl.values());
      setExportProgressMessage('Sending email to ADS...');
      await sendEmailToAds(files, values.campaignName, creativeLinks);
      if (campaignId) {
        try {
          const response = await markCampaignSubmitted(campaignId, effectiveTenantId);
          setCampaignStatus(response.campaign.status);
          setParentCampaignId(response.campaign.parentCampaignId || '');
        } catch {
          // Email already succeeded; do not fail success flow if status sync is delayed.
        }
      }
      setExportProgressMessage('Email sent to ADS.');
      setError('');
      setReviewActionError('');
      setReviewActionNeedsDueDate(false);
      if (!autoSendEmailToAds) {
        try {
          window.sessionStorage.setItem(LANDING_NOTICE_KEY, 'Email sent to ADS.');
        } catch {
          // Best effort only.
        }
        await releaseActiveCampaignLock(campaignId);
        onBack?.();
      }
      if (closeAfterEmailSend) {
        window.setTimeout(() => {
          window.close();
        }, 1200);
      }
      return true;
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : 'Unable to send email to ADS. Please try again.';
      setReviewValidationError(message);
      setExportProgressMessage('');
      return false;
    } finally {
      setSendingAdsEmail(false);
    }
  }

  function openPurchaseOrderPicker() {
    if (isSubmittedCampaign) return;
    purchaseOrderInputRef.current?.click();
  }

  function openArtworkPdfPicker() {
    if (isSubmittedCampaign) return;
    artworkPdfInputRef.current?.click();
  }

  return (
    <main className="dense-main flex min-h-0 w-full flex-col gap-4 pb-0">
      {topBarCenterHost
        ? createPortal(
            <p className="truncate text-[13px] font-semibold uppercase tracking-[0.14em] text-slate-200/90" title={activeCampaignName}>
              {activeCampaignName}
            </p>,
            topBarCenterHost,
          )
        : null}
      {topBarActionsHost && onBack
        ? createPortal(
            <Button disabled={savingCampaign} onClick={() => void handleBackToDashboard()} size="sm" variant="ghost">
              <ArrowLeft className="h-4 w-4" />
              Campaigns
            </Button>,
            topBarActionsHost,
          )
        : null}
      {(error || metadataError) ? (
        <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-4 py-3 text-sm font-medium text-rose-200">{error || metadataError}</div>
      ) : null}

      <div className={cn('grid gap-7 pb-0 transition-[padding-right] duration-200 ease-out', reviewDrawerOpen ? 'lg:pr-[488px]' : 'lg:pr-0')}>
        <section>
          <div className="grid gap-4 lg:grid-cols-1 lg:items-start">
            <div className="space-y-7">
              <div className={cn('campaign-builder-top-form-scale space-y-4', TOP_FORM_THEME)}>
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)_minmax(0,226px)_minmax(0,226px)_minmax(0,136px)]">
              <div className="flex h-11 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                <span className="inline-flex w-32 shrink-0 items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Campaign Name</span>
                <Input
                  className="h-11 rounded-none border-0 bg-slate-800/50 px-3"
                  id="campaign-name"
                  placeholder="Campaign name"
                  type="text"
                  value={values.campaignName}
                  disabled={isSubmittedCampaign}
                  onChange={(event) => updateField('campaignName', event.target.value)}
                />
              </div>
              <div className="flex h-11 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                <span className="inline-flex w-28 shrink-0 items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Client Name</span>
                <Input
                  className="h-11 rounded-none border-0 bg-slate-800/50 px-3"
                  id="client-name"
                  placeholder="Client"
                  type="text"
                  value={values.clientName}
                  disabled={isSubmittedCampaign}
                  onChange={(event) => updateField('clientName', event.target.value)}
                />
              </div>
              <div className="flex h-11 min-w-0 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                <span className="inline-flex items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Start Date</span>
                <div className="relative min-w-0 flex-1">
                  <Input
                    className="h-11 w-full rounded-none border-0 bg-transparent px-2 pr-9 text-[13px] [&::-webkit-calendar-picker-indicator]:opacity-0"
                    id="campaign-start"
                    inputMode="numeric"
                    placeholder="dd/mm/yyyy"
                    type="text"
                    value={campaignStartDateInput}
                    disabled={isSubmittedCampaign}
                    onBlur={() => {
                      if (!campaignStartDateInput.trim()) {
                        updateCampaignStartDate('');
                        setCampaignStartDateInput('');
                        return;
                      }
                      const parsed = parseDisplayDateToIso(campaignStartDateInput);
                      if (parsed) {
                        updateCampaignStartDate(parsed);
                        setCampaignStartDateInput(formatDateInputDisplay(parsed));
                        return;
                      }
                      setCampaignStartDateInput(formatDateInputDisplay(values.campaignStartDate));
                    }}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setCampaignStartDateInput(nextValue);
                      const parsed = parseDisplayDateToIso(nextValue);
                      if (parsed) updateCampaignStartDate(parsed);
                    }}
                  />
                  <input
                    ref={campaignStartPickerRef}
                    className="pointer-events-none absolute h-0 w-0 opacity-0"
                    min={minSelectableDate}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      updateCampaignStartDate(nextValue);
                      setCampaignStartDateInput(formatDateInputDisplay(nextValue));
                    }}
                    tabIndex={-1}
                    type="date"
                    value={values.campaignStartDate}
                    disabled={isSubmittedCampaign}
                  />
                  <button
                    aria-label="Open start date picker"
                    className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
                    onClick={() => openDatePicker(campaignStartPickerRef)}
                    disabled={isSubmittedCampaign}
                    type="button"
                  >
                    <CalendarDays className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex h-11 min-w-0 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                <span className="inline-flex items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Due Date</span>
                <div className="relative min-w-0 flex-1">
                  <Input
                    className="h-11 w-full rounded-none border-0 bg-transparent px-2 pr-9 text-[13px] [&::-webkit-calendar-picker-indicator]:opacity-0"
                    id="due-date"
                    inputMode="numeric"
                    placeholder="dd/mm/yyyy"
                    type="text"
                    value={dueDateInput}
                    disabled={isSubmittedCampaign}
                    onBlur={() => {
                      if (!dueDateInput.trim()) {
                        updateField('dueDate', '');
                        setDueDateInput('');
                        return;
                      }
                      const parsed = parseDisplayDateToIso(dueDateInput);
                      if (parsed) {
                        updateField('dueDate', parsed);
                        setDueDateInput(formatDateInputDisplay(parsed));
                        return;
                      }
                      setDueDateInput(formatDateInputDisplay(values.dueDate));
                    }}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      setDueDateInput(nextValue);
                      const parsed = parseDisplayDateToIso(nextValue);
                      if (parsed) updateField('dueDate', parsed);
                    }}
                  />
                  <input
                    ref={dueDatePickerRef}
                    className="pointer-events-none absolute h-0 w-0 opacity-0"
                    min={minSelectableDate}
                    onChange={(event) => {
                      const nextValue = event.target.value;
                      updateField('dueDate', nextValue);
                      setDueDateInput(formatDateInputDisplay(nextValue));
                    }}
                    tabIndex={-1}
                    type="date"
                    value={values.dueDate}
                    disabled={isSubmittedCampaign}
                  />
                  <button
                    aria-label="Open due date picker"
                    className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-slate-400 transition hover:bg-slate-800 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-violet-300/70"
                    onClick={() => openDatePicker(dueDatePickerRef)}
                    disabled={isSubmittedCampaign}
                    type="button"
                  >
                    <CalendarDays className="h-4 w-4" />
                  </button>
                </div>
              </div>
              <div className="flex h-11 w-[136px] overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                <span className="inline-flex items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Weeks</span>
                <Input
                  className="h-11 w-10 flex-none rounded-none border-0 bg-transparent px-0 text-center [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                  id="week-count"
                  inputMode="numeric"
                  max={MAX_CAMPAIGN_WEEKS}
                  min={1}
                  onChange={(event) => {
                    const rawValue = event.target.value.trim();
                    const parsedValue = Number(rawValue);
                    updateWeekCount(Number.isFinite(parsedValue) ? parsedValue : 1);
                  }}
                  type="number"
                  value={numberOfWeeks}
                  disabled={isSubmittedCampaign}
                />
                <div className="flex h-11 w-8 flex-col border-l border-white/10">
                  <Button
                    className="h-[22px] w-8 rounded-none border-b border-white/10 px-0"
                    onClick={() => updateWeekCount(numberOfWeeks + 1)}
                    disabled={isSubmittedCampaign}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronUp className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    className="h-[22px] w-8 rounded-none px-0"
                    disabled={isSubmittedCampaign || numberOfWeeks <= 1}
                    onClick={() => updateWeekCount(numberOfWeeks - 1)}
                    type="button"
                    variant="ghost"
                  >
                    <ChevronDown className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
                </div>
                <div className="grid gap-4 lg:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,320px)_minmax(0,190px)_minmax(0,190px)_minmax(0,190px)_minmax(0,190px)_minmax(0,136px)] xl:items-center">
                  <div className="flex h-11 w-full overflow-hidden rounded-lg border border-white/10 bg-slate-900/90">
                    <span className="inline-flex w-32 shrink-0 items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Purchase Order</span>
                    <button
                      className={cn(
                        'h-11 min-w-0 flex-1 truncate border-0 bg-transparent px-3 text-left text-sm font-medium transition hover:bg-slate-700/30',
                        uploadedPurchaseOrderName ? 'text-slate-200' : uploadingPurchaseOrder ? 'text-slate-300' : 'text-slate-400',
                      )}
                      disabled={isSubmittedCampaign || uploadingPurchaseOrder}
                      onClick={openPurchaseOrderPicker}
                      type="button"
                    >
                      {uploadingPurchaseOrder
                        ? 'Uploading...'
                        : uploadedPurchaseOrderName
                          ? `Uploaded: ${uploadedPurchaseOrderName}`
                          : 'Choose File'}
                    </button>
                    <input
                      ref={purchaseOrderInputRef}
                      accept="application/pdf,.pdf"
                      className="hidden"
                      onChange={(event) => {
                        const nextFile = event.target.files?.[0] ?? null;
                        if (nextFile && !isPdfFile(nextFile)) {
                          setError('Only PDF files are allowed');
                          return;
                        }
                        setSelectedPurchaseOrderFile(nextFile);
                        if (nextFile) {
                          void handleUploadPurchaseOrder(nextFile);
                        }
                      }}
                      type="file"
                    />
                  </div>
                  <div
                    className={cn(
                      'flex h-11 w-full overflow-hidden rounded-lg border bg-slate-900/90 focus-within:ring-1',
                      showPurchaseOrderNumberRequired
                        ? 'border-amber-300/70 focus-within:border-amber-300 focus-within:ring-amber-300/35'
                        : 'border-white/10 focus-within:border-violet-300/60 focus-within:ring-violet-300/40',
                    )}
                  >
                    <span className="inline-flex w-32 shrink-0 items-center whitespace-nowrap border-r border-white/10 px-3 text-xs font-semibold tracking-wide text-slate-300">Purchase Order No</span>
                    <Input
                      aria-label="Purchase order no"
                      className="h-11 min-w-0 flex-1 rounded-none border-0 bg-slate-800/60 px-3 text-sm font-semibold text-slate-100 placeholder:text-slate-400 focus-visible:ring-0"
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        updateField('purchaseOrderNumber', nextValue);
                        if (nextValue.trim()) {
                          setPurchaseOrderNumberSubmitAttempted(false);
                        }
                      }}
                      placeholder={showPurchaseOrderNumberRequired ? 'Required' : 'PO Number'}
                      type="text"
                      value={values.purchaseOrderNumber}
                      disabled={isSubmittedCampaign}
                    />
                  </div>
                  <Button
                    className="h-10 min-w-0 rounded-lg border-white/15 px-4 text-sm font-semibold"
                    disabled={isSubmittedCampaign || uploadingSupportingDocuments}
                    onClick={openSupportingDocumentPicker}
                    title={(values.supportingDocuments?.length ?? 0) > 0
                      ? `${values.supportingDocuments?.length} supporting document${values.supportingDocuments?.length === 1 ? '' : 's'} for Installs`
                      : 'Upload supporting documents for Installs'}
                    type="button"
                    variant="outline"
                  >
                    {uploadingSupportingDocuments ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : <Upload className="h-4 w-4" />}
                    {uploadingSupportingDocuments
                      ? 'Uploading...'
                      : (values.supportingDocuments?.length ?? 0) > 0
                        ? `Supporting Docs (${values.supportingDocuments?.length})`
                        : 'Supporting Docs'}
                  </Button>
                  <input
                    ref={supportingDocumentInputRef}
                    className="hidden"
                    multiple
                    onChange={(event) => void handleUploadSupportingDocuments(event.target.files)}
                    type="file"
                  />
                  <Button
                    className="h-10 min-w-0 rounded-lg border-white/15 px-4 text-sm font-semibold"
                    onClick={openUploadManagerDialog}
                    disabled={isSubmittedCampaign}
                    type="button"
                    variant="outline"
                  >
                    {uploadingArtworkPages ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : <Upload className="h-4 w-4" />}
                    {uploadingArtworkPages
                      ? pendingArtworkUploadCount > 0
                        ? `Upload Artwork (${pendingArtworkUploadCount} queued)`
                        : 'Upload Artwork'
                      : 'Upload Artwork'}
                  </Button>
                  <Button
                    className="h-10 min-w-0 rounded-lg border-white/15 px-4 text-sm font-semibold"
                    onClick={openArtworkManagerDialog}
                    disabled={isSubmittedCampaign}
                    type="button"
                    variant="outline"
                  >
                    Manage Artwork
                  </Button>
                  <Button
                    className="h-10 min-w-0 rounded-lg border-white/15 px-4 text-sm font-semibold"
                    onClick={openManageUploadsDialog}
                    type="button"
                    variant="outline"
                  >
                    Manage Uploads
                  </Button>
                  <div title={canAddMarketInPlanning ? 'Add another market' : addMarketDisabledReason}>
                    <Button
                      className="h-10 w-full min-w-0 rounded-lg border border-violet-300/40 bg-violet-600 px-4 text-sm font-semibold text-white shadow-[0_8px_20px_rgba(105,53,228,0.2)] transition hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-violet-600"
                      disabled={isSubmittedCampaign || !canAddMarketInPlanning}
                      onClick={openAddMarketDialog}
                      type="button"
                      variant="secondary"
                    >
                      <Plus className="h-4 w-4" />
                      Add Market
                    </Button>
                  </div>
                  <input
                    ref={artworkPdfInputRef}
                    accept="application/pdf,.pdf"
                    className="hidden"
                    multiple
                    onChange={(event) => {
                      void handleArtworkPickerFiles(event.target.files);
                      event.target.value = '';
                    }}
                    type="file"
                  />
                </div>
              </div>

              <div className="campaign-builder-content-scale space-y-6">
                {loadingMetadata ? (
                  <div className="flex items-center gap-3 rounded-lg border border-white/10 bg-slate-900/70 px-4 py-3 text-sm text-slate-300">
                    <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" />
                    Loading campaign mappings…
                  </div>
                ) : null}

                <div className="space-y-3">
                  {visiblePlanningMarkets.map((market, marketIndex) => {
                    const marketTheme = MARKET_PLANNING_THEMES[marketIndex % MARKET_PLANNING_THEMES.length];
                    const availableAssets = assetsForMarket(market.market);
                    const canRemoveMarket = visiblePlanningMarkets.length > 1;
                    const availableMarkets = marketOptionsFor(market.id, market.market);
                    const isActiveMarket = market.id === activeMarket?.id;
                    const marketSummary = marketSummaryByName.get(market.market);
                    const visibleMarketFormatKeys = marketSummary
                      ? visibleBreakdownKeys(marketSummary.breakdown)
                      : [...formatKeys];
                    return (
                      <div
                        key={market.id}
                        className={cn('rounded-xl border p-4 sm:p-4', marketTheme.card, isActiveMarket ? marketTheme.cardActive : '')}
                        onClick={() => setActiveMarketId(market.id)}
                        onFocusCapture={() => setActiveMarketId(market.id)}
                      >
                        <div className={cn('mb-4 h-1 w-16 rounded-full', marketTheme.accent)} />
                        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                          <div className="flex-1">
                            <SearchableSelect
                              emptyMessage="No markets available for this row."
                              items={availableMarkets}
                              label={`Market ${marketIndex + 1}`}
                                          onValueChange={(value) =>
                                            updateCampaignMarket(market.id, (current) => {
                                              const preferredAddress = preferredDeliveryAddressByMarket.get(value) || '';
                                              return {
                                                ...current,
                                                market: value,
                                                quantityOverrides: undefined,
                                                assets: current.assets.map((asset) => ({
                                                  ...asset,
                                                  assetId: '',
                                                  assetSearch: '',
                                                  deliveryAddress: preferredAddress,
                                                  selectedWeeks: [],
                                                  quantityOverrides: undefined,
                                                })),
                                              };
                                            })
                                          }
                              placeholder="Choose a market"
                              selectedValue={market.market}
                              disabled={isSubmittedCampaign}
                            />
                          </div>
                          {canRemoveMarket ? (
                            <Button disabled={isSubmittedCampaign} onClick={() => removeCampaignMarket(market.id)} size="icon" type="button" variant="ghost">
                              <X className="h-4 w-4" />
                            </Button>
                          ) : null}
                        </div>

                        <div className="mt-4 space-y-4">
                          <div>
                            <p className="text-sm font-semibold text-slate-100">Assets</p>
                            <p className="text-xs text-slate-400">Attach the assets you want to run in this market. Select weeks as needed.</p>
                          </div>
                          <div className="rounded-lg border border-white/10 bg-slate-950/40 lg:overflow-visible">
                            <div className="overflow-x-auto lg:overflow-visible">
                              <table className="dense-table min-w-[780px] w-full border-collapse text-sm">
                              <colgroup>
                                <col />
                                <col className="w-[1%]" />
                                <col className="w-[24px]" />
                              </colgroup>
                              <thead>
                                <tr className={cn('border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.15em]', marketTheme.header)}>
                                  <th className="px-4 py-3.5 text-left">Asset</th>
                                  <th className="px-4 py-3.5 text-left">Active Weeks</th>
                                  <th className="px-3 py-3.5 text-center">
                                    <span className="sr-only">Actions</span>
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {market.assets.map((asset) => {
                                  const canRemoveAsset = market.assets.length > 1;
                                  const availableAssetOptions = assetOptionsFor(market, asset.id, asset.assetId);
                                  return (
                                    <tr key={asset.id} className="border-b border-slate-700/70 align-top last:border-b-0">
                                      <td className="px-4 py-3">
                                        <SearchableSelect
                                          emptyMessage={availableAssets.length ? 'No assets available for this row.' : 'No assets available for this market.'}
                                          items={availableAssetOptions}
                                          label=""
                                          onValueChange={(value) => {
                                            updateCampaignAsset(market.id, asset.id, (current) => ({
                                              ...current,
                                              assetId: value,
                                              assetSearch: availableAssets.find((entry) => entry.id === value)?.label ?? '',
                                              quantityOverrides: undefined,
                                            }));
                                          }}
                                          placeholder={availableAssets.length ? 'Choose an asset' : 'No assets available'}
                                          selectedLabel={asset.assetSearch}
                                          selectedValue={asset.assetId}
                                          disabled={isSubmittedCampaign}
                                        />
                                      </td>
                                      <td className="px-2 py-3">
                                        <div className="flex justify-end">
                                          <WeekSelector
                                            compact
                                            weekCount={numberOfWeeks}
                                            startDate={values.campaignStartDate}
                                            onToggleWeek={(week) => toggleCampaignAssetWeek(market.id, asset.id, week)}
                                            readOnly={isSubmittedCampaign}
                                            selectedWeeks={asset.selectedWeeks}
                                          />
                                        </div>
                                      </td>
                                      <td className="px-1 py-3 text-center">
                                        {canRemoveAsset ? (
                                          <Button className="h-7 w-7" disabled={isSubmittedCampaign} onClick={() => removeCampaignAsset(market.id, asset.id)} size="icon" type="button" variant="ghost">
                                            <X className="h-3.5 w-3.5 text-rose-300" />
                                          </Button>
                                        ) : null}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                              </table>
                            </div>
                          </div>

                          <div title={canAddAssetForMarket(market) ? 'Add another asset' : addAssetDisabledReasonForMarket(market)}>
                            <Button className="h-10 min-w-[132px] px-4 text-[15px]" disabled={isSubmittedCampaign || !canAddAssetForMarket(market)} onClick={() => addCampaignAsset(market.id)} type="button" variant="secondary">
                              <Plus className="h-4 w-4" />
                              Add Asset
                            </Button>
                          </div>

                          {marketSummary ? (
                            <div className="space-y-3">
                              <p className="text-sm font-semibold text-white">Market Totals</p>
                              <div className="overflow-x-auto rounded-md border border-slate-700 bg-slate-900/65">
                                <table className="dense-table min-w-[860px] w-full border-collapse text-sm">
                                  <thead>
                                    <tr className="bg-slate-950 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-300">
                                      <th className="border border-slate-700 px-4 py-3 text-left">Type</th>
                                      {visibleMarketFormatKeys.map((key) => (
                                        <th key={`schedule-market-head-${market.id}-${key}`} className="border border-slate-700 px-4 py-3 text-center">{formatBreakdownKeyLabel(key, normalizedSheetNameOverrides)}</th>
                                      ))}
                                      <th className="border border-slate-700 px-4 py-3 text-center">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {buildReviewRows(marketSummary).map((row) => (
                                      <tr key={`schedule-market-row-${market.id}-${row.label}`} className="bg-slate-800/70 border-t border-slate-700/70">
                                        <th className="border border-slate-700 px-4 py-3 text-left font-semibold text-slate-100">{row.label}</th>
                                        {visibleMarketFormatKeys.map((key) => (
                                          <td key={`schedule-market-cell-${market.id}-${row.label}-${key}`} className="border border-slate-700 px-4 py-3 text-center font-semibold text-white">
                                            {breakdownValueForKey(row.breakdown, key)}
                                          </td>
                                        ))}
                                        <td className="border border-slate-700 px-4 py-3 text-center font-black text-white">{row.total}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="bg-violet-500/10 border-t border-violet-400/30">
                                      <th colSpan={visibleMarketFormatKeys.length + 1} className="border border-violet-300/30 px-4 py-3 text-right font-black uppercase tracking-[0.12em] text-violet-100">
                                        Total
                                      </th>
                                      <td className="border border-violet-300/30 px-4 py-3 text-center font-black text-violet-100">
                                        {marketSummary.posterTotal + marketSummary.frameTotal}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </div>
                          ) : (
                            <p className="text-sm leading-6 text-slate-400">Configure assets in this market to see its sheet-level mix and totals here.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="space-y-3">
                  {values.campaignMarkets.map((market, marketIndex) => {
                    const marketTheme = MARKET_PLANNING_THEMES[marketIndex % MARKET_PLANNING_THEMES.length];
                    const deliveryAddressOptions = deliveryAddressOptionsFor(market.market);
                    return (
                      <div key={`finalize-map-${market.id}`} className={cn('relative rounded-xl border', marketTheme.card)}>
                        <div className="flex items-center justify-between border-b border-white/10 bg-slate-950/85 px-4 py-2">
                          <div className="flex items-center gap-3">
                            <span className={cn('h-2.5 w-2.5 rounded-full ring-2 ring-violet-300/35', marketTheme.accent)} />
                            <span className="rounded-md border border-violet-300/35 bg-[rgb(var(--primary-500-rgb)/0.18)] px-2.5 py-1 text-sm font-extrabold uppercase tracking-[0.13em] text-[var(--primary-100)]">
                              {market.market || 'Market'}
                            </span>
                          </div>
                        </div>
                        <Button
                          className="absolute right-[5.25rem] top-2 h-7 w-7 border border-violet-300/20 bg-slate-900/80 hover:bg-violet-500/10"
                          onClick={() => setExpandedMarketId(market.id)}
                          size="icon"
                          title="Expand market"
                          type="button"
                          variant="ghost"
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          className="absolute right-11 top-2 h-7 w-7 border border-violet-300/20 bg-slate-900/80 hover:bg-violet-500/10"
                          onClick={() => openEditMarketDialog(market.id)}
                          size="icon"
                          title="Edit market"
                          type="button"
                          variant="ghost"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          className="absolute right-3 top-2 h-7 w-7 border border-rose-300/20 bg-slate-900/80 text-rose-300 hover:bg-rose-500/10 hover:text-rose-200"
                          onClick={() => handleDeleteMarket(market.id)}
                          size="icon"
                          title="Delete market"
                          type="button"
                          variant="ghost"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <div className="space-y-2 p-2 pb-0.5">
                          <div className={cn(market.assets.length > 4 ? 'max-h-[220px] overflow-y-auto' : 'overflow-visible')}>
                              <table className="dense-table w-full border-collapse table-fixed text-sm">
                              <colgroup>
                                <col className="w-[24%]" />
                                <col className="w-[16%]" />
                                <col className="w-[24%]" />
                                <col className="w-[36%]" />
                              </colgroup>
                              <thead>
                                <tr className={cn('border-b border-white/10 text-[11px] font-semibold uppercase tracking-[0.15em]', marketTheme.header)}>
                                  <th className="px-4 py-1.5 text-left">Asset</th>
                                  <th className="px-4 py-1.5 text-left">Category</th>
                                  <th className="px-4 py-1.5 text-left">Creative</th>
                                  <th className="px-4 py-1.5 text-left">Delivery Address</th>
                              </tr>
                            </thead>
                            <tbody>
                              {market.assets.map((asset) => {
                                const line = summaryLineByAssetId.get(asset.id);
                                const requiredFormats = getCreativeFormatsForBreakdown(line?.breakdown);
                                const displayFormats = requiredFormats.length > 0 ? requiredFormats : [null];
                                const rowSpan = displayFormats.length;
                                const metadataAsset = markets.find((entry) => entry.name === market.market)?.assets.find((entry) => entry.id === asset.assetId);
                                return (
                                  <Fragment key={`finalize-map-group-${asset.id}`}>
                                    {displayFormats.map((formatKey, index) => {
                                      const selectedCreativeId = formatKey ? getCreativeImageIdForFormat(asset, formatKey) : '';
                                      const hasAssignedMaterial = formatKey ? hasAssignedMaterialForFormat(asset, formatKey) : false;
                                      const multiArtworkSlotCount = formatKey && normalizedMultipleArtworkFormats[canonicalKeyForFormat(formatKey)] ? Math.max(1, metadataAsset?.quantities?.[formatKey] ?? 1) : 0;
                                      const multiArtworkFrameCount = formatKey ? frameCountForFormat(line?.breakdown, formatKey) : 0;
                                      const slotArtworkIds = formatKey ? expandedArtworkImageIdsForFormat(asset, formatKey) : [];
                                      const hasAnySlotArtwork = slotArtworkIds.some((id) => Boolean((id || '').trim()));
                                      const hasArtworkAssignment = hasAnySlotArtwork;
                                      return (
                                        <tr key={`finalize-map-row-${asset.id}-${formatKey ?? 'none'}-${index}`} className="border-b border-slate-700/70 align-middle last:border-b-0">
                                          {index === 0 ? (
                                            <td className="align-middle px-4 py-1.5" rowSpan={rowSpan}>
                                              <p className="text-sm font-semibold text-white">{asset.assetSearch || asset.assetId || 'Asset not selected'}</p>
                                            </td>
                                          ) : null}
                                          <td className="align-middle px-4 py-1.5">
                                            {formatKey ? (
                                              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">{creativeFormatLabel(formatKey, normalizedSheetNameOverrides)}</p>
                                            ) : (
                                              <p className="text-sm text-slate-400">No active quantity formats</p>
                                            )}
                                          </td>
                                          <td className="px-4 py-1.5">
                                            {formatKey ? (
                                              <div className="flex items-center gap-2">
                                                <Button
                                                  className="h-8 w-20 px-2 text-[11px] font-semibold"
                                                  onClick={() =>
                                                    multiArtworkSlotCount > 0
                                                      ? openMultiArtworkDialog(market.id, asset.id, formatKey, multiArtworkFrameCount)
                                                      : selectedCreativeId
                                                        ? openArtworkPreviewDialog(market.id, asset.id, formatKey)
                                                        : openAssignArtworkDialog(market.id, asset.id, formatKey)
                                                  }
                                                  type="button"
                                                  variant={multiArtworkSlotCount > 0 ? (hasArtworkAssignment ? 'outline' : 'secondary') : selectedCreativeId ? 'outline' : 'secondary'}
                                                >
                                                  {multiArtworkSlotCount > 0 ? (
                                                    hasArtworkAssignment ? (
                                                      <>
                                                        <Eye className="h-3.5 w-3.5" />
                                                        Show
                                                      </>
                                                    ) : (
                                                      '+ Assign'
                                                    )
                                                  ) : selectedCreativeId ? (
                                                    <>
                                                      <Eye className="h-3.5 w-3.5" />
                                                      Show
                                                    </>
                                                  ) : (
                                                    '+ Assign'
                                                  )}
                                                </Button>
                                                {multiArtworkSlotCount === 0 ? (
                                                  <Button
                                                    className="h-8 w-20 px-2 text-[11px] font-semibold"
                                                    onClick={() => openMaterialDialog(market.id, asset.id, formatKey, multiArtworkFrameCount)}
                                                    type="button"
                                                    variant={hasAssignedMaterial ? 'outline' : 'secondary'}
                                                  >
                                                    {hasAssignedMaterial ? <><Eye className="h-3.5 w-3.5" />Material</> : '+ Material'}
                                                  </Button>
                                                ) : null}
                                              </div>
                                            ) : (
                                              <p className="text-sm text-slate-500">-</p>
                                            )}
                                          </td>
                                          {index === 0 ? (
                                            <td className="px-4 py-1.5" rowSpan={rowSpan}>
                                              <SearchableSelect
                                                actionDisabled={!market.market}
                                                actionLabel={canAddAddressInFinalize ? 'Add new address' : undefined}
                                                emptyMessage={deliveryAddressOptions.length ? 'No matching addresses found.' : 'No addresses saved for this market yet.'}
                                                items={deliveryAddressOptions}
                                                label=""
                                                onAction={() => openAddAddressDialog(market.id, asset.id, market.market)}
                                                onValueChange={(value) =>
                                                  updateCampaignAsset(market.id, asset.id, (current) => ({
                                                    ...current,
                                                    deliveryAddress: value,
                                                  }))
                                                }
                                                placeholder={deliveryAddressOptions.length ? 'Choose delivery address' : 'No addresses available'}
                                                selectedLabel={asset.deliveryAddress || ''}
                                                selectedValue={asset.deliveryAddress || ''}
                                                triggerClassName="h-8 px-2.5 text-[13px]"
                                              />
                                            </td>
                                          ) : null}
                                        </tr>
                                      );
                                    })}
                                  </Fragment>
                                );
                              })}
                            </tbody>
                            </table>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>

              </div>
            </div>

          <aside
            className={cn(
              'fixed bottom-4 right-4 top-[92px] z-30 rounded-2xl border border-white/5 bg-gradient-to-b from-slate-900/92 to-slate-950/92 shadow-[0_24px_60px_rgba(2,6,23,0.45)] backdrop-blur-md transition-transform duration-200 ease-out',
              reviewDrawerOpen ? 'translate-x-0' : 'translate-x-[calc(100%+1.5rem)]',
            )}
            style={{ width: reviewDrawerMode === 'detailed' ? `min(calc(100vw - 2rem), ${detailedDrawerWidth}px)` : '472px' }}
          >
            {summary ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="flex items-center justify-between border-b border-white/5 px-5 py-3.5">
                  <div>
                    <h3 className="text-[16px] font-semibold text-white">Campaign Summary</h3>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <div className="inline-flex rounded-lg border border-white/10 bg-slate-900/70 p-0.5">
                      <button
                        aria-label="High-level view"
                        className={cn('rounded-md p-1.5 transition', reviewDrawerMode === 'high-level' ? 'bg-slate-700/80 text-white' : 'text-slate-300 hover:text-white')}
                        onClick={() => setReviewDrawerMode('high-level')}
                        title="High-level view"
                        type="button"
                      >
                        <LayoutGrid className="h-4 w-4" />
                      </button>
                      <button
                        aria-label="Detailed view"
                        className={cn('rounded-md p-1.5 transition', reviewDrawerMode === 'detailed' ? 'bg-slate-700/80 text-white' : 'text-slate-300 hover:text-white')}
                        onClick={() => setReviewDrawerMode('detailed')}
                        title="Detailed view"
                        type="button"
                      >
                        <Table2 className="h-4 w-4" />
                      </button>
                    </div>
                    <Button
                      aria-label="Close review"
                      className="h-8 w-8 rounded-full border border-white/10 bg-slate-900/70 p-0 text-slate-300 hover:bg-slate-800 hover:text-white"
                      onClick={() => setReviewDrawerOpen(false)}
                      type="button"
                      variant="ghost"
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>

                <div className={cn('min-h-0 flex-1 px-5 py-4 overflow-y-auto', reviewDrawerMode === 'detailed' ? 'space-y-3' : 'space-y-4')}>
                  {reviewDrawerMode === 'high-level' ? (
                    <>
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="rounded-xl bg-gradient-to-br from-slate-800/65 to-slate-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(2,6,23,0.28)]">
                          <p className="text-[11px] font-semibold text-slate-400">Total Posters</p>
                          <p className="mt-1.5 text-[25px] font-bold leading-none text-white">{grandReviewRows?.[0].total ?? 0}</p>
                        </div>
                        <div className="rounded-xl bg-gradient-to-br from-slate-800/65 to-slate-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(2,6,23,0.28)]">
                          <p className="text-[11px] font-semibold text-slate-400">Total Frames</p>
                          <p className="mt-1.5 text-[25px] font-bold leading-none text-white">{grandReviewRows?.[1].total ?? 0}</p>
                        </div>
                        <div className="rounded-xl bg-gradient-to-br from-slate-800/65 to-slate-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(2,6,23,0.28)]">
                          <p className="text-[11px] font-semibold text-slate-400">Printing Cost</p>
                          <p className="mt-1.5 text-[22px] font-bold leading-none text-white">{formatCurrency(totalPrintingCost)}</p>
                        </div>
                        <div className="rounded-xl bg-gradient-to-br from-slate-800/65 to-slate-900/70 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_24px_rgba(2,6,23,0.28)]">
                          <p className="text-[11px] font-semibold text-slate-400">Shipping Cost</p>
                          <p className="mt-1.5 text-[22px] font-bold leading-none text-white">{formatCurrency(totalShippingCost)}</p>
                        </div>
                      </div>
                      <div className="h-px bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                      <div className="space-y-3">
                        <h4 className="text-[15px] font-semibold text-white">Market Breakdown</h4>
                        {visibleReviewMarkets.map((marketSummary) => (
                          <div key={`review-market-card-${marketSummary.market}`} className="rounded-xl bg-gradient-to-b from-slate-800/52 to-slate-900/62 p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
                            <div className="-m-1.5 flex w-full items-center gap-3 rounded-xl p-1.5">
                              <span className="h-2.5 w-2.5 rounded-full bg-violet-300/80" />
                              <p className="flex-1 text-left text-[17px] font-semibold text-slate-100">{marketSummary.market}</p>
                            </div>
                            <div className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[14px]">
                              {(() => {
                                const rows = buildReviewRows(marketSummary);
                                return (
                                  <>
                              <div className="text-slate-400">Posters</div>
                              <div className="text-right font-semibold tabular-nums text-white">{rows[0].total}</div>
                              <div className="text-slate-400">Frames</div>
                              <div className="text-right font-semibold tabular-nums text-white">{rows[1].total}</div>
                              <div className="text-slate-400">Printing</div>
                              <div className="text-right font-semibold tabular-nums text-white">{formatCurrency(calculateMarketPrintingCost(marketSummary.market))}</div>
                              <div className="text-slate-400">Shipping</div>
                              <div className="text-right font-semibold tabular-nums text-white">{formatCurrency(calculateMarketShippingCost(marketSummary.market))}</div>
                                  </>
                                );
                              })()}
                            </div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="rounded-xl border border-white/10 bg-slate-900/65 p-3">
                        <p className="mb-2 text-[18px] font-semibold text-white">Posters</p>
                        <div className="overflow-hidden rounded-lg border border-white/10">
                          <table className="w-full border-collapse text-[12px]">
                            <thead className="bg-slate-950 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                              <tr>
                                <th className="border border-white/10 px-2.5 py-2 text-left">Market</th>
                                <th className="border border-white/10 px-2.5 py-2 text-left">Type</th>
                                {detailedReviewFormatKeys.map((key) => (
                                  <th key={`detail-head-${key}`} className="border border-white/10 px-2.5 py-2 text-right">{formatBreakdownKeyLabel(key, normalizedSheetNameOverrides)}</th>
                                ))}
                                <th className="border border-white/10 px-2.5 py-2 text-right">Total</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleReviewMarkets.map((marketSummary) => {
                                const rows = buildReviewRows(marketSummary);
                                return (
                                  <Fragment key={`review-detail-${marketSummary.market}`}>
                                    <tr className="bg-slate-900/60">
                                      <td className="border border-white/10 px-2.5 py-2 font-semibold text-white" rowSpan={2}>{marketSummary.market}</td>
                                      <td className="border border-white/10 px-2.5 py-2 font-semibold text-white">Posters</td>
                                      {detailedReviewFormatKeys.map((key) => (
                                        <td key={`detail-row-posters-${marketSummary.market}-${key}`} className="border border-white/10 px-2.5 py-2 text-right tabular-nums text-white">{breakdownValueForKey(rows[0].breakdown, key)}</td>
                                      ))}
                                      <td className="border border-white/10 px-2.5 py-2 text-right font-semibold tabular-nums text-white">{rows[0].total}</td>
                                    </tr>
                                    <tr className="bg-slate-900/60">
                                      <td className="border border-white/10 px-2.5 py-2 font-semibold text-white">Frames</td>
                                      {detailedReviewFormatKeys.map((key) => (
                                        <td key={`detail-row-frames-${marketSummary.market}-${key}`} className="border border-white/10 px-2.5 py-2 text-right tabular-nums text-white">{breakdownValueForKey(rows[1].breakdown, key)}</td>
                                      ))}
                                      <td className="border border-white/10 px-2.5 py-2 text-right font-semibold tabular-nums text-white">{rows[1].total}</td>
                                    </tr>
                                  </Fragment>
                                );
                              })}
                              {(() => {
                                const allRows = buildReviewRows(summary.grandTotal);
                                return (
                                  <>
                                    <tr className="bg-violet-500/10">
                                      <td className="border border-violet-300/25 px-2.5 py-2 font-semibold text-violet-100" rowSpan={2}>All Markets</td>
                                      <td className="border border-violet-300/25 px-2.5 py-2 font-semibold text-violet-100">Posters</td>
                                      {detailedReviewFormatKeys.map((key) => (
                                        <td key={`detail-all-posters-${key}`} className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{breakdownValueForKey(allRows[0].breakdown, key)}</td>
                                      ))}
                                      <td className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{allRows[0].total}</td>
                                    </tr>
                                    <tr className="bg-violet-500/10">
                                      <td className="border border-violet-300/25 px-2.5 py-2 font-semibold text-violet-100">Frames</td>
                                      {detailedReviewFormatKeys.map((key) => (
                                        <td key={`detail-all-frames-${key}`} className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{breakdownValueForKey(allRows[1].breakdown, key)}</td>
                                      ))}
                                      <td className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{allRows[1].total}</td>
                                    </tr>
                                  </>
                                );
                              })()}
                            </tbody>
                          </table>
                        </div>
                      </div>
                      <div className="rounded-xl border border-white/10 bg-slate-900/65 p-3">
                        <p className="mb-2 text-[18px] font-semibold text-white">Cost</p>
                        <div className="overflow-hidden rounded-lg border border-white/10">
                          <table className="w-full border-collapse text-[12px]">
                            <thead className="bg-slate-950 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-300">
                              <tr>
                                <th className="border border-white/10 px-2.5 py-2 text-left">Market</th>
                                <th className="border border-white/10 px-2.5 py-2 text-right">Printing Cost ($)</th>
                                <th className="border border-white/10 px-2.5 py-2 text-right">Shipping Cost ($)</th>
                              </tr>
                            </thead>
                            <tbody>
                              {visibleReviewMarkets.map((marketSummary) => (
                                <tr key={`review-cost-${marketSummary.market}`} className="bg-slate-900/60">
                                  <td className="border border-white/10 px-2.5 py-2 font-semibold text-white">{marketSummary.market}</td>
                                  <td className="border border-white/10 px-2.5 py-2 text-right font-semibold tabular-nums text-white">{formatCurrency(calculateMarketPrintingCost(marketSummary.market))}</td>
                                  <td className="border border-white/10 px-2.5 py-2 text-right font-semibold tabular-nums text-white">{formatCurrency(calculateMarketShippingCost(marketSummary.market))}</td>
                                </tr>
                              ))}
                              <tr className="bg-violet-500/10">
                                <td className="border border-violet-300/25 px-2.5 py-2 font-semibold text-violet-100">All Markets</td>
                                <td className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{formatCurrency(totalPrintingCost)}</td>
                                <td className="border border-violet-300/25 px-2.5 py-2 text-right font-semibold tabular-nums text-violet-100">{formatCurrency(totalShippingCost)}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                      </div>
                    </>
                  )}
                </div>

                <div className="border-t border-white/5 bg-gradient-to-b from-slate-900/96 via-slate-900/98 to-slate-950 px-5 py-4">
                  {reviewActionError ? (
                    <div className="mb-3 rounded-lg border border-rose-400/35 bg-rose-500/10 px-3 py-2 text-xs font-medium text-rose-100">
                      <p>{reviewActionError}</p>
                      {reviewActionNeedsDueDate ? (
                        <div className="mt-2">
                          <Button
                            className="h-7 rounded-md border-rose-300/40 bg-rose-500/15 px-2.5 text-xs text-rose-100 hover:bg-rose-500/25"
                            onClick={focusDueDateField}
                            type="button"
                            variant="outline"
                          >
                            Go To Due Date
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  <p className="text-[11px] font-semibold text-slate-400">Total Estimate</p>
                  <p className="mt-1 bg-gradient-to-r from-white to-slate-300 bg-clip-text text-[30px] font-extrabold leading-none text-transparent drop-shadow-[0_0_18px_rgba(255,255,255,0.12)]">
                    {formatCurrency(totalEstimateCost)}
                  </p>
                  {isPrintIQSubmitting ? (
                    <div className="mt-4 rounded-lg border border-violet-300/25 bg-violet-500/10 px-3 py-2.5">
                      <div className="flex items-center justify-between gap-3 text-[11px] font-semibold text-violet-100">
                        <span>{testSubmitting ? 'Testing PrintIQ order' : 'Submitting PrintIQ order'}</span>
                        <span>{Math.round(submitProgress.progress)}%</span>
                      </div>
                      <div role="progressbar" aria-label="PrintIQ submission progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={submitProgress.progress} aria-valuetext={submitProgress.label} className="mt-2 h-2 overflow-hidden rounded-full bg-slate-950/80 ring-1 ring-white/10">
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-violet-400 via-fuchsia-400 to-amber-300 transition-[width] duration-700 ease-out"
                          style={{ width: `${submitProgress.progress}%` }}
                        />
                      </div>
                      <p className="mt-2 text-[11px] font-medium text-slate-300">{submitProgress.label || 'Preparing PrintIQ submission'}</p>
                      <p className="mt-1 text-[10px] text-slate-400">Progress reflects completed steps; large attachments may take longer.</p>
                    </div>
                  ) : null}
                  <div className={cn('mt-5 grid gap-1.5', isSuperAdmin ? 'grid-cols-4' : 'grid-cols-3')}>
                    <Button
                      className="h-9 min-w-0 rounded-xl border-white/10 bg-slate-800/65 px-1.5 text-[11px] font-semibold text-slate-100 transition hover:bg-slate-700/75"
                      disabled={exportingTemplates || sendingAdsEmail || submitting || testSubmitting}
                      onClick={() => void downloadArtworkVisuals()}
                      type="button"
                      variant="outline"
                    >
                      Visuals
                    </Button>
                    <Button
                      className="h-9 min-w-0 rounded-xl border-white/10 bg-slate-800/65 px-1.5 text-[11px] font-semibold text-slate-100 transition hover:bg-slate-700/75"
                      disabled={exportingTemplates || sendingAdsEmail || uploadingSupportingDocuments || submitting || testSubmitting}
                      onClick={() => void downloadInstallationSheet()}
                      type="button"
                      variant="outline"
                    >
                      Installs
                    </Button>
                    <Button
                      className="h-9 min-w-0 rounded-xl border border-violet-300/35 bg-gradient-to-r from-violet-600 to-violet-500 px-1.5 text-[11px] font-semibold text-white shadow-[0_10px_24px_rgba(105,53,228,0.26)] transition hover:brightness-105"
                      disabled={isSubmittedCampaign || submitting || testSubmitting || exportingTemplates || sendingAdsEmail}
                      onClick={() => void handleSubmitQuote()}
                      type="button"
                      variant="secondary"
                    >
                      {submitting ? 'Submitting...' : 'Submit'}
                    </Button>
                    {isSuperAdmin ? (
                      <Button
                        className="h-9 min-w-0 rounded-xl border border-amber-300/35 bg-amber-500/15 px-1.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-500/25"
                        disabled={submitting || testSubmitting || exportingTemplates || sendingAdsEmail}
                        onClick={() => void handleSubmitQuote({ test: true })}
                        title="Submit a test order to PrintIQ without marking the campaign submitted"
                        type="button"
                        variant="outline"
                      >
                        {testSubmitting ? 'Testing...' : 'test'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>

            ) : (
              <div className="rounded-xl border border-white/10 bg-slate-900/70 p-6">
                <div className="flex items-start gap-3">
                  <CircleAlert className="mt-0.5 h-5 w-5 text-violet-300" />
                  <div>
                    <p className="font-semibold text-white">No totals yet</p>
                    <p className="mt-1 text-sm text-slate-400">Configure campaign assets above to generate totals.</p>
                  </div>
                    </div>
                  </div>
            )}
          </aside>
          </div>
        </section>

      </div>

      <div
        aria-hidden={!reviewDrawerOpen}
        className={cn(
          'fixed inset-0 z-20 bg-[rgba(3,8,20,0.35)] backdrop-blur-[2px] transition-opacity duration-200 ease-out',
          reviewDrawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        onClick={() => setReviewDrawerOpen(false)}
      />

      {!reviewDrawerOpen ? (
        <button
          className="fixed bottom-6 right-6 z-40 rounded-full border border-violet-300/45 bg-gradient-to-r from-violet-600 to-violet-500 px-4 py-2 text-sm font-semibold text-white shadow-[0_12px_30px_rgba(105, 53, 228,0.36)] transition duration-200 ease-out hover:-translate-y-[1px] hover:brightness-105"
          onClick={() => setReviewDrawerOpen(true)}
          type="button"
        >
          {reviewButtonTotals
            ? `${reviewButtonTotals.posters} Posters • ${reviewButtonTotals.frames} Frames • ${formatCurrency(totalEstimateCost)}`
            : 'Open Review'}
        </button>
      ) : null}

      {exportProgressMessage
        ? (bottomBarHost
            ? createPortal(
                <div className="z-20 border-t border-slate-800/90 bg-slate-950/92 backdrop-blur">
                  <div className="w-full px-3 py-2 sm:px-4 lg:px-5">
                    <div className="px-1 py-1 text-sm text-slate-300" role="status">
                      {exportProgressMessage}
                    </div>
                  </div>
                </div>,
                bottomBarHost,
              )
            : (
                <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-800/90 bg-slate-950/92 backdrop-blur">
                  <div className="w-full px-3 py-2 sm:px-4 lg:px-5">
                    <div className="px-1 py-1 text-sm text-slate-300" role="status">
                      {exportProgressMessage}
                    </div>
                  </div>
                </div>
              ))
        : null}

      <Dialog
        open={Boolean(expandedMarketId)}
        onOpenChange={(open) => {
          if (!open) setExpandedMarketId(null);
        }}
      >
        <DialogContent className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0" style={{ width: 'min(calc(100vw - 2rem), 86rem)', maxHeight: '90vh' }}>
          {(() => {
            const expandedMarket = values.campaignMarkets.find((entry) => entry.id === expandedMarketId) ?? null;
            if (!expandedMarket) return null;
            const deliveryAddressOptions = deliveryAddressOptionsFor(expandedMarket.market);
            return (
              <>
                <DialogHeader className="shrink-0 border-b border-slate-700 px-5 py-4">
                  <DialogTitle>{expandedMarket.market || 'Market'} - Assets</DialogTitle>
                </DialogHeader>
                <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
                <div className="overflow-auto rounded-md border border-slate-700 bg-slate-900/70">
                  <table className="dense-table w-full border-collapse table-fixed text-sm">
                    <colgroup>
                      <col className="w-[24%]" />
                      <col className="w-[16%]" />
                      <col className="w-[24%]" />
                      <col className="w-[36%]" />
                    </colgroup>
                    <thead>
                      <tr className="border-b border-white/10 bg-slate-950 text-[11px] font-semibold uppercase tracking-[0.15em] text-slate-300">
                        <th className="px-4 py-3.5 text-left">Asset</th>
                        <th className="px-4 py-3.5 text-left">Category</th>
                        <th className="px-4 py-3.5 text-left">Creative</th>
                        <th className="px-4 py-3.5 text-left">Delivery Address</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expandedMarket.assets.map((asset) => {
                        const line = summaryLineByAssetId.get(asset.id);
                        const requiredFormats = getCreativeFormatsForBreakdown(line?.breakdown);
                        const displayFormats = requiredFormats.length > 0 ? requiredFormats : [null];
                        const rowSpan = displayFormats.length;
                        const metadataAsset = markets.find((entry) => entry.name === expandedMarket.market)?.assets.find((entry) => entry.id === asset.assetId);
                        return (
                          <Fragment key={`expanded-market-group-${asset.id}`}>
                            {displayFormats.map((formatKey, index) => {
                              const selectedCreativeId = formatKey ? getCreativeImageIdForFormat(asset, formatKey) : '';
                              const hasAssignedMaterial = formatKey ? hasAssignedMaterialForFormat(asset, formatKey) : false;
                              const multiArtworkSlotCount = formatKey && normalizedMultipleArtworkFormats[canonicalKeyForFormat(formatKey)] ? Math.max(1, metadataAsset?.quantities?.[formatKey] ?? 1) : 0;
                              const multiArtworkFrameCount = formatKey ? frameCountForFormat(line?.breakdown, formatKey) : 0;
                              const slotArtworkIds = formatKey ? expandedArtworkImageIdsForFormat(asset, formatKey) : [];
                              const hasAnySlotArtwork = slotArtworkIds.some((id) => Boolean((id || '').trim()));
                              const hasArtworkAssignment = hasAnySlotArtwork;
                              return (
                                <tr key={`expanded-market-row-${asset.id}-${formatKey ?? 'none'}-${index}`} className="border-b border-slate-700/70 align-top last:border-b-0">
                                  {index === 0 ? (
                                    <td className="px-4 py-3" rowSpan={rowSpan}>
                                      <p className="text-sm font-semibold text-white">{asset.assetSearch || asset.assetId || 'Asset not selected'}</p>
                                    </td>
                                  ) : null}
                                  <td className="px-4 py-3">
                                    {formatKey ? (
                                      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-300">{creativeFormatLabel(formatKey, normalizedSheetNameOverrides)}</p>
                                    ) : (
                                      <p className="text-sm text-slate-400">No active quantity formats</p>
                                    )}
                                  </td>
                                  <td className="px-4 py-3">
                                    {formatKey ? (
                                      <div className="flex items-center gap-2">
                                        <Button
                                          className="h-9 w-24 px-3 text-xs font-semibold"
                                          onClick={() =>
                                            multiArtworkSlotCount > 0
                                              ? openMultiArtworkDialog(expandedMarket.id, asset.id, formatKey, multiArtworkFrameCount)
                                              : selectedCreativeId
                                                ? openArtworkPreviewDialog(expandedMarket.id, asset.id, formatKey)
                                                : openAssignArtworkDialog(expandedMarket.id, asset.id, formatKey)
                                          }
                                          type="button"
                                          variant={multiArtworkSlotCount > 0 ? (hasArtworkAssignment ? 'outline' : 'secondary') : selectedCreativeId ? 'outline' : 'secondary'}
                                        >
                                          {multiArtworkSlotCount > 0 ? (
                                            hasArtworkAssignment ? (
                                              <>
                                                <Eye className="h-3.5 w-3.5" />
                                                Show
                                              </>
                                            ) : (
                                              '+ Assign'
                                            )
                                          ) : selectedCreativeId ? (
                                            <>
                                              <Eye className="h-3.5 w-3.5" />
                                              Show
                                            </>
                                          ) : (
                                            '+ Assign'
                                          )}
                                        </Button>
                                        {multiArtworkSlotCount === 0 ? (
                                          <Button
                                            className="h-9 w-24 px-3 text-xs font-semibold"
                                            onClick={() => openMaterialDialog(expandedMarket.id, asset.id, formatKey, multiArtworkFrameCount)}
                                            type="button"
                                            variant={hasAssignedMaterial ? 'outline' : 'secondary'}
                                          >
                                            {hasAssignedMaterial ? <><Eye className="h-3.5 w-3.5" />Material</> : '+ Material'}
                                          </Button>
                                        ) : null}
                                      </div>
                                    ) : (
                                      <p className="text-sm text-slate-500">-</p>
                                    )}
                                  </td>
                                  {index === 0 ? (
                                    <td className="px-4 py-3" rowSpan={rowSpan}>
                                      <SearchableSelect
                                        actionDisabled={!expandedMarket.market}
                                        actionLabel={canAddAddressInFinalize ? 'Add new address' : undefined}
                                        emptyMessage={deliveryAddressOptions.length ? 'No matching addresses found.' : 'No addresses saved for this market yet.'}
                                        items={deliveryAddressOptions}
                                        label=""
                                        onAction={() => openAddAddressDialog(expandedMarket.id, asset.id, expandedMarket.market)}
                                        onValueChange={(value) =>
                                          updateCampaignAsset(expandedMarket.id, asset.id, (current) => ({
                                            ...current,
                                            deliveryAddress: value,
                                          }))
                                        }
                                        placeholder={deliveryAddressOptions.length ? 'Choose delivery address' : 'No addresses available'}
                                        selectedLabel={asset.deliveryAddress || ''}
                                        selectedValue={asset.deliveryAddress || ''}
                                      />
                                    </td>
                                  ) : null}
                                </tr>
                              );
                            })}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                </div>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog
        open={addMarketDialogOpen}
        onOpenChange={(open) => {
          setAddMarketDialogOpen(open);
          if (!open) {
            setEditingMarketId(null);
            setDraftMarket(null);
            setDraftMarketSummary(null);
            setDraftMarketLines([]);
          }
        }}
      >
        <DialogContent
          className="flex max-h-[90vh] flex-col gap-0 overflow-hidden p-0"
          style={{ width: 'min(calc(100vw - 2rem), 90rem)', maxHeight: '90vh' }}
        >
          <DialogHeader className="shrink-0 border-b border-slate-700 px-5 py-4">
            <DialogTitle>Add Market</DialogTitle>
          </DialogHeader>
          {draftMarket ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-3 text-[12px]">
              <div className="space-y-2.5">
                <div className="flex h-7 w-full overflow-hidden rounded-md border border-slate-600 bg-slate-800">
                  <span className="inline-flex w-28 shrink-0 items-center whitespace-nowrap border-r border-slate-600 px-2.5 text-[11px] font-semibold text-slate-300">Market</span>
                  <div className="relative flex-1">
                    <select
                      className="h-7 w-full appearance-none border-0 bg-transparent px-2.5 pr-9 text-[12px] text-slate-50 focus:outline-none focus:ring-0"
                      onChange={(event) =>
                        updateDraftMarket((current) => {
                          const value = event.target.value;
                          const preferredAddress = preferredDeliveryAddressByMarket.get(value) || '';
                          return {
                            ...current,
                            market: value,
                            quantityOverrides: undefined,
                            assets: current.assets.map((asset) => ({
                              ...asset,
                              assetId: '',
                              assetSearch: '',
                              deliveryAddress: preferredAddress,
                              selectedWeeks: [],
                              quantityOverrides: undefined,
                            })),
                          };
                        })
                      }
                      value={draftMarket.market}
                    >
                      {Array.from(new Set([draftMarket.market, ...remainingMarketNames].filter(Boolean))).map((marketName) => (
                        <option
                          key={`draft-market-option-${marketName}`}
                          value={marketName}
                          style={{ backgroundColor: '#1e293b', color: '#f8fafc' }}
                        >
                          {marketName}
                        </option>
                      ))}
                    </select>
                    <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 h-3 w-3 -translate-y-1/2 text-slate-400" />
                  </div>
                </div>

              <div className="space-y-2.5">
                  <div className="rounded-md border border-slate-700/80 bg-slate-900/45">
                    <div className="overflow-visible">
                      <table className="dense-table w-full table-fixed border-collapse">
                        <colgroup>
                          <col className="w-[2.4%]" />
                          <col className="w-[39.6%]" />
                          <col className="w-[44%]" />
                          <col className="w-[4%]" />
                        </colgroup>
                        <thead>
                          <tr className="border-b border-slate-700/80 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                            <th className="px-2 py-1.5 text-center">
                              <span className="sr-only">Reorder</span>
                            </th>
                            <th className="px-3 py-1.5 text-left">Asset</th>
                            <th className="px-3 py-1.5 text-left">Active Weeks</th>
                            <th className="px-2 py-1.5 text-center">
                              <span className="sr-only">Actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {draftMarket.assets.map((asset) => {
                            const canRemoveAsset = draftMarket.assets.length > 1;
                            const availableAssets = assetsForMarket(draftMarket.market);
                            const availableAssetOptions = assetOptionsFor(draftMarket, asset.id, asset.assetId);
                            const isDragging = draggingDraftAssetId === asset.id;
                            const isDragOver = dragOverDraftAssetId === asset.id && draggingDraftAssetId !== asset.id;
                            return (
                              <tr
                                key={asset.id}
                                className={cn(
                                  'border-b border-slate-700/70 align-top last:border-b-0',
                                  isDragging ? 'bg-slate-700/30 opacity-70' : '',
                                  isDragOver ? 'bg-violet-500/10 ring-1 ring-inset ring-violet-400/50' : '',
                                )}
                                onDragLeave={() => {
                                  if (dragOverDraftAssetId === asset.id) setDragOverDraftAssetId(null);
                                }}
                                onDragOver={(event) => {
                                  if (!draggingDraftAssetId || draggingDraftAssetId === asset.id) return;
                                  event.preventDefault();
                                  if (dragOverDraftAssetId !== asset.id) setDragOverDraftAssetId(asset.id);
                                }}
                                onDrop={(event) => {
                                  event.preventDefault();
                                  const sourceAssetId = draggingDraftAssetId || event.dataTransfer.getData('text/plain');
                                  if (!sourceAssetId || sourceAssetId === asset.id) {
                                    setDraggingDraftAssetId(null);
                                    setDragOverDraftAssetId(null);
                                    return;
                                  }
                                  reorderDraftAssets(sourceAssetId, asset.id);
                                  setDraggingDraftAssetId(null);
                                  setDragOverDraftAssetId(null);
                                }}
                              >
                                <td className="px-0 py-1.5 text-center align-middle">
                                  <button
                                    aria-label={`Reorder ${asset.assetSearch || 'asset'}`}
                                    className={cn(
                                      'mx-auto inline-flex h-6 w-6 cursor-grab items-center justify-center rounded border border-slate-700 bg-slate-900 text-slate-400 transition hover:border-slate-500 hover:text-slate-200',
                                      isDragging ? 'cursor-grabbing border-violet-400 text-violet-200' : '',
                                    )}
                                    draggable
                                    onDragEnd={() => {
                                      setDraggingDraftAssetId(null);
                                      setDragOverDraftAssetId(null);
                                    }}
                                    onDragStart={(event) => {
                                      event.dataTransfer.effectAllowed = 'move';
                                      event.dataTransfer.setData('text/plain', asset.id);
                                      setDraggingDraftAssetId(asset.id);
                                    }}
                                    type="button"
                                  >
                                    <GripVertical className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                                <td className="px-1 py-1.5">
                                  <SearchableSelect
                                    dialogTitle="Select asset"
                                    emptyMessage={availableAssets.length ? 'No assets available for this row.' : 'No assets available for this market.'}
                                    items={availableAssetOptions}
                                    label=""
                                    menuClassName="p-3"
                                    menuItemClassName="text-[10px]"
                                    onValueChange={(value) => {
                                      updateDraftAsset(asset.id, (current) => ({
                                        ...current,
                                        assetId: value,
                                        assetSearch: availableAssets.find((entry) => entry.id === value)?.label ?? '',
                                        quantityOverrides: undefined,
                                      }));
                                    }}
                                    placeholder={availableAssets.length ? 'Choose an asset' : 'No assets available'}
                                    pickerMode="dialog"
                                    selectedLabel={asset.assetSearch}
                                    selectedValue={asset.assetId}
                                    triggerClassName="h-7 text-[10px]"
                                  />
                                </td>
                                <td className="px-2 py-1.5">
                                  <div className="flex justify-start">
                                    <WeekSelector
                                      small
                                      weekCount={numberOfWeeks}
                                      startDate={values.campaignStartDate}
                                      onToggleWeek={(week) => toggleDraftAssetWeek(asset.id, week)}
                                      selectedWeeks={asset.selectedWeeks}
                                    />
                                  </div>
                                </td>
                                <td className="px-1 py-1.5 text-center">
                                  {canRemoveAsset ? (
                                    <Button className="h-6 w-6" onClick={() => removeDraftAsset(asset.id)} size="icon" type="button" variant="ghost">
                                      <X className="h-3 w-3 text-rose-300" />
                                    </Button>
                                  ) : null}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div title={canAddAssetForMarket(draftMarket) ? 'Add another asset' : addAssetDisabledReasonForMarket(draftMarket)}>
                    <Button className="h-8 min-w-[110px] px-3 text-[13px]" disabled={!canAddAssetForMarket(draftMarket)} onClick={addDraftAsset} type="button" variant="secondary">
                      <Plus className="h-3.5 w-3.5" />
                      Add Asset
                    </Button>
                  </div>

                  {draftMarketSummary ? (
                    <div className="overflow-x-auto rounded-md border border-slate-700 bg-slate-900/65">
                        {(() => {
                          const lineByAssetId = new Map(draftMarketLines.map((line) => [line.id, line]));
                          const visibleAssetFormatKeys = Array.from(new Set([
                            ...visibleBreakdownKeys(draftMarketSummary.breakdown),
                            ...Object.keys(draftMarket.quantityOverrides?.posters ?? {}),
                            ...draftMarket.assets.flatMap((asset) => Object.keys(asset.quantityOverrides?.posters ?? {})),
                          ])).filter((key) =>
                            breakdownValueForKey(draftMarketSummary.breakdown, key) > 0
                            || (draftMarket.quantityOverrides?.posters?.[key] ?? 0) > 0
                            || draftMarket.assets.some((asset) => (asset.quantityOverrides?.posters?.[key] ?? 0) > 0));
                          return (
                            <table className="dense-table min-w-[760px] w-full table-fixed border-collapse text-[12px]">
                              <thead>
                                <tr className="bg-slate-950 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-300">
                                  <th className="border border-slate-700 px-3 py-2 text-left">Asset</th>
                                  <th className="w-20 border border-slate-700 px-2 py-2 text-left">Type</th>
                                  {visibleAssetFormatKeys.map((key) => (
                                    <th key={`draft-asset-head-${key}`} className="border border-slate-700 px-2 py-2 text-center">{formatBreakdownKeyLabel(key, normalizedSheetNameOverrides)}</th>
                                  ))}
                                  <th className="border border-slate-700 px-3 py-2 text-center">Total</th>
                                </tr>
                              </thead>
                              <tbody>
                                {draftMarket.assets.flatMap((asset) => {
                                  const line = lineByAssetId.get(asset.id);
                                  const posterValues = visibleAssetFormatKeys.map((key) =>
                                    asset.quantityOverrides?.posters?.[key] ?? breakdownValueForKey(line?.breakdown ?? ({} as QuantityBreakdown), key));
                                  const frameValues = visibleAssetFormatKeys.map((key, index) => {
                                    const divisor = isKnownFormatKey(key) ? (formatToFrameDivisor[toCreativeFormatKey(key)] ?? 1) : 1;
                                    return Math.ceil(Math.max(0, posterValues[index]) / Math.max(1, divisor));
                                  });
                                  return [
                                    <tr key={`draft-asset-posters-${asset.id}`} className="border-t border-slate-700/70 bg-slate-800/70">
                                      <th className="border border-slate-700 px-3 py-2 text-left font-semibold text-slate-100" rowSpan={2}>
                                        {asset.assetSearch || line?.assetLabel || 'Asset not selected'}
                                      </th>
                                      <th className="border border-slate-700 px-2 py-2 text-left font-semibold text-slate-100">Posters</th>
                                      {visibleAssetFormatKeys.map((key, index) => (
                                        <td key={`draft-asset-poster-${asset.id}-${key}`} className="border border-slate-700 px-2 py-2 text-center font-semibold text-slate-100">
                                          {posterValues[index]}
                                        </td>
                                      ))}
                                      <td className="border border-slate-700 px-3 py-2 text-center font-black text-white">{posterValues.reduce((sum, value) => sum + value, 0)}</td>
                                    </tr>,
                                    <tr key={`draft-asset-frames-${asset.id}`} className="bg-slate-800/45">
                                      <th className="border border-slate-700 px-2 py-2 text-left font-semibold text-slate-300">Frames</th>
                                      {frameValues.map((value, index) => (
                                        <td key={`draft-asset-frame-${asset.id}-${visibleAssetFormatKeys[index]}`} className="border border-slate-700 px-2 py-1.5 text-center">
                                          <Input
                                            aria-label={`${asset.assetSearch || 'Asset'} Frames ${formatBreakdownKeyLabel(visibleAssetFormatKeys[index], normalizedSheetNameOverrides)}`}
                                            className="mx-auto h-7 min-w-0 rounded border-slate-600 bg-slate-950/70 px-1 text-center text-[12px] font-semibold text-white [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                            min={0}
                                            onChange={(event) => updateDraftAssetFrameOverride(asset.id, visibleAssetFormatKeys[index], event.target.value)}
                                            onFocus={(event) => event.currentTarget.select()}
                                            type="number"
                                            value={value}
                                          />
                                        </td>
                                      ))}
                                      <td className="border border-slate-700 px-3 py-2 text-center font-black text-slate-300">{frameValues.reduce((sum, value) => sum + value, 0)}</td>
                                    </tr>,
                                  ];
                                })}
                              </tbody>
                            </table>
                          );
                        })()}
                    </div>
                  ) : draftMarketCalculating ? (
                    <div className="flex items-center gap-2 rounded-md border border-slate-700 bg-slate-900/65 px-2.5 py-2 text-[12px] text-slate-300">
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin text-violet-300" />
                      Calculating asset counts...
                    </div>
                  ) : (
                    <p className="text-[12px] leading-4 text-slate-400">Configure assets in this market to see their sheet-level counts here.</p>
                  )}
                </div>
              </div>
            </div>
          ) : null}
          <div className="shrink-0 border-t border-slate-700 bg-slate-950 px-5 py-3.5">
            <div className="flex justify-end gap-3">
            <Button
              onClick={() => {
                setAddMarketDialogOpen(false);
                setEditingMarketId(null);
                setDraftMarket(null);
                setDraftMarketSummary(null);
                setDraftMarketLines([]);
              }}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              className="btn-theme-primary"
              disabled={!draftMarket?.market.trim() || (!editingMarketId && !canAddMarket)}
              onClick={handleSaveAddMarket}
              type="button"
            >
              Save
            </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={newAddressDialogOpen}
        onOpenChange={(open) => {
          setNewAddressDialogOpen(open);
          if (!open) {
            setNewAddressTarget(null);
            setNewAddressForm(emptyAddressForm());
            setNewAddressError('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Delivery Address</DialogTitle>
            <DialogDescription>
              Add a new delivery address for {newAddressTarget?.marketName || 'this market'}. This option is available to admin users only.
            </DialogDescription>
          </DialogHeader>
          {newAddressError ? (
            <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200">
              {newAddressError}
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="addr-name">Name</Label>
              <Input id="addr-name" value={newAddressForm.name} onChange={(event) => setNewAddressForm((current) => ({ ...current, name: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-unit-street-number">Unit/Street Number</Label>
              <Input
                id="addr-unit-street-number"
                value={newAddressForm.unitStreetNumber}
                onChange={(event) => setNewAddressForm((current) => ({ ...current, unitStreetNumber: event.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-suburb">Suburb</Label>
              <Input id="addr-suburb" value={newAddressForm.suburb} onChange={(event) => setNewAddressForm((current) => ({ ...current, suburb: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-state">State</Label>
              <Input id="addr-state" value={newAddressForm.state} onChange={(event) => setNewAddressForm((current) => ({ ...current, state: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-postcode">Postcode</Label>
              <Input id="addr-postcode" value={newAddressForm.postcode} onChange={(event) => setNewAddressForm((current) => ({ ...current, postcode: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-phone-number">Phone Number</Label>
              <Input id="addr-phone-number" value={newAddressForm.phoneNumber} onChange={(event) => setNewAddressForm((current) => ({ ...current, phoneNumber: event.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="addr-delivery-time">Delivery Time</Label>
              <Input id="addr-delivery-time" value={newAddressForm.deliveryTime} onChange={(event) => setNewAddressForm((current) => ({ ...current, deliveryTime: event.target.value }))} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="addr-delivery-point">Delivery Point</Label>
              <Input id="addr-delivery-point" value={newAddressForm.deliveryPoint} onChange={(event) => setNewAddressForm((current) => ({ ...current, deliveryPoint: event.target.value }))} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="addr-delivery-notes">Delivery Notes</Label>
              <Textarea id="addr-delivery-notes" rows={4} value={newAddressForm.deliveryNotes} onChange={(event) => setNewAddressForm((current) => ({ ...current, deliveryNotes: event.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Button
              onClick={() => {
                setNewAddressDialogOpen(false);
                setNewAddressTarget(null);
                setNewAddressForm(emptyAddressForm());
                setNewAddressError('');
              }}
              type="button"
              variant="ghost"
            >
              Cancel
            </Button>
            <Button onClick={handleSaveNewAddress} type="button">
              Save Address
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={previewArtworkDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setPreviewArtworkDialogOpen(true);
            return;
          }
          closeArtworkPreviewDialog();
        }}
      >
        <DialogContent style={{ width: '70vw', maxWidth: '70vw' }}>
          <DialogHeader>
            <DialogTitle>Artwork</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {previewArtworkImage ? (
              <>
                <div className="overflow-hidden rounded-md border border-slate-700 bg-slate-900">
                  <div className="max-h-[62vh] overflow-auto bg-slate-950/60 p-2">
                    {previewArtworkThumbnailSrc || previewArtworkFullSrc ? (
                      <div className="relative mx-auto w-fit">
                        {previewArtworkThumbnailSrc ? (
                          <img
                            alt={previewArtworkImage.name}
                            className={cn(
                              'mx-auto h-auto max-w-full rounded-sm transition-opacity duration-150',
                              previewArtworkFullLoaded ? 'opacity-0' : 'opacity-100',
                            )}
                            src={previewArtworkThumbnailSrc}
                          />
                        ) : null}
                        {previewArtworkFullSrc ? (
                          <img
                            alt={previewArtworkImage.name}
                            className={cn(
                              'mx-auto h-auto max-w-full rounded-sm transition-opacity duration-200',
                              previewArtworkThumbnailSrc ? 'absolute inset-0 opacity-0' : '',
                              previewArtworkFullLoaded ? 'opacity-100' : 'opacity-0',
                            )}
                            onLoad={() => setPreviewArtworkFullLoaded(true)}
                            src={previewArtworkFullSrc}
                          />
                        ) : null}
                      </div>
                    ) : (
                      <div className="flex min-h-[220px] items-center justify-center text-sm text-slate-400">
                        Preview unavailable
                      </div>
                    )}
                  </div>
                  <div className="border-t border-slate-700 px-3 py-2">
                    <p className="truncate text-sm font-semibold text-slate-100">{previewArtworkImage.name || previewArtworkImage.fileName}</p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button onClick={removeArtworkFromPreview} type="button" variant="destructive">
                    Remove
                  </Button>
                  <Button
                    className="btn-theme-primary"
                    onClick={openChangeArtworkFromPreview}
                    type="button"
                  >
                    Change
                  </Button>
                </div>
              </>
            ) : (
              <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-6 text-center text-sm text-slate-400">
                No artwork assigned.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={materialDialogOpen}
        onOpenChange={(open) => {
          if (!open) closeMaterialDialog();
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 54rem)', maxHeight: '90vh' }}>
          <DialogHeader>
            <DialogTitle>Material</DialogTitle>
          </DialogHeader>
          {(() => {
            const normalizedQuery = materialSearchQuery.trim().toLowerCase();
            const filteredMaterials = materials.filter((material) => !normalizedQuery || material.name.toLowerCase().includes(normalizedQuery));

            if (materialDialogMode === 'select') {
              return (
                <div className="space-y-3">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                    <Input className="h-9 border-slate-600 bg-slate-900 pl-9 text-slate-100" onChange={(event) => setMaterialSearchQuery(event.target.value)} placeholder="Search by material name" value={materialSearchQuery} />
                  </div>
                  {filteredMaterials.length > 0 ? (
                    <div className="max-h-[56vh] overflow-auto rounded-md border border-slate-700 bg-slate-900/65">
                      {filteredMaterials.map((material) => (
                        <button className="block w-full border-b border-slate-800 px-4 py-3 text-left text-sm font-medium text-slate-100 last:border-b-0 hover:bg-violet-500/10" key={material.id} onClick={() => selectMaterialForRecord(material.id)} type="button">{material.name}</button>
                      ))}
                    </div>
                  ) : <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-6 text-center text-sm text-slate-400">{materials.length === 0 ? 'No materials have been added on the Materials page yet.' : 'No matching materials found.'}</div>}
                  <div className="flex justify-end"><Button onClick={() => { setMaterialDialogMode('manage'); setMaterialSelectionRecordIndex(null); setMaterialSearchQuery(''); }} type="button" variant="ghost">Back</Button></div>
                </div>
              );
            }

            if (!materialTarget) return null;
            const usedFrames = multiMaterialRecords.reduce((sum, record) => sum + Math.max(0, Math.floor(record.frameCount || 0)), 0);
            const remainingFrames = Math.max(0, materialTarget.totalFrames - usedFrames);
            return (
              <div className="space-y-3">
                <div className="overflow-hidden rounded-md border border-slate-700 bg-slate-900/70">
                  <table className="w-full table-fixed border-collapse text-sm">
                    <colgroup><col /><col className="w-[150px]" /><col className="w-[150px]" /></colgroup>
                    <thead><tr className="bg-slate-950 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-300"><th className="border border-slate-700 px-3 py-2 text-left">Name</th><th className="border border-slate-700 px-3 py-2 text-center">Frame Count</th><th className="border border-slate-700 px-3 py-2 text-center">Action</th></tr></thead>
                    <tbody>
                      {multiMaterialRecords.map((record, index) => {
                        const material = materials.find((entry) => entry.id === record.materialId) ?? null;
                        const usedByOthers = multiMaterialRecords.reduce((sum, entry, entryIndex) => sum + (entryIndex === index ? 0 : Math.max(0, Math.floor(entry.frameCount || 0))), 0);
                        const maxForRow = Math.max(0, materialTarget.totalFrames - usedByOthers);
                        return (
                          <tr className="border-t border-slate-700/70 bg-slate-800/65" key={record.id}>
                            <td className="border border-slate-700 px-3 py-2 text-slate-100">{material?.name || 'No material assigned'}</td>
                            <td className="border border-slate-700 px-3 py-2"><Input className="h-8 border-slate-600 bg-slate-900 text-center text-slate-100" max={maxForRow} min={0} onChange={(event) => updateMultiMaterialRecord(index, { frameCount: Number.parseInt(event.target.value || '0', 10) || 0 })} type="number" value={record.frameCount} /></td>
                            <td className="border border-slate-700 px-3 py-2"><div className="flex items-center justify-center gap-2">
                              <Button aria-label={`Edit material for record ${index + 1}`} className="h-8 w-8 p-0" onClick={() => { setMaterialSelectionRecordIndex(index); setMaterialDialogMode('select'); }} type="button" variant={record.materialId ? 'outline' : 'secondary'}>{record.materialId ? <Pencil className="h-4 w-4" /> : <Plus className="h-4 w-4" />}</Button>
                              {record.materialId ? <Button aria-label={`Remove material from record ${index + 1}`} className="h-8 w-8 p-0" onClick={() => updateMultiMaterialRecord(index, { materialId: '' })} type="button" variant="destructive"><Trash2 className="h-4 w-4" /></Button> : null}
                              {multiMaterialRecords.length > 1 ? <Button aria-label={`Delete material record ${index + 1}`} className="h-8 w-8 p-0" onClick={() => removeMultiMaterialRecord(index)} type="button" variant="ghost"><X className="h-4 w-4" /></Button> : null}
                            </div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200">
                  <div className="space-y-1"><p>Total Frames: <span className="font-semibold text-white">{materialTarget.totalFrames}</span></p><p>Remaining Frames: <span className="font-semibold text-white">{remainingFrames}</span></p></div>
                  <Button className="btn-theme-primary" disabled={remainingFrames === 0} onClick={addMultiMaterialRecord} type="button"><Plus className="h-4 w-4" />Add Record</Button>
                  </div>
              </div>
            );
          })()}
        </DialogContent>
      </Dialog>

      <Dialog
        open={multiArtworkDialogOpen}
        onOpenChange={(open) => {
          setMultiArtworkDialogOpen(open);
          if (!open) {
            setMultiArtworkTarget(null);
            setMultiArtworkRecords([]);
            setMultiArtworkMaterialSelectionIndex(null);
            setMaterialSearchQuery('');
          }
        }}
      >
        <DialogContent style={{ width: '95vw', maxWidth: '95vw', maxHeight: '95vh' }}>
          <DialogHeader>
            <DialogTitle>Artwork &amp; Material</DialogTitle>
          </DialogHeader>
          {multiArtworkTarget ? (
            <div className="space-y-3">
              <div className="overflow-auto rounded-md border border-slate-700 bg-slate-900/70">
                <table className="w-full table-fixed border-collapse text-sm">
                  <colgroup>
                    <col className="w-[664px]" />
                    <col className="w-[170px]" />
                    <col className="w-[120px]" />
                    <col className="w-auto" />
                    <col className="w-[220px]" />
                    <col className="w-[90px]" />
                  </colgroup>
                  <thead>
                    <tr className="bg-slate-950 text-[11px] font-bold uppercase tracking-[0.15em] text-slate-300">
                      <th className="border border-slate-700 px-3 py-2 text-center">
                        <span className="whitespace-nowrap tracking-normal">Thumbnail</span>
                      </th>
                      <th className="border border-slate-700 px-3 py-2 text-left">Name</th>
                      <th className="border border-slate-700 px-3 py-2 text-center">Frame Count</th>
                      <th className="border border-slate-700 px-3 py-2 text-left">Artwork Filename</th>
                      <th className="border border-slate-700 px-3 py-2 text-left">Material</th>
                      <th className="border border-slate-700 px-3 py-2 text-center">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {multiArtworkRecords.map((record, index) => {
                      const slotImage = record.imageId ? values.printImages.find((image) => image.id === record.imageId) : null;
                      const thumbnailSrc = slotImage?.thumbnailUrl ? buildApiUrl(slotImage.thumbnailUrl) : (slotImage?.imageUrl ? buildApiUrl(slotImage.imageUrl) : '');
                      const artworkSrc = slotImage?.imageUrl ? buildApiUrl(slotImage.imageUrl) : thumbnailSrc;
                      const fileName = slotImage?.fileName || slotImage?.name || '-';
                      const assignedMaterial = materials.find((material) => material.id === record.materialId) ?? null;
                      const mappedCreativeName = record.imageId
                        ? Object.entries(resolvedCreativeNameAssignments).find(([, imageId]) => imageId === record.imageId)?.[0] || '-'
                        : '-';
                      const usedByOthers = multiArtworkRecords.reduce((sum, entry, entryIndex) => sum + (entryIndex === index ? 0 : Math.max(0, Math.floor(entry.frameCount || 0))), 0);
                      const maxForRow = Math.max(0, multiArtworkTarget.totalFrames - usedByOthers);
                      return (
                        <tr key={record.id} className="border-t border-slate-700/70 bg-slate-800/65">
                          <td className="border border-slate-700 px-3 py-2">
                            <div className="mx-auto w-[40rem] max-w-[calc(100vw-4rem)] overflow-hidden rounded-lg border border-violet-400/60 bg-slate-950 p-2">
                              {artworkSrc ? (
                                <img
                                  alt={slotImage?.name || slotImage?.fileName || `Slot ${index + 1} artwork`}
                                  className="max-h-[60vh] w-full rounded object-contain"
                                  loading="lazy"
                                  src={artworkSrc}
                                />
                              ) : null}
                            </div>
                          </td>
                          <td className="border border-slate-700 px-3 py-2 text-slate-100">
                            <p className="whitespace-normal break-all leading-snug">{mappedCreativeName}</p>
                          </td>
                          <td className="border border-slate-700 px-3 py-2">
                            <Input
                              className="h-8 border-slate-600 bg-slate-900 text-center text-slate-100"
                              max={maxForRow}
                              min={0}
                              onChange={(event) => {
                                const parsed = Number.parseInt(event.target.value || '0', 10);
                                updateMultiArtworkRecordFrameCount(index, Number.isFinite(parsed) ? parsed : 0);
                              }}
                              type="number"
                              value={record.frameCount}
                            />
                          </td>
                          <td className="border border-slate-700 px-3 py-2 text-slate-100">
                            <div className="flex items-center justify-between gap-2">
                              <p className="min-w-0 flex-1 whitespace-normal break-all leading-snug">{fileName}</p>
                              <Button
                                aria-label={`${record.imageId ? 'Change' : 'Assign'} artwork for record ${index + 1}`}
                                className="h-7 w-7 rounded-md border border-white/10 p-0 text-slate-200"
                                onClick={() => openAssignArtworkDialog(multiArtworkTarget.marketId, multiArtworkTarget.assetId, multiArtworkTarget.formatKey, index)}
                                title={`${record.imageId ? 'Change' : 'Assign'} artwork`}
                                type="button"
                                variant="ghost"
                              >
                                {record.imageId ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </td>
                          <td className="border border-slate-700 px-3 py-2 text-slate-100">
                            <div className="flex items-center justify-between gap-2">
                              <p className="min-w-0 flex-1 whitespace-normal break-words leading-snug">{assignedMaterial?.name || '-'}</p>
                              <Button
                                aria-label={`${record.materialId ? 'Change' : 'Assign'} material for record ${index + 1}`}
                                className="h-7 w-7 rounded-md border border-white/10 p-0 text-slate-200"
                                onClick={() => { setMultiArtworkMaterialSelectionIndex(index); setMaterialSearchQuery(''); }}
                                title={`${record.materialId ? 'Change' : 'Assign'} material`}
                                type="button"
                                variant="ghost"
                              >
                                {record.materialId ? <Pencil className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
                              </Button>
                            </div>
                          </td>
                          <td className="border border-slate-700 px-3 py-2 text-center">
                            <Button
                              aria-label={`Delete record ${index + 1}`}
                              className="h-7 w-7 rounded-md border border-white/10 p-0 text-rose-300"
                              onClick={() => removeMultiArtworkRecord(index)}
                              title={`Delete record ${index + 1}`}
                              type="button"
                              variant="ghost"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {(() => {
                const usedFrames = multiArtworkRecords.reduce((sum, record) => sum + Math.max(0, Math.floor(record.frameCount || 0)), 0);
                const remainingFrames = Math.max(0, multiArtworkTarget.totalFrames - usedFrames);
                return (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between rounded-md border border-slate-700 bg-slate-900/60 px-3 py-2 text-sm text-slate-200">
                      <div className="space-y-1">
                        <p>Total Frames: <span className="font-semibold text-white">{multiArtworkTarget.totalFrames}</span></p>
                        <p>Remaining Frames: <span className="font-semibold text-white">{remainingFrames}</span></p>
                      </div>
                      <Button
                        className="btn-theme-primary"
                        disabled={remainingFrames === 0}
                        onClick={addMultiArtworkRecord}
                        type="button"
                      >
                        <Plus className="h-4 w-4" />
                        Add Record
                      </Button>
                    </div>
                  </div>
                );
              })()}
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={multiArtworkMaterialSelectionIndex !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMultiArtworkMaterialSelectionIndex(null);
            setMaterialSearchQuery('');
          }
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 42rem)', maxHeight: '85vh' }}>
          <DialogHeader>
            <DialogTitle>Choose Material</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="h-9 border-slate-600 bg-slate-900 pl-9 text-slate-100" onChange={(event) => setMaterialSearchQuery(event.target.value)} placeholder="Search by material name" value={materialSearchQuery} />
            </div>
            <div className="max-h-[55vh] overflow-auto rounded-md border border-slate-700 bg-slate-900/65">
              {materials.filter((material) => !materialSearchQuery.trim() || material.name.toLowerCase().includes(materialSearchQuery.trim().toLowerCase())).map((material) => (
                <button
                  className="block w-full border-b border-slate-800 px-4 py-3 text-left text-sm font-medium text-slate-100 last:border-b-0 hover:bg-violet-500/10"
                  key={material.id}
                  onClick={() => {
                    if (multiArtworkMaterialSelectionIndex !== null) updateMultiArtworkRecordMaterial(multiArtworkMaterialSelectionIndex, material.id);
                    setMultiArtworkMaterialSelectionIndex(null);
                    setMaterialSearchQuery('');
                  }}
                  type="button"
                >
                  {material.name}
                </button>
              ))}
              {materials.length === 0 ? <div className="px-4 py-6 text-center text-sm text-slate-400">No materials have been added on the Materials page yet.</div> : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={assignArtworkDialogOpen}
        onOpenChange={(open) => {
          if (open) {
            setAssignArtworkDialogOpen(true);
            return;
          }
          closeAssignArtworkDialog();
        }}
      >
        <DialogContent style={{ width: '95vw', maxWidth: '95vw', maxHeight: '95vh' }}>
          <DialogHeader>
            <DialogTitle>Artwork</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="relative min-w-[220px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input
                className="h-9 border-slate-600 bg-slate-900 pl-9 text-slate-100 placeholder:text-slate-500 focus-visible:border-violet-400 focus-visible:ring-violet-400/70"
                onChange={(event) => setArtworkSearchQuery(event.target.value)}
                placeholder={assignArtworkTarget !== null ? 'Search by file name' : 'Search by creative or file name'}
                value={artworkSearchQuery}
              />
            </div>
            {artworkDialogError ? (
              <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200">
                {artworkDialogError}
              </div>
            ) : null}
            {isSubCampaign ? (
              <div className="rounded-md border border-sky-400/30 bg-sky-500/10 px-3 py-2 text-sm font-medium text-sky-100">
                Artwork deletion is disabled for sub campaigns because these files may also be referenced by the parent campaign.
              </div>
            ) : null}
            {values.printImages.length > 0 ? (
              <div className="min-h-[calc(95vh-9rem)] max-h-[calc(95vh-9rem)] overflow-auto rounded-lg border border-slate-700 bg-slate-950/70 p-3">
                <div className="min-h-full space-y-3">
                  {filteredCreativeNames.map((creativeName) => {
                    const mappedImageId = resolvedCreativeNameAssignments[creativeName] || '';
                    const mappedImage = mappedImageId ? artworkImageById.get(mappedImageId) ?? null : null;
                    const artworkSrc = mappedImage?.imageUrl || mappedImage?.thumbnailUrl ? buildApiUrl(mappedImage.imageUrl || mappedImage.thumbnailUrl || '') : '';
                    const artworkCode = mappedImageId ? values.artworkCodes?.[mappedImageId] ?? '' : '';
                    const isSwapFeedbackRow = recentCreativeSwap?.source === creativeName || recentCreativeSwap?.target === creativeName;
                    const selectedAssignmentMarketId = artworkAssignmentMarketByCreativeName[creativeName] || defaultArtworkAssignmentMarketByCreativeName[creativeName] || '';
                    const selectedAssignmentMarket = values.campaignMarkets.find((market) => market.id === selectedAssignmentMarketId) ?? values.campaignMarkets[0] ?? null;
                    const selectedArtworkAssetKeys = mappedImageId ? artworkAssignedAssetKeySetByImageId.get(mappedImageId) ?? new Set<string>() : new Set<string>();
                    return (
                      <div
                        key={`creative-name-row-${creativeName}`}
                        className={cn(
                          'grid gap-4 rounded-lg border border-slate-700/80 bg-slate-900/70 p-3 transition-colors duration-500 ease-out lg:grid-cols-[16rem_12rem_minmax(24rem,1fr)_24rem]',
                          isSwapFeedbackRow ? 'border-violet-400/50 bg-violet-500/10' : '',
                          creativeDropTarget?.name === creativeName && creativeDropTarget.position === 'above' ? 'border-t-2 border-t-violet-400' : '',
                          creativeDropTarget?.name === creativeName && creativeDropTarget.position === 'below' ? 'border-b-2 border-b-violet-400' : '',
                          draggingCreativeName ? 'bg-slate-900/85' : '',
                        )}
                        onDragOver={(event) => {
                          if (!draggingCreativeName || draggingCreativeName === creativeName) return;
                          event.preventDefault();
                          event.dataTransfer.dropEffect = 'move';
                          const rect = event.currentTarget.getBoundingClientRect();
                          const position = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                          if (creativeDropTarget?.name !== creativeName || creativeDropTarget.position !== position) {
                            setCreativeDropTarget({ name: creativeName, position });
                          }
                        }}
                        onDrop={(event) => {
                          event.preventDefault();
                          const sourceCreativeName = event.dataTransfer.getData('text/plain');
                          if (!sourceCreativeName || sourceCreativeName === creativeName) return;
                          const rect = event.currentTarget.getBoundingClientRect();
                          const position = event.clientY < rect.top + rect.height / 2 ? 'above' : 'below';
                          reorderCreativeAssignments(sourceCreativeName, creativeName, position);
                          setDraggingCreativeName(null);
                          setCreativeDropTarget(null);
                        }}
                      >
                        <div className="flex min-w-0 flex-col justify-between gap-3 rounded-md border border-slate-700/70 bg-slate-950/55 p-3">
                          <div className="min-w-0 space-y-3">
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Name</p>
                              <p className="mt-1 break-words text-sm font-semibold text-slate-100">{creativeName}</p>
                            </div>
                            <div>
                              <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">File</p>
                              {editingCreativeFileName === creativeName ? (
                                <div className="mt-2 space-y-2">
                                  <select
                                    aria-label={`Change artwork file for ${creativeName}`}
                                    className="h-9 w-full rounded-md border border-slate-700 bg-slate-900 px-2 text-xs font-medium text-slate-100 outline-none transition focus:border-violet-300/70 focus:ring-1 focus:ring-violet-300/35"
                                    onChange={(event) => changeCreativeArtworkFile(creativeName, event.target.value)}
                                    value={mappedImageId}
                                  >
                                    {values.printImages.map((image) => (
                                      <option className="bg-slate-950 text-slate-100" key={`creative-file-option-${creativeName}-${image.id}`} value={image.id}>
                                        {image.name || image.fileName || `Artwork ${image.id.slice(0, 6)}`}
                                      </option>
                                    ))}
                                  </select>
                                  <Button
                                    className="h-7 rounded-md border border-white/10 px-2 text-xs text-slate-300"
                                    onClick={() => setEditingCreativeFileName(null)}
                                    type="button"
                                    variant="ghost"
                                  >
                                    Cancel
                                  </Button>
                                </div>
                              ) : (
                                <div className="mt-1 flex items-start justify-between gap-2">
                                  <p className="min-w-0 break-words text-xs leading-5 text-slate-300">
                                    {mappedImage ? mappedImage.name || mappedImage.fileName : 'No artwork mapped'}
                                  </p>
                                  <Button
                                    aria-label={`Change artwork file for ${creativeName}`}
                                    className="h-7 w-7 shrink-0 rounded-md border border-white/10 p-0 text-slate-200"
                                    disabled={values.printImages.length <= 1}
                                    onClick={() => setEditingCreativeFileName(creativeName)}
                                    title={values.printImages.length > 1 ? 'Change file' : 'Upload another artwork file to change'}
                                    type="button"
                                    variant="ghost"
                                  >
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              )}
                            </div>
                          </div>
                          {mappedImage && !isSubCampaign ? (
                            <Button
                              className={cn(
                                'h-8 w-8 self-start rounded-md border p-0',
                                assignedArtworkIdSet.has(mappedImage.id)
                                  ? 'cursor-not-allowed border-slate-800 bg-slate-900/70 text-slate-600 hover:bg-slate-900/70 hover:text-slate-600'
                                  : 'border-slate-700 bg-slate-950/90 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100',
                              )}
                              disabled={deletingArtworkIds.includes(mappedImage.id) || assignedArtworkIdSet.has(mappedImage.id)}
                              onClick={() => void handleDeleteArtwork(mappedImage)}
                              size="icon"
                              title="Delete artwork"
                              type="button"
                              variant="ghost"
                            >
                              {deletingArtworkIds.includes(mappedImage.id)
                                ? <LoaderCircle className="h-3.5 w-3.5 animate-spin text-violet-300" />
                                : <Trash2 className="h-3.5 w-3.5" />}
                            </Button>
                          ) : null}
                        </div>
                        <div className="flex min-w-0 flex-col rounded-md border border-slate-700/70 bg-slate-950/55 p-3">
                          <Label className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500" htmlFor={`artwork-code-${mappedImageId || creativeName}`}>Code</Label>
                          <Textarea
                            className="mt-2 h-[4.5rem] min-h-[4.5rem] resize-none whitespace-pre-wrap border-slate-600 bg-slate-900 text-slate-100"
                            disabled={!mappedImageId || isSubmittedCampaign}
                            id={`artwork-code-${mappedImageId || creativeName}`}
                            maxLength={80}
                            onChange={(event) => updateArtworkCode(mappedImageId, event.target.value)}
                            placeholder="Code"
                            value={artworkCode}
                          />
                        </div>
                        <button
                          className={cn(
                            'flex min-w-0 items-center justify-center rounded-md border border-slate-700 bg-slate-950/45 p-3 text-left transition hover:border-violet-300/45 hover:bg-slate-950/70',
                            assignArtworkTarget !== null ? 'cursor-pointer' : '',
                          )}
                          draggable={Boolean(mappedImageId)}
                          onClick={() => {
                            if (assignArtworkTarget !== null && mappedImageId) {
                              assignArtworkImageToTarget(mappedImageId);
                            }
                          }}
                          onDragEnd={() => {
                            setDraggingCreativeName(null);
                            setCreativeDropTarget(null);
                          }}
                          onDragStart={(event) => {
                            if (!mappedImageId) return;
                            event.dataTransfer.setData('text/plain', creativeName);
                            event.dataTransfer.effectAllowed = 'move';
                            setDraggingCreativeName(creativeName);
                          }}
                          type="button"
                        >
                          <div className="w-[40rem] max-w-full overflow-hidden rounded-lg border border-violet-400/60 bg-slate-950 p-2 shadow-[0_16px_42px_rgba(2,6,23,0.28)]">
                            {artworkSrc ? (
                              <img
                                alt={mappedImage?.name || mappedImage?.fileName || creativeName}
                                className="max-h-[60vh] w-full rounded object-contain"
                                loading="lazy"
                                src={artworkSrc}
                              />
                            ) : (
                              <div className="flex min-h-[18rem] items-center justify-center rounded border border-dashed border-slate-700 px-4 text-center text-sm text-slate-400">No artwork mapped</div>
                            )}
                          </div>
                        </button>
                        <div className="flex min-h-[18rem] min-w-0 flex-col rounded-md border border-slate-700/70 bg-slate-950/55 p-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">Assign To Assets</p>
                          {values.campaignMarkets.length > 0 ? (
                            <div className="mt-2 flex min-h-0 flex-1 flex-col gap-2">
                              <select
                                aria-label={`Choose market for ${creativeName}`}
                                className="h-9 w-full shrink-0 rounded-md border border-slate-700 bg-slate-900 px-2 text-xs font-medium text-slate-100 outline-none transition focus:border-violet-300/70 focus:ring-1 focus:ring-violet-300/35"
                                onChange={(event) =>
                                  setArtworkAssignmentMarketByCreativeName((current) => ({
                                    ...current,
                                    [creativeName]: event.target.value,
                                  }))
                                }
                                value={selectedAssignmentMarket?.id || ''}
                              >
                                {values.campaignMarkets.map((market) => (
                                  <option className="bg-slate-950 text-slate-100" key={`artwork-assignment-market-${creativeName}-${market.id}`} value={market.id}>
                                    {market.market || 'Unnamed market'}
                                  </option>
                                ))}
                              </select>
                              {selectedAssignmentMarket && selectedAssignmentMarket.assets.length > 0 ? (
                                <div className="min-h-0 flex-1 space-y-1 overflow-auto rounded-md border border-slate-800 bg-slate-900/60 p-2 lg:max-h-[60vh]">
                                  {selectedAssignmentMarket.assets.map((asset) => {
                                    const assetKey = `${selectedAssignmentMarket.id}\x00${asset.id}`;
                                    return (
                                      <label
                                        className="flex items-start gap-2 rounded px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800/70"
                                        key={`artwork-assignment-asset-${creativeName}-${selectedAssignmentMarket.id}-${asset.id}`}
                                      >
                                        <input
                                          checked={selectedArtworkAssetKeys.has(assetKey)}
                                          className="mt-0.5 h-3.5 w-3.5 accent-violet-400"
                                          disabled={!mappedImageId}
                                          onChange={(event) => setArtworkAssetAssignment(selectedAssignmentMarket.id, asset.id, mappedImageId, event.target.checked)}
                                          type="checkbox"
                                        />
                                        <span className="min-w-0 break-words">{asset.assetSearch || asset.assetId || 'Asset not selected'}</span>
                                      </label>
                                    );
                                  })}
                                </div>
                              ) : (
                                <p className="rounded-md border border-dashed border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-500">No assets in this market.</p>
                              )}
                            </div>
                          ) : (
                            <p className="mt-1 text-xs leading-5 text-slate-500">Add a market before assigning artwork.</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {filteredCreativeNames.length === 0 ? (
                    <div className="flex min-h-[calc(95vh-11rem)] items-center justify-center rounded-md border border-dashed border-slate-700 bg-slate-900/70 px-4 py-8 text-center text-sm text-slate-400">
                      No artwork matches this search.
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-6 text-center text-sm text-slate-400">
                No artwork uploaded yet. Upload PDFs to generate selectable thumbnails.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={uploadManagerOpen}
        onOpenChange={(open) => {
          setUploadManagerOpen(open);
          if (!open) setIsDraggingArtworkFiles(false);
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 44rem)', maxHeight: '90vh' }}>
          <DialogHeader>
            <DialogTitle>Upload Manager</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2">
              <div className="text-sm text-slate-300">
                {uploadingArtworkPages
                  ? pendingArtworkUploadCount > 0
                    ? `Uploading in progress (${pendingArtworkUploadCount} queued)`
                    : 'Uploading in progress'
                  : 'No active uploads'}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void openOneDriveImportDialog()} type="button" variant="secondary">
                  Import from OneDrive
                </Button>
                <Button onClick={openArtworkPdfPicker} type="button" variant="secondary">
                  {uploadingArtworkPages ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : <Upload className="h-4 w-4" />}
                  {uploadingArtworkPages || hasChosenArtworkInSession ? 'Choose More PDFs' : 'Choose PDFs'}
                </Button>
              </div>
            </div>

            <button
              className={cn(
                'flex w-full flex-col items-center justify-center rounded-md border-2 border-dashed px-4 py-7 text-center transition',
                isDraggingArtworkFiles
                  ? 'border-violet-400 bg-violet-500/15 text-violet-100'
                  : 'border-slate-600 bg-slate-900/70 text-slate-300 hover:border-violet-400/70 hover:bg-slate-800/80',
              )}
              onClick={openArtworkPdfPicker}
              onDragEnter={handleArtworkDragOver}
              onDragLeave={handleArtworkDragLeave}
              onDragOver={handleArtworkDragOver}
              onDrop={handleArtworkDrop}
              type="button"
            >
              <Upload className={cn('mb-2 h-7 w-7', isDraggingArtworkFiles ? 'text-violet-300' : 'text-slate-400')} />
              <span className="text-sm font-semibold">
                {isDraggingArtworkFiles ? 'Drop PDFs to upload' : 'Drag and drop PDFs here'}
              </span>
              <span className="mt-1 text-xs text-slate-400">or click to choose multiple files</span>
            </button>

            {artworkDialogError ? (
              <p className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
                {artworkDialogError}
              </p>
            ) : null}

            {queuedArtworkFileNames.length > 0 ? (
              <div className="rounded-md border border-slate-700 bg-slate-950/70 px-3 py-2">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Queued Files ({queuedArtworkFileNames.length})
                </p>
                <div className="mt-1 max-h-44 space-y-1 overflow-auto">
                  {queuedArtworkFileNames.map((fileName, index) => (
                    <div key={`upload-manager-queued-file-${index}-${fileName}`} className="flex items-center gap-2">
                      <p className="min-w-0 flex-1 truncate text-xs text-slate-400" title={fileName}>
                        {index + 1}. {fileName}
                      </p>
                      <Button
                        aria-label={`Remove queued file ${fileName}`}
                        className="h-6 w-6 rounded-full border border-slate-700 p-0 text-slate-300 hover:text-white"
                        onClick={() => removeQueuedArtworkFileAt(index)}
                        size="icon"
                        type="button"
                        variant="ghost"
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-4 text-sm text-slate-400">
                No queued files. Choose PDFs to add them here.
              </div>
            )}
            <div className="flex justify-end">
              <Button
                className="border-violet-500 bg-violet-500 text-white hover:bg-violet-400"
                onClick={() => setUploadManagerOpen(false)}
                type="button"
                variant="secondary"
              >
                Continue
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <OneDriveArtworkImportDialog
        onImport={handleOneDriveImport}
        onOpenChange={setOneDriveImportOpen}
        open={oneDriveImportOpen}
      />

      <Dialog
        open={manageUploadsOpen}
        onOpenChange={(open) => {
          setManageUploadsOpen(open);
          if (!open) setManageUploadsError('');
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 54rem)', maxHeight: '90vh' }}>
          <DialogHeader>
            <DialogTitle>Manage Uploads</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {manageUploadsError ? (
              <div className="rounded-md border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm font-medium text-rose-200">
                {manageUploadsError}
              </div>
            ) : null}

            <section className="space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">Purchase Order</h3>
              </div>
              {uploadedPurchaseOrder ? (
                <div className="overflow-hidden rounded-md border border-slate-700 bg-slate-900/65">
                  <table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col />
                      <col className="w-[110px]" />
                      <col className="w-[180px]" />
                      <col className="w-[90px]" />
                    </colgroup>
                    <thead>
                      <tr className="bg-slate-950/90 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">
                        <th className="border-b border-slate-700 px-3 py-2 text-left">File</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-left">Size</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-left">Uploaded</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t border-slate-800">
                        <td className="px-3 py-3">
                          <p className="truncate font-semibold text-slate-100" title={uploadedPurchaseOrder.originalName}>{uploadedPurchaseOrder.originalName}</p>
                          <p className="truncate text-xs text-slate-500" title={uploadedPurchaseOrder.mimeType}>{uploadedPurchaseOrder.mimeType || 'application/octet-stream'}</p>
                        </td>
                        <td className="px-3 py-3 text-slate-300">{formatFileSize(uploadedPurchaseOrder.size)}</td>
                        <td className="px-3 py-3 text-slate-300">{formatUploadDate(uploadedPurchaseOrder.uploadedAt)}</td>
                        <td className="px-3 py-3 text-center">
                          <Button
                            aria-label="Download purchase order"
                            className="h-8 w-8 p-0"
                            disabled={downloadingPurchaseOrder}
                            onClick={() => void handleDownloadUploadedPurchaseOrder()}
                            type="button"
                            variant="outline"
                          >
                            {downloadingPurchaseOrder ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          </Button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-5 text-center text-sm text-slate-400">
                  No purchase order uploaded yet.
                </div>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-100">Supporting Documents</h3>
              {(values.supportingDocuments?.length ?? 0) > 0 ? (
                <div className="max-h-[38vh] overflow-auto rounded-md border border-slate-700 bg-slate-900/65">
                  <table className="w-full table-fixed text-sm">
                    <colgroup>
                      <col />
                      <col className="w-[110px]" />
                      <col className="w-[180px]" />
                      <col className="w-[90px]" />
                    </colgroup>
                    <thead>
                      <tr className="bg-slate-950/90 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-300">
                        <th className="border-b border-slate-700 px-3 py-2 text-left">File</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-left">Size</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-left">Uploaded</th>
                        <th className="border-b border-slate-700 px-3 py-2 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(values.supportingDocuments ?? []).map((document) => (
                        <tr className="border-t border-slate-800" key={document.storedName}>
                          <td className="px-3 py-3">
                            <p className="truncate font-semibold text-slate-100" title={document.originalName}>{document.originalName}</p>
                            <p className="truncate text-xs text-slate-500" title={document.mimeType}>{document.mimeType || 'application/octet-stream'}</p>
                          </td>
                          <td className="px-3 py-3 text-slate-300">{formatFileSize(document.size)}</td>
                          <td className="px-3 py-3 text-slate-300">{formatUploadDate(document.uploadedAt)}</td>
                          <td className="px-3 py-3 text-center">
                            <Button
                              aria-label={`Download ${document.originalName}`}
                              className="h-8 w-8 p-0"
                              disabled={Boolean(downloadingSupportingDocumentName)}
                              onClick={() => void handleDownloadSupportingDocument(document)}
                              type="button"
                              variant="outline"
                            >
                              {downloadingSupportingDocumentName === document.storedName ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="rounded-md border border-slate-700 bg-slate-900 px-4 py-5 text-center text-sm text-slate-400">
                  No supporting documents uploaded yet.
                </div>
              )}
            </section>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={unsavedDialogOpen}
        onOpenChange={(open) => {
          if (open) setUnsavedDialogOpen(true);
        }}
      >
        <DialogContent
          className="[&>button]:hidden"
          onEscapeKeyDown={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
        >
          <DialogHeader>
            <DialogTitle>Unsaved Changes</DialogTitle>
            <DialogDescription>
              You have unsaved changes. Save before going to dashboard, or discard and continue.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-3">
            <Button disabled={savingCampaign} onClick={() => setUnsavedDialogOpen(false)} type="button" variant="ghost">
              Stay
            </Button>
            <Button disabled={savingCampaign} onClick={handleDiscardAndLeave} type="button" variant="secondary">
              Discard
            </Button>
            <Button disabled={savingCampaign} onClick={() => void handleSaveAndLeave()} type="button">
              {savingCampaign ? <LoaderCircle className="h-4 w-4 animate-spin text-violet-300" /> : null}
              {savingCampaign ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(visualsDownloadError)}
        onOpenChange={(open) => {
          if (!open) setVisualsDownloadError('');
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleAlert className="h-5 w-5 text-rose-300" />
              Unable to Download Visuals
            </DialogTitle>
            <DialogDescription className="break-words text-left">{visualsDownloadError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
              onClick={() => setVisualsDownloadError('')}
              type="button"
              variant="secondary"
            >
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(installDownloadError)}
        onOpenChange={(open) => {
          if (!open) setInstallDownloadError('');
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CircleAlert className="h-5 w-5 text-rose-300" />
              Unable to Download Installation Sheet
            </DialogTitle>
            <DialogDescription className="break-words text-left">{installDownloadError}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button onClick={() => setInstallDownloadError('')} type="button" variant="secondary">
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={purchaseOrderUploadSuccessOpen}
        onOpenChange={setPurchaseOrderUploadSuccessOpen}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
          <DialogHeader>
            <DialogTitle>Purchase Order Uploaded</DialogTitle>
            <DialogDescription>{purchaseOrderUploadSuccessMessage || 'Purchase order file uploaded successfully.'}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
              onClick={() => setPurchaseOrderUploadSuccessOpen(false)}
              type="button"
              variant="secondary"
            >
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(quoteResponseMessage)}
        onOpenChange={(open) => {
          if (!open) setQuoteResponseMessage('');
        }}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {quoteResponseStatus === 'error' ? (
                <CircleAlert className="h-5 w-5 text-rose-300" />
              ) : (
                <Check className="h-5 w-5 text-emerald-300" />
              )}
              {quoteResponseStatus === 'error' ? 'Unable to Submit Order' : 'Order Submitted'}
            </DialogTitle>
            <DialogDescription>{quoteResponseMessage}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
              onClick={() => setQuoteResponseMessage('')}
              type="button"
              variant="secondary"
            >
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        cancelLabel={pendingSubmitOptions?.test ? 'Cancel' : 'No'}
        confirmLabel={pendingSubmitOptions?.test ? 'Submit Test Order' : 'Yes'}
        confirming={isPrintIQSubmitting}
        confirmingLabel={pendingSubmitOptions?.test ? 'Submitting Test...' : 'Submitting...'}
        description={
          pendingSubmitOptions?.test
            ? `Submit a test order for "${truncateForDialog(activeCampaignName, 72)}" to PrintIQ? The campaign will not be marked submitted.`
            : 'Do you want to submit?'
        }
        descriptionClassName={
          pendingSubmitOptions?.test
            ? undefined
            : 'break-words whitespace-normal text-left text-lg font-semibold text-white sm:text-xl'
        }
        onCancel={cancelSubmitConfirmation}
        onConfirm={() => void confirmSubmitQuote()}
        open={submitConfirmationOpen}
        title={pendingSubmitOptions?.test ? 'Submit Test Order to PrintIQ' : ''}
        warningText={
          pendingSubmitOptions?.test
            ? 'This will create a test order in PrintIQ. Review the campaign, artwork, and purchase order before continuing.'
            : ''
        }
      />

      <Dialog
        open={artworkUploadSuccessOpen}
        onOpenChange={setArtworkUploadSuccessOpen}
      >
        <DialogContent style={{ width: 'min(calc(100vw - 2rem), 30rem)' }}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Check className="h-4 w-4 text-emerald-300" />
              Artwork Upload Complete
            </DialogTitle>
            <DialogDescription>{artworkUploadSuccessMessage || 'Artwork files uploaded successfully.'}</DialogDescription>
          </DialogHeader>
          <div className="flex justify-end">
            <Button
              onClick={() => setArtworkUploadSuccessOpen(false)}
              type="button"
              variant="secondary"
            >
              OK
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmationDialog
        cancelLabel="Keep Artwork"
        confirmLabel="Delete Artwork"
        confirming={confirmingArtworkDelete}
        description={
          deleteArtworkCandidate
            ? `Delete "${truncateForDialog(deleteArtworkCandidate.name || deleteArtworkCandidate.fileName || 'this artwork')}"? This permanently removes the file from storage.`
            : ''
        }
        onCancel={cancelDeleteArtwork}
        onConfirm={() => void confirmDeleteArtwork()}
        open={Boolean(deleteArtworkCandidate)}
        title="Delete Artwork"
      />
    </main>
  );
}
