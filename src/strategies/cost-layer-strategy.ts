import { InventoryCostingStrategy } from "./inventory-costing-strategy";
import {
  TransferStockInput,
  CreditNoteInput,
  ClosePeriodInput,
  OpenPeriodInput,
  CostLayerTransaction,
  CostLayerTransferResult,
  CreditNoteResult,
  ClosePeriodResult,
  OpenPeriodResult,
} from "../types";

export interface CostLayerCostingStrategy extends InventoryCostingStrategy {
  transferStockCostLayer(input: TransferStockInput): CostLayerTransferResult;
  creditNote(input: CreditNoteInput): CreditNoteResult;
  closePeriod(input: ClosePeriodInput): ClosePeriodResult;
  openPeriod(input: OpenPeriodInput): OpenPeriodResult;
  getTransactionLog(
    productId: string,
    warehouseId: string
  ): CostLayerTransaction[];
  getAccumulatedDiff(productId: string, warehouseId: string): number;
}
