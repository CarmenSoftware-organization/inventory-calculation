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
  CostLayerTransaction,
  CreditNoteInput,
  ClosePeriodInput,
  OpenPeriodInput,
  CostLayerTransferResult,
  CreditNoteResult,
  ClosePeriodResult,
  OpenPeriodResult,
} from "../types";
import { InsufficientStockError, PeriodNotClosedError } from "../errors";
import { round } from "../utils/rounding";
import { derivePeriod } from "../utils/period";
import { CostLayerCostingStrategy } from "./cost-layer-strategy";

function lotKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`;
}

interface ClosedPeriodSnapshot {
  period: string;
  lots: InventoryLot[];
  accumulatedDiff: number;
}

export class CostLayerFIFOStrategy implements CostLayerCostingStrategy {
  private lots = new Map<string, InventoryLot[]>();
  private transactionLog = new Map<string, CostLayerTransaction[]>();
  private seqCounters = new Map<string, number>();
  private closedPeriods = new Map<string, ClosedPeriodSnapshot>();
  private accumulatedDiff = new Map<string, number>();
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

  private getOrCreateLog(
    productId: string,
    warehouseId: string
  ): CostLayerTransaction[] {
    const key = lotKey(productId, warehouseId);
    let log = this.transactionLog.get(key);
    if (!log) {
      log = [];
      this.transactionLog.set(key, log);
    }
    return log;
  }

  private nextSeq(productId: string, warehouseId: string): number {
    const key = lotKey(productId, warehouseId);
    const current = this.seqCounters.get(key) ?? 0;
    const next = current + 1;
    this.seqCounters.set(key, next);
    return next;
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
  ): {
    totalCost: number;
    lotDetails: InventoryTransactionLot[];
    consumedLots: Array<{ lotId: string; quantity: number; unitCost: number }>;
    txnId: string;
  } {
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
    const consumedLots: Array<{
      lotId: string;
      quantity: number;
      unitCost: number;
    }> = [];

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

      consumedLots.push({
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

    return { totalCost: round(totalCost), lotDetails, consumedLots, txnId };
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

    // Record cost layer transaction
    const period = derivePeriod(purchaseDate);
    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    log.push({
      id: txnId,
      type: TransactionType.IN,
      lotId,
      inQty: input.quantity,
      outQty: 0,
      unitCost: input.unitCost,
      diff: 0,
      date: purchaseDate,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    });

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
    const { totalCost, lotDetails, consumedLots, txnId } = this.consumeLots(
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

    // Record per-lot cost layer transactions
    const date = input.date ?? new Date();
    const period = derivePeriod(date);
    const log = this.getOrCreateLog(input.productId, input.warehouseId);

    for (const consumed of consumedLots) {
      log.push({
        id: txnId,
        type: TransactionType.OUT,
        lotId: undefined,
        inQty: 0,
        outQty: consumed.quantity,
        unitCost: consumed.unitCost,
        diff: 0,
        date,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        parentLotId: consumed.lotId,
        period,
        referenceDoc: input.referenceDoc,
      });
    }

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

      const period = derivePeriod(adjustDate);
      const log = this.getOrCreateLog(input.productId, input.warehouseId);
      log.push({
        id: txnId,
        type: TransactionType.ADJUST,
        lotId,
        inQty: input.quantity,
        outQty: 0,
        unitCost: input.unitCost,
        diff: 0,
        date: adjustDate,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        period,
        referenceDoc: input.referenceDoc,
      });
    } else {
      const removeQty = Math.abs(input.quantity);
      const consumed = this.consumeLots(
        input.productId,
        input.warehouseId,
        removeQty
      );
      txnId = consumed.txnId;
      lotDetails = consumed.lotDetails;

      const adjustDate = input.date ?? new Date();
      const period = derivePeriod(adjustDate);
      const log = this.getOrCreateLog(input.productId, input.warehouseId);
      for (const c of consumed.consumedLots) {
        log.push({
          id: txnId,
          type: TransactionType.ADJUST,
          lotId: undefined,
          inQty: 0,
          outQty: c.quantity,
          unitCost: c.unitCost,
          diff: 0,
          date: adjustDate,
          location: input.warehouseId,
          seq: this.nextSeq(input.productId, input.warehouseId),
          parentLotId: c.lotId,
          period,
          referenceDoc: input.referenceDoc,
        });
      }
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

  transferStockCostLayer(input: TransferStockInput): CostLayerTransferResult {
    const available = this.availableQty(input.productId, input.fromWarehouseId);
    if (available < input.quantity) {
      throw new InsufficientStockError(
        input.productId,
        input.fromWarehouseId,
        input.quantity,
        available
      );
    }

    const lotList = this.getOrCreateLots(
      input.productId,
      input.fromWarehouseId
    );
    const transferDate = input.date ?? new Date();
    const period = derivePeriod(transferDate);

    let remaining = input.quantity;
    let totalTransferCost = 0;
    const transferOutTransactions: CostLayerTransaction[] = [];
    const transferInTransactions: CostLayerTransaction[] = [];
    const consumedEntries: Array<{
      lotId: string;
      quantity: number;
      unitCost: number;
    }> = [];

    // Consume lots FIFO from source
    for (const lot of lotList) {
      if (remaining <= 0) break;
      if (lot.quantity <= 0) continue;

      const consume = Math.min(lot.quantity, remaining);
      lot.quantity = round(lot.quantity - consume);
      remaining = round(remaining - consume);
      totalTransferCost += consume * lot.unitCost;

      consumedEntries.push({
        lotId: lot.lotId,
        quantity: consume,
        unitCost: lot.unitCost,
      });
    }

    // Remove fully consumed lots from source
    const sourceKey = lotKey(input.productId, input.fromWarehouseId);
    this.lots.set(
      sourceKey,
      lotList.filter((l) => l.quantity > 0)
    );

    totalTransferCost = round(totalTransferCost);

    // Create per-lot TRANSFER_OUT and TRANSFER_IN pairs
    const sourceLog = this.getOrCreateLog(
      input.productId,
      input.fromWarehouseId
    );
    const destLog = this.getOrCreateLog(input.productId, input.toWarehouseId);
    const destLotList = this.getOrCreateLots(
      input.productId,
      input.toWarehouseId
    );

    for (const entry of consumedEntries) {
      // TRANSFER_OUT at source
      const outTxn: CostLayerTransaction = {
        id: this.nextTxnId(),
        type: TransactionType.TRANSFER_OUT,
        lotId: entry.lotId,
        inQty: 0,
        outQty: entry.quantity,
        unitCost: entry.unitCost,
        diff: 0,
        date: transferDate,
        location: input.fromWarehouseId,
        seq: this.nextSeq(input.productId, input.fromWarehouseId),
        parentLotId: entry.lotId,
        period,
        referenceDoc: input.referenceDoc,
      };
      sourceLog.push(outTxn);
      transferOutTransactions.push(outTxn);

      // Create new lot at destination preserving cost
      const newLotId = this.nextLotId();
      destLotList.push({
        lotId: newLotId,
        productId: input.productId,
        warehouseId: input.toWarehouseId,
        purchaseDate: transferDate,
        quantity: entry.quantity,
        unitCost: entry.unitCost,
      });

      // TRANSFER_IN at destination
      const inTxn: CostLayerTransaction = {
        id: this.nextTxnId(),
        type: TransactionType.TRANSFER_IN,
        lotId: newLotId,
        inQty: entry.quantity,
        outQty: 0,
        unitCost: entry.unitCost,
        diff: 0,
        date: transferDate,
        location: input.toWarehouseId,
        seq: this.nextSeq(input.productId, input.toWarehouseId),
        period,
        referenceDoc: input.referenceDoc,
      };
      destLog.push(inTxn);
      transferInTransactions.push(inTxn);
    }

    destLotList.sort(
      (a, b) => a.purchaseDate.getTime() - b.purchaseDate.getTime()
    );

    return {
      transferOutTransactions,
      transferInTransactions,
      totalTransferCost,
    };
  }

  transferStock(input: TransferStockInput): TransferResult {
    const result = this.transferStockCostLayer(input);

    const transferDate = input.date ?? new Date();
    const totalQty = result.transferOutTransactions.reduce(
      (s, t) => s + t.outQty,
      0
    );
    const avgCost =
      totalQty > 0 ? round(result.totalTransferCost / totalQty) : 0;

    const issueTransaction = this.makeTransaction(
      result.transferOutTransactions[0]?.id ?? this.nextTxnId(),
      input.productId,
      input.fromWarehouseId,
      TransactionType.TRANSFER,
      totalQty,
      avgCost,
      result.totalTransferCost,
      input.referenceDoc,
      transferDate
    );

    const receiveTransaction = this.makeTransaction(
      result.transferInTransactions[0]?.id ?? this.nextTxnId(),
      input.productId,
      input.toWarehouseId,
      TransactionType.TRANSFER,
      totalQty,
      avgCost,
      result.totalTransferCost,
      input.referenceDoc,
      transferDate
    );

    return {
      issueTransaction,
      receiveTransaction,
      transferCost: result.totalTransferCost,
    };
  }

  creditNote(input: CreditNoteInput): CreditNoteResult {
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);
    const lot = lotList.find((l) => l.lotId === input.lotId);

    if (!lot) {
      throw new Error(
        `Lot "${input.lotId}" not found for product "${input.productId}" in warehouse "${input.warehouseId}"`
      );
    }

    if (lot.quantity < input.quantity) {
      throw new InsufficientStockError(
        input.productId,
        input.warehouseId,
        input.quantity,
        lot.quantity
      );
    }

    lot.quantity = round(lot.quantity - input.quantity);

    // Remove fully consumed lots
    const key = lotKey(input.productId, input.warehouseId);
    this.lots.set(
      key,
      lotList.filter((l) => l.quantity > 0)
    );

    const date = input.date ?? new Date();
    const period = derivePeriod(date);
    const txnId = this.nextTxnId();

    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    const clTxn: CostLayerTransaction = {
      id: txnId,
      type: TransactionType.CREDIT_NOTE,
      lotId: input.lotId,
      inQty: 0,
      outQty: input.quantity,
      unitCost: input.unitCost,
      diff: 0,
      date,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    };
    log.push(clTxn);

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    return {
      transaction: clTxn,
      balance: {
        quantity: qty,
        totalValue: val,
      },
    };
  }

  closePeriod(input: ClosePeriodInput): ClosePeriodResult {
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);
    const key = lotKey(input.productId, input.warehouseId);
    const date = input.date ?? new Date();

    // Snapshot current lots for this location
    const snapshot: InventoryLot[] = lotList
      .filter((l) => l.quantity > 0)
      .map((l) => ({ ...l }));

    const accDiff = this.accumulatedDiff.get(key) ?? 0;

    // Store closed period snapshot
    const closedKey = `${key}::${input.period}`;
    this.closedPeriods.set(closedKey, {
      period: input.period,
      lots: snapshot,
      accumulatedDiff: accDiff,
    });

    const closeTransactions: CostLayerTransaction[] = [];
    const log = this.getOrCreateLog(input.productId, input.warehouseId);

    // Record CLOSE transaction for each lot
    for (const lot of snapshot) {
      const clTxn: CostLayerTransaction = {
        id: this.nextTxnId(),
        type: TransactionType.CLOSE,
        lotId: lot.lotId,
        inQty: 0,
        outQty: lot.quantity,
        unitCost: lot.unitCost,
        diff: 0,
        date,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        parentLotId: lot.lotId,
        period: input.period,
      };
      log.push(clTxn);
      closeTransactions.push(clTxn);
    }

    const closingQty = snapshot.reduce((s, l) => s + l.quantity, 0);
    const closingValue = round(
      snapshot.reduce((s, l) => s + l.quantity * l.unitCost, 0)
    );
    const closingAvg = closingQty > 0 ? round(closingValue / closingQty) : 0;

    // Zero out lots at this location
    this.lots.set(key, []);

    return {
      closeTransactions,
      closingBalance: {
        quantity: closingQty,
        totalValue: closingValue,
        averageCost: closingAvg,
        diff: accDiff,
      },
    };
  }

  openPeriod(input: OpenPeriodInput): OpenPeriodResult {
    const key = lotKey(input.productId, input.warehouseId);

    // Find the closed period snapshot — look for previous period
    // We need to find a closed period to open from
    const closedKey = this.findClosedPeriodKey(
      input.productId,
      input.warehouseId
    );

    if (!closedKey) {
      throw new PeriodNotClosedError(
        input.productId,
        input.warehouseId,
        input.period
      );
    }

    const snapshot = this.closedPeriods.get(closedKey)!;
    const date = input.date ?? new Date();
    const openTransactions: CostLayerTransaction[] = [];
    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);

    // Re-create lots from snapshot
    for (const lot of snapshot.lots) {
      lotList.push({
        ...lot,
        warehouseId: input.warehouseId,
      });

      const clTxn: CostLayerTransaction = {
        id: this.nextTxnId(),
        type: TransactionType.OPEN,
        lotId: lot.lotId,
        inQty: lot.quantity,
        outQty: 0,
        unitCost: lot.unitCost,
        diff: 0,
        date,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        period: input.period,
      };
      log.push(clTxn);
      openTransactions.push(clTxn);
    }

    // Reset accumulated diff
    this.accumulatedDiff.set(key, 0);

    // Remove the closed period snapshot
    this.closedPeriods.delete(closedKey);

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);
    const avg = qty > 0 ? round(val / qty) : 0;

    return {
      openTransactions,
      openingBalance: {
        quantity: qty,
        totalValue: val,
        averageCost: avg,
      },
    };
  }

  private findClosedPeriodKey(
    productId: string,
    warehouseId: string
  ): string | undefined {
    const prefix = `${lotKey(productId, warehouseId)}::`;
    for (const key of this.closedPeriods.keys()) {
      if (key.startsWith(prefix)) {
        return key;
      }
    }
    return undefined;
  }

  getTransactionLog(
    productId: string,
    warehouseId: string
  ): CostLayerTransaction[] {
    return this.getOrCreateLog(productId, warehouseId).slice();
  }

  getAccumulatedDiff(productId: string, warehouseId: string): number {
    const key = lotKey(productId, warehouseId);
    return this.accumulatedDiff.get(key) ?? 0;
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
    const key = lotKey(productId, warehouseId);
    this.lots.set(key, []);

    const sorted = [...transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const results: RecalculateResultTransaction[] = [];

    for (const txn of sorted) {
      if (txn.transactionType === TransactionType.IN) {
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
