import crypto from "crypto";
import { Router, Request, Response } from "express";
import { eq, and, sql, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { products, orders, orderItems } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// Validation Schemas
const initializeCheckoutSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Valid email address is required"),
  phone: z.string().min(1, "Phone number is required"),
  address: z.string().min(1, "Delivery address is required"),
  items: z.array(
    z.object({
      id: z.string().min(1),
      quantity: z.number().int().positive(),
    })
  ).min(1, "Cart must contain at least one product"),
});

const verifyCheckoutSchema = z.object({
  reference: z.string().min(1, "Payment reference is required"),
});

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || "";

const productSchema = z.object({
  name: z.string().min(1),
  price: z.number().positive(),
  image: z.string().url(),
  description: z.string().min(1),
  category: z.string().min(1),
  stock: z.number().int().nonnegative().optional().default(100),
});

// ─────────────────────────────────────────────
// PUBLIC ENDPOINTS
// ─────────────────────────────────────────────

// GET /products
router.get("/products", async (req: Request, res: Response) => {
  const category = req.query.category as string;
  const search = req.query.search as string;

  try {
    let query = db.select().from(products).where(eq(products.isActive, true));

    const conds = [eq(products.isActive, true)];

    if (category && category !== "All") {
      conds.push(eq(products.category, category));
    }

    if (search) {
      conds.push(
        or(
          sql`LOWER(${products.name}) LIKE ${"%" + search.toLowerCase() + "%"}`,
          sql`LOWER(${products.description}) LIKE ${"%" + search.toLowerCase() + "%"}`
        ) as any
      );
    }

    const list = await db
      .select()
      .from(products)
      .where(and(...conds))
      .orderBy(products.name);

    return res.json(list);
  } catch (err) {
    console.error("[shop-service] fetch products error:", err);
    return res.status(500).json({ error: "Failed to fetch products" });
  }
});

// GET /products/:id
router.get("/products/:id", async (req: Request, res: Response) => {
  try {
    const [item] = await db
      .select()
      .from(products)
      .where(eq(products.id, req.params.id))
      .limit(1);

    if (!item) {
      return res.status(404).json({ error: "Product not found" });
    }
    return res.json(item);
  } catch (err) {
    console.error("[shop-service] fetch product detail error:", err);
    return res.status(500).json({ error: "Failed to fetch product details" });
  }
});

