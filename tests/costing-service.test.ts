import { CostingService } from "../src/services/costing-service";
import { CostingMethod } from "../src/types";
import { FIFOStrategy } from "../src/strategies/fifo-strategy";
import { AverageCostStrategy } from "../src/strategies/average-cost-strategy";

describe("CostingService", () => {
  describe("createStrategy", () => {
    it("should create FIFOStrategy for FIFO method", () => {
      const strategy = CostingService.createStrategy(CostingMethod.FIFO);
      expect(strategy).toBeInstanceOf(FIFOStrategy);
    });

    it("should create AverageCostStrategy for AVERAGE method", () => {
      const strategy = CostingService.createStrategy(CostingMethod.AVERAGE);
      expect(strategy).toBeInstanceOf(AverageCostStrategy);
    });

    it("should throw for unknown method", () => {
      expect(() =>
        CostingService.createStrategy("LIFO" as CostingMethod)
      ).toThrow("Unknown costing method");
    });
  });

  describe("getStrategy", () => {
    it("should return the same strategy instance on repeated calls", () => {
      const service = new CostingService();
      const s1 = service.getStrategy(CostingMethod.FIFO);
      const s2 = service.getStrategy(CostingMethod.FIFO);
      expect(s1).toBe(s2);
    });

    it("should return different strategies for different methods", () => {
      const service = new CostingService();
      const fifo = service.getStrategy(CostingMethod.FIFO);
      const avg = service.getStrategy(CostingMethod.AVERAGE);
      expect(fifo).not.toBe(avg);
      expect(fifo).toBeInstanceOf(FIFOStrategy);
      expect(avg).toBeInstanceOf(AverageCostStrategy);
    });
  });

  describe("workflow test", () => {
    it("should support a full receive-issue workflow via FIFO", () => {
      const service = new CostingService(CostingMethod.FIFO);
      const strategy = service.getStrategy(CostingMethod.FIFO);

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 10,
      });

      const issue = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
      });

      expect(issue.totalCost).toBe(200);
      expect(issue.balance.quantity).toBe(30);
    });

    it("should support a full receive-issue workflow via Average", () => {
      const service = new CostingService(CostingMethod.AVERAGE);
      const strategy = service.getStrategy(CostingMethod.AVERAGE);

      strategy.receiveStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 50,
        unitCost: 10,
      });

      const issue = strategy.issueStock({
        productId: "P1",
        warehouseId: "W1",
        quantity: 20,
      });

      expect(issue.totalCost).toBe(200);
      expect(issue.balance.quantity).toBe(30);
    });
  });
});
