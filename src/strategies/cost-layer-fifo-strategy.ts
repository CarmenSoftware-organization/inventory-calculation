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
import { FIFOInventoryEngine } from "../engine/fifo";
import type { EngineTransaction, LotRecord } from "../engine/fifo";

function lotKey(productId: string, warehouseId: string): string {
  return `${productId}::${warehouseId}`;
}

function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

interface ClosedPeriodSnapshot {
  period: string;
  lots: InventoryLot[];
  accumulatedDiff: number;
}

export class CostLayerFIFOStrategy implements CostLayerCostingStrategy {
  private engine = new FIFOInventoryEngine();
  private seqCounters = new Map<string, number>();
  private closedPeriods = new Map<string, ClosedPeriodSnapshot>();
  private accumulatedDiff = new Map<string, number>();
  private txnCounter = 0;
  private lotCounter = 0;
  private transactionLog = new Map<string, CostLayerTransaction[]>();

  // Track inputs for recalculate/replay
  private processedInputs: Array<{
    method: string;
    input: any;
  }> = [];

  getEngine(): FIFOInventoryEngine {
    return this.engine;
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

  private availableQty(productId: string, warehouseId: string): number {
    return this.engine.getQuantityByProductAndLocation(
      productId,
      warehouseId
    );
  }

  private totalValue(productId: string, warehouseId: string): number {
    const lots = this.engine.getLotsByProductAndLocation(
      productId,
      warehouseId
    );
    return round(lots.reduce((sum, l) => sum + l.quantity * l.unitCost, 0));
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
    const lotId = this.nextLotId();
    const purchaseDate = input.date ?? new Date();
    const dateStr = formatDate(purchaseDate);
    const txnId = this.nextTxnId();
    const seq = this.nextSeq(input.productId, input.warehouseId);

    const engineTx: EngineTransaction = {
      id: txnId,
      type: "Receiving",
      productId: input.productId,
      lot: lotId,
      in: input.quantity,
      out: null,
      unitCost: input.unitCost,
      date: dateStr,
      location: input.warehouseId,
      seq,
      parentLot: null,
      period: derivePeriod(purchaseDate),
    };

    this.engine.process(engineTx);

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
      seq,
      period,
      referenceDoc: input.referenceDoc,
    });

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    return {
      transaction: txn,
      lotDetails: [lotDetail],
      balance: { quantity: qty, totalValue: val },
    };
  }

  issueStock(input: IssueStockInput): IssueResult {
    const available = this.availableQty(input.productId, input.warehouseId);
    if (available < input.quantity) {
      throw new InsufficientStockError(
        input.productId,
        input.warehouseId,
        input.quantity,
        available
      );
    }

    const txnId = this.nextTxnId();
    const issueDate = input.date ?? new Date();
    const dateStr = formatDate(issueDate);
    const period = derivePeriod(issueDate);

    // Get lots before consumption for FIFO allocation
    const lotsBefore = this.engine.getLotsByProductAndLocation(
      input.productId,
      input.warehouseId
    );

    // Build an Issue transaction for the engine (FIFO deduction)
    const seq = this.nextSeq(input.productId, input.warehouseId);
    const engineTx: EngineTransaction = {
      id: txnId,
      type: "Issue",
      productId: input.productId,
      lot: null,
      in: null,
      out: input.quantity,
      unitCost: 0,
      date: dateStr,
      location: input.warehouseId,
      seq,
      parentLot: null,
      period,
    };

    const result = this.engine.process(engineTx);

    // Build lot details from allocations
    const lotDetails: InventoryTransactionLot[] = result.allocations.map(
      (a) => ({
        transactionId: txnId,
        lotId: a.lot,
        quantity: a.quantity,
        unitCost: a.unitCost,
      })
    );

    const totalCost = round(
      result.allocations.reduce((s, a) => s + a.totalCost, 0)
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
    const log = this.getOrCreateLog(input.productId, input.warehouseId);
    for (const alloc of result.allocations) {
      log.push({
        id: txnId,
        type: TransactionType.OUT,
        lotId: undefined,
        inQty: 0,
        outQty: alloc.quantity,
        unitCost: alloc.unitCost,
        diff: 0,
        date: issueDate,
        location: input.warehouseId,
        seq: this.nextSeq(input.productId, input.warehouseId),
        parentLotId: alloc.lot,
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
      balance: { quantity: qty, totalValue: val },
    };
  }

  adjustStock(input: AdjustStockInput): AdjustResult {
    let lotDetails: InventoryTransactionLot[] | undefined;
    let txnId: string;

    if (input.quantity > 0) {
      const lotId = this.nextLotId();
      const adjustDate = input.date ?? new Date();
      const dateStr = formatDate(adjustDate);
      const seq = this.nextSeq(input.productId, input.warehouseId);

      txnId = this.nextTxnId();

      const engineTx: EngineTransaction = {
        id: txnId,
        type: "Receiving",
        productId: input.productId,
        lot: lotId,
        in: input.quantity,
        out: null,
        unitCost: input.unitCost,
        date: dateStr,
        location: input.warehouseId,
        seq,
        parentLot: null,
        period: derivePeriod(adjustDate),
      };

      this.engine.process(engineTx);

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
        seq,
        period,
        referenceDoc: input.referenceDoc,
      });
    } else {
      const removeQty = Math.abs(input.quantity);
      const available = this.availableQty(input.productId, input.warehouseId);
      if (available < removeQty) {
        throw new InsufficientStockError(
          input.productId,
          input.warehouseId,
          removeQty,
          available
        );
      }

      txnId = this.nextTxnId();
      const adjustDate = input.date ?? new Date();
      const dateStr = formatDate(adjustDate);
      const period = derivePeriod(adjustDate);
      const seq = this.nextSeq(input.productId, input.warehouseId);

      const engineTx: EngineTransaction = {
        id: txnId,
        type: "Issue",
        productId: input.productId,
        lot: null,
        in: null,
        out: removeQty,
        unitCost: 0,
        date: dateStr,
        location: input.warehouseId,
        seq,
        parentLot: null,
        period,
      };

      const result = this.engine.process(engineTx);

      lotDetails = result.allocations.map((a) => ({
        transactionId: txnId,
        lotId: a.lot,
        quantity: a.quantity,
        unitCost: a.unitCost,
      }));

      const log = this.getOrCreateLog(input.productId, input.warehouseId);
      for (const alloc of result.allocations) {
        log.push({
          id: txnId,
          type: TransactionType.ADJUST,
          lotId: undefined,
          inQty: 0,
          outQty: alloc.quantity,
          unitCost: alloc.unitCost,
          diff: 0,
          date: adjustDate,
          location: input.warehouseId,
          seq: this.nextSeq(input.productId, input.warehouseId),
          parentLotId: alloc.lot,
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
      balance: { quantity: qty, totalValue: val },
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

    const transferDate = input.date ?? new Date();
    const dateStr = formatDate(transferDate);
    const period = derivePeriod(transferDate);

    // Get source lots for per-lot transfer (FIFO order)
    const sourceLots = this.engine.getLotsByProductAndLocation(
      input.productId,
      input.fromWarehouseId
    );
    sourceLots.sort(
      (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt)
    );

    let remaining = input.quantity;
    let totalTransferCost = 0;
    const transferOutTransactions: CostLayerTransaction[] = [];
    const transferInTransactions: CostLayerTransaction[] = [];
    const consumedEntries: Array<{
      lotId: string;
      quantity: number;
      unitCost: number;
    }> = [];

    // Calculate what will be consumed FIFO
    for (const lot of sourceLots) {
      if (remaining <= 0) break;
      if (lot.quantity <= 0) continue;

      const consume = Math.min(lot.quantity, remaining);
      remaining = round(remaining - consume);
      totalTransferCost += consume * lot.unitCost;

      consumedEntries.push({
        lotId: lot.lot,
        quantity: consume,
        unitCost: lot.unitCost,
      });
    }

    totalTransferCost = round(totalTransferCost);

    // Process per-lot TransferOut/TransferIn via engine
    const sourceLog = this.getOrCreateLog(
      input.productId,
      input.fromWarehouseId
    );
    const destLog = this.getOrCreateLog(
      input.productId,
      input.toWarehouseId
    );

    for (const entry of consumedEntries) {
      const outTxnId = this.nextTxnId();
      const outSeq = this.nextSeq(input.productId, input.fromWarehouseId);

      // TransferOut via engine
      const outEngineTx: EngineTransaction = {
        id: outTxnId,
        type: "TransferOut",
        productId: input.productId,
        lot: entry.lotId,
        in: null,
        out: entry.quantity,
        unitCost: entry.unitCost,
        date: dateStr,
        location: input.fromWarehouseId,
        seq: outSeq,
        parentLot: entry.lotId,
        period,
      };

      this.engine.process(outEngineTx);

      const outTxn: CostLayerTransaction = {
        id: outTxnId,
        type: TransactionType.TRANSFER_OUT,
        lotId: entry.lotId,
        inQty: 0,
        outQty: entry.quantity,
        unitCost: entry.unitCost,
        diff: 0,
        date: transferDate,
        location: input.fromWarehouseId,
        seq: outSeq,
        parentLotId: entry.lotId,
        period,
        referenceDoc: input.referenceDoc,
      };
      sourceLog.push(outTxn);
      transferOutTransactions.push(outTxn);

      // TransferIn via engine
      const newLotId = this.nextLotId();
      const inTxnId = this.nextTxnId();
      const inSeq = this.nextSeq(input.productId, input.toWarehouseId);

      const inEngineTx: EngineTransaction = {
        id: inTxnId,
        type: "TransferIn",
        productId: input.productId,
        lot: newLotId,
        in: entry.quantity,
        out: null,
        unitCost: entry.unitCost,
        date: dateStr,
        location: input.toWarehouseId,
        seq: inSeq,
        parentLot: null,
        period,
      };

      this.engine.process(inEngineTx);

      const inTxn: CostLayerTransaction = {
        id: inTxnId,
        type: TransactionType.TRANSFER_IN,
        lotId: newLotId,
        inQty: entry.quantity,
        outQty: 0,
        unitCost: entry.unitCost,
        diff: 0,
        date: transferDate,
        location: input.toWarehouseId,
        seq: inSeq,
        period,
        referenceDoc: input.referenceDoc,
      };
      destLog.push(inTxn);
      transferInTransactions.push(inTxn);
    }

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
    // Find the lot in the engine
    const lots = this.engine.getLotsByProductAndLocation(
      input.productId,
      input.warehouseId
    );
    const lot = lots.find((l) => l.lot === input.lotId);

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

    const date = input.date ?? new Date();
    const dateStr = formatDate(date);
    const period = derivePeriod(date);
    const txnId = this.nextTxnId();
    const seq = this.nextSeq(input.productId, input.warehouseId);

    const engineTx: EngineTransaction = {
      id: txnId,
      type: "CreditNote",
      productId: input.productId,
      lot: null,
      in: null,
      out: input.quantity,
      unitCost: input.unitCost,
      date: dateStr,
      location: input.warehouseId,
      seq,
      parentLot: input.lotId,
      period,
    };

    this.engine.process(engineTx);

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
      seq,
      period,
      referenceDoc: input.referenceDoc,
    };
    log.push(clTxn);

    const qty = this.availableQty(input.productId, input.warehouseId);
    const val = this.totalValue(input.productId, input.warehouseId);

    return {
      transaction: clTxn,
      balance: { quantity: qty, totalValue: val },
    };
  }

  closePeriod(input: ClosePeriodInput): ClosePeriodResult {
    const key = lotKey(input.productId, input.warehouseId);
    const date = input.date ?? new Date();
    const dateStr = formatDate(date);

    // Get current lots from engine for this product/location
    const currentLots = this.engine.getLotsByProductAndLocation(
      input.productId,
      input.warehouseId
    );
    const activeLots = currentLots.filter((l) => l.quantity > 0);

    // Build snapshot for reopening
    const snapshot: InventoryLot[] = activeLots.map((l) => ({
      lotId: l.lot,
      productId: l.productId,
      warehouseId: input.warehouseId,
      purchaseDate: new Date(l.createdAt),
      quantity: l.quantity,
      unitCost: l.unitCost,
    }));

    const accDiff = this.accumulatedDiff.get(key) ?? 0;

    const closedKey = `${key}::${input.period}`;
    this.closedPeriods.set(closedKey, {
      period: input.period,
      lots: snapshot,
      accumulatedDiff: accDiff,
    });

    const closeTransactions: CostLayerTransaction[] = [];
    const log = this.getOrCreateLog(input.productId, input.warehouseId);

    // Close each lot via engine and record transactions
    for (const lot of activeLots) {
      const txnId = this.nextTxnId();
      const seq = this.nextSeq(input.productId, input.warehouseId);

      const engineTx: EngineTransaction = {
        id: txnId,
        type: "Close",
        productId: input.productId,
        lot: lot.lot,
        in: null,
        out: lot.quantity,
        unitCost: lot.unitCost,
        date: dateStr,
        location: input.warehouseId,
        seq,
        parentLot: null,
        period: input.period,
      };

      this.engine.process(engineTx);

      const clTxn: CostLayerTransaction = {
        id: txnId,
        type: TransactionType.CLOSE,
        lotId: lot.lot,
        inQty: 0,
        outQty: lot.quantity,
        unitCost: lot.unitCost,
        diff: 0,
        date,
        location: input.warehouseId,
        seq,
        parentLotId: lot.lot,
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
    const dateStr = formatDate(date);
    const openTransactions: CostLayerTransaction[] = [];
    const log = this.getOrCreateLog(input.productId, input.warehouseId);

    // Re-create lots from snapshot via engine
    for (const lot of snapshot.lots) {
      const txnId = this.nextTxnId();
      const seq = this.nextSeq(input.productId, input.warehouseId);

      const engineTx: EngineTransaction = {
        id: txnId,
        type: "Open",
        productId: input.productId,
        lot: lot.lotId,
        in: lot.quantity,
        out: null,
        unitCost: lot.unitCost,
        date: dateStr,
        location: input.warehouseId,
        seq,
        parentLot: null,
        period: input.period,
      };

      this.engine.process(engineTx);

      const clTxn: CostLayerTransaction = {
        id: txnId,
        type: TransactionType.OPEN,
        lotId: lot.lotId,
        inQty: lot.quantity,
        outQty: 0,
        unitCost: lot.unitCost,
        diff: 0,
        date,
        location: input.warehouseId,
        seq,
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
    const lots = this.engine.getLotsByProductAndLocation(
      productId,
      warehouseId
    );
    const qty = lots.reduce((s, l) => s + l.quantity, 0);
    const val = round(lots.reduce((s, l) => s + l.quantity * l.unitCost, 0));
    const avgCost = qty > 0 ? round(val / qty) : 0;

    return {
      productId,
      warehouseId,
      quantity: qty,
      totalValue: val,
      averageCost: avgCost,
      lots: lots
        .filter((l) => l.quantity > 0)
        .map((l) => ({
          lotId: l.lot,
          productId: l.productId,
          warehouseId,
          purchaseDate: new Date(l.createdAt),
          quantity: l.quantity,
          unitCost: l.unitCost,
        })),
    };
  }

  recalculate(
    productId: string,
    warehouseId: string,
    transactions: RecalculateTransaction[]
  ): RecalculateResult {
    // Create a fresh engine for replay
    const freshEngine = new FIFOInventoryEngine();

    const sorted = [...transactions].sort(
      (a, b) => a.date.getTime() - b.date.getTime()
    );

    const results: RecalculateResultTransaction[] = [];
    let lotSeq = 0;
    let lotNum = 0;

    for (const txn of sorted) {
      if (txn.transactionType === TransactionType.IN) {
        lotNum++;
        lotSeq++;
        const lotId = `recalc-lot-${lotNum}`;
        const dateStr = formatDate(txn.date);

        const engineTx: EngineTransaction = {
          id: `recalc-${lotSeq}`,
          type: "Receiving",
          productId,
          lot: lotId,
          in: txn.quantity,
          out: null,
          unitCost: txn.unitCost,
          date: dateStr,
          location: warehouseId,
          seq: lotSeq,
          parentLot: null,
          period: derivePeriod(txn.date),
        };

        freshEngine.process(engineTx);

        results.push({
          transactionType: TransactionType.IN,
          quantity: txn.quantity,
          unitCost: txn.unitCost,
          totalCost: round(txn.quantity * txn.unitCost),
          date: txn.date,
          referenceDoc: txn.referenceDoc,
        });
      } else {
        lotSeq++;
        const dateStr = formatDate(txn.date);

        const engineTx: EngineTransaction = {
          id: `recalc-${lotSeq}`,
          type: "Issue",
          productId,
          lot: null,
          in: null,
          out: txn.quantity,
          unitCost: 0,
          date: dateStr,
          location: warehouseId,
          seq: lotSeq,
          parentLot: null,
          period: derivePeriod(txn.date),
        };

        const engineResult = freshEngine.process(engineTx);
        const totalCost = round(
          engineResult.allocations.reduce((s, a) => s + a.totalCost, 0)
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

    const remainingLots = freshEngine.getLotsByProductAndLocation(
      productId,
      warehouseId
    );
    const qty = remainingLots.reduce((s, l) => s + l.quantity, 0);
    const val = round(
      remainingLots.reduce((s, l) => s + l.quantity * l.unitCost, 0)
    );
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
