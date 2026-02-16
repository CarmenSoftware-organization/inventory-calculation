import { FIFOStrategy } from "../src/strategies/fifo-strategy";
import { AverageCostStrategy } from "../src/strategies/average-cost-strategy";
import { TransactionType, RecalculateTransaction } from "../src/types";

describe("FIFOStrategy recalculate", () => {
  let strategy: FIFOStrategy;

  beforeEach(() => {
    strategy = new FIFOStrategy();
  });

  it("should recalculate after correcting a purchase cost", () => {
    // Original: bought 100 @ 10, then sold 50
    // Correction: purchase was actually @ 12
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 12, // corrected from 10 to 12
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        date: new Date("2025-01-15"),
        unitCost: 0, // unitCost for OUT is determined by FIFO
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // IN: 100 @ 12 = 1200
    expect(result.transactions[0].totalCost).toBe(1200);
    // OUT: 50 @ 12 (FIFO from single lot) = 600
    expect(result.transactions[1].unitCost).toBe(12);
    expect(result.transactions[1].totalCost).toBe(600);
    // Balance: 50 remaining @ 12 = 600
    expect(result.finalBalance.quantity).toBe(50);
    expect(result.finalBalance.totalValue).toBe(600);
    expect(result.finalBalance.averageCost).toBe(12);
  });

  it("should recalculate after correcting a purchase quantity", () => {
    // Correction: first purchase was actually 80, not 100
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 80, // corrected from 100 to 80
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 50,
        unitCost: 12,
        date: new Date("2025-01-10"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 60,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // OUT: FIFO consumes 60 from first lot @ 10
    expect(result.transactions[2].unitCost).toBe(10);
    expect(result.transactions[2].totalCost).toBe(600);
    // Balance: 20 @ 10 + 50 @ 12 = 200 + 600 = 800
    expect(result.finalBalance.quantity).toBe(70);
    expect(result.finalBalance.totalValue).toBe(800);
  });

  it("should recalculate with mixed IN/OUT consuming multiple lots", () => {
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 30,
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 40,
        unitCost: 15,
        date: new Date("2025-01-05"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-10"),
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // OUT: FIFO consumes 30 @ 10 (300) + 20 @ 15 (300) = 600
    expect(result.transactions[2].totalCost).toBe(600);
    expect(result.transactions[2].unitCost).toBe(12); // 600/50
    // Balance: 20 @ 15 = 300
    expect(result.finalBalance.quantity).toBe(20);
    expect(result.finalBalance.totalValue).toBe(300);
    expect(result.finalBalance.averageCost).toBe(15);
  });

  it("should produce different results when cost is changed", () => {
    const originalTransactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const correctedTransactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 15, // changed from 10 to 15
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const original = strategy.recalculate("P1", "W1", originalTransactions);
    const corrected = strategy.recalculate("P1", "W1", correctedTransactions);

    // Original: OUT cost = 50 * 10 = 500, balance = 500
    expect(original.transactions[1].totalCost).toBe(500);
    expect(original.finalBalance.totalValue).toBe(500);

    // Corrected: OUT cost = 50 * 15 = 750, balance = 750
    expect(corrected.transactions[1].totalCost).toBe(750);
    expect(corrected.finalBalance.totalValue).toBe(750);

    // They should differ
    expect(corrected.transactions[1].totalCost).not.toBe(
      original.transactions[1].totalCost
    );
  });

  it("should clear previous state when recalculating", () => {
    // First, add some stock normally
    strategy.receiveStock({
      productId: "P1",
      warehouseId: "W1",
      quantity: 200,
      unitCost: 5,
    });

    // Now recalculate — should ignore the 200 qty above
    const result = strategy.recalculate("P1", "W1", [
      {
        transactionType: TransactionType.IN,
        quantity: 10,
        unitCost: 20,
        date: new Date("2025-01-01"),
      },
    ]);

    expect(result.finalBalance.quantity).toBe(10);
    expect(result.finalBalance.totalValue).toBe(200);
  });
});

describe("AverageCostStrategy recalculate", () => {
  let strategy: AverageCostStrategy;

  beforeEach(() => {
    strategy = new AverageCostStrategy();
  });

  it("should recalculate after correcting a purchase cost", () => {
    // Correction: purchase was actually @ 12
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 12, // corrected from 10 to 12
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // IN: 100 @ 12, avg = 12
    // OUT: 50 @ avg 12 = 600
    expect(result.transactions[1].unitCost).toBe(12);
    expect(result.transactions[1].totalCost).toBe(600);
    // Balance: 50 @ 12 = 600
    expect(result.finalBalance.quantity).toBe(50);
    expect(result.finalBalance.totalValue).toBe(600);
    expect(result.finalBalance.averageCost).toBe(12);
  });

  it("should recalculate after correcting a purchase quantity", () => {
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 80, // corrected from 100
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 50,
        unitCost: 12,
        date: new Date("2025-01-10"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 60,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // After 2 INs: qty=130, value = 800+600 = 1400, avg = round4(1400/130) = 10.7692
    const expectedAvg = 10.7692;
    expect(result.transactions[1].totalCost).toBe(600);

    // OUT: 60 @ 10.7692 = round4(646.152) = 646.152
    expect(result.transactions[2].unitCost).toBe(expectedAvg);
    expect(result.transactions[2].totalCost).toBe(
      Math.round(60 * expectedAvg * 10000) / 10000
    );

    // Balance: 70 remaining
    expect(result.finalBalance.quantity).toBe(70);
  });

  it("should recalculate with mixed IN/OUT and weighted average", () => {
    const transactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 40,
        unitCost: 0,
        date: new Date("2025-01-10"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 60,
        unitCost: 15,
        date: new Date("2025-01-15"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-20"),
      },
    ];

    const result = strategy.recalculate("P1", "W1", transactions);

    // Step 1: IN 100 @ 10, avg=10, qty=100
    // Step 2: OUT 40 @ 10 = 400, qty=60, avg=10
    expect(result.transactions[1].unitCost).toBe(10);
    expect(result.transactions[1].totalCost).toBe(400);

    // Step 3: IN 60 @ 15, total = 60*10 + 60*15 = 600+900 = 1500, qty=120, avg=12.5
    // Step 4: OUT 50 @ 12.5 = 625, qty=70
    expect(result.transactions[3].unitCost).toBe(12.5);
    expect(result.transactions[3].totalCost).toBe(625);

    expect(result.finalBalance.quantity).toBe(70);
    expect(result.finalBalance.averageCost).toBe(12.5);
    expect(result.finalBalance.totalValue).toBe(875);
  });

  it("should produce different results when cost is changed", () => {
    const originalTransactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 20,
        date: new Date("2025-01-05"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const correctedTransactions: RecalculateTransaction[] = [
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 10,
        date: new Date("2025-01-01"),
      },
      {
        transactionType: TransactionType.IN,
        quantity: 100,
        unitCost: 30, // changed from 20 to 30
        date: new Date("2025-01-05"),
      },
      {
        transactionType: TransactionType.OUT,
        quantity: 50,
        unitCost: 0,
        date: new Date("2025-01-15"),
      },
    ];

    const original = strategy.recalculate("P1", "W1", originalTransactions);
    const corrected = strategy.recalculate("P1", "W1", correctedTransactions);

    // Original avg = (1000+2000)/200 = 15, OUT = 50*15 = 750
    expect(original.transactions[2].unitCost).toBe(15);
    expect(original.transactions[2].totalCost).toBe(750);

    // Corrected avg = (1000+3000)/200 = 20, OUT = 50*20 = 1000
    expect(corrected.transactions[2].unitCost).toBe(20);
    expect(corrected.transactions[2].totalCost).toBe(1000);

    expect(corrected.transactions[2].totalCost).not.toBe(
      original.transactions[2].totalCost
    );
  });

  it("should clear previous state when recalculating", () => {
    // First, add stock normally
    strategy.receiveStock({
      productId: "P1",
      warehouseId: "W1",
      quantity: 200,
      unitCost: 5,
    });

    // Now recalculate — should ignore the 200 qty above
    const result = strategy.recalculate("P1", "W1", [
      {
        transactionType: TransactionType.IN,
        quantity: 10,
        unitCost: 20,
        date: new Date("2025-01-01"),
      },
    ]);

    expect(result.finalBalance.quantity).toBe(10);
    expect(result.finalBalance.totalValue).toBe(200);
    expect(result.finalBalance.averageCost).toBe(20);
  });
});
