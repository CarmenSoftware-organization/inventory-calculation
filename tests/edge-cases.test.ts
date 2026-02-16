import { FIFOStrategy } from "../src/strategies/fifo-strategy";
import { AverageCostStrategy } from "../src/strategies/average-cost-strategy";
import { InsufficientStockError } from "../src/errors";
import { round } from "../src/utils/rounding";

describe("Edge cases", () => {
  describe("round() utility", () => {
    it("should round to 4 decimal places by default", () => {
      expect(round(10.66666667)).toBe(10.6667);
      expect(round(11.27272727)).toBe(11.2727);
    });

    it("should round to custom precision", () => {
      expect(round(10.666, 2)).toBe(10.67);
      expect(round(10.664, 2)).toBe(10.66);
    });

    it("should handle whole numbers", () => {
      expect(round(100)).toBe(100);
    });
  });

  describe("zero stock scenarios", () => {
    it("FIFO: should throw when issuing from zero stock", () => {
      const strategy = new FIFOStrategy();
      expect(() =>
        strategy.issueStock({
          productId: "P1",
          warehouseId: "W1",
          quantity: 10,
        })
      ).toThrow(InsufficientStockError);
    });

    it("Average: should throw when issuing from zero stock", () => {
      const strategy = new AverageCostStrategy();
      expect(() =>
        strategy.issueStock({
          productId: "P1",
          warehouseId: "W1",
          quantity: 10,
        })
      ).toThrow(InsufficientStockError);
    });

    it("FIFO: receive after full depletion", () => {
      const strategy = new FIFOStrategy();
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 5,
      });
      strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
      });

      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
        unitCost: 8,
      });

      expect(result.balance.quantity).toBe(20);
      expect(result.balance.totalValue).toBe(160);
    });

    it("Average: receive after full depletion resets average cost", () => {
      const strategy = new AverageCostStrategy();
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 5,
      });
      strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
      });

      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
        unitCost: 8,
      });

      expect(result.balance.quantity).toBe(20);
      expect(result.balance.averageCost).toBe(8);
      expect(result.balance.totalValue).toBe(160);
    });
  });

  describe("returns (receive back after issue)", () => {
    it("FIFO: return creates a new lot", () => {
      const strategy = new FIFOStrategy();
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });
      strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
      });

      // Customer returns 10 units at original cost
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 10,
        referenceDoc: "RETURN-001",
        date: new Date("2024-01-05"),
      });

      expect(result.balance.quantity).toBe(60);
      expect(result.balance.totalValue).toBe(600);
    });

    it("Average: return recalculates average", () => {
      const strategy = new AverageCostStrategy();
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
      });
      // avg = 10.6667

      strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
      });
      // remaining: 100 @ 10.6667

      // Return 20 units at original cost of 12
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
        unitCost: 12,
        referenceDoc: "RETURN-001",
      });

      expect(result.balance.quantity).toBe(120);
      // (100*10.6667 + 20*12) / 120 = (1066.67 + 240) / 120
    });
  });

  describe("rounding precision", () => {
    it("Average: should maintain precision through multiple operations", () => {
      const strategy = new AverageCostStrategy();

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 3,
        unitCost: 10,
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 7,
        unitCost: 11,
      });

      const val = strategy.getValuation("P1", "W1");
      // (3*10 + 7*11) / 10 = 107/10 = 10.7
      expect(val.averageCost).toBe(10.7);
      expect(val.quantity).toBe(10);
    });

    it("FIFO: should maintain exact lot costs", () => {
      const strategy = new FIFOStrategy();

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 3,
        unitCost: 10.3333,
        date: new Date("2024-01-01"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 7,
        unitCost: 11.6667,
        date: new Date("2024-01-02"),
      });

      const val = strategy.getValuation("P1", "W1");
      expect(val.lots![0].unitCost).toBe(10.3333);
      expect(val.lots![1].unitCost).toBe(11.6667);
    });
  });

  describe("section 5 - full comparison", () => {
    it("should produce the expected comparison results", () => {
      const fifo = new FIFOStrategy();
      const avg = new AverageCostStrategy();

      // 1. รับเข้า 100 หน่วย @ ฿10.00
      fifo.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });
      avg.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      let fifoVal = fifo.getValuation("P1", "W1");
      let avgVal = avg.getValuation("P1", "W1");

      expect(fifoVal.quantity).toBe(100);
      expect(fifoVal.totalValue).toBe(1000);
      expect(avgVal.quantity).toBe(100);
      expect(avgVal.totalValue).toBe(1000);
      expect(avgVal.averageCost).toBe(10);

      // 2. รับเข้า 50 หน่วย @ ฿12.00
      fifo.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
        date: new Date("2024-01-02"),
      });
      avg.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
      });

      fifoVal = fifo.getValuation("P1", "W1");
      avgVal = avg.getValuation("P1", "W1");

      expect(fifoVal.quantity).toBe(150);
      expect(fifoVal.totalValue).toBe(1600);
      expect(avgVal.quantity).toBe(150);
      expect(avgVal.averageCost).toBe(10.6667);

      // 3. เบิกออก 120 หน่วย
      const fifoIssue = fifo.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 120,
      });
      const avgIssue = avg.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 120,
      });

      // FIFO COGS: 100*10 + 20*12 = 1240
      expect(fifoIssue.totalCost).toBe(1240);
      // Average COGS: 120 * 10.6667 = 1280.004
      expect(avgIssue.totalCost).toBe(1280.004);

      fifoVal = fifo.getValuation("P1", "W1");
      avgVal = avg.getValuation("P1", "W1");

      expect(fifoVal.quantity).toBe(30);
      expect(fifoVal.totalValue).toBe(360); // 30 * 12
      expect(avgVal.quantity).toBe(30);

      // 4. รับเข้า 80 หน่วย @ ฿11.50
      fifo.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 80,
        unitCost: 11.5,
        date: new Date("2024-01-03"),
      });
      avg.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 80,
        unitCost: 11.5,
      });

      fifoVal = fifo.getValuation("P1", "W1");
      avgVal = avg.getValuation("P1", "W1");

      expect(fifoVal.quantity).toBe(110);
      expect(fifoVal.totalValue).toBe(1280); // 30*12 + 80*11.50 = 360 + 920
      expect(avgVal.quantity).toBe(110);

      // Key observation: FIFO total value > Average total value in rising prices
      expect(fifoVal.totalValue).toBeGreaterThan(avgVal.totalValue);
    });
  });

  describe("InsufficientStockError", () => {
    it("should contain product, warehouse, requested, and available info", () => {
      const strategy = new FIFOStrategy();
      strategy.receiveStock({
        productId: "PROD-A",
        warehouseId: "WH-1",
        quantity: 5,
        unitCost: 10,
      });

      try {
        strategy.issueStock({
          productId: "PROD-A",
          warehouseId: "WH-1",
          quantity: 10,
        });
        fail("Should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(InsufficientStockError);
        const err = e as InsufficientStockError;
        expect(err.productId).toBe("PROD-A");
        expect(err.warehouseId).toBe("WH-1");
        expect(err.requested).toBe(10);
        expect(err.available).toBe(5);
        expect(err.message).toContain("PROD-A");
        expect(err.message).toContain("WH-1");
      }
    });
  });

  describe("multiple products and warehouses", () => {
    it("FIFO: should track products independently", () => {
      const strategy = new FIFOStrategy();

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });
      strategy.receiveStock({
        productId: "P2",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 20,
      });

      const v1 = strategy.getValuation("P1", "W1");
      const v2 = strategy.getValuation("P2", "W1");

      expect(v1.quantity).toBe(100);
      expect(v1.totalValue).toBe(1000);
      expect(v2.quantity).toBe(50);
      expect(v2.totalValue).toBe(1000);
    });

    it("Average: should track warehouses independently", () => {
      const strategy = new AverageCostStrategy();

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W2",
        quantity: 50,
        unitCost: 15,
      });

      const v1 = strategy.getValuation("P1", "W1");
      const v2 = strategy.getValuation("P1", "W2");

      expect(v1.quantity).toBe(100);
      expect(v1.averageCost).toBe(10);
      expect(v2.quantity).toBe(50);
      expect(v2.averageCost).toBe(15);
    });
  });
});
