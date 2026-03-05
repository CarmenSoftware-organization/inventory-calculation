import { FIFOInventoryEngine } from "../src/engine/fifo";
import type { EngineTransaction } from "../src/engine/fifo";

function makeTx(
  overrides: Partial<EngineTransaction> & { id: string; type: EngineTransaction["type"] }
): EngineTransaction {
  return {
    productId: "P1",
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

describe("FIFOInventoryEngine", () => {
  let engine: FIFOInventoryEngine;

  beforeEach(() => {
    engine = new FIFOInventoryEngine();
  });

  // --- Receiving ---

  describe("Receiving", () => {
    it("should add a lot on receiving", () => {
      engine.process(
        makeTx({
          id: "T1",
          type: "Receiving",
          lot: "LOT-1",
          in: 20,
          unitCost: 33.33,
          seq: 1,
        })
      );

      const lots = engine.getLots();
      expect(lots).toHaveLength(1);
      expect(lots[0].lot).toBe("LOT-1");
      expect(lots[0].quantity).toBe(20);
      expect(lots[0].unitCost).toBe(33.33);
    });

    it("should track multiple lots", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 20, unitCost: 10, seq: 1 })
      );
      engine.process(
        makeTx({ id: "T2", type: "Receiving", lot: "LOT-2", in: 10, unitCost: 20, seq: 2 })
      );

      expect(engine.getLots()).toHaveLength(2);
      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(30);
    });

    it("should throw when lot is missing", () => {
      expect(() =>
        engine.process(makeTx({ id: "T1", type: "Receiving", lot: null, in: 10, unitCost: 5 }))
      ).toThrow("'lot' is required");
    });

    it("should throw when in quantity is missing", () => {
      expect(() =>
        engine.process(makeTx({ id: "T1", type: "Receiving", lot: "L1", in: null, unitCost: 5 }))
      ).toThrow("'in' must be > 0");
    });
  });

  // --- Issue ---

  describe("Issue", () => {
    beforeEach(() => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 10, unitCost: 10, seq: 1 })
      );
      engine.process(
        makeTx({ id: "T2", type: "Receiving", lot: "LOT-2", in: 10, unitCost: 20, seq: 2 })
      );
    });

    it("should consume oldest lot first (FIFO)", () => {
      const result = engine.process(
        makeTx({ id: "T3", type: "Issue", out: 5, seq: 3 })
      );

      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].lot).toBe("LOT-1");
      expect(result.allocations[0].quantity).toBe(5);
      expect(result.allocations[0].unitCost).toBe(10);
      expect(result.allocations[0].totalCost).toBe(50);

      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(15);
    });

    it("should consume across multiple lots FIFO", () => {
      const result = engine.process(
        makeTx({ id: "T3", type: "Issue", out: 15, seq: 3 })
      );

      expect(result.allocations).toHaveLength(2);
      expect(result.allocations[0].lot).toBe("LOT-1");
      expect(result.allocations[0].quantity).toBe(10);
      expect(result.allocations[1].lot).toBe("LOT-2");
      expect(result.allocations[1].quantity).toBe(5);

      const totalCost = result.allocations.reduce((s, a) => s + a.totalCost, 0);
      // 10*10 + 5*20 = 200
      expect(totalCost).toBe(200);
    });

    it("should throw on insufficient stock", () => {
      expect(() =>
        engine.process(makeTx({ id: "T3", type: "Issue", out: 25, seq: 3 }))
      ).toThrow("Insufficient stock");
    });

    it("should remove fully consumed lots", () => {
      engine.process(makeTx({ id: "T3", type: "Issue", out: 10, seq: 3 }));
      const lots = engine.getLots();
      expect(lots).toHaveLength(1);
      expect(lots[0].lot).toBe("LOT-2");
    });

    it("should deduct from specific lot when parentLot is set", () => {
      const result = engine.process(
        makeTx({ id: "T3", type: "Issue", out: 3, parentLot: "LOT-2", seq: 3 })
      );

      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].lot).toBe("LOT-2");
      expect(result.allocations[0].quantity).toBe(3);
      expect(result.allocations[0].unitCost).toBe(20);
    });
  });

  // --- Transfer ---

  describe("TransferOut / TransferIn", () => {
    beforeEach(() => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 20, unitCost: 50, seq: 1 })
      );
    });

    it("should transfer stock between locations", () => {
      engine.process(
        makeTx({
          id: "T2",
          type: "TransferOut",
          out: 10,
          parentLot: "LOT-1",
          location: "MK",
          seq: 2,
        })
      );

      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(10);

      engine.process(
        makeTx({
          id: "T3",
          type: "TransferIn",
          lot: "LOT-1-KC",
          in: 10,
          unitCost: 50,
          location: "KC",
          seq: 3,
        })
      );

      expect(engine.getQuantityByProductAndLocation("P1", "KC")).toBe(10);
    });

    it("should throw when parentLot missing on TransferOut", () => {
      expect(() =>
        engine.process(
          makeTx({ id: "T2", type: "TransferOut", out: 5, parentLot: null, seq: 2 })
        )
      ).toThrow("'parentLot' is required");
    });
  });

  // --- CreditNote ---

  describe("CreditNote", () => {
    it("should deduct from specific lot", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 10, unitCost: 33.34, seq: 1 })
      );

      const result = engine.process(
        makeTx({
          id: "T2",
          type: "CreditNote",
          out: 1,
          parentLot: "LOT-1",
          unitCost: 33.34,
          seq: 2,
        })
      );

      expect(result.allocations).toHaveLength(1);
      expect(result.allocations[0].quantity).toBe(1);
      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(9);
    });
  });

  // --- Close / Open ---

  describe("Close / Open", () => {
    it("should close a lot and reopen it", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 10, unitCost: 50, seq: 1 })
      );

      const closeResult = engine.process(
        makeTx({
          id: "T2",
          type: "Close",
          lot: "LOT-1",
          out: 10,
          unitCost: 50,
          seq: 2,
          period: "25-11",
        })
      );

      expect(closeResult.allocations).toHaveLength(1);
      expect(closeResult.allocations[0].totalCost).toBe(500);
      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(0);

      engine.process(
        makeTx({
          id: "T3",
          type: "Open",
          lot: "LOT-1",
          in: 10,
          unitCost: 50,
          seq: 3,
          period: "25-12",
        })
      );

      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(10);
    });

    it("should throw on Close mismatch", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "LOT-1", in: 10, unitCost: 50, seq: 1 })
      );

      expect(() =>
        engine.process(
          makeTx({ id: "T2", type: "Close", lot: "LOT-1", out: 5, unitCost: 50, seq: 2 })
        )
      ).toThrow("CLOSE mismatch");
    });

    it("should throw when closing nonexistent lot", () => {
      expect(() =>
        engine.process(
          makeTx({ id: "T1", type: "Close", lot: "NONE", out: 5, unitCost: 10, seq: 1 })
        )
      ).toThrow("not found");
    });
  });

  // --- Query methods ---

  describe("Query methods", () => {
    beforeEach(() => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 100, productId: "P1", location: "MK", seq: 1 })
      );
      engine.process(
        makeTx({ id: "T2", type: "Receiving", lot: "L2", in: 5, unitCost: 200, productId: "P1", location: "KC", seq: 2 })
      );
      engine.process(
        makeTx({ id: "T3", type: "Receiving", lot: "L3", in: 20, unitCost: 50, productId: "P2", location: "MK", seq: 3 })
      );
    });

    it("getLotsByLocation", () => {
      expect(engine.getLotsByLocation("MK")).toHaveLength(2);
      expect(engine.getLotsByLocation("KC")).toHaveLength(1);
    });

    it("getLotsByProduct", () => {
      expect(engine.getLotsByProduct("P1")).toHaveLength(2);
      expect(engine.getLotsByProduct("P2")).toHaveLength(1);
    });

    it("getLotsByProductAndLocation", () => {
      expect(engine.getLotsByProductAndLocation("P1", "MK")).toHaveLength(1);
      expect(engine.getLotsByProductAndLocation("P1", "KC")).toHaveLength(1);
      expect(engine.getLotsByProductAndLocation("P2", "MK")).toHaveLength(1);
    });

    it("getQuantityByLocation", () => {
      expect(engine.getQuantityByLocation("MK")).toBe(30); // 10 + 20
      expect(engine.getQuantityByLocation("KC")).toBe(5);
    });

    it("getQuantityByProduct", () => {
      expect(engine.getQuantityByProduct("P1")).toBe(15); // 10 + 5
      expect(engine.getQuantityByProduct("P2")).toBe(20);
    });

    it("getQuantityByProductAndLocation", () => {
      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(10);
      expect(engine.getQuantityByProductAndLocation("P2", "MK")).toBe(20);
    });

    it("getAvgCostByProduct", () => {
      // P1: (10*100 + 5*200) / 15 = 2000/15 ≈ 133.3333
      expect(engine.getAvgCostByProduct("P1")).toBeCloseTo(133.3333, 4);
      expect(engine.getAvgCostByProduct("P2")).toBe(50);
    });

    it("getAvgCostByProductAndLocation", () => {
      expect(engine.getAvgCostByProductAndLocation("P1", "MK")).toBe(100);
      expect(engine.getAvgCostByProductAndLocation("P1", "KC")).toBe(200);
    });

    it("getAvgCostByProduct returns 0 for nonexistent product", () => {
      expect(engine.getAvgCostByProduct("NONE")).toBe(0);
    });

    it("getInventorySummary", () => {
      const summary = engine.getInventorySummary();
      expect(summary.size).toBe(2);

      const p1 = summary.get("P1")!;
      expect(p1.totalQty).toBe(15);
      expect(p1.locations.get("MK")).toBe(10);
      expect(p1.locations.get("KC")).toBe(5);

      const p2 = summary.get("P2")!;
      expect(p2.totalQty).toBe(20);
      expect(p2.avgCost).toBe(50);
    });
  });

  // --- processAll ---

  describe("processAll", () => {
    it("should process multiple transactions in order", () => {
      const results = engine.processAll([
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 50, seq: 1 }),
        makeTx({ id: "T2", type: "Issue", out: 3, seq: 2 }),
      ]);

      expect(results).toHaveLength(2);
      expect(engine.getQuantityByProductAndLocation("P1", "MK")).toBe(7);
    });
  });

  // --- getResults ---

  describe("getResults", () => {
    it("should track all processed results", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 50, seq: 1 })
      );
      engine.process(
        makeTx({ id: "T2", type: "Issue", out: 3, seq: 2 })
      );

      const results = engine.getResults();
      expect(results).toHaveLength(2);
      expect(results[0].transaction.type).toBe("Receiving");
      expect(results[1].transaction.type).toBe("Issue");
      expect(results[1].allocations).toHaveLength(1);
    });

    it("should capture lotsBefore and lotsAfter snapshots", () => {
      engine.process(
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 50, seq: 1 })
      );

      const result = engine.process(
        makeTx({ id: "T2", type: "Issue", out: 3, seq: 2 })
      );

      expect(result.lotsBefore).toHaveLength(1);
      expect(result.lotsBefore[0].quantity).toBe(10);
      expect(result.lotsAfter).toHaveLength(1);
      expect(result.lotsAfter[0].quantity).toBe(7);
    });
  });

  // --- Validation ---

  describe("validateIssue", () => {
    it("should validate a valid retroactive issue", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 20, unitCost: 50, seq: 1, date: "2025-11-01" }),
        makeTx({ id: "T2", type: "Issue", out: 5, seq: 2, date: "2025-11-03" }),
      ];

      engine.processAll(txs);

      const newIssue = makeTx({
        id: "T-NEW",
        type: "Issue",
        out: 3,
        seq: 0,
        date: "2025-11-02",
      });

      const validation = engine.validateIssue(newIssue, txs);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it("should detect insufficient stock for retroactive issue", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 50, seq: 1, date: "2025-11-01" }),
        makeTx({ id: "T2", type: "Issue", out: 8, seq: 2, date: "2025-11-03" }),
      ];

      engine.processAll(txs);

      const newIssue = makeTx({
        id: "T-NEW",
        type: "Issue",
        out: 5,
        seq: 0,
        date: "2025-11-02",
      });

      const validation = engine.validateIssue(newIssue, txs);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });

    it("should throw if transaction type is not Issue", () => {
      expect(() =>
        engine.validateIssue(
          makeTx({ id: "X", type: "Receiving", lot: "L1", in: 10 }),
          []
        )
      ).toThrow("only accepts Issue");
    });
  });

  // --- findMaxIssuableQuantity ---

  describe("findMaxIssuableQuantity", () => {
    it("should find the maximum issuable quantity", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 20, unitCost: 50, seq: 1, date: "2025-11-01" }),
        makeTx({ id: "T2", type: "Issue", out: 10, seq: 2, date: "2025-11-03" }),
      ];

      engine.processAll(txs);

      const newIssue = makeTx({
        id: "T-NEW",
        type: "Issue",
        out: 1, // placeholder
        seq: 0,
        date: "2025-11-02",
      });

      const max = engine.findMaxIssuableQuantity(newIssue, txs);
      // 20 received, 10 issued later. Inserting before the issue: max = 10
      expect(max).toBe(10);
    });
  });

  // --- insertIssueAndRebalance ---

  describe("insertIssueAndRebalance", () => {
    it("should insert a retroactive issue and replay", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 20, unitCost: 50, seq: 1, date: "2025-11-01" }),
        makeTx({ id: "T2", type: "Issue", out: 5, seq: 2, date: "2025-11-03" }),
      ];

      engine.processAll(txs);

      const newIssue = makeTx({
        id: "T-NEW",
        type: "Issue",
        out: 3,
        seq: 0,
        date: "2025-11-02",
      });

      const { transactions, results } = engine.insertIssueAndRebalance(
        newIssue,
        txs
      );

      expect(transactions).toHaveLength(3);
      expect(results).toHaveLength(3);

      // Final state: 20 - 3 - 5 = 12
      const finalLots = results[results.length - 1].lotsAfter;
      const totalQty = finalLots.reduce((s, l) => s + l.quantity, 0);
      expect(totalQty).toBe(12);
    });

    it("should throw when insertion would cause insufficient stock", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T1", type: "Receiving", lot: "L1", in: 10, unitCost: 50, seq: 1, date: "2025-11-01" }),
        makeTx({ id: "T2", type: "Issue", out: 8, seq: 2, date: "2025-11-03" }),
      ];

      engine.processAll(txs);

      const newIssue = makeTx({
        id: "T-NEW",
        type: "Issue",
        out: 5,
        seq: 0,
        date: "2025-11-02",
      });

      expect(() =>
        engine.insertIssueAndRebalance(newIssue, txs)
      ).toThrow("Cannot insert issue");
    });
  });

  // --- Mock data scenario (multi-product, multi-location) ---

  describe("Multi-product, multi-location scenario", () => {
    it("should handle P001 (Premium Olive Oil 1L) — 14 transactions", () => {
      const txs: EngineTransaction[] = [
        // Receive 20 @ 350
        makeTx({ id: "T001", type: "Receiving", productId: "P001", lot: "MK-251102-01", in: 20, unitCost: 350, date: "2025-11-02", location: "MK", seq: 1, period: "25-11" }),
        // Receive 10 @ 360
        makeTx({ id: "T002", type: "Receiving", productId: "P001", lot: "MK-251102-02", in: 10, unitCost: 360, date: "2025-11-02", location: "MK", seq: 2, period: "25-11" }),
        // Issue 5 (FIFO: from MK-251102-01)
        makeTx({ id: "T003", type: "Issue", productId: "P001", out: 5, date: "2025-11-03", location: "MK", seq: 3, period: "25-11" }),
        // Transfer 15 from MK lot1
        makeTx({ id: "T004", type: "TransferOut", productId: "P001", out: 15, parentLot: "MK-251102-01", date: "2025-11-05", location: "MK", seq: 4, period: "25-11" }),
        // Transfer in 15 to KC
        makeTx({ id: "T005", type: "TransferIn", productId: "P001", lot: "KC-251105-01", in: 15, unitCost: 350, date: "2025-11-05", location: "KC", seq: 1, period: "25-11" }),
        // Transfer 5 from MK lot2
        makeTx({ id: "T006", type: "TransferOut", productId: "P001", out: 5, parentLot: "MK-251102-02", date: "2025-11-05", location: "MK", seq: 5, period: "25-11" }),
        // Transfer in 5 to KC
        makeTx({ id: "T007", type: "TransferIn", productId: "P001", lot: "KC-251105-02", in: 5, unitCost: 360, date: "2025-11-05", location: "KC", seq: 2, period: "25-11" }),
        // Credit note 1 from lot2
        makeTx({ id: "T008", type: "CreditNote", productId: "P001", out: 1, parentLot: "MK-251102-02", unitCost: 360, date: "2025-11-06", location: "MK", seq: 6, period: "25-11" }),
        // Close MK lot2
        makeTx({ id: "T009", type: "Close", productId: "P001", lot: "MK-251102-02", out: 4, unitCost: 360, date: "2025-11-30", location: "MK", seq: 7, period: "25-11" }),
        // Close KC lot1
        makeTx({ id: "T010", type: "Close", productId: "P001", lot: "KC-251105-01", out: 15, unitCost: 350, date: "2025-11-30", location: "KC", seq: 3, period: "25-11" }),
        // Close KC lot2
        makeTx({ id: "T011", type: "Close", productId: "P001", lot: "KC-251105-02", out: 5, unitCost: 360, date: "2025-11-30", location: "KC", seq: 4, period: "25-11" }),
        // Open MK
        makeTx({ id: "T012", type: "Open", productId: "P001", lot: "MK-251102-02", in: 4, unitCost: 360, date: "2025-12-01", location: "MK", seq: 8, period: "25-12" }),
        // Open KC lot1
        makeTx({ id: "T013", type: "Open", productId: "P001", lot: "KC-251105-01", in: 15, unitCost: 350, date: "2025-12-01", location: "KC", seq: 5, period: "25-12" }),
        // Open KC lot2
        makeTx({ id: "T014", type: "Open", productId: "P001", lot: "KC-251105-02", in: 5, unitCost: 360, date: "2025-12-01", location: "KC", seq: 6, period: "25-12" }),
      ];

      const results = engine.processAll(txs);
      expect(results).toHaveLength(14);

      // After all transactions
      expect(engine.getQuantityByProductAndLocation("P001", "MK")).toBe(4);
      expect(engine.getQuantityByProductAndLocation("P001", "KC")).toBe(20);

      // Summary
      const summary = engine.getInventorySummary();
      const p001 = summary.get("P001")!;
      expect(p001.totalQty).toBe(24);
      expect(p001.locations.get("MK")).toBe(4);
      expect(p001.locations.get("KC")).toBe(20);
    });

    it("should handle P002 (Jasmine Rice 5kg) — 18 transactions", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T015", type: "Receiving", productId: "P002", lot: "MK-251101-R01", in: 50, unitCost: 189, date: "2025-11-01", location: "MK", seq: 1, period: "25-11" }),
        makeTx({ id: "T016", type: "Receiving", productId: "P002", lot: "MK-251103-R02", in: 30, unitCost: 195, date: "2025-11-03", location: "MK", seq: 2, period: "25-11" }),
        makeTx({ id: "T017", type: "Issue", productId: "P002", out: 10, date: "2025-11-04", location: "MK", seq: 3, period: "25-11" }),
        makeTx({ id: "T018", type: "Issue", productId: "P002", out: 20, date: "2025-11-06", location: "MK", seq: 4, period: "25-11" }),
        // Transfer 15 from lot1
        makeTx({ id: "T019", type: "TransferOut", productId: "P002", out: 15, parentLot: "MK-251101-R01", date: "2025-11-08", location: "MK", seq: 5, period: "25-11" }),
        makeTx({ id: "T020", type: "TransferIn", productId: "P002", lot: "KC-251108-R01", in: 15, unitCost: 189, date: "2025-11-08", location: "KC", seq: 1, period: "25-11" }),
        // Transfer 5 from lot1 (R01 has 5 remaining after FIFO issues)
        makeTx({ id: "T021", type: "TransferOut", productId: "P002", out: 5, parentLot: "MK-251101-R01", date: "2025-11-08", location: "MK", seq: 6, period: "25-11" }),
        makeTx({ id: "T022", type: "TransferIn", productId: "P002", lot: "KC-251108-R02", in: 5, unitCost: 189, date: "2025-11-08", location: "KC", seq: 2, period: "25-11" }),
        // Issue 3 (FIFO from R02)
        makeTx({ id: "T023", type: "Issue", productId: "P002", out: 3, date: "2025-11-10", location: "MK", seq: 7, period: "25-11" }),
        // Credit note 2 from R02
        makeTx({ id: "T024", type: "CreditNote", productId: "P002", out: 2, parentLot: "MK-251103-R02", unitCost: 195, date: "2025-11-12", location: "MK", seq: 8, period: "25-11" }),
        // Close MK (R02: 30-3-2 = 25)
        makeTx({ id: "T025", type: "Close", productId: "P002", lot: "MK-251103-R02", out: 25, unitCost: 195, date: "2025-11-30", location: "MK", seq: 9, period: "25-11" }),
        // Close KC
        makeTx({ id: "T026", type: "Close", productId: "P002", lot: "KC-251108-R01", out: 15, unitCost: 189, date: "2025-11-30", location: "KC", seq: 3, period: "25-11" }),
        makeTx({ id: "T027", type: "Close", productId: "P002", lot: "KC-251108-R02", out: 5, unitCost: 189, date: "2025-11-30", location: "KC", seq: 4, period: "25-11" }),
        // Open
        makeTx({ id: "T028", type: "Open", productId: "P002", lot: "MK-251103-R02", in: 25, unitCost: 195, date: "2025-12-01", location: "MK", seq: 10, period: "25-12" }),
        makeTx({ id: "T029", type: "Open", productId: "P002", lot: "KC-251108-R01", in: 15, unitCost: 189, date: "2025-12-01", location: "KC", seq: 5, period: "25-12" }),
        makeTx({ id: "T030", type: "Open", productId: "P002", lot: "KC-251108-R02", in: 5, unitCost: 189, date: "2025-12-01", location: "KC", seq: 6, period: "25-12" }),
      ];

      // R01=50, R02=30 → Issue 10 FIFO(R01→40) → Issue 20 FIFO(R01→20) →
      // Transfer 15 R01(→5) → Transfer 5 R01(→0) → Issue 3 FIFO(R02→27) → CN 2 R02(→25)
      // Close/Open cycle
      const results = engine.processAll(txs);
      expect(results).toHaveLength(16);

      // MK: 50+30-10-20-15-5-3-2 = 25 (lot R02 remains)
      expect(engine.getQuantityByProductAndLocation("P002", "MK")).toBe(25);
      // KC: 15+5 = 20
      expect(engine.getQuantityByProductAndLocation("P002", "KC")).toBe(20);
    });

    it("should handle P003 (Sparkling Water 500ml) — 9 transactions", () => {
      const txs: EngineTransaction[] = [
        makeTx({ id: "T031", type: "Receiving", productId: "P003", lot: "MK-251101-W01", in: 100, unitCost: 25, date: "2025-11-01", location: "MK", seq: 1, period: "25-11" }),
        makeTx({ id: "T032", type: "Issue", productId: "P003", out: 30, date: "2025-11-03", location: "MK", seq: 2, period: "25-11" }),
        // Transfer 40 to KC
        makeTx({ id: "T033", type: "TransferOut", productId: "P003", out: 40, parentLot: "MK-251101-W01", date: "2025-11-05", location: "MK", seq: 3, period: "25-11" }),
        makeTx({ id: "T034", type: "TransferIn", productId: "P003", lot: "KC-251105-W01", in: 40, unitCost: 25, date: "2025-11-05", location: "KC", seq: 1, period: "25-11" }),
        // Issue 10 from KC
        makeTx({ id: "T035", type: "Issue", productId: "P003", out: 10, date: "2025-11-07", location: "KC", seq: 2, period: "25-11" }),
        // Close
        makeTx({ id: "T036", type: "Close", productId: "P003", lot: "MK-251101-W01", out: 30, unitCost: 25, date: "2025-11-30", location: "MK", seq: 4, period: "25-11" }),
        makeTx({ id: "T037", type: "Close", productId: "P003", lot: "KC-251105-W01", out: 30, unitCost: 25, date: "2025-11-30", location: "KC", seq: 3, period: "25-11" }),
        // Open
        makeTx({ id: "T038", type: "Open", productId: "P003", lot: "MK-251101-W01", in: 30, unitCost: 25, date: "2025-12-01", location: "MK", seq: 5, period: "25-12" }),
        makeTx({ id: "T039", type: "Open", productId: "P003", lot: "KC-251105-W01", in: 30, unitCost: 25, date: "2025-12-01", location: "KC", seq: 4, period: "25-12" }),
      ];

      const results = engine.processAll(txs);
      expect(results).toHaveLength(9);

      // MK: 100-30-40 = 30
      expect(engine.getQuantityByProductAndLocation("P003", "MK")).toBe(30);
      // KC: 40-10 = 30
      expect(engine.getQuantityByProductAndLocation("P003", "KC")).toBe(30);
    });

    it("should produce correct inventory summary across all 3 products", () => {
      // Process all products together
      const allTxs: EngineTransaction[] = [
        // P001
        makeTx({ id: "T001", type: "Receiving", productId: "P001", lot: "MK-01", in: 20, unitCost: 350, location: "MK", seq: 1, period: "25-11", date: "2025-11-01" }),
        makeTx({ id: "T002", type: "Receiving", productId: "P001", lot: "MK-02", in: 10, unitCost: 360, location: "MK", seq: 2, period: "25-11", date: "2025-11-01" }),
        makeTx({ id: "T003", type: "Issue", productId: "P001", out: 5, location: "MK", seq: 3, period: "25-11", date: "2025-11-02" }),
        // P002
        makeTx({ id: "T004", type: "Receiving", productId: "P002", lot: "MK-R1", in: 50, unitCost: 189, location: "MK", seq: 1, period: "25-11", date: "2025-11-01" }),
        makeTx({ id: "T005", type: "Issue", productId: "P002", out: 10, location: "MK", seq: 2, period: "25-11", date: "2025-11-02" }),
        // P003
        makeTx({ id: "T006", type: "Receiving", productId: "P003", lot: "MK-W1", in: 100, unitCost: 25, location: "MK", seq: 1, period: "25-11", date: "2025-11-01" }),
      ];

      engine.processAll(allTxs);

      const summary = engine.getInventorySummary();
      expect(summary.size).toBe(3);

      // P001: 20+10-5 = 25
      expect(summary.get("P001")!.totalQty).toBe(25);
      // P002: 50-10 = 40
      expect(summary.get("P002")!.totalQty).toBe(40);
      // P003: 100
      expect(summary.get("P003")!.totalQty).toBe(100);
    });
  });
});
