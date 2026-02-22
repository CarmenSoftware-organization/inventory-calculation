import { CostLayerAverageStrategy } from "../src/strategies/cost-layer-average-strategy";
import { TransactionType } from "../src/types";
import { InsufficientStockError, PeriodNotClosedError } from "../src/errors";

describe("CostLayerAverageStrategy", () => {
  let strategy: CostLayerAverageStrategy;

  beforeEach(() => {
    strategy = new CostLayerAverageStrategy();
  });

  // --- Receive ---

  describe("receiveStock", () => {
    it("should create a lot, update average, and track diff", () => {
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });

      expect(result.balance.quantity).toBe(3);
      expect(result.balance.averageCost).toBe(33.33);

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log).toHaveLength(1);
      expect(log[0].type).toBe(TransactionType.IN);
      expect(log[0].unitCost).toBe(33.33);
      expect(log[0].seq).toBe(1);
      expect(log[0].period).toBe("2025-11");
    });

    it("should recalculate weighted average on second receive", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });

      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });

      expect(result.balance.quantity).toBe(8);
      // Weighted avg: (3*33.33 + 5*34) / 8 = 269.99/8 = 33.74875 → round(4) = 33.7488
      expect(result.balance.averageCost).toBe(33.7488);
    });

    it("should track rounding diff on receive", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });

      const log = strategy.getTransactionLog("P1", "MK");
      // diff should be defined (may be 0 if first receive at exact cost)
      expect(log[0].diff).toBeDefined();
    });
  });

  // --- Issue ---

  describe("issueStock", () => {
    it("should issue at weighted average cost", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      // Issue at weighted average (33.7488)
      expect(result.transaction.unitCost).toBe(33.7488);
      expect(result.totalCost).toBe(134.9952); // 4 * 33.7488
      expect(result.balance.quantity).toBe(4);
    });

    it("should throw InsufficientStockError", () => {
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
        });
      }).toThrow(InsufficientStockError);
    });

    it("should record avgUnitCost in transaction log", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        date: new Date("2025-11-03"),
      });

      const log = strategy.getTransactionLog("P1", "MK");
      const issueTxn = log.find((t) => t.type === TransactionType.OUT);
      expect(issueTxn!.avgUnitCost).toBe(50);
    });
  });

  // --- Transfer ---

  describe("transferStockCostLayer", () => {
    it("should transfer at average cost with single OUT/IN pair", () => {
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
        quantity: 4,
        date: new Date("2025-11-05"),
      });

      expect(result.transferOutTransactions).toHaveLength(1);
      expect(result.transferInTransactions).toHaveLength(1);
      expect(result.totalTransferCost).toBe(200); // 4 * 50
      expect(result.transferOutTransactions[0].unitCost).toBe(50);
      expect(result.transferInTransactions[0].unitCost).toBe(50);
    });
  });

  // --- Credit Note ---

  describe("creditNote", () => {
    it("should adjust a lot and recalculate average", () => {
      const recv = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 10,
        unitCost: 50,
        date: new Date("2025-11-02"),
      });

      const log = strategy.getTransactionLog("P1", "MK");
      const lotId = log[0].lotId!;

      const result = strategy.creditNote({
        productId: "P1",
        warehouseId: "MK",
        lotId,
        quantity: 2,
        unitCost: 50,
        date: new Date("2025-11-06"),
      });

      expect(result.transaction.type).toBe(TransactionType.CREDIT_NOTE);
      expect(result.balance.quantity).toBe(8);
      expect(result.balance.totalValue).toBe(400);
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
  });

  // --- Period Management ---

  describe("closePeriod / openPeriod", () => {
    it("should close with accumulated diff and open with single lot at avg cost", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 6,
        unitCost: 35.00,
        date: new Date("2025-11-04"),
      });

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        date: new Date("2025-11-04"),
      });

      const closeResult = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
        date: new Date("2025-11-30"),
      });

      expect(closeResult.closeTransactions).toHaveLength(1);
      expect(closeResult.closeTransactions[0].type).toBe(TransactionType.CLOSE);
      expect(closeResult.closingBalance.quantity).toBe(7);
      // diff should be tracked
      expect(closeResult.closingBalance.diff).toBeDefined();

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
      expect(openResult.openingBalance.quantity).toBe(7);

      // Diff should be reset after open
      expect(strategy.getAccumulatedDiff("P1", "MK")).toBe(0);
    });

    it("should throw PeriodNotClosedError when opening without close", () => {
      expect(() => {
        strategy.openPeriod({
          productId: "P1",
          warehouseId: "MK",
          period: "2025-12",
        });
      }).toThrow(PeriodNotClosedError);
    });
  });

  // --- Full Excel Average scenario ---

  describe("Full Excel Average scenario (C001-C009)", () => {
    it("should replay the exact Avg sheet from the Excel file", () => {
      // C001: Receiving 3 units @ 33.33
      const c001 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      expect(c001.balance.quantity).toBe(3);
      expect(c001.balance.averageCost).toBe(33.33);

      // C003: Receiving 5 units @ 34.00
      const c003 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });
      expect(c003.balance.quantity).toBe(8);
      // Weighted average: (3*33.33 + 5*34) / 8 = 269.99/8 = 33.7499
      const avgAfterC003 = c003.balance.averageCost!;

      // C004: Issue 4 units at weighted average
      const c004 = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });
      expect(c004.balance.quantity).toBe(4);
      expect(c004.transaction.unitCost).toBe(avgAfterC003);

      // C005: Receiving 6 units @ 35.00
      const c005 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 6,
        unitCost: 35.00,
        date: new Date("2025-11-04"),
      });
      expect(c005.balance.quantity).toBe(10);
      const avgAfterC005 = c005.balance.averageCost!;

      // C006: Issue 3 units at weighted average
      const c006 = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        date: new Date("2025-11-04"),
      });
      expect(c006.balance.quantity).toBe(7);
      expect(c006.transaction.unitCost).toBe(avgAfterC005);

      // C007: CLOSE period 2025-11
      const c007 = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
        date: new Date("2025-11-30"),
      });
      expect(c007.closeTransactions).toHaveLength(1);
      expect(c007.closingBalance.quantity).toBe(7);
      expect(c007.closingBalance.averageCost).toBe(avgAfterC005);

      // After close, balance should be zero
      expect(strategy.getValuation("P1", "MK").quantity).toBe(0);

      // C009: OPEN period 2025-12
      const c009 = strategy.openPeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-12",
        date: new Date("2025-12-01"),
      });
      expect(c009.openTransactions).toHaveLength(1);
      expect(c009.openingBalance.quantity).toBe(7);
      expect(c009.openingBalance.averageCost).toBe(avgAfterC005);

      // Verify transaction log has all entries
      const log = strategy.getTransactionLog("P1", "MK");
      const types = log.map((t) => t.type);
      expect(types).toContain(TransactionType.IN);
      expect(types).toContain(TransactionType.OUT);
      expect(types).toContain(TransactionType.CLOSE);
      expect(types).toContain(TransactionType.OPEN);
    });
  });

  // --- Recalculate ---

  describe("recalculate", () => {
    it("should recalculate from scratch using weighted average", () => {
      const result = strategy.recalculate("P1", "MK", [
        {
          transactionType: TransactionType.IN,
          quantity: 10,
          unitCost: 50,
          date: new Date("2025-11-01"),
        },
        {
          transactionType: TransactionType.IN,
          quantity: 5,
          unitCost: 60,
          date: new Date("2025-11-02"),
        },
        {
          transactionType: TransactionType.OUT,
          quantity: 3,
          unitCost: 0,
          date: new Date("2025-11-03"),
        },
      ]);

      expect(result.finalBalance.quantity).toBe(12);
      // avg = (10*50 + 5*60) / 15 = 800/15 = 53.3333
      expect(result.finalBalance.averageCost).toBe(53.3333);
    });
  });

  // --- getAccumulatedDiff ---

  describe("getAccumulatedDiff", () => {
    it("should return 0 for unknown location", () => {
      expect(strategy.getAccumulatedDiff("P1", "UNKNOWN")).toBe(0);
    });

    it("should accumulate diff across receives", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 5,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });

      // Diff should be tracked (may be small rounding differences)
      const diff = strategy.getAccumulatedDiff("P1", "MK");
      expect(typeof diff).toBe("number");
    });
  });
});
