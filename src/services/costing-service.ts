import { CostingMethod } from "../types";
import { InventoryCostingStrategy } from "../strategies/inventory-costing-strategy";
import { FIFOStrategy } from "../strategies/fifo-strategy";
import { AverageCostStrategy } from "../strategies/average-cost-strategy";
import { CostLayerFIFOStrategy } from "../strategies/cost-layer-fifo-strategy";
import { CostLayerAverageStrategy } from "../strategies/cost-layer-average-strategy";

export class CostingService {
  private strategies = new Map<CostingMethod, InventoryCostingStrategy>();

  constructor(method?: CostingMethod) {
    if (method) {
      this.strategies.set(method, CostingService.createStrategy(method));
    }
  }

  static createStrategy(method: CostingMethod): InventoryCostingStrategy {
    switch (method) {
      case CostingMethod.FIFO:
        return new FIFOStrategy();
      case CostingMethod.AVERAGE:
        return new AverageCostStrategy();
      case CostingMethod.COST_LAYER_FIFO:
        return new CostLayerFIFOStrategy();
      case CostingMethod.COST_LAYER_AVERAGE:
        return new CostLayerAverageStrategy();
      default:
        throw new Error(`Unknown costing method: ${method}`);
    }
  }

  getStrategy(method: CostingMethod): InventoryCostingStrategy {
    let strategy = this.strategies.get(method);
    if (!strategy) {
      strategy = CostingService.createStrategy(method);
      this.strategies.set(method, strategy);
    }
    return strategy;
  }
}
