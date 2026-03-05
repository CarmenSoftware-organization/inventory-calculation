import { round } from "../../utils/rounding";
import type {
  EngineTransaction,
  LotRecord,
  FIFOAllocation,
  FIFOResult,
  ValidationError,
  AffectedTransaction,
  SimulationSnapshot,
  ValidationResult,
} from "./types";

export class FIFOInventoryEngine {
  private lots: LotRecord[] = [];
  private results: FIFOResult[] = [];

  // ----------------------------------------------------------
  // Query methods
  // ----------------------------------------------------------

  getLots(): LotRecord[] {
    return structuredClone(this.lots);
  }

  getResults(): FIFOResult[] {
    return this.results;
  }

  getLotsByLocation(location: string): LotRecord[] {
    return this.lots.filter((l) => l.location === location);
  }

  getLotsByProduct(productId: string): LotRecord[] {
    return this.lots.filter((l) => l.productId === productId);
  }

  getLotsByProductAndLocation(
    productId: string,
    location: string
  ): LotRecord[] {
    return this.lots.filter(
      (l) => l.productId === productId && l.location === location
    );
  }

  getQuantityByLocation(location: string): number {
    return this.lots
      .filter((l) => l.location === location)
      .reduce((s, l) => s + l.quantity, 0);
  }

  getQuantityByProduct(productId: string): number {
    return this.lots
      .filter((l) => l.productId === productId)
      .reduce((s, l) => s + l.quantity, 0);
  }

  getQuantityByProductAndLocation(
    productId: string,
    location: string
  ): number {
    return this.lots
      .filter((l) => l.productId === productId && l.location === location)
      .reduce((s, l) => s + l.quantity, 0);
  }

  getAvgCostByProduct(productId: string): number {
    const pLots = this.lots.filter((l) => l.productId === productId);
    const totalQty = pLots.reduce((s, l) => s + l.quantity, 0);
    if (totalQty === 0) return 0;
    const totalCost = pLots.reduce(
      (s, l) => s + l.quantity * l.unitCost,
      0
    );
    return round(totalCost / totalQty);
  }

  getAvgCostByProductAndLocation(
    productId: string,
    location: string
  ): number {
    const pLots = this.lots.filter(
      (l) => l.productId === productId && l.location === location
    );
    const totalQty = pLots.reduce((s, l) => s + l.quantity, 0);
    if (totalQty === 0) return 0;
    const totalCost = pLots.reduce(
      (s, l) => s + l.quantity * l.unitCost,
      0
    );
    return round(totalCost / totalQty);
  }

  getInventorySummary(): Map<
    string,
    {
      productId: string;
      totalQty: number;
      totalCost: number;
      avgCost: number;
      locations: Map<string, number>;
    }
  > {
    const summary = new Map<
      string,
      {
        productId: string;
        totalQty: number;
        totalCost: number;
        avgCost: number;
        locations: Map<string, number>;
      }
    >();

    for (const lot of this.lots) {
      if (!summary.has(lot.productId)) {
        summary.set(lot.productId, {
          productId: lot.productId,
          totalQty: 0,
          totalCost: 0,
          avgCost: 0,
          locations: new Map(),
        });
      }
      const entry = summary.get(lot.productId)!;
      entry.totalQty += lot.quantity;
      entry.totalCost += lot.quantity * lot.unitCost;
      entry.locations.set(
        lot.location,
        (entry.locations.get(lot.location) ?? 0) + lot.quantity
      );
    }

    for (const entry of summary.values()) {
      entry.avgCost =
        entry.totalQty > 0 ? round(entry.totalCost / entry.totalQty) : 0;
      entry.totalCost = round(entry.totalCost);
    }

    return summary;
  }

  // ----------------------------------------------------------
  // Processing
  // ----------------------------------------------------------

  process(tx: EngineTransaction): FIFOResult {
    const lotsBefore = this.getLots();
    let allocations: FIFOAllocation[] = [];

    switch (tx.type) {
      case "Receiving":
        this.handleReceiving(tx);
        break;
      case "Issue":
        allocations = this.handleIssue(tx);
        break;
      case "TransferOut":
        allocations = this.handleTransferOut(tx);
        break;
      case "TransferIn":
        this.handleTransferIn(tx);
        break;
      case "CreditNote":
        allocations = this.handleCreditNote(tx);
        break;
      case "Close":
        allocations = this.handleClose(tx);
        break;
      case "Open":
        this.handleOpen(tx);
        break;
      default:
        throw new Error(`Unknown transaction type: ${(tx as any).type}`);
    }

    const result: FIFOResult = {
      transaction: tx,
      lotsBefore,
      lotsAfter: this.getLots(),
      allocations,
    };
    this.results.push(result);
    return result;
  }

