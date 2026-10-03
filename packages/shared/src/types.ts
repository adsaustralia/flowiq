export const formatKeys = ['8-sheet', '6-sheet', '4-sheet', '2-sheet', 'QA0', 'Mega', 'DOT M', 'MP', 'FF'] as const;

export type FormatKey = (typeof formatKeys)[number];

export type QuantityBreakdown = Record<string, number>;

export type PrintIqStockOption = {
  value: string;
  label: string;
  description?: string;
};

export type AuthRole = 'super_admin' | 'admin' | 'user';
export type CampaignStatus = 'in_progress' | 'submitted';

export type AuthUser = {
  id: string;
  email: string;
  name: string;
  role: AuthRole;
  tenantId: string | null;
  tenantName: string | null;
  active: boolean;
};

export type AuthSession = {
  token: string;
  user: AuthUser;
};

export type TenantRecord = {
  type?: 'A' | 'B';
  id: string;
  name: string;
  code: string;
  userCount?: number;
  campaignCount?: number;
  createdAt?: string;
};

export type SheetNameOverrides = Record<string, string>;

export type SheetNameOverrideRecord = {
  tenantId: string;
  overrides: SheetNameOverrides;
  multipleArtworkFormats?: Record<string, boolean>;
  customPrintCostFormats?: Record<string, boolean>;
  customSheetSizeFormats?: Record<string, boolean>;
  productCodes?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type MaterialInput = {
  id?: string;
  name: string;
  isDefault: boolean;
};

export type MaterialRecord = {
  id: string;
  tenantId: string;
  name: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
};

export type MaterialMappingInput = {
  market: string;
  sheetKey: string;
  productCode: string;
  sheetCode: string;
};

export type MaterialMappingRecord = MaterialMappingInput & {
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type CustomPrintCostInput = {
  sheetKey: string;
  onePageCost: number;
  twoPageCost: number;
  fivePageCost: number;
  tenPlusPageCost: number;
};

export type CustomPrintCostRecord = CustomPrintCostInput & {
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type PrintIqOptionsCacheBucket = {
  cached: boolean;
  count: number;
  updatedAt: string | null;
};

export type PrintIqOptionsCacheStatus = {
  stocks: PrintIqOptionsCacheBucket;
  processes: PrintIqOptionsCacheBucket;
};

export type ContactDetails = {
  title: string;
  firstName: string;
  surname: string;
  email: string;
};

export type ArtworkMaterialAssignment = {
  artworkImageId: string;
  materialId: string;
  frameCount: number;
};

export type CampaignAsset = {
  id: string;
  assetId: string;
  assetSearch: string;
  selectedWeeks: number[];
  creativeImageId: string;
  creativeImageIds?: Record<string, string>;
  artworkMaterialAssignments?: Record<string, ArtworkMaterialAssignment[]>;
  quantityOverrides?: {
    posters?: Record<string, number>;
  };
  deliveryAddress: string;
};

export type CampaignMarket = {
  dueDate: string;
  id: string;
  market: string;
  assets: CampaignAsset[];
  quantityOverrides?: {
    posters?: Record<string, number>;
    frames?: Record<string, number>;
  };
};

export type CampaignPrintImage = {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  storedName?: string;
  imageUrl?: string;
  thumbnailFileName?: string;
  thumbnailStoredName?: string;
  thumbnailUrl?: string;
  previewFileName?: string;
  previewStoredName?: string;
  previewUrl?: string;
  sourcePdfFileName?: string;
  sourcePdfStoredName?: string;
  sourcePdfUrl?: string;
  sourcePdfPageNumber?: number;
  sourcePdfPageCount?: number;
};

export type CampaignLine = CampaignAsset & {
  market: string;
  marketQuantityOverrides?: CampaignMarket['quantityOverrides'];
};

export type MarketAssetOption = {
  id: string;
  market: string;
  asset: string;
  label: string;
  state: string;
  maintenanceAssetId?: string | null;
  isMaintenance?: boolean;
  quantities: QuantityBreakdown;
};

export type MarketMetadata = {
  name: string;
  assets: MarketAssetOption[];
};

export type CalculatorMappingInput = {
  market: string;
  asset: string;
  label: string;
  state: string;
  maintenanceAssetId?: string | null;
  quantities: QuantityBreakdown;
};

export type CalculatorMappingRecord = CalculatorMappingInput & {
  id: string;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketDeliveryAddressInput = {
  market: string;
  deliveryAddress: string;
  isDefault?: boolean;
};

export type MarketDeliveryAddressRecord = {
  market: string;
  deliveryAddress: string;
  isDefault: boolean;
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketShippingRateInput = {
  market: string;
  useMarketFlatRate?: boolean;
  marketFlatRate?: number;
  useFlatRate: boolean;
  useFlatRateSheeters?: boolean;
  useFlatRateMegas?: boolean;
  shippingRate: number;
  postersPerBox: number;
  sheeterSetsPerBox: number;
  twoSheeterSetsPerBox: number;
  fourSheeterSetsPerBox: number;
  sixSheeterSetsPerBox: number;
  eightSheeterSetsPerBox: number;
  twoSheeterPrice: number;
  fourSheeterPrice: number;
  sixSheeterPrice: number;
  eightSheeterPrice: number;
  megasPerBox: number;
  megaShippingRate: number;
  dotMShippingRate: number;
  mpShippingRate: number;
};

export type MarketShippingRateRecord = MarketShippingRateInput & {
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketAssetShippingCostInput = {
  market: string;
  assetId: string;
  megaShippingRate: number;
  dotMShippingRate: number;
  mpShippingRate: number;
  costs?: Record<string, number>;
};

export type MarketAssetShippingCostRecord = MarketAssetShippingCostInput & {
  tenantId: string;
  asset: string;
  label: string;
  createdAt: string;
  updatedAt: string;
};

export type PrintingCostBreakdown = Record<string, number>;

export type MarketPrintingCostInput = {
  market: string;
  posterCost: number;
};

export type MarketPrintingCostRecord = MarketPrintingCostInput & {
  tenantId: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketAssetPrintingCostInput = {
  market: string;
  assetId: string;
  costs: PrintingCostBreakdown;
};

export type MarketAssetPrintingCostRecord = MarketAssetPrintingCostInput & {
  tenantId: string;
  asset: string;
  label: string;
  createdAt: string;
  updatedAt: string;
};

export type MarketSheetSizeInput = {
  market: string;
  assetId?: string | null;
  presetKey?: string;
  name: string;
  widthMm: number;
  heightMm: number;
};

export type MarketSheetSizeRecord = MarketSheetSizeInput & {
  id: string;
  tenantId: string;
  asset?: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignLineResult = {
  id: string;
  market: string;
  assetLabel: string;
  state: string;
  runCount: number;
  selectedWeeks: number[];
  breakdown: QuantityBreakdown;
};

export type CampaignTotals = {
  market: string;
  breakdown: QuantityBreakdown;
  frameBreakdown?: QuantityBreakdown;
  posterTotal: number;
  frameTotal: number;
  specialFormatTotal: number;
  totalUnits: number;
  activeAssets: number;
  activeRuns: number;
};

export type CampaignCalculationSummary = {
  lines: CampaignLineResult[];
  perMarket: CampaignTotals[];
  grandTotal: CampaignTotals;
};

export type CalculatorMetadataResponse = {
  markets: MarketMetadata[];
  formatKeys: FormatKey[];
};

export type CampaignSupportingDocument = {
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  uploadedAt: string;
};

export type OrderFormValues = {
  customerCode: string;
  customerReference: string;
  purchaseOrderNumber: string;
  campaignName: string;
  clientName: string;
  jobDescription: string;
  notes: string;
  productCode: string;
  quantity: string;
  kindName: string;
  campaignStartDate: string;
  /** Legacy campaign date, read only to populate older campaigns. Use campaignMarkets[].dueDate. */
  dueDate: string;
  numberOfWeeks: string;
  printImages: CampaignPrintImage[];
  supportingDocuments?: CampaignSupportingDocument[];
  creativeNameAssignments?: Record<string, string>;
  artworkCodes?: Record<string, string>;
  campaignMarkets: CampaignMarket[];
  contact: ContactDetails;
};

export type CampaignRecord = {
  id: string;
  tenantId: string;
  parentCampaignId?: string;
  createdByUserId: string;
  updatedByUserId: string;
  status: CampaignStatus;
  values: OrderFormValues;
  summary: CampaignCalculationSummary | null;
  purchaseOrder: {
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    uploadedAt: string;
  } | null;
  latestQuoteAmount: number | string | null;
  createdAt: string;
  updatedAt: string;
};

export type CampaignListItem = {
  id: string;
  tenantId: string;
  parentCampaignId?: string;
  parentCampaignName?: string;
  childCampaignCount: number;
  status: CampaignStatus;
  createdBy: string;
  updatedBy: string;
  campaignName: string;
  campaignStartDate: string;
  /** Legacy campaign date, read only to populate older campaigns. Use campaignMarkets[].dueDate. */
  dueDate: string;
  numberOfWeeks: string;
  marketCount: number;
  assetCount: number;
  purchaseOrder: {
    originalName: string;
    storedName: string;
    mimeType: string;
    size: number;
    uploadedAt: string;
  } | null;
  latestQuoteAmount: number | string | null;
  updatedAt: string;
  createdAt: string;
  submittedAt: string | null;
};

export type CampaignUpsertPayload = {
  values: OrderFormValues;
};

export type CampaignCalculationResponse = {
  campaign: CampaignRecord;
  summary: CampaignCalculationSummary;
};

export type CampaignSubmitResponse = {
  campaign: CampaignRecord;
  amount: number | string | null;
  quoteNo?: string;
  quoteNos?: string[];
  marketQuotes?: { market: string; dueDate: string; quoteNo: string; jobNos: string[] }[];
  jobNo?: string;
  jobNos?: string[];
  test?: boolean;
};

export type LoginResponse = AuthSession;

export type ActiveUsersResponse = {
  activeUsers: number;
  windowMinutes: number;
};

export type CampaignEditLockInfo = {
  campaignId: string;
  userId: string;
  userName: string;
  expiresAt: string;
};
