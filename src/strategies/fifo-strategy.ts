import {
  InventoryLot,
  InventoryTransaction,
  InventoryTransactionLot,
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

function lotKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`;
}

export class FIFOStrategy implements InventoryCostingStrategy {
  private lots = new Map<string, InventoryLot[]>();
  private txnCounter = 0;
  private lotCounter = 0;

  private getOrCreateLots(
    productId: string,
    warehouseId: string
  ): InventoryLot[] {
    const key = lotKey(productId, warehouseId);
    let lotList = this.lots.get(key);
    if (!lotList) {
      lotList = [];
      this.lots.set(key, lotList);
    }
    return lotList;
  }

  private nextTxnId(): string {
    return `txn-${++this.txnCounter}`;
  }

  private nextLotId(): string {
    return `lot-${++this.lotCounter}`;
  }

  private availableQty(productId: string, warehouseId: string): number {
    const lotList = this.getOrCreateLots(productId, warehouseId);
    return lotList.reduce((sum, lot) => sum + lot.quantity, 0);
  }

  private totalValue(productId: string, warehouseId: string): number {
    const lotList = this.getOrCreateLots(productId, warehouseId);
    return round(
      lotList.reduce((sum, lot) => sum + lot.quantity * lot.unitCost, 0)
    );
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

  private consumeLots(
    productId: string,
    warehouseId: string,
    requiredQty: number
  ): { totalCost: number; lotDetails: InventoryTransactionLot[]; txnId: string } {
    const lotList = this.getOrCreateLots(productId, warehouseId);
    const available = this.availableQty(productId, warehouseId);

    if (available < requiredQty) {
      throw new InsufficientStockError(
        productId,
        warehouseId,
        requiredQty,
        available
      );
    }

    const txnId = this.nextTxnId();
    let totalCost = 0;
    let remaining = requiredQty;
    const lotDetails: InventoryTransactionLot[] = [];

    for (const lot of lotList) {
      if (remaining <= 0) break;
      if (lot.quantity <= 0) continue;

      const consume = Math.min(lot.quantity, remaining);
      totalCost += consume * lot.unitCost;
      lot.quantity = round(lot.quantity - consume);
      remaining = round(remaining - consume);

      lotDetails.push({
        transactionId: txnId,
        lotId: lot.lotId,
        quantity: consume,
        unitCost: lot.unitCost,
      });
    }

    // Remove fully consumed lots
    const key = lotKey(productId, warehouseId);
    this.lots.set(
      key,
      lotList.filter((l) => l.quantity > 0)
    );

    return { totalCost: round(totalCost), lotDetails, txnId };
  }

  receiveStock(input: ReceiveStockInput): ReceiveResult {
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);
    const lotId = this.nextLotId();
    const purchaseDate = input.date ?? new Date();

    const newLot: InventoryLot = {
      lotId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      purchaseDate,
      quantity: input.quantity,
      unitCost: input.unitCost,
    };

    lotList.push(newLot);
    // Keep sorted by purchase date ASC
    lotList.sort((a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime());

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

    const lotDetail: InventoryTransactionLot = {
      transactionId: txnId,
      lotId,
      quantity: input.quantity,
      unitCost: input.unitCost,
    };

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    return {
      transaction: txn,
      lotDetails: [lotDetail],
      balance: {
        quantity: qty,
        totalValue: val,
      },
    };
  }

  issueStock(input: IssueStockInput): IssueResult {
    const { totalCost, lotDetails, txnId } = this.consumeLots(
      input.productId,
      input.warehouseId,
      input.quantity
    );

    const avgUnitCost =
      input.quantity > 0 ? round(totalCost / input.quantity) : 0;

    const txn = this.makeTransaction(
      txnId,
      input.productId,
      input.warehouseId,
      TransactionType.OUT,
      input.quantity,
      avgUnitCost,
      totalCost,
      input.referenceDoc,
      input.date
    );

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    return {
      transaction: txn,
      lotDetails,
      totalCost,
      balance: {
        quantity: qty,
        totalValue: val,
      },
    };
  }

  adjustStock(input: AdjustStockInput): AdjustResult {
    let lotDetails: InventoryTransactionLot[] | undefined;
    let txnId: string;

    if (input.quantity > 0) {
      // Positive adjustment: create a new lot
      const lotId = this.nextLotId();
      const lotList = this.getOrCreateLots(input.productId, input.warehouseId);
      const adjustDate = input.date ?? new Date();

      lotList.push({
        lotId,
        productId: input.productId,
        warehouseId: input.warehouseId,
        purchaseDate: adjustDate,
        quantity: input.quantity,
        unitCost: input.unitCost,
      });

      lotList.sort(
        (a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime()
      );

      txnId = this.nextTxnId();
      lotDetails = [
        {
          transactionId: txnId,
          lotId,
          quantity: input.quantity,
          unitCost: input.unitCost,
        },
      ];
    } else {
      // Negative adjustment: consume oldest lots
      const removeQty = Math.abs(input.quantity);
      const consumed = this.consumeLots(
        input.productId,
        input.warehouseId,
        removeQty
      );
      txnId = consumed.txnId;
      lotDetails = consumed.lotDetails;
    }

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    const txn = this.makeTransaction(
      txnId,
      input.productId,
      input.warehouseId,
      TransactionType.ADJUST,
      input.quantity,
      input.unitCost,
      round(Math.abs(input.quantity) * input.unitCost),
      input.referenceDoc,
      input.date
    );

    return {
      transaction: txn,
      lotDetails,
      balance: {
        quantity: qty,
        totalValue: val,
      },
    };
  }

  transferStock(input: TransferStockInput): TransferResult {
    // Issue from source (consumes oldest lots)
    const issueResult = this.issueStock({
      productId: input.productId,
      warehouseId: input.fromWarehouseId,
      quantity: input.quantity,
      referenceDoc: input.referenceDoc,
      date: input.date,
    });

    // Calculate weighted average cost from consumed lots
    const transferUnitCost =
      input.quantity > 0
        ? round(issueResult.totalCost / input.quantity)
        : 0;

    // Receive at destination as a new lot
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
      transferCost: issueResult.totalCost,
    };
  }

  getValuation(productId: string, warehouseId: string): ValuationResult {
    const lotList = this.getOrCreateLots(productId, warehouseId);
    const qty = this.availableQty(productId, warehouseId);
    const val = this.totalValue(productId, warehouseId);
    const avgCost = qty > 0 ? round(val / qty) : 0;

    return {
      productId,
      warehouseId,
      quantity: qty,
      totalValue: val,
      averageCost: avgCost,
      lots: lotList.filter((l) => l.quantity > 0).map((l) => ({ ...l })),
    };
  }

  recalculate(
    productId: string,
    warehouseId: string,
    transactions: RecalculateTransaction[]
  ): RecalculateResult {
    // Clear existing lots for this product/warehouse
    const key = lotKey(productId, warehouseId);
    this.lots.set(key, []);

    // Sort transactions by date
    const sorted = [...transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const results: RecalculateResultTransaction[] = [];

    for (const txn of sorted) {
      if (txn.transactionType === TransactionType.IN) {
        // Create a new lot
        const lotList = this.getOrCreateLots(productId, warehouseId);
        const lotId = this.nextLotId();

        lotList.push({
          lotId,
          productId,
          warehouseId,
          purchaseDate: txn.date,
          quantity: txn.quantity,
          unitCost: txn.unitCost,
        });

        results.push({
          transactionType: TransactionType.IN,
          quantity: txn.quantity,
          unitCost: txn.unitCost,
          totalCost: round(txn.quantity * txn.unitCost),
          date: txn.date,
          referenceDoc: txn.referenceDoc,
        });
      } else {
        // OUT: consume lots via FIFO
        const { totalCost } = this.consumeLots(
          productId,
          warehouseId,
          txn.quantity
        );

        const avgUnitCost =
          txn.quantity > 0 ? round(totalCost / txn.quantity) : 0;

        results.push({
          transactionType: TransactionType.OUT,
          quantity: txn.quantity,
          unitCost: avgUnitCost,
          totalCost,
          date: txn.date,
          referenceDoc: txn.referenceDoc,
        });
      }
    }

    const qty = this.availableQty(productId, warehouseId);
    const val = this.totalValue(productId, warehouseId);
    const avgCost = qty > 0 ? round(val / qty) : 0;

    return {
      transactions: results,
      finalBalance: {
        quantity: qty,
        totalValue: val,
        averageCost: avgCost,
      },
    };
  }
}
