export type AppRoleTab =
  | 'activation'
  | 'admin'
  | 'manager'
  | 'collector'
  | 'subscriber'
  | 'flutter';

export type SyncStatus = 'synced' | 'pending';

export type LicenseStatus = 'unused' | 'active' | 'suspended' | 'expired';

export interface CollectorPermissions {
  canRecordReadings: boolean;
  canCollectCash: boolean;
  canSendInvoices: boolean;
  canViewDebts: boolean;
}

export interface AccessCodeRecord {
  code: string;
  role: 'manager' | 'collector';
  name: string;
  phone: string;
  stationId: string;
  stationName: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface StationConfig {
  stationId: string;
  stationName: string;
  kwhPriceYer: number;
  minimumFeeYer: number;
  mainGeneratorKwh: number;
  licenseCode: string;
  licenseStatus: 'active' | 'suspended';
  maxCollectors: number;
  maxSubscribers: number;
  ownerUid: string;
  updatedAt: string;
  subscriberCount?: number;
  readingCount?: number;
  receiptCount?: number;
}

export interface CollectorProfile {
  id: string;
  code?: string;
  name: string;
  email: string;
  phone: string;
  assignedZones: string[];
  permissions: CollectorPermissions;
  active: boolean;
  inviteCode?: string;
  createdAt: string;
}

export type LowerReadingReason =
  | 'meter_replaced'
  | 'meter_reset'
  | 'previous_error';

export type ReadingApprovalStatus =
  | 'approved'
  | 'pending_manager'
  | 'rejected';

export type ManagerAlertType =
  | 'manual_edit'
  | 'high_consumption'
  | 'lower_reading';

export type ManagerAlertSeverity = 'critical' | 'warning';

export type ManagerAlertStatus = 'pending' | 'approved' | 'rejected';

export interface ManagerAlert {
  id: string;
  stationId: string;
  alertType: ManagerAlertType;
  severity: ManagerAlertSeverity;
  status: ManagerAlertStatus;
  readingId: string;
  subscriberId: string;
  subscriberName: string;
  meterNumber: string;
  collectorName: string;
  collectorCode?: string;
  ocrOriginalReading?: number;
  editedReading: number;
  previousReading: number;
  difference?: number;
  consumptionKwh?: number;
  avg3MonthsKwh?: number;
  lowerReadingReason?: LowerReadingReason;
  newMeterNumber?: string;
  openingReading?: number;
  photoUrl: string;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  managerNote?: string;
  syncStatus: SyncStatus;
}

export interface Subscriber {
  id: string;
  meterNumber: string;
  subscriberName: string;
  phone: string;
  previousReading: number;
  currentReading: number;
  previousDebtYer: number;
  last3MonthsAvgKwh?: number;
  zoneStreet: string;
  sequenceOrder: number;
  assignedCollectorId?: string;
  importedLocally?: boolean;
  syncStatus: SyncStatus;
  updatedAt: string;
}

export interface MeterReading {
  id: string;
  subscriberId: string;
  meterNumber: string;
  subscriberName: string;
  previousReading: number;
  currentReading: number;
  consumptionKwh: number;
  kwhPriceYer: number;
  currentBillYer: number;
  previousDebtYer: number;
  totalDueYer: number;
  photoUrl: string;
  photoSizeKb: number;
  hasLocalPhoto?: boolean;
  readingSource?: 'camera_ocr' | 'manual_override';
  ocrConfidence?: number;
  ocrOriginalReading?: number;
  wasManuallyEdited?: boolean;
  editedAt?: string;
  approvalStatus?: ReadingApprovalStatus;
  lowerReadingReason?: LowerReadingReason;
  newMeterNumber?: string;
  openingReading?: number;
  isClosedHouseZero?: boolean;
  zeroConsumptionNote?: string;
  highConsumptionWarning?: boolean;
  collectorUid: string;
  collectorName: string;
  recordedAt: string;
  syncStatus: SyncStatus;
}

export interface PaymentReceipt {
  id: string;
  subscriberId: string;
  meterNumber: string;
  subscriberName: string;
  readingId: string;
  amountPaidYer: number;
  remainingBalanceYer: number;
  collectorUid: string;
  collectorName: string;
  paidAt: string;
  syncStatus: SyncStatus;
}

export interface SubscriberLookupResult {
  stationName: string;
  subscriber: Subscriber;
  readings: MeterReading[];
  receipts: PaymentReceipt[];
}

export interface SyncProgress {
  completed: number;
  total: number;
  currentBatch: number;
  totalBatches: number;
}
