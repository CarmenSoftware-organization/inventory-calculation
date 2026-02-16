import { AverageCostStrategy } from "../src/strategies/average-cost-strategy";
import { InsufficientStockError } from "../src/errors";

describe("AverageCostStrategy", () => {
  let strategy: AverageCostStrategy;

  beforeEach(() => {
    strategy = new AverageCostStrategy();
  });

  describe("receiveStock", () => {
    it("should set average cost on first receive", () => {
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      expect(result.balance.quantity).toBe(100);
      expect(result.balance.totalValue).toBe(1000);
      expect(result.balance.averageCost).toBe(10);
      expect(result.transaction.transactionType).toBe("IN");
    });

    it("should recalculate weighted average on second receive", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
      });

      // (100*10 + 50*12) / 150 = 1600/150 = 10.6667
      expect(result.balance.quantity).toBe(150);
      expect(result.balance.averageCost).toBe(10.6667);
      expect(result.balance.totalValue).toBe(1600.005); // 150 * 10.6667
    });
  });

  describe("issueStock", () => {
    it("should issue at current average cost", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 40,
      });

      expect(result.totalCost).toBe(400); // 40 * 10
      expect(result.balance.quantity).toBe(60);
      expect(result.balance.averageCost).toBe(10);
    });

    it("should throw InsufficientStockError when not enough stock", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 5,
      });

      expect(() =>
        strategy.issueStock({
          productId: "P1",
          warehouseId: "W1",
          quantity: 20,
        })
      ).toThrow(InsufficientStockError);
    });

    it("should reset average cost to 0 when stock is fully depleted", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 5,
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
      });

      expect(result.balance.quantity).toBe(0);
      expect(result.balance.averageCost).toBe(0);
      expect(result.balance.totalValue).toBe(0);
    });
  });

  describe("adjustStock", () => {
    it("should recalculate average on positive adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
        unitCost: 15,
      });

      // (100*10 + 20*15) / 120 = 1300/120 = 10.8333
      expect(result.balance.quantity).toBe(120);
      expect(result.balance.averageCost).toBe(10.8333);
    });

    it("should use current average for negative adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: -30,
        unitCost: 10,
      });

      expect(result.balance.quantity).toBe(70);
      expect(result.balance.averageCost).toBe(10);
    });

    it("should throw on negative adjustment exceeding stock", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 10,
        unitCost: 5,
      });

      expect(() =>
        strategy.adjustStock({
          productId: "P1",
          warehouseId: "W1",
          quantity: -20,
          unitCost: 5,
        })
      ).toThrow(InsufficientStockError);
    });
  });

  describe("transferStock", () => {
    it("should transfer at source average cost", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      const result = strategy.transferStock({
        productId: "P1",
        fromWarehouseId: "W1",
        toWarehouseId: "W2",
        quantity: 30,
      });

      expect(result.transferCost).toBe(300); // 30 * 10

      const sourceVal = strategy.getValuation("P1", "W1");
      expect(sourceVal.quantity).toBe(70);
      expect(sourceVal.averageCost).toBe(10);

      const destVal = strategy.getValuation("P1", "W2");
      expect(destVal.quantity).toBe(30);
      expect(destVal.averageCost).toBe(10);
    });
  });

  describe("getValuation", () => {
    it("should return zero valuation for unknown product", () => {
      const result = strategy.getValuation("UNKNOWN", "W1");

      expect(result.quantity).toBe(0);
      expect(result.totalValue).toBe(0);
      expect(result.averageCost).toBe(0);
    });
  });

  describe("document example (section 3.2)", () => {
    it("should match the weighted average example from the spec", () => {
      // ซื้อครั้งที่ 1: 100 หน่วย @ ฿10.00
      const r1 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });
      expect(r1.balance.quantity).toBe(100);
      expect(r1.balance.averageCost).toBe(10);
      expect(r1.balance.totalValue).toBe(1000);

      // ซื้อครั้งที่ 2: 50 หน่วย @ ฿12.00
      const r2 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
      });
      expect(r2.balance.quantity).toBe(150);
      expect(r2.balance.averageCost).toBe(10.6667);

      // เบิกออก 120 หน่วย: COGS = 120 * 10.6667 = 1280.004
      const issue = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 120,
      });
      expect(issue.totalCost).toBe(1280.004); // 120 * 10.6667
      expect(issue.balance.quantity).toBe(30);

      // ซื้อครั้งที่ 3: 80 หน่วย @ ฿11.50
      const r3 = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 80,
        unitCost: 11.5,
      });
      expect(r3.balance.quantity).toBe(110);
    });
  });
});
