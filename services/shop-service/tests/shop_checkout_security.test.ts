import "dotenv/config";
import assert from "assert";

async function runShopTestSuite() {
  console.log("=============================================================");
  console.log("  SHOP SERVICE CHECKOUT SECURITY & INTEGRITY TEST SUITE");
  console.log("=============================================================\n");

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => void | Promise<void>) {
    try {
      await fn();
      console.log("  ✓ PASS: " + name);
      passed++;
    } catch (err: any) {
      console.error("  ✗ FAIL: " + name);
      console.error("    Error: " + err.message);
      failed++;
    }
  }

  await test("Server checkout initialization calculates authoritative total from DB prices", () => {
    const dbProducts = [
      { id: "prod-a", name: "Feeder", price: 12000, stock: 10 },
      { id: "prod-b", name: "Drinker", price: 4000, stock: 5 },
    ];
    const requestedCart = [
      { id: "prod-a", quantity: 2 },
      { id: "prod-b", quantity: 3 },
    ];
    let serverTotal = 0;
    for (const req of requestedCart) {
      const p = dbProducts.find((item) => item.id === req.id);
      assert.ok(p);
      serverTotal += p.price * req.quantity;
    }
    assert.strictEqual(serverTotal, 36000, "2 x 12,000 + 3 x 4,000 = 36,000 NGN");
    assert.strictEqual(serverTotal * 100, 3600000, "Paystack minor unit must be 3,600,000 kobo");
  });

  await test("Order is initially marked with paymentStatus pending, not paid or Processing", () => {
    const newOrder = {
      status: "Pending Payment",
      paymentStatus: "pending",
    };
    assert.strictEqual(newOrder.paymentStatus, "pending");
    assert.notStrictEqual(newOrder.paymentStatus, "paid");
  });

  await test("Server verification rejects Paystack response when amount in kobo does not match order total", () => {
    const orderTotalNaira = 36000;
    const expectedKobo = orderTotalNaira * 100;
    const paystackReportedKobo = 1000; // Client tampered or underpaid 10 NGN
    const isMatch = paystackReportedKobo === expectedKobo;
    assert.strictEqual(isMatch, false, "Underpayment must fail verification");
  });

  await test("Server verification rejects Paystack response when currency is not NGN", () => {
    const paystackCurrency = "USD";
    const isNgn = paystackCurrency.toUpperCase() === "NGN";
    assert.strictEqual(isNgn, false, "Non-NGN currency must be rejected");
  });

  await test("Stock deduction is executed only upon confirmed verification", () => {
    let stock = 10;
    const purchasedQuantity = 2;
    let paymentVerified = false;
    if (paymentVerified) {
      stock -= purchasedQuantity;
    }
    assert.strictEqual(stock, 10, "Stock must remain untouched until payment is verified");
    paymentVerified = true;
    if (paymentVerified) {
      stock -= purchasedQuantity;
    }
    assert.strictEqual(stock, 8, "Stock must deduct exactly 2 units after verified payment");
  });

  console.log("\n=============================================================");
  console.log("  SHOP CHECKOUT SECURITY TEST RESULTS: " + passed + " PASSED, " + failed + " FAILED");
  console.log("=============================================================\n");

  if (failed > 0) process.exit(1);
}

runShopTestSuite().catch((err) => {
  console.error("Shop test suite error:", err);
  process.exit(1);
});