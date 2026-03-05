export type EngineTransactionType =
  | "Receiving"
  | "Issue"
  | "TransferOut"
  | "TransferIn"
  | "CreditNote"
  | "Close"
  | "Open";

export interface EngineTransaction {
  id: string;
  type: EngineTransactionType;
  productId: string;
  lot: string | null;
  in: number | null;
  out: number | null;
  unitCost: number;
  date: string;
  location: string;
  seq: number;
  parentLot: string | null;
  period: string;
}

export interface LotRecord {
  lot: string;
  productId: string;
  location: string;
  quantity: number;
  unitCost: number;
  seq: number;
  createdAt: string;
}

export interface FIFOAllocation {
  lot: string;
  productId: string;
  quantity: number;
  unitCost: number;
  totalCost: number;
}

export interface FIFOResult {
  transaction: EngineTransaction;
  lotsBefore: LotRecord[];
  lotsAfter: LotRecord[];
  allocations: FIFOAllocation[];
}

export interface ValidationError {
  transactionId: string;
  type: EngineTransactionType;
  productId: string;
  lot: string;
  location: string;
  required: number;
  available: number;
  shortfall: number;
  message: string;
}

export interface AffectedTransaction {
  transactionId: string;
  type: EngineTransactionType;
  productId: string;
  lot: string;
  originalQty: number;
  newQty: number;
  diff: number;
}

export interface SimulationSnapshot {
  transactionId: string;
  type: EngineTransactionType;
  lots: LotRecord[];
  status: "ok" | "error";
  error?: string;
}

export interface ValidationResult {
  valid: boolean;
  maxIssuable: number;
  errors: ValidationError[];
  affectedTransactions: AffectedTransaction[];
  simulation: SimulationSnapshot[];
}
