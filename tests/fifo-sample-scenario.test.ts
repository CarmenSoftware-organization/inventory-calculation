import { FIFOInventoryEngine } from "../src/engine/fifo";
import type { EngineTransaction } from "../src/engine/fifo";

function makeTx(
  overrides: Partial<EngineTransaction> & {
    id: string;
    type: EngineTransaction["type"];
  }
): EngineTransaction {
  return {
    productId: "ITEM-001",
    lot: null,
    in: null,
    out: null,
    unitCost: 0,
    date: "2025-11-01",
    location: "MK",
    seq: 1,
    parentLot: null,
    period: "25-11",
    ...overrides,
  };
}

/**
 * Sample FIFO scenario:
 *
 * Receiving: 30 units @ 1,000 total at MK on 2025-11-02
 *   - Lot MK-251102-01: 20 units @ 33.33
 *   - Lot MK-251102-02: 10 units @ 33.34
 *
 * Transactions:
 *   C001  Receiving       MK-251102-01  in=20   @ 33.33  MK   period 25-11
 *   C002  Receiving       MK-251102-02  in=10   @ 33.34  MK   period 25-11
 *   C003  Issue           -             out=5   @ 33.33  MK   (from MK-251102-01 FIFO)
 *   C004  Transfer out    -             out=15  @ 33.33  MK   (from MK-251102-01)
 *   C005  Transfer out    -             out=5   @ 33.34  MK   (from MK-251102-02)
 *   C006  Transfer in     KC-251105-01  in=15   @ 33.33  KC
 *   C007  Transfer in     KC-251105-02  in=5    @ 33.34  KC
 *   C008  CN QTY          -             out=1   @ 33.34  MK   (from MK-251102-02)
 *   C009  Close           MK-251102-02  out=4   @ 33.34  MK   period 25-11
 *   C010  Close           KC-251105-01  out=15  @ 33.33  KC   period 25-11
 *   C011  Close           KC-251105-02  out=5   @ 33.34  KC   period 25-11
 *   C012  Open            MK-251102-02  in=4    @ 33.34  MK   period 25-12
 *   C013  Open            KC-251105-01  in=15   @ 33.33  KC   period 25-12
 *   C014  Open            KC-251105-02  in=5    @ 33.34  KC   period 25-12
 */
