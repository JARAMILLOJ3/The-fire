import type { Timestamp } from 'firebase/firestore';

export type StationId = string;
export type TeamStationId = StationId | 'jefe';
export type ReportStatus = 'open' | 'opening_saved' | 'completed';
export type StockLevel = 'agotado' | 'comprar' | 'medio' | 'suficiente';

export interface ShiftSchedule {
  enabled: boolean;
  openingStart: string; // HH:mm 24h e.g. "16:00"
  openingEnd: string;   // HH:mm 24h e.g. "19:00"
  closingStart: string; // HH:mm 24h e.g. "23:00"
  closingEnd: string;   // HH:mm 24h e.g. "02:00"
}

export interface Workspace {
  id: string;
  name: string;
  ownerName?: string;
  shiftSchedule?: ShiftSchedule;
  ownerUid: string;
  ownerEmail: string;
  authorizedEmails: string[];
  seeded: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Workstation {
  id: string;
  workspaceId: string;
  ownerUid: string;
  authorizedEmails: string[];
  name: string;
  area: string;
  workerName: string;
  description: string;
  accessCode: string;
  nextItemSlot: number;
  active: boolean;
  sortOrder: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface StationLink {
  id: string;
  workspaceId: string;
  ownerUid: string;
  stationId: string;
  stationName: string;
  workerName: string;
  active: boolean;
  createdAt?: Timestamp;
}

export interface InventoryItem {
  id: string;
  workspaceId: string;
  ownerUid: string;
  authorizedEmails: string[];
  station: StationId;
  name: string;
  unit: string;
  minStock: number;
  targetStock: number;
  active: boolean;
  sortOrder: number;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DailyReport {
  id: string;
  workspaceId: string;
  ownerUid: string;
  authorizedEmails: string[];
  date: string;
  station: StationId;
  status: ReportStatus;
  reportedByUid: string;
  reportedByName: string;
  notes: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DailyReportEntry {
  id: string;
  workspaceId: string;
  ownerUid: string;
  authorizedEmails: string[];
  reportId: string;
  itemId: string;
  station: StationId;
  date: string;
  itemName: string;
  unit: string;
  minStock: number;
  targetStock: number;
  opening: number;
  added: number;
  closing: number;
  hasOpening: boolean;
  hasClosing: boolean;
  updatedByUid: string;
  updatedByName: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface Invite {
  id: string;
  workspaceId: string;
  ownerUid: string;
  email: string;
  displayName: string;
  station: TeamStationId;
  createdAt?: Timestamp;
}

export interface TeamMember {
  id: string;
  workspaceId: string;
  ownerUid: string;
  uid: string;
  email: string;
  displayName: string;
  station: TeamStationId;
  inviteId: string;
  active: boolean;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
}

export interface DraftEntryRow {
  itemId: string;
  itemName: string;
  unit: string;
  minStock: number;
  targetStock: number;
  opening: number;
  added: number;
  closing: number;
  hasOpening: boolean;
  hasClosing: boolean;
}

export interface ConsolidatedItemRow {
  item: InventoryItem;
  entry: DailyReportEntry | null;
  reportStatus: ReportStatus;
  currentStock: number;
  hasCountedClosing: boolean;
  consumed: number | null;
  stockLevel: StockLevel;
  suggestedBuy: number;
}
