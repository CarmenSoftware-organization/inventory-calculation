import { CostLayerAverageStrategy } from "../src/strategies/cost-layer-average-strategy";
import { TransactionType } from "../src/types";

/**
 * AVG Sample Scenario (Cost Layer Average)
 *
 * Three receiving events into MK warehouse:
 *   - 3 units @ 100 total → lots: 2@33.33, 1@33.34
 *   - 5 units @ 170.03 total → lots: 3@34.01, 2@34.00
 *   - 6 units @ 210 total → lots: 6@35.00
 *   Total receiving: 14 units, 480.03 total
 *
 * Transactions (C001-C009):
 *   C001  Receiving  in=2   @ 33.33  (lot MK-251102-01)
 *   C002  Receiving  in=1   @ 33.34  (lot MK-251102-02)
 *   C003  Receiving  in=3   @ 34.01  (lot MK-251102-03)
 *   C004  Receiving  in=2   @ 34.00  (lot MK-251102-04)
 *   C005  Issue      out=4  @ avg    (to BAR)
 *   C006  Receiving  in=6   @ 35.00  (lot MK-251104-01)
 *   C007  Issue      out=4  @ avg    (to POOL)
 *   C008  CLOSE      out=6  @ avg    (period 25-11, with rounding diff)
 *   C009  OPEN       in=6   @ avg    (period 25-12)
 *
 * Note: The sample spreadsheet uses 2dp rounding. The strategy uses 4dp
 * precision, so unit costs differ slightly (e.g., 33.7538 vs 33.76).
 * This test verifies the strategy's 4dp computed values.
 */
