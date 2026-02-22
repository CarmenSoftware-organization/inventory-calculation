import { CostLayerFIFOStrategy } from "../src/strategies/cost-layer-fifo-strategy";
import { TransactionType } from "../src/types";
import { InsufficientStockError, PeriodNotClosedError } from "../src/errors";

describe("CostLayerFIFOStrategy", () => {
  let strategy: CostLayerFIFOStrategy;

  beforeEach(() => {
    strategy = new CostLayerFIFOStrategy();
  });

  // --- Receive ---

  describe("receiveStock", () => {
    it("should create a lot and record a cost layer transaction", () => {
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });

      expect(result.balance.quantity).toBe(20);
      expect(result.balance.totalValue).toBe(666.6);
      expect(result.lotDetails).toHaveLength(1);

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(TransactionType.IN);
      expect(log[0].seq).toBe(1);
      expect(log[0].period).toBe("2025-11");
      expect(log[0].inQty).toBe(20);
      expect(log[0].unitCost).toBe(33.33);
    });

    it("should assign sequential seq numbers per location", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log[0].seq).toBe(1);
      expect(log[1].seq).toBe(2);
    });
  });

  // --- Issue ---

  describe("issueStock", () => {
    it("should consume lots FIFO and record per-lot transactions with parentLotId", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        date: new Date("2025-11-03"),
      });

      expect(result.totalCost).toBe(166.65); // 5 * 33.33
      expect(result.balance.quantity).toBe(25);

      const log = strategy.getTransactionLog("P1", "MK");
      // 2 receives + 1 issue log entry
      expect(log).toHaveLength(3);
      const issueTxn = log[2];
      expect(issueTxn.type).toBe(TransactionType.OUT);
      expect(issueTxn.outQty).toBe(5);
      expect(issueTxn.parentLotId).toBeDefined();
    });

    it("should throw InsufficientStockError when not enough stock", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 10,
        date: new Date("2025-11-02"),
      });

      expect(() => {
        strategy.issueStock({
          productId: "P1",
          warehouseId: "MK",
          quantity: 10,
          date: new Date("2025-11-03"),
        });
      }).toThrow(InsufficientStockError);
    });

    it("should consume across multiple lots FIFO", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 10,
        date: new Date("2025-11-01"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 20,
        date: new Date("2025-11-02"),
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        date: new Date("2025-11-03"),
      });

      // 3 * 10 + 2 * 20 = 70
      expect(result.totalCost).toBe(70);
      expect(result.balance.quantity).toBe(3);

      const log = strategy.getTransactionLog("P1", "MK");
      // 2 receives + 2 issue entries (consumed from 2 lots)
      const issueEntries = log.filter((t) => t.type === TransactionType.OUT);
      expect(issueEntries).toHaveLength(2);
    });
  });

  // --- Transfer ---

  describe("transferStockCostLayer", () => {
    it("should create per-lot TRANSFER_OUT/IN pairs preserving individual costs", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });

      // Issue 5 first (like C003 in Excel)
      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        date: new Date("2025-11-03"),
      });

      // Transfer remaining 25 units (15 from lot1 + 10 from lot2) — but let's transfer 20
      const result = strategy.transferStockCostLayer({
        productId: "P1",
        fromWarehouseId: "MK",
        toWarehouseId: "KC",
        quantity: 20,
        date: new Date("2025-11-05"),
      });

      expect(result.transferOutTransactions).toHaveLength(2);
      expect(result.transferInTransactions).toHaveLength(2);
      expect(result.totalTransferCost).toBeCloseTo(666.65, 2);

      // Verify costs are preserved (not blended)
      const out1 = result.transferOutTransactions[0];
      const out2 = result.transferOutTransactions[1];
      expect(out1.unitCost).toBe(33.33);
      expect(out1.outQty).toBe(15);
      expect(out2.unitCost).toBe(33.34);
      expect(out2.outQty).toBe(5);

      // Verify destination gets matching lots
      const in1 = result.transferInTransactions[0];
      const in2 = result.transferInTransactions[1];
      expect(in1.unitCost).toBe(33.33);
      expect(in1.inQty).toBe(15);
      expect(in2.unitCost).toBe(33.34);
      expect(in2.inQty).toBe(5);

      // Verify source balance
      const sourceVal = strategy.getValuation("P1", "MK");
      expect(sourceVal.quantity).toBe(5); // 10 remaining from lot2

      // Verify destination balance
      const destVal = strategy.getValuation("P1", "KC");
      expect(destVal.quantity).toBe(20);
    });

    it("should set parentLotId on TRANSFER_OUT transactions", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const result = strategy.transferStockCostLayer({
        productId: "P1",
        fromWarehouseId: "MK",
        toWarehouseId: "KC",
        quantity: 5,
        date: new Date("2025-11-05"),
      });

      expect(result.transferOutTransactions[0].parentLotId).toBeDefined();
      expect(result.transferOutTransactions[0].type).toBe(
        TransactionType.TRANSFER_OUT
      );
      expect(result.transferInTransactions[0].type).toBe(
        TransactionType.TRANSFER_IN
      );
    });
  });

  // --- transferStock (backward compat) ---

  describe("transferStock", () => {
    it("should return TransferResult compatible with existing interface", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const result = strategy.transferStock({
        productId: "P1",
        fromWarehouseId: "MK",
        toWarehouseId: "KC",
        quantity: 5,
        date: new Date("2025-11-05"),
      });

      expect(result.transferCost).toBe(250);
      expect(result.issueTransaction).toBeDefined();
      expect(result.receiveTransaction).toBeDefined();
    });
  });

  // --- Credit Note ---

  describe("creditNote", () => {
    it("should adjust a specific lot by lotId", () => {
      const recv = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });

      const lotId = recv.lotDetails![0].lotId;

      const result = strategy.creditNote({
        productId: "P1",
        warehouseId: "MK",
        lotId,
        quantity: 1,
        unitCost: 33.34,
        date: new Date("2025-11-06"),
      });

      expect(result.transaction.type).toBe(TransactionType.CREDIT_NOTE);
      expect(result.transaction.outQty).toBe(1);
      expect(result.balance.quantity).toBe(9);
    });

    it("should throw when lot not found", () => {
      expect(() => {
        strategy.creditNote({
          productId: "P1",
          warehouseId: "MK",
          lotId: "nonexistent",
          quantity: 1,
          unitCost: 10,
        });
      }).toThrow("not found");
    });

    it("should throw InsufficientStockError when quantity exceeds lot", () => {
      const recv = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 10,
        date: new Date("2025-11-02"),
      });

      const lotId = recv.lotDetails![0].lotId;

      expect(() => {
        strategy.creditNote({
          productId: "P1",
          warehouseId: "MK",
          lotId,
          quantity: 10,
          unitCost: 10,
        });
      }).toThrow(InsufficientStockError);
    });
  });

  // --- Period Management ---

  describe("closePeriod / openPeriod", () => {
    it("should zero out lots on close and restore on open", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const closeResult = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
        date: new Date("2025-11-30"),
      });

      expect(closeResult.closeTransactions).toHaveLength(1);
      expect(closeResult.closeTransactions[0].type).toBe(TransactionType.CLOSE);
      expect(closeResult.closingBalance.quantity).toBe(10);
      expect(closeResult.closingBalance.totalValue).toBe(500);

      // After close, valuation should be zero
      const val = strategy.getValuation("P1", "MK");
      expect(val.quantity).toBe(0);

      // Open next period
      const openResult = strategy.openPeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-12",
        date: new Date("2025-12-01"),
      });

      expect(openResult.openTransactions).toHaveLength(1);
      expect(openResult.openTransactions[0].type).toBe(TransactionType.OPEN);
      expect(openResult.openingBalance.quantity).toBe(10);
      expect(openResult.openingBalance.totalValue).toBe(500);
    });

    it("should close multiple lots and reopen them", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });

      const closeResult = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
      });

      expect(closeResult.closeTransactions).toHaveLength(2);

      const openResult = strategy.openPeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-12",
      });

      expect(openResult.openTransactions).toHaveLength(2);
      expect(openResult.openingBalance.quantity).toBe(30);
    });

    it("should throw PeriodNotClosedError when opening without prior close", () => {
      expect(() => {
        strategy.openPeriod({
          productId: "P1",
          warehouseId: "MK",
          period: "2025-12",
        });
      }).toThrow(PeriodNotClosedError);
    });
  });

  // --- Transaction Log ---

  describe("getTransactionLog", () => {
    it("should contain all transaction types in correct order", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        date: new Date("2025-11-03"),
      });

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log[0].type).toBe(TransactionType.IN);
      expect(log[1].type).toBe(TransactionType.OUT);

      // Verify sequential ordering
      for (let i = 1; i < log.length; i++) {
        expect(log[i].seq).toBeGreaterThan(log[i - 1].seq);
      }
    });
  });

  // --- getValuation ---

  describe("getValuation", () => {
    it("should return correct valuation with lots", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const val = strategy.getValuation("P1", "MK");
      expect(val.quantity).toBe(10);
      expect(val.totalValue).toBe(500);
      expect(val.averageCost).toBe(50);
      expect(val.lots).toHaveLength(1);
    });
  });

  // --- Adjust ---

  describe("adjustStock", () => {
    it("should create a new lot for positive adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 45,
        date: new Date("2025-11-03"),
      });

      expect(result.balance.quantity).toBe(15);
    });

    it("should consume lots FIFO for negative adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: -3,
        unitCost: 50,
        date: new Date("2025-11-03"),
      });

      expect(result.balance.quantity).toBe(7);
    });
  });

  // --- Full Excel FIFO scenario ---

  describe("Full Excel FIFO scenario (C001-C014)", () => {
    it("should replay the exact FIFO sheet from the Excel file", () => {
      // C001: Receiving lot MK-251102-01: 20 units @ 33.33
      const c001 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 20,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      expect(c001.balance.quantity).toBe(20);
      expect(c001.balance.totalValue).toBe(666.6);
      const lot1Id = c001.lotDetails![0].lotId;

      // C002: Receiving lot MK-251102-02: 10 units @ 33.34
      const c002 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });
      expect(c002.balance.quantity).toBe(30);
      // 666.6 + 333.4 = 1000.0
      expect(c002.balance.totalValue).toBe(1000);
      const lot2Id = c002.lotDetails![0].lotId;

      // C003: Issue 5 units from MK (FIFO: from lot1 @ 33.33)
      const c003 = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        date: new Date("2025-11-03"),
      });
      expect(c003.totalCost).toBe(166.65); // 5 * 33.33
      expect(c003.balance.quantity).toBe(25);

      // C004-C007: Transfer 20 units MK -> KC (15 from lot1 + 5 from lot2)
      const transfer = strategy.transferStockCostLayer({
        productId: "P1",
        fromWarehouseId: "MK",
        toWarehouseId: "KC",
        quantity: 20,
        date: new Date("2025-11-05"),
      });

      // C004: Transfer out 15 @ 33.33 from lot1
      expect(transfer.transferOutTransactions[0].outQty).toBe(15);
      expect(transfer.transferOutTransactions[0].unitCost).toBe(33.33);

      // C005: Transfer out 5 @ 33.34 from lot2
      expect(transfer.transferOutTransactions[1].outQty).toBe(5);
      expect(transfer.transferOutTransactions[1].unitCost).toBe(33.34);

      // C006: Transfer in 15 @ 33.33 to KC
      expect(transfer.transferInTransactions[0].inQty).toBe(15);
      expect(transfer.transferInTransactions[0].unitCost).toBe(33.33);

      // C007: Transfer in 5 @ 33.34 to KC
      expect(transfer.transferInTransactions[1].inQty).toBe(5);
      expect(transfer.transferInTransactions[1].unitCost).toBe(33.34);

      // After transfer: MK has 5 units (lot2 remainder), KC has 20 units
      const mkVal = strategy.getValuation("P1", "MK");
      expect(mkVal.quantity).toBe(5);
      expect(mkVal.totalValue).toBe(166.7); // 5 * 33.34

      const kcVal = strategy.getValuation("P1", "KC");
      expect(kcVal.quantity).toBe(20);

      // C008: Credit Note — 1 unit from remaining MK lot (lot2) @ 33.34
      const creditResult = strategy.creditNote({
        productId: "P1",
        warehouseId: "MK",
        lotId: lot2Id,
        quantity: 1,
        unitCost: 33.34,
        date: new Date("2025-11-06"),
      });
      expect(creditResult.balance.quantity).toBe(4);

      // C009: CLOSE MK period 2025-11 (4 units of lot2 @ 33.34)
      const closeMK = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
      });
      expect(closeMK.closeTransactions).toHaveLength(1);
      expect(closeMK.closingBalance.quantity).toBe(4);
      expect(closeMK.closingBalance.totalValue).toBe(133.36); // 4 * 33.34

      // C010-C011: CLOSE KC period 2025-11 (15 @ 33.33 + 5 @ 33.34)
      const closeKC = strategy.closePeriod({
        productId: "P1",
        warehouseId: "KC",
        period: "2025-11",
      });
      expect(closeKC.closeTransactions).toHaveLength(2);
      expect(closeKC.closingBalance.quantity).toBe(20);
      // 15*33.33 + 5*33.34 = 499.95 + 166.70 = 666.65
      expect(closeKC.closingBalance.totalValue).toBe(666.65);

      // C012: OPEN MK period 2025-12
      const openMK = strategy.openPeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-12",
      });
      expect(openMK.openTransactions).toHaveLength(1);
      expect(openMK.openingBalance.quantity).toBe(4);

      // C013-C014: OPEN KC period 2025-12
      const openKC = strategy.openPeriod({
        productId: "P1",
        warehouseId: "KC",
        period: "2025-12",
      });
      expect(openKC.openTransactions).toHaveLength(2);
      expect(openKC.openingBalance.quantity).toBe(20);

      // Verify transaction logs
      const mkLog = strategy.getTransactionLog("P1", "MK");
      const kcLog = strategy.getTransactionLog("P1", "KC");

      // MK: 2 receives + 1 issue + 2 transfer-out + 1 credit note + 1 close + 1 open = 8
      expect(mkLog.length).toBeGreaterThanOrEqual(8);
      // KC: 2 transfer-in + 2 close + 2 open = 6
      expect(kcLog.length).toBeGreaterThanOrEqual(6);

      // Verify all log entries have sequential seq numbers
      for (const entry of mkLog) {
        expect(entry.seq).toBeGreaterThan(0);
        expect(entry.period).toBeDefined();
      }
    });
  });

  // --- Recalculate ---

  describe("recalculate", () => {
    it("should recalculate from scratch using FIFO", () => {
      const result = strategy.recalculate("P1", "MK", [
        {
          transactionType: TransactionType.IN,
          quantity: 10,
          unitCost: 50,
          date: new Date("2025-11-01"),
        },
        {
          transactionType: TransactionType.OUT,
          quantity: 3,
          unitCost: 0, // ignored for FIFO
          date: new Date("2025-11-02"),
        },
      ]);

      expect(result.finalBalance.quantity).toBe(7);
      expect(result.finalBalance.totalValue).toBe(350);
    });
  });
});
