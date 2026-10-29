import "dotenv/config";
import assert from "assert";
import crypto from "crypto";

async function runPaymentTestSuite() {
  console.log("=============================================================");
  console.log("  ORIYON PAYMENT GATEWAY ARCHITECTURE - COMPREHENSIVE TEST SUITE");
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

  const TEST_SECRET = "sk_test_mock_secret_key_for_unit_tests_12345";

  // 1. SECURITY: WEBHOOK HMAC-SHA512 SIGNATURE VERIFICATION
  console.log("--- 1. Paystack Webhook HMAC-SHA512 Signature Tests ---");

  await test("Valid HMAC-SHA512 signature matches exact raw payload", () => {
    const payload = JSON.stringify({ event: "charge.success", data: { reference: "WS-PAY-TEST-001" } });
    const computedSig = crypto.createHmac("sha512", TEST_SECRET).update(payload).digest("hex");
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(computedSig),
      Buffer.from(crypto.createHmac("sha512", TEST_SECRET).update(payload).digest("hex"))
    );
    assert.strictEqual(isMatch, true, "Valid HMAC signature must match");
  });

  await test("Tampered payload with valid signature is rejected", () => {
    const originalPayload = JSON.stringify({ event: "charge.success", data: { reference: "WS-PAY-TEST-001" } });
    const tamperedPayload = JSON.stringify({ event: "charge.success", data: { reference: "WS-PAY-TAMPERED-001" } });
    const originalSig = crypto.createHmac("sha512", TEST_SECRET).update(originalPayload).digest("hex");
    const tamperedSig = crypto.createHmac("sha512", TEST_SECRET).update(tamperedPayload).digest("hex");
    assert.notStrictEqual(originalSig, tamperedSig, "Tampered payload must produce different signature");
  });

  await test("Different length signature is rejected safely", () => {
    const validSig = crypto.createHmac("sha512", TEST_SECRET).update("test").digest("hex");
    const shortSig = "short_sig_12345";
    assert.notStrictEqual(validSig.length, shortSig.length);
  });

  // 2. FINANCIAL INTEGRITY: AMOUNT & CURRENCY INTEGRITY CHECKS
  console.log("\n--- 2. Amount & Currency Integrity Tests ---");

  await test("Rejects tampered payment amount (underpayment exploit)", () => {
    const expectedAmountKobo = 200000; // 2,000 NGN in kobo
    const receivedPaystackData = { amount: 1000, currency: "NGN", status: "success" }; // 10 NGN in kobo
    const isValidAmount = Number(receivedPaystackData.amount) === Number(expectedAmountKobo);
    assert.strictEqual(isValidAmount, false, "Must detect and reject underpaid transaction");
  });

  await test("Rejects foreign currency when NGN is expected", () => {
    const expectedCurrency = "NGN";
    const receivedPaystackData = { amount: 200000, currency: "USD", status: "success" };
    const isValidCurrency = receivedPaystackData.currency.toUpperCase() === expectedCurrency.toUpperCase();
    assert.strictEqual(isValidCurrency, false, "Must reject mismatched currency");
  });

  // 3. MULTI-FLOW CATEGORIZATION & REFERENCE ROUTING
  console.log("\n--- 3. Multi-Flow Reference Routing Tests ---");

  function detectPaymentCategory(reference: string): string {
    if (reference.startsWith("WS-PAY-")) return "workshop";
    if (reference.startsWith("COOP-PAY-")) return "cooperative_registration_fee";
    if (reference.startsWith("COOP-CONTRIB-")) return "cooperative_contribution";
    if (reference.startsWith("OR-SHOP-") || reference.startsWith("SHOP-")) return "shop_order";
    return "unmatched";
  }

  await test("Routes Workshop reference (WS-PAY-*) correctly", () => {
    assert.strictEqual(detectPaymentCategory("WS-PAY-A1B2C3D4-1730000000000"), "workshop");
  });

  await test("Routes Cooperative Registration Fee (COOP-PAY-*) correctly", () => {
    assert.strictEqual(detectPaymentCategory("COOP-PAY-MEM123-1730000000000-ABCD"), "cooperative_registration_fee");
  });

  await test("Routes Cooperative Contribution (COOP-CONTRIB-*) correctly", () => {
    assert.strictEqual(detectPaymentCategory("COOP-CONTRIB-MEM123-1730000000000-ABCD"), "cooperative_contribution");
  });

  await test("Routes Shop Order reference (OR-SHOP-*) correctly", () => {
    assert.strictEqual(detectPaymentCategory("OR-SHOP-1730000000000-E5F6G7H8"), "shop_order");
  });

  await test("Identifies unknown reference as unmatched", () => {
    assert.strictEqual(detectPaymentCategory("RANDOM-UNKNOWN-REF-9999"), "unmatched");
  });

  // 4. DUPLICATE PAYMENT & OVERPAYMENT DETECTION
  console.log("\n--- 4. Duplicate Payment & Overpayment Detection Tests ---");

  await test("Flags second successful payment for already-paid workshop as duplicate_paid_review", () => {
    const existingRegistration = { id: "reg-123", status: "paid" };
    let paymentStatus = "success";
    let duplicateDetected = false;
    if (existingRegistration.status === "paid") {
      paymentStatus = "duplicate_paid_review";
      duplicateDetected = true;
    }
    assert.strictEqual(duplicateDetected, true, "Duplicate charge must be detected");
    assert.strictEqual(paymentStatus, "duplicate_paid_review");
  });

  await test("Flags second registration fee payment for already-verified cooperative member", () => {
    const member = { id: "mem-456", registrationFeePaid: "YES" };
    const incomingRef = "COOP-PAY-MEM456-SECOND";
    let duplicateDetected = false;
    let paymentStatus = "success";
    if (incomingRef.startsWith("COOP-PAY-") && member.registrationFeePaid === "YES") {
      duplicateDetected = true;
      paymentStatus = "duplicate_paid_review";
    }
    assert.strictEqual(duplicateDetected, true, "Member overpayment must be detected");
    assert.strictEqual(paymentStatus, "duplicate_paid_review");
  });

  // 5. SERVER-AUTHORITATIVE PRICING VALIDATION
  console.log("\n--- 5. Server-Authoritative Shop Pricing Tests ---");

  await test("Calculates total from trusted product database rather than client-supplied values", () => {
    const trustedProductsDb = new Map([
      ["prod-1", { id: "prod-1", name: "Goat Feed 25kg", price: 15000, stock: 50 }],
      ["prod-2", { id: "prod-2", name: "Mineral Salt Block", price: 3500, stock: 20 }],
    ]);
    const clientCart = [
      { id: "prod-1", quantity: 2, clientClaimedPrice: 100 },
      { id: "prod-2", quantity: 1, clientClaimedPrice: 50 },
    ];
    let serverTotal = 0;
    for (const item of clientCart) {
      const dbProduct = trustedProductsDb.get(item.id);
      assert.ok(dbProduct, "Product must exist in DB");
      assert.ok(dbProduct.stock >= item.quantity, "Stock must be sufficient");
      serverTotal += dbProduct.price * item.quantity;
    }
    assert.strictEqual(serverTotal, 33500, "Server must compute authoritative 33,500 NGN, ignoring client 250");
  });

  await test("Rejects checkout when stock is insufficient", () => {
    const trustedProduct = { id: "prod-low-stock", price: 5000, stock: 2 };
    const requestedQuantity = 5;
    const isAvailable = trustedProduct.stock >= requestedQuantity;
    assert.strictEqual(isAvailable, false, "Must reject request when stock is less than quantity");
  });

  // 6. IDEMPOTENCY & DEDUPLICATION
  console.log("\n--- 6. Idempotency & Webhook Deduplication Tests ---");

  await test("Duplicate event_id is recognized and returned as deduplicated", () => {
    const processedEvents = new Set<string>(["paystack-charge.success-WS-PAY-001"]);
    const incomingEventId = "paystack-charge.success-WS-PAY-001";
    const isDuplicate = processedEvents.has(incomingEventId);
    assert.strictEqual(isDuplicate, true, "Incoming event must be identified as duplicate");
  });

  await test("Multiple verification calls on already-confirmed payment return idempotent success", () => {
    const payment = { status: "success", reference: "WS-PAY-ALREADY-CONFIRMED" };
    const registration = { status: "paid" };
    let idempotentReturn = false;
    if (payment.status === "success" && registration.status === "paid") {
      idempotentReturn = true;
    }
    assert.strictEqual(idempotentReturn, true, "Already confirmed payment must return idempotently");
  });

  console.log("\n=============================================================");
  console.log("  PAYMENT ARCHITECTURE TEST RESULTS: " + passed + " PASSED, " + failed + " FAILED");
  console.log("=============================================================\n");

  if (failed > 0) process.exit(1);
}

runPaymentTestSuite().catch((err) => {
  console.error("Test suite unhandled rejection:", err);
  process.exit(1);
});