  processAll(transactions: EngineTransaction[]): FIFOResult[] {
    return transactions.map((tx) => this.process(tx));
  }

  // ----------------------------------------------------------
  // Validation
  // ----------------------------------------------------------

  validateIssue(
    newIssue: EngineTransaction,
    allTransactions: EngineTransaction[]
  ): ValidationResult {
    if (newIssue.type !== "Issue") {
      throw new Error("validateIssue only accepts Issue transactions");
    }
    const insertIdx = this.findInsertionIndex(newIssue, allTransactions);
    const merged = [
      ...allTransactions.slice(0, insertIdx),
      newIssue,
      ...allTransactions.slice(insertIdx),
    ];
    const { errors, snapshots } = this.simulateAll(merged);
    const affected = this.findAffectedTransactions(
      allTransactions,
      merged,
      insertIdx
    );
    const maxIssuable = this.findMaxIssuable(
      newIssue,
      allTransactions,
      insertIdx
    );

    return {
      valid: errors.length === 0,
      maxIssuable,
      errors,
      affectedTransactions: affected,
      simulation: snapshots,
    };
  }

  findMaxIssuableQuantity(
    newIssue: EngineTransaction,
    allTransactions: EngineTransaction[]
  ): number {
    const insertIdx = this.findInsertionIndex(newIssue, allTransactions);
    return this.findMaxIssuable(newIssue, allTransactions, insertIdx);
  }

  insertIssueAndRebalance(
    newIssue: EngineTransaction,
    allTransactions: EngineTransaction[]
  ): { transactions: EngineTransaction[]; results: FIFOResult[] } {
    const validation = this.validateIssue(newIssue, allTransactions);
    if (!validation.valid) {
      throw new Error(
        `Cannot insert issue: ${validation.errors
          .map((e) => e.message)
          .join("; ")}`
      );
    }
    const insertIdx = this.findInsertionIndex(newIssue, allTransactions);
    const merged = [
      ...allTransactions.slice(0, insertIdx),
      newIssue,
      ...allTransactions.slice(insertIdx),
    ];
    const adjusted = this.adjustCloseOpen(merged);
    const freshEngine = new FIFOInventoryEngine();
    const results = freshEngine.processAll(adjusted);
    return { transactions: adjusted, results };
  }

  // ----------------------------------------------------------
  // Internal validation helpers
  // ----------------------------------------------------------

  private findInsertionIndex(
    newTx: EngineTransaction,
    transactions: EngineTransaction[]
  ): number {
    let idx = transactions.length;
    for (let i = 0; i < transactions.length; i++) {
      if (transactions[i].date > newTx.date) {
        idx = i;
        break;
      }
    }
    return idx;
  }