// ─────────────────────────────────────────────
// POST /checkout/initialize
// Server-authoritative checkout initialization & pricing validation
// ─────────────────────────────────────────────
router.post("/checkout/initialize", async (req: Request, res: Response) => {
  const parsed = initializeCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid checkout request", details: parsed.error.flatten() });
  }

  const { firstName, lastName, email, phone, address, items: requestedItems } = parsed.data;

  try {
    let serverCalculatedTotal = 0;
    const validatedItems: { id: string; name: string; price: number; quantity: number }[] = [];

    // 1. Authoritatively validate each product and calculate server total
    for (const item of requestedItems) {
      const [product] = await db
        .select()
        .from(products)
        .where(and(eq(products.id, item.id), eq(products.isActive, true)))
        .limit(1);

      if (!product) {
        return res.status(400).json({ error: `Product ${item.id} not found or is currently unavailable.` });
      }

      if (product.stock < item.quantity) {
        return res.status(400).json({
          error: `Insufficient stock for product "${product.name}". Available: ${product.stock}, requested: ${item.quantity}.`,
        });
      }

      serverCalculatedTotal += product.price * item.quantity;
      validatedItems.push({
        id: product.id,
        name: product.name,
        price: product.price,
        quantity: item.quantity,
      });
    }

    if (serverCalculatedTotal <= 0) {
      return res.status(400).json({ error: "Order total must be greater than zero." });
    }

    // 2. Generate unique server reference
    const paymentRef = `OR-SHOP-${Date.now()}-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;

    // 3. Create order record with pending payment status
    const newOrder = await db.transaction(async (tx) => {
      const [order] = await tx
        .insert(orders)
        .values({
          ref: paymentRef,
          customerName: `${firstName} ${lastName}`,
          email,
          phone,
          address,
          total: serverCalculatedTotal,
          status: "Pending Payment",
          paymentStatus: "pending",
          paymentReference: paymentRef,
        })
        .returning();

      for (const vItem of validatedItems) {
        await tx.insert(orderItems).values({
          orderId: order.id,
          productId: vItem.id,
          name: vItem.name,
          price: vItem.price,
          quantity: vItem.quantity,
        });
      }

      return order;
    });

    const paystackAmountKobo = serverCalculatedTotal * 100;
    const secretKey = PAYSTACK_SECRET_KEY;

    // Check if test bypass or mock mode
    if (!secretKey || secretKey.includes("mockkey")) {
      console.log("[Mock Paystack] Bypassing shop initialization API call...");
      return res.json({
        authorization_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/checkout/callback?reference=${paymentRef}`,
        reference: paymentRef,
        totalAmount: serverCalculatedTotal,
        orderId: newOrder.id,
      });
    }

    // 4. Initialize transaction with Paystack API
    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: paystackAmountKobo,
        reference: paymentRef,
        callback_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/checkout/callback`,
        metadata: {
          category: "shop_order",
          orderRef: paymentRef,
          customerName: `${firstName} ${lastName}`,
          phone,
        },
      }),
    });

    const paystackJson = (await paystackRes.json()) as any;
    if (!paystackRes.ok) {
      console.error("[shop-service] Paystack initialization error:", paystackJson);
      return res.status(502).json({ error: "Failed to initialize checkout with transaction provider." });
    }

    return res.json({
      authorization_url: paystackJson.data?.authorization_url,
      reference: paymentRef,
      totalAmount: serverCalculatedTotal,
      orderId: newOrder.id,
    });
  } catch (err: any) {
    console.error("[shop-service] Checkout initialization error:", err);
    return res.status(500).json({ error: "Internal error during checkout initialization." });
  }
});

// ─────────────────────────────────────────────
// POST /checkout/verify
// Server-side Paystack verification & atomic inventory deduction
// ─────────────────────────────────────────────
router.post("/checkout/verify", async (req: Request, res: Response) => {
  const parsed = verifyCheckoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Payment reference is required." });
  }

  const { reference } = parsed.data;

  try {
    const [order] = await db
      .select()
      .from(orders)
      .where(or(eq(orders.paymentReference, reference), eq(orders.ref, reference)))
      .limit(1);

    if (!order) {
      return res.status(404).json({ error: "Order record not found." });
    }

    // Idempotent return if already paid
    if (order.paymentStatus === "paid") {
      return res.json({
        status: "success",
        alreadyConfirmed: true,
        reference: order.ref,
        orderId: order.id,
        total: order.total,
      });
    }

    const secretKey = PAYSTACK_SECRET_KEY;
    if (!secretKey) {
      return res.status(500).json({ error: "Payment verification configuration error." });
    }

    let paystackData: any;

    if (secretKey.includes("mockkey")) {
      console.log("[Mock Paystack] Auto-approving shop verification...");
      paystackData = {
        status: "success",
        id: "mock-txn-" + Date.now(),
        amount: order.total * 100,
        currency: "NGN",
        paid_at: new Date().toISOString(),
      };
    } else {
      const paystackRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const paystackJson = (await paystackRes.json()) as any;
      if (!paystackRes.ok || !paystackJson.data) {
        return res.status(400).json({ error: "Failed to verify transaction with payment provider." });
      }
      paystackData = paystackJson.data;
    }

    if (paystackData.status === "success") {
      // Validate amount integrity in minor unit (kobo)
      if (Number(paystackData.amount) !== Number(order.total * 100)) {
        console.error(
          `[SECURITY ALERT] Shop order amount mismatch for ref ${reference}: Expected ${order.total * 100}, got ${paystackData.amount}`
        );
        return res.status(400).json({ error: "Payment verification failed: Amount mismatch." });
      }

      // Validate currency
      if (paystackData.currency?.toUpperCase() !== "NGN") {
        console.error(
          `[SECURITY ALERT] Shop order currency mismatch for ref ${reference}: Expected NGN, got ${paystackData.currency}`
        );
        return res.status(400).json({ error: "Payment verification failed: Currency mismatch." });
      }

      const paidAt = new Date(paystackData.paid_at || Date.now());

      // Atomically update order status and decrement stock in transaction
      await db.transaction(async (tx) => {
        await tx
          .update(orders)
          .set({
            status: "Processing",
            paymentStatus: "paid",
            paystackTransactionId: String(paystackData.id),
            paidAt,
            metadata: paystackData,
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id));

        const itemsList = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
        for (const item of itemsList) {
          try {
            await tx
              .update(products)
              .set({ stock: sql`${products.stock} - ${item.quantity}` })
              .where(eq(products.id, item.productId));
          } catch (e) {
            // Ignore for seeded non-uuid ids
          }
        }
      });

      // Publish event for notifications-service
      try {
        const itemsList = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
        await publishEvent("shop.order_placed", {
          orderId: order.id,
          ref: order.ref,
          email: order.email,
          customerName: order.customerName,
          total: order.total,
          items: itemsList.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
        });
      } catch (e) {
        console.error("[shop-service] Failed to publish order event:", e);
      }

      return res.json({
        status: "success",
        reference: order.ref,
        orderId: order.id,
        total: order.total,
      });
    } else {
      await db
        .update(orders)
        .set({
          status: "Payment Failed",
          paymentStatus: "failed",
          metadata: paystackData,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      return res.status(400).json({ error: "Payment was not completed successfully." });
    }
  } catch (err: any) {
    console.error("[shop-service] verify error:", err);
    return res.status(500).json({ error: "Failed to process payment verification." });
  }
});

// ─────────────────────────────────────────────
// POST /orders/:ref/mark-paid
// Internal webhook fulfilment endpoint (called by central payments dispatcher)
// ─────────────────────────────────────────────
router.post("/orders/:ref/mark-paid", async (req: Request, res: Response) => {
  const reference = req.params.ref.trim();
  const { paystackTransactionId, paidAt } = req.body;

  try {
    const [order] = await db
      .select()
      .from(orders)
      .where(or(eq(orders.paymentReference, reference), eq(orders.ref, reference)))
      .limit(1);

    if (!order) {
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.paymentStatus === "paid") {
      return res.json({ status: "already_paid", orderId: order.id });
    }

    // Atomically mark paid and decrement stock
    await db.transaction(async (tx) => {
      await tx
        .update(orders)
        .set({
          status: "Processing",
          paymentStatus: "paid",
          paystackTransactionId: String(paystackTransactionId || ""),
          paidAt: paidAt ? new Date(paidAt) : new Date(),
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id));

      const itemsList = await tx.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      for (const item of itemsList) {
        try {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} - ${item.quantity}` })
            .where(eq(products.id, item.productId));
        } catch (e) {
          // Ignore for non-uuid
        }
      }
    });

    // Publish event for notifications-service
    try {
      const itemsList = await db.select().from(orderItems).where(eq(orderItems.orderId, order.id));
      await publishEvent("shop.order_placed", {
        orderId: order.id,
        ref: order.ref,
        email: order.email,
        customerName: order.customerName,
        total: order.total,
        items: itemsList.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      });
    } catch (e) {
      console.error("[shop-service mark-paid] Failed to publish order event:", e);
    }

    return res.json({ success: true, orderId: order.id });
  } catch (err: any) {
    console.error("[shop-service mark-paid error]:", err);
    return res.status(500).json({ error: "Internal error updating order payment status." });
  }
});

