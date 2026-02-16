import {
  InventoryBalance,
  InventoryTransaction,
  TransactionType,
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
  RecalculateResultTransaction,
} from "../types";
import { InsufficientStockError } from "../errors";
import { round } from "../utils/rounding";
import { InventoryCostingStrategy } from "./inventory-costing-strategy";

function balanceKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`;
}

export class AverageCostStrategy implements InventoryCostingStrategy {
  private balances = new Map<string, InventoryBalance>();
  private txnCounter = 0;

  private getOrCreateBalance(
    productId: string,
    warehouseId: string
  ): InventoryBalance {
    const key = balanceKey(productId, warehouseId);
    let bal = this.balances.get(key);
    if (!bal) {
      bal = {
        productId,
        warehouseId,
        quantity: 0,
        averageCost: 0,
        totalValue: 0,
      };
      this.balances.set(key, bal);
    }
    return bal;
  }

  private nextTxnId(): string {
    return `txn-${++this.txnCounter}`;
  }

  private makeTransaction(
    id: string,
    productId: string,
    warehouseId: string,
    type: TransactionType,
    quantity: number,
    unitCost: number,
    totalCost: number,
    referenceDoc?: string,
    date?: Date
  ): InventoryTransaction {
    return {
      transactionId: id,
      productId,
      warehouseId,
      transactionType: type,
      quantity,
      unitCost: round(unitCost),
      totalCost: round(totalCost),
      referenceDoc,
      createdAt: date ?? new Date(),
    };
  }

  receiveStock(input: ReceiveStockInput): ReceiveResult {
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);

    const newTotalValue = round(
      bal.quantity * bal.averageCost + input.quantity * input.unitCost
    );
    const newTotalQty = bal.quantity + input.quantity;
    const newAvgCost = newTotalQty > 0 ? round(newTotalValue / newTotalQty) : 0;

    bal.quantity = newTotalQty;
    bal.averageCost = newAvgCost;
    bal.totalValue = round(newTotalQty * newAvgCost);

    const txnId = this.nextTxnId();
    const txn = this.makeTransaction(
      txnId,
      input.productId,
      input.warehouseId,
      TransactionType.IN,
      input.quantity,
      input.unitCost,
      round(input.quantity * input.unitCost),
      input.referenceDoc,
      input.date
    );

    return {
      transaction: txn,
      balance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }

  issueStock(input: IssueStockInput): IssueResult {
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);

    if (bal.quantity < input.quantity) {
      throw new InsufficientStockError(
        input.productId,
        input.warehouseId,
        input.quantity,
        bal.quantity
      );
    }

    const totalCost = round(input.quantity * bal.averageCost);

    bal.quantity -= input.quantity;
    bal.totalValue = round(bal.quantity * bal.averageCost);
    if (bal.quantity === 0) {
      bal.averageCost = 0;
      bal.totalValue = 0;
    }

    const txnId = this.nextTxnId();
    const txn = this.makeTransaction(
      txnId,
      input.productId,
      input.warehouseId,
      TransactionType.OUT,
      input.quantity,
      bal.quantity === 0 && totalCost > 0
        ? round(totalCost / input.quantity)
        : bal.averageCost,
      totalCost,
      input.referenceDoc,
      input.date
    );

    return {
      transaction: txn,
      totalCost,
      balance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.quantity === 0 ? 0 : bal.averageCost,
      },
    };
  }

  adjustStock(input: AdjustStockInput): AdjustResult {
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);

    if (input.quantity > 0) {
      // Positive adjustment: recalculate average
      const newTotalValue = round(
        bal.quantity * bal.averageCost + input.quantity * input.unitCost
      );
      const newTotalQty = bal.quantity + input.quantity;
      const newAvgCost =
        newTotalQty > 0 ? round(newTotalValue / newTotalQty) : 0;

      bal.quantity = newTotalQty;
      bal.averageCost = newAvgCost;
      bal.totalValue = round(newTotalQty * newAvgCost);
    } else {
      // Negative adjustment: use current average cost
      const removeQty = Math.abs(input.quantity);
      if (bal.quantity < removeQty) {
        throw new InsufficientStockError(
          input.productId,
          input.warehouseId,
          removeQty,
          bal.quantity
        );
      }

      bal.quantity -= removeQty;
      bal.totalValue = round(bal.quantity * bal.averageCost);
      if (bal.quantity === 0) {
        bal.averageCost = 0;
        bal.totalValue = 0;
      }
    }

    const txnId = this.nextTxnId();
    const txn = this.makeTransaction(
      txnId,
      input.productId,
      input.warehouseId,
      TransactionType.ADJUST,
      input.quantity,
      input.quantity > 0 ? input.unitCost : bal.averageCost,
      round(Math.abs(input.quantity) * input.unitCost),
      input.referenceDoc,
      input.date
    );

    return {
      transaction: txn,
      balance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }

  transferStock(input: TransferStockInput): TransferResult {
    const sourceBal = this.getOrCreateBalance(
      input.productId,
      input.fromWarehouseId
    );
    const transferCost = round(input.quantity * sourceBal.averageCost);
    const transferUnitCost = sourceBal.averageCost;

    // Issue from source
    const issueResult = this.issueStock({
      productId: input.productId,
      warehouseId: input.fromWarehouseId,
      quantity: input.quantity,
      referenceDoc: input.referenceDoc,
      date: input.date,
    });

    // Receive at destination with the source's average cost
    const receiveResult = this.receiveStock({
      productId: input.productId,
      warehouseId: input.toWarehouseId,
      quantity: input.quantity,
      unitCost: transferUnitCost,
      referenceDoc: input.referenceDoc,
      date: input.date,
    });

    return {
      issueTransaction: issueResult.transaction,
      receiveTransaction: receiveResult.transaction,
      transferCost,
    };
  }

  getValuation(productId: string, warehouseId: string): ValuationResult {
    const bal = this.getOrCreateBalance(productId, warehouseId);
    return {
      productId,
      warehouseId,
      quantity: bal.quantity,
      totalValue: bal.totalValue,
      averageCost: bal.averageCost,
    };
  }

  recalculate(
    productId: string,
    warehouseId: string,
    transactions: RecalculateTransaction[]
  ): RecalculateResult {
    // Reset balance for this product/warehouse
    const key = balanceKey(productId, warehouseId);
    this.balances.set(key, {
      productId,
      warehouseId,
      quantity: 0,
      averageCost: 0,
      totalValue: 0,
    });

    // Sort transactions by date
    const sorted = [...transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const results: RecalculateResultTransaction[] = [];

    for (const txn of sorted) {
      const bal = this.getOrCreateBalance(productId, warehouseId);

      if (txn.transactionType === TransactionType.IN) {
        // Recalculate weighted average
        const newTotalValue = round(
          bal.quantity * bal.averageCost + txn.quantity * txn.unitCost
        );
        const newTotalQty = bal.quantity + txn.quantity;
        const newAvgCost =
          newTotalQty > 0 ? round(newTotalValue / newTotalQty) : 0;

        bal.quantity = newTotalQty;
        bal.averageCost = newAvgCost;
        bal.totalValue = round(newTotalQty * newAvgCost);

        results.push({
          transactionType: TransactionType.IN,
          quantity: txn.quantity,
          unitCost: txn.unitCost,
          totalCost: round(txn.quantity * txn.unitCost),
          date: txn.date,
          referenceDoc: txn.referenceDoc,
        });
      } else {
        // OUT: use current average cost
        const totalCost = round(txn.quantity * bal.averageCost);
        const unitCost = bal.averageCost;

        bal.quantity -= txn.quantity;
        bal.totalValue = round(bal.quantity * bal.averageCost);
        if (bal.quantity === 0) {
          bal.averageCost = 0;
          bal.totalValue = 0;
        }

        results.push({
          transactionType: TransactionType.OUT,
          quantity: txn.quantity,
          unitCost,
          totalCost,
          date: txn.date,
          referenceDoc: txn.referenceDoc,
        });
      }
    }

    const bal = this.getOrCreateBalance(productId, warehouseId);

    return {
      transactions: results,
      finalBalance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }
}
