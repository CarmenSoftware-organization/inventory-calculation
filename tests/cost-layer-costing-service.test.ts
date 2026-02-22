import { CostingService } from "../src/services/costing-service";
import { CostingMethod } from "../src/types";
import { CostLayerFIFOStrategy } from "../src/strategies/cost-layer-fifo-strategy";
import { CostLayerAverageStrategy } from "../src/strategies/cost-layer-average-strategy";

describe("CostingService - Cost Layer Methods", () => {
  describe("createStrategy", () => {
    it("should create CostLayerFIFOStrategy for COST_LAYER_FIFO method", () => {
      const strategy = CostingService.createStrategy(
        CostingMethod.COST_LAYER_FIFO
      );
      expect(strategy).toBeInstanceOf(CostLayerFIFOStrategy);
    });

    it("should create CostLayerAverageStrategy for COST_LAYER_AVERAGE method", () => {
      const strategy = CostingService.createStrategy(
        CostingMethod.COST_LAYER_AVERAGE
      );
      expect(strategy).toBeInstanceOf(CostLayerAverageStrategy);
    });
  });

  describe("getStrategy", () => {
    it("should return the same COST_LAYER_FIFO instance on repeated calls", () => {
      const service = new CostingService();
      const s1 = service.getStrategy(CostingMethod.COST_LAYER_FIFO);
      const s2 = service.getStrategy(CostingMethod.COST_LAYER_FIFO);
      expect(s1).toBe(s2);
    });

    it("should return different instances for COST_LAYER_FIFO and COST_LAYER_AVERAGE", () => {
      const service = new CostingService();
      const fifo = service.getStrategy(CostingMethod.COST_LAYER_FIFO);
      const avg = service.getStrategy(CostingMethod.COST_LAYER_AVERAGE);
      expect(fifo).not.toBe(avg);
      expect(fifo).toBeInstanceOf(CostLayerFIFOStrategy);
      expect(avg).toBeInstanceOf(CostLayerAverageStrategy);
    });
  });
});
