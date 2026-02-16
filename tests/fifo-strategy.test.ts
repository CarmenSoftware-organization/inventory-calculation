import { FIFOStrategy } from "../src/strategies/fifo-strategy";
import { InsufficientStockError } from "../src/errors";

describe("FIFOStrategy", () => {
  let strategy: FIFOStrategy;

  beforeEach(() => {
    strategy = new FIFOStrategy();
  });

  describe("receiveStock", () => {
    it("should create a new lot on receive", () => {
      const result = strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
      });

      expect(result.balance.quantity).toBe(100);
      expect(result.balance.totalValue).toBe(1000);
      expect(result.lotDetails).toHaveLength(1);
      expect(result.lotDetails![0].quantity).toBe(100);
      expect(result.lotDetails![0].unitCost).toBe(10);
    });

    it("should create separate lots for different receives", () => {
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

      expect(result.balance.quantity).toBe(150);
      expect(result.balance.totalValue).toBe(1600); // 100*10 + 50*12

      const valuation = strategy.getValuation("P1", "W1");
      expect(valuation.lots).toHaveLength(2);
    });
  });

  describe("issueStock", () => {
    it("should consume oldest lot first", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
        date: new Date("2024-01-02"),
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 80,
      });

      // Should consume 80 units from lot 1 @ 10
      expect(result.totalCost).toBe(800);
      expect(result.lotDetails).toHaveLength(1);
      expect(result.lotDetails![0].quantity).toBe(80);
      expect(result.lotDetails![0].unitCost).toBe(10);

      expect(result.balance.quantity).toBe(70);
    });

    it("should consume across multiple lots", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
        date: new Date("2024-01-02"),
      });

      const result = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 120,
      });

      // 100 from lot 1 @ 10 = 1000, 20 from lot 2 @ 12 = 240
      expect(result.totalCost).toBe(1240);
      expect(result.lotDetails).toHaveLength(2);
      expect(result.lotDetails![0].quantity).toBe(100);
      expect(result.lotDetails![0].unitCost).toBe(10);
      expect(result.lotDetails![1].quantity).toBe(20);
      expect(result.lotDetails![1].unitCost).toBe(12);

      expect(result.balance.quantity).toBe(30);
      expect(result.balance.totalValue).toBe(360); // 30 * 12
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
  });

  describe("adjustStock", () => {
    it("should create a new lot on positive adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 10,
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
        unitCost: 8,
      });

      expect(result.balance.quantity).toBe(70);
      // 50*10 + 20*8 = 660
      expect(result.balance.totalValue).toBe(660);
    });

    it("should consume oldest lots on negative adjustment", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 30,
        unitCost: 15,
        date: new Date("2024-01-02"),
      });

      const result = strategy.adjustStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: -60,
        unitCost: 10,
      });

      expect(result.balance.quantity).toBe(20);
      // 20 remaining from lot 2 @ 15
      expect(result.balance.totalValue).toBe(300);
    });
  });

  describe("transferStock", () => {
    it("should transfer lots from source to destination", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      const result = strategy.transferStock({
        productId: "P1",
        fromWarehouseId: "W1",
        toWarehouseId: "W2",
        quantity: 30,
      });

      expect(result.transferCost).toBe(300);

      const sourceVal = strategy.getValuation("P1", "W1");
      expect(sourceVal.quantity).toBe(70);
      expect(sourceVal.totalValue).toBe(700);

      const destVal = strategy.getValuation("P1", "W2");
      expect(destVal.quantity).toBe(30);
      expect(destVal.totalValue).toBe(300);
    });
  });

  describe("getValuation", () => {
    it("should return zero valuation for unknown product", () => {
      const result = strategy.getValuation("UNKNOWN", "W1");

      expect(result.quantity).toBe(0);
      expect(result.totalValue).toBe(0);
      expect(result.averageCost).toBe(0);
      expect(result.lots).toHaveLength(0);
    });

    it("should include lot details in valuation", () => {
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
        date: new Date("2024-01-02"),
      });

      const valuation = strategy.getValuation("P1", "W1");
      expect(valuation.lots).toHaveLength(2);
      expect(valuation.lots![0].unitCost).toBe(10);
      expect(valuation.lots![1].unitCost).toBe(12);
    });
  });

  describe("document example (section 2.2)", () => {
    it("should match the FIFO example from the spec", () => {
      // ล็อตซื้อที่ 1: 100 หน่วย @ ฿10.00
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 100,
        unitCost: 10,
        date: new Date("2024-01-01"),
      });

      // ล็อตซื้อที่ 2: 50 หน่วย @ ฿12.00
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 12,
        date: new Date("2024-01-02"),
      });

      // ล็อตซื้อที่ 3: 80 หน่วย @ ฿11.50
      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 80,
        unitCost: 11.5,
        date: new Date("2024-01-03"),
      });

      // เบิกออก 120 หน่วย
      const issue = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 120,
      });

      // 100 จากล็อต 1 @ 10 = 1000, 20 จากล็อต 2 @ 12 = 240
      expect(issue.totalCost).toBe(1240);

      // คงเหลือ: 30@12 + 80@11.50 = 360 + 920 = 1280
      const valuation = strategy.getValuation("P1", "W1");
      expect(valuation.quantity).toBe(110);
      expect(valuation.totalValue).toBe(1280);
      expect(valuation.lots).toHaveLength(2);
      expect(valuation.lots![0].quantity).toBe(30);
      expect(valuation.lots![0].unitCost).toBe(12);
      expect(valuation.lots![1].quantity).toBe(80);
      expect(valuation.lots![1].unitCost).toBe(11.5);
    });
  });
});