describe("FIFO Sample Scenario", () => {
  let engine: FIFOInventoryEngine;

  const transactions: EngineTransaction[] = [
    // C001: Receiving 20 units @ 33.33 into MK
    makeTx({
      id: "C001",
      type: "Receiving",
      lot: "MK-251102-01",
      in: 20,
      unitCost: 33.33,
      date: "2025-11-02",
      location: "MK",
      seq: 1,
      period: "25-11",
    }),
    // C002: Receiving 10 units @ 33.34 into MK
    makeTx({
      id: "C002",
      type: "Receiving",
      lot: "MK-251102-02",
      in: 10,
      unitCost: 33.34,
      date: "2025-11-02",
      location: "MK",
      seq: 2,
      period: "25-11",
    }),
    // C003: Issue 5 units from MK (FIFO -> MK-251102-01 @ 33.33)
    makeTx({
      id: "C003",
      type: "Issue",
      out: 5,
      unitCost: 33.33,
      date: "2025-11-03",
      location: "MK",
      seq: 1,
      parentLot: "MK-251102-01",
      period: "25-11",
    }),
    // C004: Transfer out 15 units from MK-251102-01
    makeTx({
      id: "C004",
      type: "TransferOut",
      lot: "MK-251105-01",
      out: 15,
      unitCost: 33.33,
      date: "2025-11-05",
      location: "MK",
      seq: 1,
      parentLot: "MK-251102-01",
      period: "25-11",
    }),
    // C005: Transfer out 5 units from MK-251102-02
    makeTx({
      id: "C005",
      type: "TransferOut",
      lot: "MK-251105-02",
      out: 5,
      unitCost: 33.34,
      date: "2025-11-05",
      location: "MK",
      seq: 2,
      parentLot: "MK-251102-02",
      period: "25-11",
    }),
    // C006: Transfer in 15 units to KC
    makeTx({
      id: "C006",
      type: "TransferIn",
      lot: "KC-251105-01",
      in: 15,
      unitCost: 33.33,
      date: "2025-11-05",
      location: "KC",
      seq: 1,
      period: "25-11",
    }),
    // C007: Transfer in 5 units to KC
    makeTx({
      id: "C007",
      type: "TransferIn",
      lot: "KC-251105-02",
      in: 5,
      unitCost: 33.34,
      date: "2025-11-05",
      location: "KC",
      seq: 2,
      period: "25-11",
    }),
    // C008: Credit Note - reduce 1 unit from MK-251102-02
    makeTx({
      id: "C008",
      type: "CreditNote",
      out: 1,
      unitCost: 33.34,
      date: "2025-11-08",
      location: "MK",
      seq: 1,
      parentLot: "MK-251102-02",
      period: "25-11",
    }),
    // C009: Close MK-251102-02 (4 remaining) at end of period 25-11
    makeTx({
      id: "C009",
      type: "Close",
      lot: "MK-251102-02",
      out: 4,
      unitCost: 33.34,
      date: "2025-11-30",
      location: "MK",
      seq: 1,
      parentLot: "MK-251102-02",
      period: "25-11",
    }),
    // C010: Close KC-251105-01 (15 remaining) at end of period 25-11
    makeTx({
      id: "C010",
      type: "Close",
      lot: "KC-251105-01",
      out: 15,
      unitCost: 33.33,
      date: "2025-11-30",
      location: "KC",
      seq: 1,
      parentLot: "KC-251105-01",
      period: "25-11",
    }),
    // C011: Close KC-251105-02 (5 remaining) at end of period 25-11
    makeTx({
      id: "C011",
      type: "Close",
      lot: "KC-251105-02",
      out: 5,
      unitCost: 33.34,
      date: "2025-11-30",
      location: "KC",
      seq: 2,
      parentLot: "KC-251105-02",
      period: "25-11",
    }),
    // C012: Open MK-251102-02 in new period 25-12
    makeTx({
      id: "C012",
      type: "Open",
      lot: "MK-251102-02",
      in: 4,
      unitCost: 33.34,
      date: "2025-12-01",
      location: "MK",
      seq: 1,
      period: "25-12",
    }),
    // C013: Open KC-251105-01 in new period 25-12
    makeTx({
      id: "C013",
      type: "Open",
      lot: "KC-251105-01",
      in: 15,
      unitCost: 33.33,
      date: "2025-12-01",
      location: "KC",
      seq: 1,
      period: "25-12",
    }),
    // C014: Open KC-251105-02 in new period 25-12
    makeTx({
      id: "C014",
      type: "Open",
      lot: "KC-251105-02",
      in: 5,
      unitCost: 33.34,
      date: "2025-12-01",
      location: "KC",
      seq: 2,
      period: "25-12",
    }),
  ];

  beforeEach(() => {
    engine = new FIFOInventoryEngine();
  });

  it("should process all 14 transactions without errors", () => {
    const results = engine.processAll(transactions);
    expect(results).toHaveLength(14);
  });

  describe("after receiving (C001, C002)", () => {
    beforeEach(() => {
      engine.processAll(transactions.slice(0, 2));
    });

    it("should have 30 units at MK across 2 lots", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "MK")).toBe(30);
      const lots = engine.getLotsByProductAndLocation("ITEM-001", "MK");
      expect(lots).toHaveLength(2);
    });

    it("should have lot MK-251102-01 with 20 @ 33.33", () => {
      const lot = engine.findLot("MK-251102-01", "MK");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(20);
      expect(lot!.unitCost).toBe(33.33);
    });

    it("should have lot MK-251102-02 with 10 @ 33.34", () => {
      const lot = engine.findLot("MK-251102-02", "MK");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(10);
      expect(lot!.unitCost).toBe(33.34);
    });

    it("total receiving cost should be 1,000.00 (666.60 + 333.40)", () => {
      const lot1 = engine.findLot("MK-251102-01", "MK")!;
      const lot2 = engine.findLot("MK-251102-02", "MK")!;
      const totalCost =
        lot1.quantity * lot1.unitCost + lot2.quantity * lot2.unitCost;
      expect(totalCost).toBeCloseTo(1000.0, 2);
    });
  });

  describe("after issue (C003)", () => {
    beforeEach(() => {
      engine.processAll(transactions.slice(0, 3));
    });

    it("should deduct 5 from lot MK-251102-01 (FIFO)", () => {
      const lot = engine.findLot("MK-251102-01", "MK");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(15);
    });

    it("issue allocation should be 5 @ 33.33 = 166.65", () => {
      const results = new FIFOInventoryEngine().processAll(
        transactions.slice(0, 3)
      );
      const issueResult = results[2]; // C003
      expect(issueResult.allocations).toHaveLength(1);
      expect(issueResult.allocations[0].lot).toBe("MK-251102-01");
      expect(issueResult.allocations[0].quantity).toBe(5);
      expect(issueResult.allocations[0].unitCost).toBe(33.33);
      expect(issueResult.allocations[0].totalCost).toBe(166.65);
    });

    it("MK should have 25 units remaining", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "MK")).toBe(25);
    });
  });

  describe("after transfers (C004-C007)", () => {
    beforeEach(() => {
      engine.processAll(transactions.slice(0, 7));
    });

    it("MK should have 5 units remaining (lot MK-251102-02)", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "MK")).toBe(5);
      const lots = engine.getLotsByProductAndLocation("ITEM-001", "MK");
      expect(lots).toHaveLength(1);
      expect(lots[0].lot).toBe("MK-251102-02");
      expect(lots[0].quantity).toBe(5);
      expect(lots[0].unitCost).toBe(33.34);
    });

    it("KC should have 20 units across 2 lots", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "KC")).toBe(20);
      const lots = engine.getLotsByProductAndLocation("ITEM-001", "KC");
      expect(lots).toHaveLength(2);
    });

    it("KC lot KC-251105-01 should have 15 @ 33.33 = 499.95", () => {
      const lot = engine.findLot("KC-251105-01", "KC");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(15);
      expect(lot!.unitCost).toBe(33.33);
    });

    it("KC lot KC-251105-02 should have 5 @ 33.34 = 166.70", () => {
      const lot = engine.findLot("KC-251105-02", "KC");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(5);
      expect(lot!.unitCost).toBe(33.34);
    });

    it("transfer out allocations should match source lot costs", () => {
      const results = new FIFOInventoryEngine().processAll(
        transactions.slice(0, 7)
      );
      // C004: TransferOut 15 from MK-251102-01 @ 33.33
      const c004 = results[3];
      expect(c004.allocations[0].lot).toBe("MK-251102-01");
      expect(c004.allocations[0].quantity).toBe(15);
      expect(c004.allocations[0].totalCost).toBe(499.95);

      // C005: TransferOut 5 from MK-251102-02 @ 33.34
      const c005 = results[4];
      expect(c005.allocations[0].lot).toBe("MK-251102-02");
      expect(c005.allocations[0].quantity).toBe(5);
      expect(c005.allocations[0].totalCost).toBe(166.7);
    });
  });

  describe("after credit note (C008)", () => {
    beforeEach(() => {
      engine.processAll(transactions.slice(0, 8));
    });

    it("MK lot MK-251102-02 should have 4 units after CN of 1", () => {
      const lot = engine.findLot("MK-251102-02", "MK");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(4);
    });

    it("CN allocation should be 1 @ 33.34 = 33.34", () => {
      const results = new FIFOInventoryEngine().processAll(
        transactions.slice(0, 8)
      );
      const c008 = results[7];
      expect(c008.allocations).toHaveLength(1);
      expect(c008.allocations[0].quantity).toBe(1);
      expect(c008.allocations[0].unitCost).toBe(33.34);
      expect(c008.allocations[0].totalCost).toBe(33.34);
    });
  });

  describe("after period close (C009-C011)", () => {
    beforeEach(() => {
      engine.processAll(transactions.slice(0, 11));
    });

    it("all lots should be cleared (0 inventory)", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "MK")).toBe(0);
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "KC")).toBe(0);
      expect(engine.getLots()).toHaveLength(0);
    });

    it("close allocations should match remaining quantities", () => {
      const results = new FIFOInventoryEngine().processAll(
        transactions.slice(0, 11)
      );
      // C009: Close MK-251102-02, 4 @ 33.34 = 133.36
      const c009 = results[8];
      expect(c009.allocations[0].quantity).toBe(4);
      expect(c009.allocations[0].totalCost).toBe(133.36);

      // C010: Close KC-251105-01, 15 @ 33.33 = 499.95
      const c010 = results[9];
      expect(c010.allocations[0].quantity).toBe(15);
      expect(c010.allocations[0].totalCost).toBe(499.95);

      // C011: Close KC-251105-02, 5 @ 33.34 = 166.70
      const c011 = results[10];
      expect(c011.allocations[0].quantity).toBe(5);
      expect(c011.allocations[0].totalCost).toBe(166.7);
    });
  });

  describe("after period open (C012-C014) - new period 25-12", () => {
    beforeEach(() => {
      engine.processAll(transactions);
    });

    it("MK should have 4 units (lot MK-251102-02 @ 33.34)", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "MK")).toBe(4);
      const lot = engine.findLot("MK-251102-02", "MK");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(4);
      expect(lot!.unitCost).toBe(33.34);
    });

    it("KC should have 20 units across 2 lots", () => {
      expect(engine.getQuantityByProductAndLocation("ITEM-001", "KC")).toBe(20);
    });

    it("KC lot KC-251105-01 should have 15 @ 33.33", () => {
      const lot = engine.findLot("KC-251105-01", "KC");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(15);
      expect(lot!.unitCost).toBe(33.33);
    });

    it("KC lot KC-251105-02 should have 5 @ 33.34", () => {
      const lot = engine.findLot("KC-251105-02", "KC");
      expect(lot).toBeDefined();
      expect(lot!.quantity).toBe(5);
      expect(lot!.unitCost).toBe(33.34);
    });

    it("total inventory should be 24 units", () => {
      const summary = engine.getInventorySummary();
      const item = summary.get("ITEM-001")!;
      expect(item.totalQty).toBe(24);
      expect(item.locations.get("MK")).toBe(4);
      expect(item.locations.get("KC")).toBe(20);
    });

    it("total inventory value should be preserved correctly", () => {
      // MK: 4 * 33.34 = 133.36
      // KC: 15 * 33.33 + 5 * 33.34 = 499.95 + 166.70 = 666.65
      // Total: 133.36 + 666.65 = 800.01
      const summary = engine.getInventorySummary();
      const item = summary.get("ITEM-001")!;
      expect(item.totalCost).toBeCloseTo(800.01, 2);
    });
  });

  describe("cost traceability", () => {
    it("should preserve unit costs through the full lifecycle", () => {
      const results = engine.processAll(transactions);

      // Verify each transaction's allocations match expected per-unit costs
      // C003 Issue: 5 @ 33.33
      expect(results[2].allocations[0].unitCost).toBe(33.33);
      // C004 TransferOut: 15 @ 33.33
      expect(results[3].allocations[0].unitCost).toBe(33.33);
      // C005 TransferOut: 5 @ 33.34
      expect(results[4].allocations[0].unitCost).toBe(33.34);
      // C008 CreditNote: 1 @ 33.34
      expect(results[7].allocations[0].unitCost).toBe(33.34);
    });

    it("all outflows should account for 1,000 total (original receiving)", () => {
      const results = engine.processAll(transactions);

      // Sum true outflow costs (Issue + CreditNote only; transfers are internal movements)
      let totalOutflowCost = 0;
      for (const r of results) {
        if (["Issue", "CreditNote"].includes(r.transaction.type)) {
          totalOutflowCost += r.allocations.reduce(
            (s, a) => s + a.totalCost,
            0
          );
        }
      }
      // Issue: 5 * 33.33 = 166.65
      // CreditNote: 1 * 33.34 = 33.34
      // Total outflow: 199.99
      expect(totalOutflowCost).toBeCloseTo(199.99, 2);

      // Remaining inventory value
      const summary = engine.getInventorySummary();
      const remainingValue = summary.get("ITEM-001")!.totalCost;
      // MK: 4 * 33.34 = 133.36, KC: 15*33.33 + 5*33.34 = 499.95 + 166.70 = 666.65
      // Total remaining: 800.01
      expect(remainingValue).toBeCloseTo(800.01, 2);

      // Original: 20*33.33 + 10*33.34 = 666.60 + 333.40 = 1000.00
      // Outflows + remaining should equal original
      expect(totalOutflowCost + remainingValue).toBeCloseTo(1000.0, 2);
    });
  });
});