  private simulateAll(transactions: EngineTransaction[]): {
    errors: ValidationError[];
    snapshots: SimulationSnapshot[];
  } {
    const sim = new FIFOInventoryEngine();
    const errors: ValidationError[] = [];
    const snapshots: SimulationSnapshot[] = [];

    for (const tx of transactions) {
      try {
        if (tx.type === "Close") {
          const lot = sim.findLot(tx.lot!, tx.location);
          if (lot && lot.quantity !== tx.out!) {
            snapshots.push({
              transactionId: tx.id,
              type: tx.type,
              lots: sim.getLots(),
              status: "ok",
            });
            sim.removeLot(tx.lot!, tx.location);
            continue;
          }
        }
        sim.process(tx);
        snapshots.push({
          transactionId: tx.id,
          type: tx.type,
          lots: sim.getLots(),
          status: "ok",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const lotId = tx.parentLot || tx.lot || "unknown";
        const lot = sim.findLot(lotId, tx.location);
        errors.push({
          transactionId: tx.id,
          type: tx.type,
          productId: tx.productId,
          lot: lotId,
          location: tx.location,
          required: tx.out ?? 0,
          available: lot?.quantity ?? 0,
          shortfall: (tx.out ?? 0) - (lot?.quantity ?? 0),
          message: msg,
        });
        snapshots.push({
          transactionId: tx.id,
          type: tx.type,
          lots: sim.getLots(),
          status: "error",
          error: msg,
        });
      }
    }
    return { errors, snapshots };
  }

  private findAffectedTransactions(
    _original: EngineTransaction[],
    merged: EngineTransaction[],
    _insertIdx: number
  ): AffectedTransaction[] {
    const affected: AffectedTransaction[] = [];
    const mergedEngine = new FIFOInventoryEngine();

    for (const tx of merged) {
      try {
        if (tx.type === "Close") {
          const lot = mergedEngine.findLot(tx.lot!, tx.location);
          if (lot) {
            const newQty = lot.quantity;
            const origQty = tx.out ?? 0;
            if (newQty !== origQty) {
              affected.push({
                transactionId: tx.id,
                type: tx.type,
                productId: tx.productId,
                lot: tx.lot!,
                originalQty: origQty,
                newQty,
                diff: newQty - origQty,
              });
            }
            mergedEngine.removeLot(tx.lot!, tx.location);
            continue;
          }
        }
        mergedEngine.process(tx);
      } catch {
        /* skip errored transactions */
      }
    }
    return affected;
  }

  private findMaxIssuable(
    newIssue: EngineTransaction,
    allTransactions: EngineTransaction[],
    insertIdx: number
  ): number {
    const simBefore = new FIFOInventoryEngine();
    for (let i = 0; i < insertIdx; i++) {
      try {
        simBefore.process(allTransactions[i]);
      } catch {
        /* skip */
      }
    }

    let upperBound: number;
    if (newIssue.parentLot) {
      const lot = simBefore.findLot(newIssue.parentLot, newIssue.location);
      upperBound = lot?.quantity ?? 0;
    } else {
      upperBound = simBefore
        .getLotsByProductAndLocation(newIssue.productId, newIssue.location)
        .reduce((s, l) => s + l.quantity, 0);
    }

    let lo = 0;
    let hi = upperBound;
    let maxValid = 0;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const testIssue = { ...newIssue, out: mid };
      const merged = [
        ...allTransactions.slice(0, insertIdx),
        testIssue,
        ...allTransactions.slice(insertIdx),
      ];
      const { errors } = this.simulateAll(merged);
      if (errors.length === 0) {
        maxValid = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return maxValid;
  }

  private adjustCloseOpen(
    transactions: EngineTransaction[]
  ): EngineTransaction[] {
    const adjusted = structuredClone(transactions);
    const sim = new FIFOInventoryEngine();

    for (const tx of adjusted) {
      if (tx.type === "Close") {
        const lot = sim.findLot(tx.lot!, tx.location);
        if (lot) {
          tx.out = lot.quantity;
          sim.removeLot(tx.lot!, tx.location);
        }
        continue;
      }
      if (tx.type === "Open") {
        const matchingClose = adjusted.find(
          (t) =>
            t.type === "Close" &&
            t.lot === tx.lot &&
            t.location === tx.location
        );
        if (matchingClose) {
          tx.in = matchingClose.out;
        }
        sim.lots.push({
          lot: tx.lot!,
          productId: tx.productId,
          location: tx.location,
          quantity: tx.in!,
          unitCost: tx.unitCost,
          seq: tx.seq,
          createdAt: tx.date,
        });
        continue;
      }
      try {
        sim.process(tx);
      } catch {
        /* skip */
      }
    }

    return adjusted.filter((tx) => {
      if (tx.type === "Close" && tx.out === 0) return false;
      if (tx.type === "Open" && tx.in === 0) return false;
      return true;
    });
  }

  // ----------------------------------------------------------
  // Transaction handlers
  // ----------------------------------------------------------

  private handleReceiving(tx: EngineTransaction): void {
    this.validateRequired(tx, { lot: true, in: true });
    this.lots.push({
      lot: tx.lot!,
      productId: tx.productId,
      location: tx.location,
      quantity: tx.in!,
      unitCost: tx.unitCost,
      seq: tx.seq,
      createdAt: tx.date,
    });
  }

  private handleIssue(tx: EngineTransaction): FIFOAllocation[] {
    this.validateRequired(tx, { out: true });
    if (tx.parentLot) {
      return this.deductFromSpecificLot(
        tx.parentLot,
        tx.productId,
        tx.location,
        tx.out!
      );
    }
    return this.deductFIFO(tx.productId, tx.location, tx.out!);
  }

  private handleTransferOut(tx: EngineTransaction): FIFOAllocation[] {
    this.validateRequired(tx, { out: true, parentLot: true });
    return this.deductFromSpecificLot(
      tx.parentLot!,
      tx.productId,
      tx.location,
      tx.out!
    );
  }

  private handleTransferIn(tx: EngineTransaction): void {
    this.validateRequired(tx, { lot: true, in: true });
    this.lots.push({
      lot: tx.lot!,
      productId: tx.productId,
      location: tx.location,
      quantity: tx.in!,
      unitCost: tx.unitCost,
      seq: tx.seq,
      createdAt: tx.date,
    });
  }

  private handleCreditNote(tx: EngineTransaction): FIFOAllocation[] {
    this.validateRequired(tx, { out: true, parentLot: true });
    return this.deductFromSpecificLot(
      tx.parentLot!,
      tx.productId,
      tx.location,
      tx.out!
    );
  }

  private handleClose(tx: EngineTransaction): FIFOAllocation[] {
    this.validateRequired(tx, { lot: true, out: true });
    const lot = this.findLot(tx.lot!, tx.location);
    if (!lot) {
      throw new Error(
        `CLOSE: Lot ${tx.lot} not found at location ${tx.location}`
      );
    }
    if (lot.quantity !== tx.out!) {
      throw new Error(
        `CLOSE mismatch: Lot ${tx.lot} has ${lot.quantity} units but closing with ${tx.out}`
      );
    }
    const allocation: FIFOAllocation = {
      lot: lot.lot,
      productId: lot.productId,
      quantity: lot.quantity,
      unitCost: lot.unitCost,
      totalCost: round(lot.quantity * lot.unitCost),
    };
    this.removeLot(tx.lot!, tx.location);
    return [allocation];
  }

  private handleOpen(tx: EngineTransaction): void {
    this.validateRequired(tx, { lot: true, in: true });
    this.lots.push({
      lot: tx.lot!,
      productId: tx.productId,
      location: tx.location,
      quantity: tx.in!,
      unitCost: tx.unitCost,
      seq: tx.seq,
      createdAt: tx.date,
    });
  }

  // ----------------------------------------------------------
  // FIFO Core Logic
  // ----------------------------------------------------------

  private deductFIFO(
    productId: string,
    location: string,
    quantity: number
  ): FIFOAllocation[] {
    const allocations: FIFOAllocation[] = [];
    let remaining = quantity;

    const targetLots = this.lots
      .filter(
        (l) =>
          l.productId === productId &&
          l.location === location &&
          l.quantity > 0
      )
      .sort(
        (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt)
      );

    for (const lot of targetLots) {
      if (remaining <= 0) break;
      const deduct = Math.min(lot.quantity, remaining);
      lot.quantity -= deduct;
      remaining -= deduct;
      allocations.push({
        lot: lot.lot,
        productId,
        quantity: deduct,
        unitCost: lot.unitCost,
        totalCost: round(deduct * lot.unitCost),
      });
    }

    if (remaining > 0) {
      throw new Error(
        `Insufficient stock for product ${productId} at ${location}. Short by ${remaining} units.`
      );
    }

    this.lots = this.lots.filter((l) => l.quantity > 0);
    return allocations;
  }

  private deductFromSpecificLot(
    lotId: string,
    productId: string,
    location: string,
    quantity: number
  ): FIFOAllocation[] {
    const lot = this.findLot(lotId, location);
    if (!lot) {
      throw new Error(`Lot ${lotId} not found at location ${location}`);
    }
    if (lot.quantity < quantity) {
      throw new Error(
        `Insufficient stock in lot ${lotId}. Available: ${lot.quantity}, Requested: ${quantity}`
      );
    }
    lot.quantity -= quantity;
    const allocation: FIFOAllocation = {
      lot: lotId,
      productId,
      quantity,
      unitCost: lot.unitCost,
      totalCost: round(quantity * lot.unitCost),
    };
    this.lots = this.lots.filter((l) => l.quantity > 0);
    return [allocation];
  }

  // ----------------------------------------------------------
  // Helpers (public for validation/simulation access)
  // ----------------------------------------------------------

  findLot(lotId: string, location: string): LotRecord | undefined {
    return this.lots.find(
      (l) => l.lot === lotId && l.location === location
    );
  }

  removeLot(lotId: string, location: string): void {
    this.lots = this.lots.filter(
      (l) => !(l.lot === lotId && l.location === location)
    );
  }

  private validateRequired(
    tx: EngineTransaction,
    fields: {
      lot?: boolean;
      in?: boolean;
      out?: boolean;
      parentLot?: boolean;
    }
  ): void {
    if (fields.lot && !tx.lot)
      throw new Error(`${tx.type} (${tx.id}): 'lot' is required`);
    if (fields.in && (tx.in == null || tx.in <= 0))
      throw new Error(`${tx.type} (${tx.id}): 'in' must be > 0`);
    if (fields.out && (tx.out == null || tx.out <= 0))
      throw new Error(`${tx.type} (${tx.id}): 'out' must be > 0`);
    if (fields.parentLot && !tx.parentLot)
      throw new Error(`${tx.type} (${tx.id}): 'parentLot' is required`);
  }
}
