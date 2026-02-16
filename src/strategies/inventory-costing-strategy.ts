import {
  ReceiveStockInput,
  IssueStockInput,
  AdjustStockInput,
  TransferStockInput,
  ReceiveResult,
  IssueResult,
  AdjustResult,
  TransferResult,
  ValuationResult,
  RecalculateTransaction,
  RecalculateResult,
} from "../types";

export interface InventoryCostingStrategy {
  receiveStock(input: ReceiveStockInput): ReceiveResult;
  issueStock(input: IssueStockInput): IssueResult;
  adjustStock(input: AdjustStockInput): AdjustResult;
  transferStock(input: TransferStockInput): TransferResult;
  getValuation(productId: string, warehouseId: string): ValuationResult;
  recalculate(
    productId: string,
    warehouseId: string,
    transactions: RecalculateTransaction[]
  ): RecalculateResult;
}
