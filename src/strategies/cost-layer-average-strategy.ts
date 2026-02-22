import {
  InventoryBalance,
  InventoryLot,
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

function balanceKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`;
}

interface ClosedPeriodSnapshot {
  period: string;
  balance: InventoryBalance;
  lots: InventoryLot[];
  accumulatedDiff: number;
}

export class CostLayerAverageStrategy implements CostLayerCostingStrategy {
  private balances = new Map<string, InventoryBalance>();
  private lots = new Map<string, InventoryLot[]>();
  private transactionLog = new Map<string, CostLayerTransaction[]>();
  private seqCounters = new Map<string, number>();
  private closedPeriods = new Map<string, ClosedPeriodSnapshot>();
  private accumulatedDiffMap = new Map<string, number>();
  private txnCounter = 0;
  private lotCounter = 0;

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

  private getOrCreateLots(
    productId: string,
    warehouseId: string
  ): InventoryLot[] {
    const key = balanceKey(productId, warehouseId);
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
    const key = balanceKey(productId, warehouseId);
    let log = this.transactionLog.get(key);
    if (!log) {
      log = [];
      this.transactionLog.set(key, log);
    }
    return log;
  }

  private nextSeq(productId: string, warehouseId: string): number {
    const key = balanceKey(productId, warehouseId);
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

  private addDiff(productId: string, warehouseId: string, diff: number): void {
    const key = balanceKey(productId, warehouseId);
    const current = this.accumulatedDiffMap.get(key) ?? 0;
    this.accumulatedDiffMap.set(key, round(current + diff));
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
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);

    const exactTotalValue =
      bal.quantity * bal.averageCost + input.quantity * input.unitCost;
    const newTotalQty = bal.quantity + input.quantity;
    const exactAvg = newTotalQty > 0 ? exactTotalValue / newTotalQty : 0;
    const roundedAvg = newTotalQty > 0 ? round(exactAvg) : 0;

    // Compute rounding diff: (rounded avg * newQty) - exactTotalValue
    const diff = round(roundedAvg * newTotalQty - exactTotalValue);

    bal.quantity = newTotalQty;
    bal.averageCost = roundedAvg;
    bal.totalValue = round(newTotalQty * roundedAvg);

    this.addDiff(input.productId, input.warehouseId, diff);

    // Create lot for tracking
    const lotId = this.nextLotId();
    const purchaseDate = input.date ?? new Date();
    lotList.push({
      lotId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      purchaseDate,
      quantity: input.quantity,
      unitCost: input.unitCost,
    });

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
      diff,
      avgUnitCost: roundedAvg,
      date: purchaseDate,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    });

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
    const issueAvg = bal.averageCost;

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
      issueAvg,
      totalCost,
      input.referenceDoc,
      input.date
    );

    const date = input.date ?? new Date();
    const period = derivePeriod(date);
    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    log.push({
      id: txnId,
      type: TransactionType.OUT,
      inQty: 0,
      outQty: input.quantity,
      unitCost: issueAvg,
      diff: 0,
      avgUnitCost: issueAvg,
      date,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    });

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
    const date = input.date ?? new Date();
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

    const period = derivePeriod(date);
    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    log.push({
      id: txnId,
      type: TransactionType.ADJUST,
      inQty: input.quantity > 0 ? input.quantity : 0,
      outQty: input.quantity < 0 ? Math.abs(input.quantity) : 0,
      unitCost: input.unitCost,
      diff: 0,
      avgUnitCost: bal.averageCost,
      date,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    });

    return {
      transaction: txn,
      balance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }

  transferStockCostLayer(input: TransferStockInput): CostLayerTransferResult {
    const sourceBal = this.getOrCreateBalance(
      input.productId,
      input.fromWarehouseId
    );

    if (sourceBal.quantity < input.quantity) {
      throw new InsufficientStockError(
        input.productId,
        input.fromWarehouseId,
        input.quantity,
        sourceBal.quantity
      );
    }

    const transferDate = input.date ?? new Date();
    const period = derivePeriod(transferDate);
    const transferUnitCost = sourceBal.averageCost;
    const totalTransferCost = round(input.quantity * transferUnitCost);

    // TRANSFER_OUT from source
    sourceBal.quantity -= input.quantity;
    sourceBal.totalValue = round(sourceBal.quantity * sourceBal.averageCost);
    if (sourceBal.quantity === 0) {
      sourceBal.averageCost = 0;
      sourceBal.totalValue = 0;
    }

    const outTxnId = this.nextTxnId();
    const sourceLog = this.getOrCreateLog(
      input.productId,
      input.fromWarehouseId
    );
    const outTxn: CostLayerTransaction = {
      id: outTxnId,
      type: TransactionType.TRANSFER_OUT,
      inQty: 0,
      outQty: input.quantity,
      unitCost: transferUnitCost,
      diff: 0,
      avgUnitCost: transferUnitCost,
      date: transferDate,
      location: input.fromWarehouseId,
      seq: this.nextSeq(input.productId, input.fromWarehouseId),
      period,
      referenceDoc: input.referenceDoc,
    };
    sourceLog.push(outTxn);

    // TRANSFER_IN at destination
    const destBal = this.getOrCreateBalance(
      input.productId,
      input.toWarehouseId
    );
    const newTotalValue = round(
      destBal.quantity * destBal.averageCost +
        input.quantity * transferUnitCost
    );
    const newTotalQty = destBal.quantity + input.quantity;
    const newAvgCost = newTotalQty > 0 ? round(newTotalValue / newTotalQty) : 0;

    destBal.quantity = newTotalQty;
    destBal.averageCost = newAvgCost;
    destBal.totalValue = round(newTotalQty * newAvgCost);

    const newLotId = this.nextLotId();
    const destLotList = this.getOrCreateLots(
      input.productId,
      input.toWarehouseId
    );
    destLotList.push({
      lotId: newLotId,
      productId: input.productId,
      warehouseId: input.toWarehouseId,
      purchaseDate: transferDate,
      quantity: input.quantity,
      unitCost: transferUnitCost,
    });

    const inTxnId = this.nextTxnId();
    const destLog = this.getOrCreateLog(input.productId, input.toWarehouseId);
    const inTxn: CostLayerTransaction = {
      id: inTxnId,
      type: TransactionType.TRANSFER_IN,
      lotId: newLotId,
      inQty: input.quantity,
      outQty: 0,
      unitCost: transferUnitCost,
      diff: 0,
      avgUnitCost: newAvgCost,
      date: transferDate,
      location: input.toWarehouseId,
      seq: this.nextSeq(input.productId, input.toWarehouseId),
      period,
      referenceDoc: input.referenceDoc,
    };
    destLog.push(inTxn);

    return {
      transferOutTransactions: [outTxn],
      transferInTransactions: [inTxn],
      totalTransferCost,
    };
  }

  transferStock(input: TransferStockInput): TransferResult {
    const sourceBal = this.getOrCreateBalance(
      input.productId,
      input.fromWarehouseId
    );
    const transferUnitCost = sourceBal.averageCost;
    const transferCost = round(input.quantity * transferUnitCost);

    // Use issueStock and receiveStock for backward-compat TransferResult
    const issueResult = this.issueStock({
      productId: input.productId,
      warehouseId: input.fromWarehouseId,
      quantity: input.quantity,
      referenceDoc: input.referenceDoc,
      date: input.date,
    });

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

  creditNote(input: CreditNoteInput): CreditNoteResult {
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);
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

    // Adjust the lot
    lot.quantity = round(lot.quantity - input.quantity);

    // Recalculate weighted average from remaining lots
    const activeLots = lotList.filter((l) => l.quantity > 0);
    const totalQty = activeLots.reduce((s, l) => s + l.quantity, 0);
    const totalVal = round(
      activeLots.reduce((s, l) => s + l.quantity * l.unitCost, 0)
    );

    // Update balance: reduce quantity, recalculate average
    bal.quantity -= input.quantity;
    if (bal.quantity <= 0) {
      bal.quantity = 0;
      bal.averageCost = 0;
      bal.totalValue = 0;
    } else {
      // Recalculate using actual cost removed
      const removedValue = round(input.quantity * input.unitCost);
      bal.totalValue = round(bal.totalValue - removedValue);
      bal.averageCost = round(bal.totalValue / bal.quantity);
    }

    const diff = round(bal.totalValue - totalVal);
    this.addDiff(input.productId, input.warehouseId, diff);

    // Remove fully consumed lots
    const key = balanceKey(input.productId, input.warehouseId);
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
      diff,
      avgUnitCost: bal.averageCost,
      date,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period,
      referenceDoc: input.referenceDoc,
    };
    log.push(clTxn);

    return {
      transaction: clTxn,
      balance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }

  closePeriod(input: ClosePeriodInput): ClosePeriodResult {
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);
    const key = balanceKey(input.productId, input.warehouseId);
    const date = input.date ?? new Date();
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);

    const accDiff = this.accumulatedDiffMap.get(key) ?? 0;

    // Snapshot
    const snapshot: ClosedPeriodSnapshot = {
      period: input.period,
      balance: { ...bal },
      lots: lotList.filter((l) => l.quantity > 0).map((l) => ({ ...l })),
      accumulatedDiff: accDiff,
    };

    const closedKey = `${key}::${input.period}`;
    this.closedPeriods.set(closedKey, snapshot);

    const closeTransactions: CostLayerTransaction[] = [];
    const log = this.getOrCreateLog(input.productId, input.warehouseId);

    // Record a single CLOSE transaction for the total balance
    if (bal.quantity > 0) {
      const clTxn: CostLayerTransaction = {
        id: this.nextTxnId(),
        type: TransactionType.CLOSE,
        inQty: 0,
        outQty: bal.quantity,
        unitCost: bal.averageCost,
        diff: accDiff,
        avgUnitCost: bal.averageCost,
        date,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        period: input.period,
      };
      log.push(clTxn);
      closeTransactions.push(clTxn);
    }

    const closingBalance = {
      quantity: bal.quantity,
      totalValue: bal.totalValue,
      averageCost: bal.averageCost,
      diff: accDiff,
    };

    // Zero out balance
    bal.quantity = 0;
    bal.averageCost = 0;
    bal.totalValue = 0;
    this.lots.set(key, []);

    return {
      closeTransactions,
      closingBalance,
    };
  }

  openPeriod(input: OpenPeriodInput): OpenPeriodResult {
    const key = balanceKey(input.productId, input.warehouseId);

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

    // Restore balance at closing average cost
    const bal = this.getOrCreateBalance(input.productId, input.warehouseId);
    bal.quantity = snapshot.balance.quantity;
    bal.averageCost = snapshot.balance.averageCost;
    bal.totalValue = round(bal.quantity * bal.averageCost);

    // Create a single lot at the closing average cost
    const lotList = this.getOrCreateLots(input.productId, input.warehouseId);
    const newLotId = this.nextLotId();
    lotList.push({
      lotId: newLotId,
      productId: input.productId,
      warehouseId: input.warehouseId,
      purchaseDate: date,
      quantity: snapshot.balance.quantity,
      unitCost: snapshot.balance.averageCost,
    });

    const openTxn: CostLayerTransaction = {
      id: this.nextTxnId(),
      type: TransactionType.OPEN,
      lotId: newLotId,
      inQty: snapshot.balance.quantity,
      outQty: 0,
      unitCost: snapshot.balance.averageCost,
      diff: 0,
      avgUnitCost: snapshot.balance.averageCost,
      date,
      location: input.warehouseId,
      seq: this.nextSeq(input.productId, input.warehouseId),
      period: input.period,
    };
    log.push(openTxn);
    openTransactions.push(openTxn);

    // Reset accumulated diff
    this.accumulatedDiffMap.set(key, 0);

    // Remove closed period snapshot
    this.closedPeriods.delete(closedKey);

    return {
      openTransactions,
      openingBalance: {
        quantity: bal.quantity,
        totalValue: bal.totalValue,
        averageCost: bal.averageCost,
      },
    };
  }

  private findClosedPeriodKey(
    productId: string,
    warehouseId: string
  ): string | undefined {
    const prefix = `${balanceKey(productId, warehouseId)}::`;
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
    const key = balanceKey(productId, warehouseId);
    return this.accumulatedDiffMap.get(key) ?? 0;
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
    const key = balanceKey(productId, warehouseId);
    this.balances.set(key, {
      productId,
      warehouseId,
      quantity: 0,
      averageCost: 0,
      totalValue: 0,
    });

    const sorted = [...transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const results: RecalculateResultTransaction[] = [];

    for (const txn of sorted) {
      const bal = this.getOrCreateBalance(productId, warehouseId);

      if (txn.transactionType === TransactionType.IN) {
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