// Deprecated direct unverified POST /checkout (Reject unverified submissions)
router.post("/checkout", (_req: Request, res: Response) => {
  return res.status(400).json({
    error: "Direct unverified checkout is deprecated and disabled for security. Please use /checkout/initialize and /checkout/verify.",
  });
});

// GET /orders/:ref
router.get("/orders/:ref", async (req: Request, res: Response) => {
  const reference = req.params.ref.trim().toUpperCase();

  try {
    const [order] = await db
      .select()
      .from(orders)
      .where(eq(sql`UPPER(${orders.ref})`, reference))
      .limit(1);

    if (!order) {
      return res.status(404).json({ error: "Order not found" });
    }

    const itemsList = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id));

    return res.json({
      ...order,
      items: itemsList.map((i) => ({
        id: i.productId,
        name: i.name,
        price: i.price,
        quantity: i.quantity,
      })),
    });
  } catch (err) {
    console.error("[shop-service] fetch order error:", err);
    return res.status(500).json({ error: "Failed to fetch order status" });
  }
});

// ─────────────────────────────────────────────
// PROTECTED / ADMIN ENDPOINTS (Headers checked)
// ─────────────────────────────────────────────

// Helper middleware to check for admin role from header
const requireAdmin = (req: Request, res: Response, next: any) => {
  const role = req.headers["x-user-role"] as string;
  if (role !== "admin") {
    return res.status(403).json({ error: "Forbidden — admin only" });
  }
  next();
};

