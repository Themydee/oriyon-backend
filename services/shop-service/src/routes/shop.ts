import { Router, Request, Response } from "express";
import { eq, and, sql, or } from "drizzle-orm";
import { z } from "zod";
import { db } from "../index";
import { products, orders, orderItems } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// Validation Schemas
const checkoutSchema = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phone: z.string().min(1),
  address: z.string().min(1),
  totalAmount: z.number().positive(),
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      price: z.number(),
      quantity: z.number().int().positive(),
      image: z.string(),
    })
  ).min(1),
});

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

// POST /checkout
router.post("/checkout", async (req: Request, res: Response) => {
  const parsed = checkoutSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid checkout data", details: parsed.error.flatten() });
  }

  const { firstName, lastName, email, phone, address, totalAmount, items } = parsed.data;
  const paymentRef = `OR-SHOP-${Date.now()}-${Math.floor(Math.random() * 1000)}`;

  try {
    // Perform order saving and stock update in a transaction
    const newOrder = await db.transaction(async (tx) => {
      // 1. Create order
      const [order] = await tx
        .insert(orders)
        .values({
          ref: paymentRef,
          customerName: `${firstName} ${lastName}`,
          email,
          phone,
          address,
          total: totalAmount,
          status: "Processing",
        })
        .returning();

      // 2. Insert order items & check stock
      for (const item of items) {
        await tx.insert(orderItems).values({
          orderId: order.id,
          productId: item.id,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
        });

        // Try updating stock if it is a registered UUID product
        try {
          await tx
            .update(products)
            .set({ stock: sql`${products.stock} - ${item.quantity}` })
            .where(eq(products.id, item.id));
        } catch (e) {
          // Skip stock update silently if the product ID was mock/pre-seeded string
        }
      }

      return order;
    });

    // 3. Publish event for notifications-service
    try {
      await publishEvent("shop.order_placed", {
        orderId: newOrder.id,
        ref: newOrder.ref,
        email,
        customerName: newOrder.customerName,
        total: newOrder.total,
        items: items.map((i) => ({ name: i.name, quantity: i.quantity, price: i.price })),
      });
    } catch (e) {
      console.error("[shop-service] Failed to publish order event:", e);
    }

    return res.status(201).json({ success: true, reference: paymentRef, orderId: newOrder.id });
  } catch (err) {
    console.error("[shop-service] checkout error:", err);
    return res.status(500).json({ error: "Failed to process checkout transaction" });
  }
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