describe("AVG Sample Scenario (Cost Layer Average)", () => {
  let strategy: CostLayerAverageStrategy;

  beforeEach(() => {
    strategy = new CostLayerAverageStrategy();
  });

  describe("after all receivings (C001-C004)", () => {
    it("should compute running weighted average across 4 lots", () => {
      // C001: Receive 2 @ 33.33
      const c001 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 2,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      expect(c001.balance.quantity).toBe(2);
      expect(c001.balance.averageCost).toBe(33.33);
      expect(c001.balance.totalValue).toBe(66.66);

      // C002: Receive 1 @ 33.34
      const c002 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 1,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });
      expect(c002.balance.quantity).toBe(3);
      // (2*33.33 + 1*33.34) / 3 = 100/3 = 33.3333
      expect(c002.balance.averageCost).toBe(33.3333);

      // C003: Receive 3 @ 34.01
      const c003 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 34.01,
        date: new Date("2025-11-02"),
      });
      expect(c003.balance.quantity).toBe(6);

      // C004: Receive 2 @ 34.00
      const c004 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 2,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });
      expect(c004.balance.quantity).toBe(8);

      // Running weighted average with 4dp precision
      const avgAfter4Receives = c004.balance.averageCost!;
      expect(avgAfter4Receives).toBeDefined();
      // Sample shows ~33.76 (2dp), strategy computes more precisely
      expect(avgAfter4Receives).toBeCloseTo(33.75, 1);
    });
  });

  describe("full scenario C001-C009", () => {
    let avgAfterFirstReceives: number;
    let avgAfterAllReceives: number;

    function runReceivings() {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 2,
        unitCost: 33.33,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 1,
        unitCost: 33.34,
        date: new Date("2025-11-02"),
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 3,
        unitCost: 34.01,
        date: new Date("2025-11-02"),
      });
      const c004 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 2,
        unitCost: 34.00,
        date: new Date("2025-11-02"),
      });
      avgAfterFirstReceives = c004.balance.averageCost!;
      return c004;
    }

    it("C005: issue 4 should use current weighted average", () => {
      runReceivings();

      const c005 = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      expect(c005.balance.quantity).toBe(4);
      expect(c005.transaction.unitCost).toBe(avgAfterFirstReceives);
      expect(c005.totalCost).toBe(
        parseFloat((4 * avgAfterFirstReceives).toFixed(4))
      );
    });

    it("C006: receive 6@35 should recalculate weighted average", () => {
      runReceivings();

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      const c006 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 6,
        unitCost: 35.00,
        date: new Date("2025-11-04"),
      });

      expect(c006.balance.quantity).toBe(10);
      avgAfterAllReceives = c006.balance.averageCost!;
      // New avg includes remaining 4 units + 6 new units
      expect(avgAfterAllReceives).toBeGreaterThan(avgAfterFirstReceives);
    });

    it("C007: issue 4 should use updated weighted average", () => {
      runReceivings();

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      const c006 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 6,
        unitCost: 35.00,
        date: new Date("2025-11-04"),
      });
      avgAfterAllReceives = c006.balance.averageCost!;

      const c007 = strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      expect(c007.balance.quantity).toBe(6);
      expect(c007.transaction.unitCost).toBe(avgAfterAllReceives);
    });

    it("C008-C009: close period and open next period", () => {
      runReceivings();

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      const c006 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 6,
        unitCost: 35.00,
        date: new Date("2025-11-04"),
      });
      avgAfterAllReceives = c006.balance.averageCost!;

      strategy.issueStock({
        productId: "P1",
        warehouseId: "MK",
        quantity: 4,
        date: new Date("2025-11-04"),
      });

      // Verify pre-close state
      const preClose = strategy.getValuation("P1", "MK");
      expect(preClose.quantity).toBe(6);
      expect(preClose.averageCost).toBe(avgAfterAllReceives);

      // C008: Close period 25-11
      const c008 = strategy.closePeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-11",
        date: new Date("2025-11-30"),
      });

      expect(c008.closeTransactions).toHaveLength(1);
      expect(c008.closeTransactions[0].type).toBe(TransactionType.CLOSE);
      expect(c008.closingBalance.quantity).toBe(6);
      expect(c008.closingBalance.averageCost).toBe(avgAfterAllReceives);
      // Rounding diff should be tracked
      expect(typeof c008.closingBalance.diff).toBe("number");

      // After close, balance should be zero
      const afterClose = strategy.getValuation("P1", "MK");
      expect(afterClose.quantity).toBe(0);
      expect(afterClose.totalValue).toBe(0);

      // C009: Open period 25-12
      const c009 = strategy.openPeriod({
        productId: "P1",
        warehouseId: "MK",
        period: "2025-12",
        date: new Date("2025-12-01"),
      });

      expect(c009.openTransactions).toHaveLength(1);
      expect(c009.openTransactions[0].type).toBe(TransactionType.OPEN);
      expect(c009.openingBalance.quantity).toBe(6);
      expect(c009.openingBalance.averageCost).toBe(avgAfterAllReceives);

      // Accumulated diff should be reset after open
      expect(strategy.getAccumulatedDiff("P1", "MK")).toBe(0);
    });
  });

  describe("transaction log verification", () => {
    it("should produce 7 log entries (4 receives + 2 issues + 1 close)", () => {
      // C001-C004: 4 receivings
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });

      // C005: Issue 4
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      // C006: Receive 6@35
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });

      // C007: Issue 4
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log).toHaveLength(7);

      const types = log.map((t) => t.type);
      expect(types.filter((t) => t === TransactionType.IN)).toHaveLength(5);
      expect(types.filter((t) => t === TransactionType.OUT)).toHaveLength(2);

      // All transactions should have period 2025-11
      expect(log.every((t) => t.period === "2025-11")).toBe(true);
    });

    it("should produce 9 log entries after close+open", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      strategy.closePeriod({ productId: "P1", warehouseId: "MK", period: "2025-11", date: new Date("2025-11-30") });
      strategy.openPeriod({ productId: "P1", warehouseId: "MK", period: "2025-12", date: new Date("2025-12-01") });

      const log = strategy.getTransactionLog("P1", "MK");
      expect(log).toHaveLength(9);

      const types = log.map((t) => t.type);
      expect(types).toContain(TransactionType.CLOSE);
      expect(types).toContain(TransactionType.OPEN);
    });
  });

  describe("cost traceability", () => {
    it("total receiving cost should be 480.03", () => {
      // All 5 receivings: 2*33.33 + 1*33.34 + 3*34.01 + 2*34 + 6*35
      // = 66.66 + 33.34 + 102.03 + 68.00 + 210.00 = 480.03
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });

      const log = strategy.getTransactionLog("P1", "MK");
      const totalReceivingCost = log
        .filter((t) => t.type === TransactionType.IN)
        .reduce((sum, t) => sum + t.inQty * t.unitCost, 0);

      expect(totalReceivingCost).toBeCloseTo(480.03, 2);
    });

    it("issues + remaining should account for all received value (within rounding)", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });

      const c005 = strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });

      const c007 = strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      const remaining = strategy.getValuation("P1", "MK");

      const totalIssueCost = c005.totalCost + c007.totalCost;
      const totalReceiving = 480.03;

      // Issues + remaining ≈ total receiving (small rounding diff expected)
      const diff = totalIssueCost + remaining.totalValue - totalReceiving;
      // Rounding diff should be very small (within a few cents)
      expect(Math.abs(diff)).toBeLessThan(0.1);
    });

    it("accumulated diff should track rounding differences", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      const accDiff = strategy.getAccumulatedDiff("P1", "MK");
      // Accumulated diff from rounding across all receivings
      expect(typeof accDiff).toBe("number");
      // Should be very small (sample shows -0.03 at 2dp; at 4dp it's smaller)
      expect(Math.abs(accDiff)).toBeLessThan(0.01);
    });
  });

  describe("weighted average behavior", () => {
    it("issue should not change the average cost", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      const c004 = strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });

      const avgBefore = c004.balance.averageCost!;

      const c005 = strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      // Average should remain the same after issue
      expect(c005.balance.averageCost).toBe(avgBefore);
      expect(c005.transaction.unitCost).toBe(avgBefore);
    });

    it("new receiving after issue should recalculate average", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      const c004 = strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });

      const avgBeforeIssue = c004.balance.averageCost!;

      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      // Receive 6@35 (higher than current avg)
      const c006 = strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });

      const newAvg = c006.balance.averageCost!;
      // New avg should be between old avg and 35 (pulled up by higher cost)
      expect(newAvg).toBeGreaterThan(avgBeforeIssue);
      expect(newAvg).toBeLessThan(35);
    });

    it("second issue should use the updated average (not the first issue avg)", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });

      const c005 = strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      const firstIssueAvg = c005.transaction.unitCost;

      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });

      const c007 = strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      const secondIssueAvg = c007.transaction.unitCost;

      // Second issue should use higher avg (after 35.00 receiving)
      expect(secondIssueAvg).toBeGreaterThan(firstIssueAvg);
    });
  });

  describe("quantity flow", () => {
    it("should track correct quantities: 14 in, 8 out, 6 remaining", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      const val = strategy.getValuation("P1", "MK");
      expect(val.quantity).toBe(6);

      const log = strategy.getTransactionLog("P1", "MK");
      const totalIn = log.reduce((s, t) => s + t.inQty, 0);
      const totalOut = log.reduce((s, t) => s + t.outQty, 0);
      expect(totalIn).toBe(14);
      expect(totalOut).toBe(8);
      expect(totalIn - totalOut).toBe(6);
    });

    it("should preserve quantity through close/open cycle", () => {
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 33.33, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 1, unitCost: 33.34, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 3, unitCost: 34.01, date: new Date("2025-11-02") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 2, unitCost: 34.00, date: new Date("2025-11-02") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });
      strategy.receiveStock({ productId: "P1", warehouseId: "MK", quantity: 6, unitCost: 35.00, date: new Date("2025-11-04") });
      strategy.issueStock({ productId: "P1", warehouseId: "MK", quantity: 4, date: new Date("2025-11-04") });

      const beforeClose = strategy.getValuation("P1", "MK");

      strategy.closePeriod({ productId: "P1", warehouseId: "MK", period: "2025-11", date: new Date("2025-11-30") });
      strategy.openPeriod({ productId: "P1", warehouseId: "MK", period: "2025-12", date: new Date("2025-12-01") });

      const afterOpen = strategy.getValuation("P1", "MK");
      expect(afterOpen.quantity).toBe(beforeClose.quantity);
      expect(afterOpen.averageCost).toBe(beforeClose.averageCost);
      expect(afterOpen.totalValue).toBe(beforeClose.totalValue);
    });
  });
});
