import { CampaignAsset, CampaignMarket, OrderFormValues } from './types';

function getTodayDateInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function createAllWeeks(weekCount: number) {
  const safeWeekCount = Math.max(1, Math.floor(weekCount || 1));
  return Array.from({ length: safeWeekCount }, (_, index) => index + 1);
}

export function createCampaignAsset(id: string, weekCount = 1): CampaignAsset {
  return {
    id,
    assetId: '',
    assetSearch: '',
    selectedWeeks: createAllWeeks(weekCount),
    creativeImageId: '',
    creativeImageIds: {},
    artworkMaterialAssignments: {},
    deliveryAddress: '',
  };
}

export function createCampaignMarket(id: string, weekCount = 1): CampaignMarket {
  return {
    id,
    market: 'Sydney',
    dueDate: '',
    assets: [createCampaignAsset(`asset-${id}-1`, weekCount)],
  };
}

export function createDefaultFormValues(customerCode = '', productCode = ''): OrderFormValues {
  return {
    customerCode,
    customerReference: 'Q14259:1.0',
    purchaseOrderNumber: '',
    campaignName: '',
    clientName: '',
    jobDescription: '',
    notes: '',
    productCode,
    quantity: '',
    kindName: 'Campaign-01',
    campaignStartDate: getTodayDateInputValue(),
    dueDate: '',
    numberOfWeeks: '3',
    printImages: [],
    supportingDocuments: [],
    creativeNameAssignments: {},
    artworkCodes: {},
    campaignMarkets: [],
    contact: {
      title: 'Accounts Payable',
      firstName: 'Accounts',
      surname: 'Payable',
      email: 'accounts@revolution360.com.au',
    },
  };
}
