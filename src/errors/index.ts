export class PeriodNotClosedError extends Error {
  public readonly productId: string;
  public readonly warehouseId: string;
  public readonly period: string;

  constructor(productId: string, warehouseId: string, period: string) {
    super(
      `Period "${period}" has not been closed for product "${productId}" in warehouse "${warehouseId}"`
    );
    this.name = "PeriodNotClosedError";
    this.productId = productId;
    this.warehouseId = warehouseId;
    this.period = period;
  }
}

export class InsufficientStockError extends Error {
  public readonly productId: string;
  public readonly warehouseId: string;
  public readonly requested: number;
  public readonly available: number;

  constructor(
    productId: string,
    warehouseId: string,
    requested: number,
    available: number
  ) {
    super(
      `Insufficient stock for product "${productId}" in warehouse "${warehouseId}": ` +
        `requested ${requested}, available ${available}`
    );
    this.name = "InsufficientStockError";
    this.productId = productId;
    this.warehouseId = warehouseId;
    this.requested = requested;
    this.available = available;
  }
}
