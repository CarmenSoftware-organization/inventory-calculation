export enum TransactionType {
  IN = "IN",
  OUT = "OUT",
  ADJUST = "ADJUST",
  TRANSFER = "TRANSFER",
  TRANSFER_OUT = "TRANSFER_OUT",
  TRANSFER_IN = "TRANSFER_IN",
  CREDIT_NOTE = "CREDIT_NOTE",
  CLOSE = "CLOSE",
  OPEN = "OPEN",
}

export enum CostingMethod {
  FIFO = "FIFO",
  AVERAGE = "AVERAGE",
  COST_LAYER_FIFO = "COST_LAYER_FIFO",
  COST_LAYER_AVERAGE = "COST_LAYER_AVERAGE",
}

export interface InventoryLot {
  lotId: string;
  productId: string;
  warehouseId: string;
  purchaseDate: Date;
  quantity: number;
  unitCost: number;
}

export interface InventoryBalance {
  productId: string;
  warehouseId: string;
  quantity: number;
  averageCost: number;
  totalValue: number;
}

export interface InventoryTransaction {
  transactionId: string;
  productId: string;
  warehouseId: string;
  transactionType: TransactionType;
  quantity: number;
  unitCost: number;
  totalCost: number;
  referenceDoc?: string;
  createdAt: Date;
}

export interface InventoryTransactionLot {
  transactionId: string;
  lotId: string;
  quantity: number;
  unitCost: number;
}

// Input types

export interface ReceiveStockInput {
  productId: string;
  warehouseId: string;
  quantity: number;
  unitCost: number;
  referenceDoc?: string;
  date?: Date;
}

export interface IssueStockInput {
  productId: string;
  warehouseId: string;
  quantity: number;
  referenceDoc?: string;
  date?: Date;
}

export interface AdjustStockInput {
  productId: string;
  warehouseId: string;
  quantity: number; // positive = add, negative = remove
  unitCost: number;
  referenceDoc?: string;
  date?: Date;
}

export interface TransferStockInput {
  productId: string;
  fromWarehouseId: string;
  toWarehouseId: string;
  quantity: number;
  referenceDoc?: string;
  date?: Date;
}

// Result types

export interface ReceiveResult {
  transaction: InventoryTransaction;
  lotDetails?: InventoryTransactionLot[];
  balance: { quantity: number; totalValue: number; averageCost?: number };
}

export interface IssueResult {
  transaction: InventoryTransaction;
  lotDetails?: InventoryTransactionLot[];
  totalCost: number;
  balance: { quantity: number; totalValue: number; averageCost?: number };
}

export interface AdjustResult {
  transaction: InventoryTransaction;
  lotDetails?: InventoryTransactionLot[];
  balance: { quantity: number; totalValue: number; averageCost?: number };
}

export interface TransferResult {
  issueTransaction: InventoryTransaction;
  receiveTransaction: InventoryTransaction;
  transferCost: number;
}

export interface ValuationResult {
  productId: string;
  warehouseId: string;
  quantity: number;
  totalValue: number;
  averageCost: number;
  lots?: InventoryLot[];
}

// Recalculate types (Section 6.5)

export interface RecalculateTransaction {
  transactionType: TransactionType.IN | TransactionType.OUT;
  quantity: number;
  unitCost: number;
  date: Date;
  referenceDoc?: string;
}

export interface RecalculateResultTransaction {
  transactionType: TransactionType.IN | TransactionType.OUT;
  quantity: number;
  unitCost: number;
  totalCost: number;
  date: Date;
  referenceDoc?: string;
}

export interface RecalculateResult {
  transactions: RecalculateResultTransaction[];
  finalBalance: {
    quantity: number;
    totalValue: number;
    averageCost: number;
  };
}

// Cost Layer types

export interface CostLayerTransaction {
  id: string;
  type: TransactionType;
  lotId?: string;
  inQty: number;
  outQty: number;
  unitCost: number;
  diff: number;
  avgUnitCost?: number;
  date: Date;
  location: string;
  seq: number;
  parentLotId?: string;
  period: string;
  referenceDoc?: string;
}

export interface CreditNoteInput {
  productId: string;
  warehouseId: string;
  lotId: string;
  quantity: number;
  unitCost: number;
  referenceDoc?: string;
  date?: Date;
}

export interface ClosePeriodInput {
  productId: string;
  warehouseId: string;
  period: string;
  date?: Date;
}

export interface OpenPeriodInput {
  productId: string;
  warehouseId: string;
  period: string;
  date?: Date;
}

export interface CreditNoteResult {
  transaction: CostLayerTransaction;
  balance: { quantity: number; totalValue: number; averageCost?: number };
}

export interface CostLayerTransferResult {
  transferOutTransactions: CostLayerTransaction[];
  transferInTransactions: CostLayerTransaction[];
  totalTransferCost: number;
}

export interface ClosePeriodResult {
  closeTransactions: CostLayerTransaction[];
  closingBalance: {
    quantity: number;
    totalValue: number;
    averageCost: number;
    diff: number;
  };
}

export interface OpenPeriodResult {
  openTransactions: CostLayerTransaction[];
  openingBalance: {
    quantity: number;
    totalValue: number;
    averageCost: number;
  };
}