// GET /admin/orders
router.get("/admin/orders", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const list = await db.select().from(orders).orderBy(sql`${orders.date} DESC`);
    
    // Stitch items details
    const populated = [];
    for (const order of list) {
      const itemsList = await db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      populated.push({
        ...order,
        items: itemsList.map((i) => ({
          id: i.productId,
          name: i.name,
          price: i.price,
          quantity: i.quantity,
        })),
      });
    }

    return res.json(populated);
  } catch (err) {
    console.error("[shop-service] fetch admin orders error:", err);
    return res.status(500).json({ error: "Failed to fetch admin orders" });
  }
});

// PATCH /admin/orders/:id/status
router.patch("/admin/orders/:id/status", requireAdmin, async (req: Request, res: Response) => {
  const statusSchema = z.object({
    status: z.enum(["Processing", "In Transit", "Delivered"]),
  });

  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { status } = parsed.data;

  try {
    const [updated] = await db
      .update(orders)
      .set({ status, updatedAt: new Date() })
      .where(eq(orders.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Order not found" });
    }

    // Publish event
    try {
      await publishEvent("shop.order_updated", {
        orderId: updated.id,
        ref: updated.ref,
        email: updated.email,
        customerName: updated.customerName,
        status: updated.status,
      });
    } catch (e) {
      console.error("[shop-service] Failed to publish order update event:", e);
    }

    return res.json(updated);
  } catch (err) {
    console.error("[shop-service] update order status error:", err);
    return res.status(500).json({ error: "Failed to update order status" });
  }
});

// POST /admin/products
router.post("/admin/products", requireAdmin, async (req: Request, res: Response) => {
  const parsed = productSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [newProduct] = await db
      .insert(products)
      .values(parsed.data)
      .returning();
    return res.status(201).json(newProduct);
  } catch (err) {
    console.error("[shop-service] create product error:", err);
    return res.status(500).json({ error: "Failed to create product" });
  }
});

// PATCH /admin/products/:id
router.patch("/admin/products/:id", requireAdmin, async (req: Request, res: Response) => {
  const updateSchema = productSchema.partial();
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [updated] = await db
      .update(products)
      .set({ ...parsed.data, updatedAt: new Date() })
      .where(eq(products.id, req.params.id))
      .returning();

    if (!updated) {
      return res.status(404).json({ error: "Product not found" });
    }
    return res.json(updated);
  } catch (err) {
    console.error("[shop-service] update product error:", err);
    return res.status(500).json({ error: "Failed to update product" });
  }
});

// GET /admin/stats
router.get("/admin/stats", requireAdmin, async (_req: Request, res: Response) => {
  try {
    const allOrders = await db.select().from(orders);
    const allProducts = await db.select().from(products);

    const totalRevenue = allOrders.reduce((acc, o) => acc + o.total, 0);
    const totalOrders = allOrders.length;
    const activeOrders = allOrders.filter((o) => o.status !== "Delivered").length;
    const completedDeliveries = allOrders.filter((o) => o.status === "Delivered").length;

    return res.json({
      totalRevenue,
      totalOrders,
      activeOrders,
      completedDeliveries,
      totalProducts: allProducts.length,
    });
  } catch (err) {
    console.error("[shop-service] fetch stats error:", err);
    return res.status(500).json({ error: "Failed to calculate stats" });
  }
});

export default router;
