import { Router, Request, Response } from "express";
import { eq, count, and } from "drizzle-orm";
import { z } from "zod";
import axios from "axios";
import { db } from "../index";
import { cooperativeMembers, applications, cooperatives, cooperativePayments } from "../db/schema";
import { publishEvent } from "../rabbitmq";

const router = Router();

// ─────────────────────────────────────────────
// GET /cooperative
// Public — list all cooperatives (or dynamic list)
// ─────────────────────────────────────────────
router.get("/", async (_req: Request, res: Response) => {
  try {
    const list = await db
      .select()
      .from(cooperatives)
      .orderBy(cooperatives.name);
    return res.json(list);
  } catch (err) {
    console.error("[cooperative] fetch cooperatives error:", err);
    return res.status(500).json({ error: "Failed to fetch cooperatives list" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative
// Admin only — create a new cooperative
// ─────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  const schema = z.object({
    name: z.string().min(1, "Name is required"),
    state: z.string().min(1, "State is required"),
    description: z.string().optional().nullable(),
    locationId: z.string().optional().nullable(),
    regionId: z.string().optional().nullable(),
    zone: z.string().optional().nullable(),
    lga: z.string().optional().nullable(),
    isActive: z.boolean().optional().default(true),
    whatsappLink: z.string().optional().nullable(),
    registrationFee: z.number().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [newCoop] = await db
      .insert(cooperatives)
      .values(parsed.data)
      .returning();

    return res.status(201).json(newCoop);
  } catch (err: any) {
    console.error("[cooperative] create error:", err);
    if (err.code === "23505") { // unique violation code in PG
      return res.status(409).json({ error: "A cooperative with this name already exists" });
    }
    return res.status(500).json({ error: "Failed to create cooperative" });
  }
});

// ─────────────────────────────────────────────
// DELETE /cooperative/:id
// Admin only — delete a cooperative
// ─────────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    // Check if there are members assigned to it first
    const [memberCount] = await db
      .select({ count: count() })
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.cooperativeId, req.params.id));

    if (Number(memberCount.count) > 0) {
      return res.status(400).json({
        error: "Cannot delete this cooperative because it has registered members associated with it.",
      });
    }

    const [deleted] = await db
      .delete(cooperatives)
      .where(eq(cooperatives.id, req.params.id))
      .returning();

    if (!deleted) {
      return res.status(404).json({ error: "Cooperative not found" });
    }

    return res.json({ message: "Cooperative deleted successfully", deleted });
  } catch (err) {
    console.error("[cooperative] delete error:", err);
    return res.status(500).json({ error: "Failed to delete cooperative" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative/payment/initialize
// Initialize transaction with Paystack
// ─────────────────────────────────────────────
router.post("/payment/initialize", async (req: Request, res: Response) => {
  const schema = z.object({
    memberId: z.string().uuid("Invalid Member ID"),
    paymentType: z.enum(["registration", "contribution"]).optional().default("registration"),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { memberId, paymentType } = parsed.data;

  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, memberId))
      .limit(1);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (!member.cooperativeId) {
      return res.status(400).json({ error: "Member is not linked to any cooperative" });
    }

    let feeAmount = 2000;
    let reference = "";

    if (paymentType === "contribution") {
      let contribAmount = 2000; // Default lock to 2000 as requested
      if (member.monthlyContributionAmount) {
        const parsedAmount = parseInt(member.monthlyContributionAmount.replace(/[^0-9]/g, ""), 10);
        if (!isNaN(parsedAmount) && parsedAmount > 0) {
          contribAmount = parsedAmount;
        }
      }
      feeAmount = contribAmount;
      reference = `COOP-CONTRIB-${memberId}-${Date.now()}`;
    } else {
      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);
      feeAmount = coop?.registrationFee || 2000;
      reference = `COOP-PAY-${memberId}-${Date.now()}`;
    }

    const paystackAmount = feeAmount * 100; // in kobo

    // Log the transaction in the database
    await db.insert(cooperativePayments).values({
      memberId: member.id,
      amount: paystackAmount,
      reference,
      status: "pending",
    });

    const secretKey = process.env.PAYSTACK_SECRET_KEY || "sk_test_mockkey123";

    if (!process.env.PAYSTACK_SECRET_KEY || secretKey === "sk_test_mockkey123") {
      console.log("[Mock Paystack] Bypassing initialization call...");
      return res.json({
        authorization_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/cooperative/payment-callback?reference=${reference}`,
        reference,
        amount: feeAmount,
      });
    }

    const paystackResponse = await axios.post(
      "https://api.paystack.co/transaction/initialize",
      {
        email: member.email || "support@oriyoninternational.com",
        amount: paystackAmount,
        reference,
        callback_url: `${process.env.FRONTEND_URL || "http://localhost:3000"}/cooperative/payment-callback`,
      },
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/json",
        },
      }
    );

    return res.json({
      authorization_url: paystackResponse.data.data.authorization_url,
      reference,
      amount: feeAmount,
    });
  } catch (error: any) {
    console.error("Payment initialization error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to initialize payment with transaction provider" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative/payment/verify
// Verify payment and fetch WhatsApp link
// ─────────────────────────────────────────────
router.post("/payment/verify", async (req: Request, res: Response) => {
  const schema = z.object({
    reference: z.string().min(1, "Reference is required"),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const { reference } = parsed.data;

  try {
    const [payment] = await db
      .select()
      .from(cooperativePayments)
      .where(eq(cooperativePayments.reference, reference))
      .limit(1);

    if (!payment) {
      return res.status(404).json({ error: "Payment record not found" });
    }

    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, payment.memberId))
      .limit(1);

    if (!member || !member.cooperativeId) {
      return res.status(400).json({ error: "Member details invalid or missing cooperative ID" });
    }

    if (payment.status === "success") {
      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);

      return res.json({
        status: "success",
        whatsappLink: coop?.whatsappLink || "https://chat.whatsapp.com/default-placeholder-link",
      });
    }

    const secretKey = process.env.PAYSTACK_SECRET_KEY || "sk_test_f9e5be53d3b65af77fc8a7ab5d829e11dbd2e831";

    if (!process.env.PAYSTACK_SECRET_KEY || secretKey === "sk_test_f9e5be53d3b65af77fc8a7ab5d829e11dbd2e831") {
      console.log("[Mock Paystack] Bypassing verify API call, auto-approving transaction...");
      
      await db
        .update(cooperativePayments)
        .set({
          status: "success",
          metadata: { mock: true, verifiedAt: new Date() },
          updatedAt: new Date(),
        })
        .where(eq(cooperativePayments.id, payment.id));

      if (reference.startsWith("COOP-PAY-")) {
        await db
          .update(cooperativeMembers)
          .set({
            registrationFeePaid: "YES",
            updatedAt: new Date(),
          })
          .where(eq(cooperativeMembers.id, payment.memberId));

        // Publish event so user-service can auto-provision account if cooperative-only
        await publishEvent("cooperative.payment_verified", {
          memberId: member.id,
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          phone: member.phone,
          lga: member.lga,
        });
      }

      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);

      return res.json({
        status: "success",
        whatsappLink: coop?.whatsappLink || "https://chat.whatsapp.com/default-placeholder-link",
      });
    }

    // Call Paystack verification endpoint
    const paystackResponse = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );

    const data = paystackResponse.data.data;

    if (data.status === "success") {
      // 1. Update payment status in db
      await db
        .update(cooperativePayments)
        .set({
          status: "success",
          metadata: data,
          updatedAt: new Date(),
        })
        .where(eq(cooperativePayments.id, payment.id));

      if (reference.startsWith("COOP-PAY-")) {
        // 2. Update registration status in cooperativeMembers table
        await db
          .update(cooperativeMembers)
          .set({
            registrationFeePaid: "YES", // Match the varchar representation ("YES") in DB
            updatedAt: new Date(),
          })
          .where(eq(cooperativeMembers.id, payment.memberId));

        // Publish event so user-service can auto-provision account if cooperative-only
        await publishEvent("cooperative.payment_verified", {
          memberId: member.id,
          email: member.email,
          firstName: member.firstName,
          lastName: member.lastName,
          phone: member.phone,
          lga: member.lga,
        });
      }

      // 3. Fetch linked WhatsApp group link
      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);

      return res.json({
        status: "success",
        whatsappLink: coop?.whatsappLink || "https://chat.whatsapp.com/default-placeholder-link",
      });
    } else {
      // Update as failed if paystack reports it failed
      if (data.status === "failed") {
        await db
          .update(cooperativePayments)
          .set({
            status: "failed",
            metadata: data,
            updatedAt: new Date(),
          })
          .where(eq(cooperativePayments.id, payment.id));
      }

      return res.json({
        status: data.status,
        message: "Payment verification failed or pending",
      });
    }
  } catch (error: any) {
    console.error("Payment verification error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Failed to verify transaction status" });
  }
});

// ─────────────────────────────────────────────
// POST /cooperative/join
// Called automatically after EEWYLA application is submitted.
// Public — no auth required.
// Body: { applicationId }
// ─────────────────────────────────────────────
router.post("/join", async (req: Request, res: Response) => {
  const schema = z.object({
    applicationId: z.string().uuid().optional().nullable(),
    cooperativeId: z.string().uuid().optional().nullable(),
    firstName: z.string().optional().nullable(),
    lastName: z.string().optional().nullable(),
    email: z.string().email().optional().nullable().or(z.literal("")),
    phone: z.string().min(1, "Phone number is required"),
    address: z.string().optional().nullable(),
    
    // New spreadsheet fields
    memberId: z.string().optional().nullable(),
    fullName: z.string().min(1, "Full Legal Name is required"),
    gender: z.string().optional().nullable(),
    dateOfBirth: z.string().optional().nullable(),
    lga: z.string().optional().nullable(),
    zoneCluster: z.string().optional().nullable(),
    locationId: z.string().optional().nullable(),
    regionId: z.string().optional().nullable(),
    occupation: z.string().optional().nullable(),
    livestockType: z.string().optional().nullable(),
    yearsOfExperience: z.string().optional().nullable(),
    idType: z.string().optional().nullable(),
    idNumber: z.string().optional().nullable(),
    nextOfKinName: z.string().optional().nullable(),
    nextOfKinPhone: z.string().optional().nullable(),
    registrationFeePaid: z.string().optional().nullable(),
    monthlyContributionAmount: z.string().optional().nullable(),
    attendanceCommitment: z.string().optional().nullable(),
    qualifiedForTraining: z.string().optional().nullable(),
    whatsappNumber: z.string().optional().nullable(),
    signature: z.string().optional().nullable(),
    remarks: z.string().optional().nullable(),
    
    agreesToConstitution: z.boolean().optional().default(false),
    willingToContribute: z.boolean().optional().default(false),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  const {
    applicationId,
    cooperativeId,
    firstName,
    lastName,
    email,
    phone,
    address,
    memberId,
    fullName,
    gender,
    dateOfBirth,
    lga,
    zoneCluster,
    locationId,
    regionId,
    occupation,
    livestockType,
    yearsOfExperience,
    idType,
    idNumber,
    nextOfKinName,
    nextOfKinPhone,
    registrationFeePaid,
    monthlyContributionAmount,
    attendanceCommitment,
    qualifiedForTraining,
    whatsappNumber,
    signature,
    remarks,
    agreesToConstitution,
    willingToContribute,
  } = parsed.data;

  try {
    // Resolve cooperative ID, default to Ibadan North if none specified (safeguard)
    let finalCooperativeId = cooperativeId;
    if (!finalCooperativeId) {
      const [defaultCoop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.name, "Ibadan North"))
        .limit(1);
      if (defaultCoop) {
        finalCooperativeId = defaultCoop.id;
      }
    }

    let finalFirstName = firstName;
    let finalLastName = lastName;
    
    if (!finalFirstName && !finalLastName && fullName) {
      const parts = fullName.trim().split(/\s+/);
      finalFirstName = parts[0] || "";
      finalLastName = parts.slice(1).join(" ") || "";
    }

    let memberData: any = {
      cooperativeId: finalCooperativeId ?? undefined,
      agreesToConstitution: agreesToConstitution ?? false,
      willingToContribute: willingToContribute ?? false,
      status: "active",
      
      memberId: memberId ?? undefined,
      fullName: fullName ?? undefined,
      gender: gender ?? undefined,
      dateOfBirth: dateOfBirth ?? undefined,
      lga: lga ?? undefined,
      zoneCluster: zoneCluster ?? undefined,
      locationId: locationId ?? undefined,
      regionId: regionId ?? undefined,
      occupation: occupation ?? undefined,
      livestockType: livestockType ?? undefined,
      yearsOfExperience: yearsOfExperience ?? undefined,
      idType: idType ?? undefined,
      idNumber: idNumber ?? undefined,
      nextOfKinName: nextOfKinName ?? undefined,
      nextOfKinPhone: nextOfKinPhone ?? undefined,
      registrationFeePaid: registrationFeePaid ?? undefined,
      monthlyContributionAmount: monthlyContributionAmount ?? undefined,
      attendanceCommitment: attendanceCommitment ?? undefined,
      qualifiedForTraining: qualifiedForTraining ?? undefined,
      whatsappNumber: whatsappNumber ?? undefined,
      signature: signature ?? undefined,
      remarks: remarks ?? undefined,
    };

    if (applicationId) {
      // Fetch the linked application
      const [application] = await db
        .select()
        .from(applications)
        .where(eq(applications.id, applicationId))
        .limit(1);

      if (!application) {
        return res.status(404).json({ error: "Application not found" });
      }

      memberData = {
        ...memberData,
        applicationId,
        firstName: application.firstName,
        lastName: application.lastName,
        email: application.email,
        phone: application.phone,
        address: application.address ?? undefined,
        fullName: memberData.fullName || `${application.firstName} ${application.lastName}`,
      };
    } else {
      if (!phone) {
        return res.status(400).json({ error: "Phone number is required for direct registration" });
      }
      memberData = {
        ...memberData,
        firstName: finalFirstName ?? undefined,
        lastName: finalLastName ?? undefined,
        email: email || undefined,
        phone,
        address: address ?? undefined,
      };
    }

    // Check if already a member of this cooperative (idempotent)
    const [existing] = await db
      .select()
      .from(cooperativeMembers)
      .where(
        and(
          memberData.email
            ? eq(cooperativeMembers.email, memberData.email)
            : eq(cooperativeMembers.phone, memberData.phone),
          finalCooperativeId 
            ? eq(cooperativeMembers.cooperativeId, finalCooperativeId)
            : eq(cooperativeMembers.agreesToConstitution, true) // fallback
        )
      )
      .limit(1);

    if (existing) {
      return res.json({
        message: "Already a cooperative member",
        member: existing,
      });
    }

    // Create the cooperative member record
    const [member] = await db
      .insert(cooperativeMembers)
      .values(memberData)
      .returning();

    // Fetch cooperative name for notification
    let cooperativeName = "EEWYLA Cooperative";
    if (member.cooperativeId) {
      const [coop] = await db
        .select()
        .from(cooperatives)
        .where(eq(cooperatives.id, member.cooperativeId))
        .limit(1);
      if (coop) {
        cooperativeName = coop.name;
      }
    }

    // Publish event so notifications-service sends the welcome email
    await publishEvent("cooperative.member_joined", {
      memberId: member.id,
      applicationId,
      email: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      cooperativeName,
      joinedAt: member.joinedAt.toISOString(),
    });

    return res.status(201).json({
      message: `Successfully joined ${cooperativeName}`,
      member,
    });
  } catch (err) {
    console.error("[cooperative] join error:", err);
    return res.status(500).json({ error: "Failed to join cooperative" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members
// Admin only — list all cooperative members
// ─────────────────────────────────────────────
router.get("/members", async (req: Request, res: Response) => {
  const role = req.headers["x-user-role"] as string;
  const assignedLga = req.headers["x-user-assigned-lga"] as string;
  const assignedState = req.headers["x-user-assigned-state"] as string;
  const assignedZone = req.headers["x-user-assigned-zone"] as string;

  try {
    const query = db
      .select({
        id: cooperativeMembers.id,
        applicationId: cooperativeMembers.applicationId,
        cooperativeId: cooperativeMembers.cooperativeId,
        cooperativeName: cooperatives.name,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        email: cooperativeMembers.email,
        phone: cooperativeMembers.phone,
        address: cooperativeMembers.address,
        
        memberId: cooperativeMembers.memberId,
        fullName: cooperativeMembers.fullName,
        gender: cooperativeMembers.gender,
        dateOfBirth: cooperativeMembers.dateOfBirth,
        lga: cooperativeMembers.lga,
        zoneCluster: cooperativeMembers.zoneCluster,
        locationId: cooperativeMembers.locationId,
        regionId: cooperativeMembers.regionId,
        occupation: cooperativeMembers.occupation,
        livestockType: cooperativeMembers.livestockType,
        yearsOfExperience: cooperativeMembers.yearsOfExperience,
        idType: cooperativeMembers.idType,
        idNumber: cooperativeMembers.idNumber,
        nextOfKinName: cooperativeMembers.nextOfKinName,
        nextOfKinPhone: cooperativeMembers.nextOfKinPhone,
        registrationFeePaid: cooperativeMembers.registrationFeePaid,
        monthlyContributionAmount: cooperativeMembers.monthlyContributionAmount,
        attendanceCommitment: cooperativeMembers.attendanceCommitment,
        qualifiedForTraining: cooperativeMembers.qualifiedForTraining,
        whatsappNumber: cooperativeMembers.whatsappNumber,
        signature: cooperativeMembers.signature,
        remarks: cooperativeMembers.remarks,
        
        agreesToConstitution: cooperativeMembers.agreesToConstitution,
        willingToContribute: cooperativeMembers.willingToContribute,
        status: cooperativeMembers.status,
        joinedAt: cooperativeMembers.joinedAt,
        updatedAt: cooperativeMembers.updatedAt,
      })
      .from(cooperativeMembers)
      .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id));

    let finalQuery = query;
    if (role === "coordinator") {
      const conds = [];
      if (assignedLga) {
        conds.push(eq(cooperativeMembers.lga, assignedLga));
      } else if (assignedState) {
        conds.push(eq(cooperatives.state, assignedState));
      } else if (assignedZone) {
        conds.push(eq(cooperatives.zone, assignedZone));
      }
      if (conds.length > 0) {
        finalQuery = finalQuery.where(and(...conds)) as any;
      }
    }

    const members = await finalQuery.orderBy(cooperativeMembers.joinedAt);

    return res.json(members);
  } catch (err) {
    console.error("[cooperative] fetch members error:", err);
    return res.status(500).json({ error: "Failed to fetch cooperative members" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/status/:status
// Admin/Coordinator — list cooperative members by status
// ─────────────────────────────────────────────
router.get("/members/status/:status", async (req: Request, res: Response) => {
  const { status } = req.params;
  const role = req.headers["x-user-role"] as string;
  const assignedLga = req.headers["x-user-assigned-lga"] as string;
  const assignedState = req.headers["x-user-assigned-state"] as string;
  const assignedZone = req.headers["x-user-assigned-zone"] as string;

  if (status !== "active" && status !== "inactive") {
    return res.status(400).json({ error: "Invalid status value" });
  }

  try {
    let conditions = [eq(cooperativeMembers.status, status)];
    if (role === "coordinator") {
      if (assignedLga) {
        conditions.push(eq(cooperativeMembers.lga, assignedLga));
      } else if (assignedState) {
        conditions.push(eq(cooperatives.state, assignedState));
      } else if (assignedZone) {
        conditions.push(eq(cooperatives.zone, assignedZone));
      }
    }

    const members = await db
      .select({
        id: cooperativeMembers.id,
        applicationId: cooperativeMembers.applicationId,
        cooperativeId: cooperativeMembers.cooperativeId,
        cooperativeName: cooperatives.name,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        email: cooperativeMembers.email,
        phone: cooperativeMembers.phone,
        address: cooperativeMembers.address,
        
        memberId: cooperativeMembers.memberId,
        fullName: cooperativeMembers.fullName,
        gender: cooperativeMembers.gender,
        dateOfBirth: cooperativeMembers.dateOfBirth,
        lga: cooperativeMembers.lga,
        zoneCluster: cooperativeMembers.zoneCluster,
        locationId: cooperativeMembers.locationId,
        regionId: cooperativeMembers.regionId,
        occupation: cooperativeMembers.occupation,
        livestockType: cooperativeMembers.livestockType,
        yearsOfExperience: cooperativeMembers.yearsOfExperience,
        idType: cooperativeMembers.idType,
        idNumber: cooperativeMembers.idNumber,
        nextOfKinName: cooperativeMembers.nextOfKinName,
        nextOfKinPhone: cooperativeMembers.nextOfKinPhone,
        registrationFeePaid: cooperativeMembers.registrationFeePaid,
        monthlyContributionAmount: cooperativeMembers.monthlyContributionAmount,
        attendanceCommitment: cooperativeMembers.attendanceCommitment,
        qualifiedForTraining: cooperativeMembers.qualifiedForTraining,
        whatsappNumber: cooperativeMembers.whatsappNumber,
        signature: cooperativeMembers.signature,
        remarks: cooperativeMembers.remarks,
        
        agreesToConstitution: cooperativeMembers.agreesToConstitution,
        willingToContribute: cooperativeMembers.willingToContribute,
        status: cooperativeMembers.status,
        joinedAt: cooperativeMembers.joinedAt,
        updatedAt: cooperativeMembers.updatedAt,
      })
      .from(cooperativeMembers)
      .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id))
      .where(and(...conditions))
      .orderBy(cooperativeMembers.joinedAt);

    return res.json(members);
  } catch (err) {
    console.error("[cooperative] fetch members by status error:", err);
    return res.status(500).json({ error: "Failed to fetch cooperative members by status" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/me
// Get the logged-in member's cooperative details
// ─────────────────────────────────────────────
router.get("/members/me", async (req: Request, res: Response) => {
  const email = req.headers["x-user-email"] as string;
  if (!email) {
    return res.status(400).json({ error: "Missing user email header" });
  }

  try {
    const [member] = await db
      .select({
        id: cooperativeMembers.id,
        cooperativeId: cooperativeMembers.cooperativeId,
        cooperativeName: cooperatives.name,
        whatsappLink: cooperatives.whatsappLink,
        registrationFee: cooperatives.registrationFee,
        firstName: cooperativeMembers.firstName,
        lastName: cooperativeMembers.lastName,
        email: cooperativeMembers.email,
        phone: cooperativeMembers.phone,
        lga: cooperativeMembers.lga,
        registrationFeePaid: cooperativeMembers.registrationFeePaid,
        monthlyContributionAmount: cooperativeMembers.monthlyContributionAmount,
        status: cooperativeMembers.status,
        joinedAt: cooperativeMembers.joinedAt,
      })
      .from(cooperativeMembers)
      .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id))
      .where(eq(cooperativeMembers.email, email))
      .limit(1);

    if (!member) {
      return res.status(404).json({ error: "Cooperative member record not found" });
    }

    return res.json(member);
  } catch (err) {
    console.error("[cooperative] fetch self member record error:", err);
    return res.status(500).json({ error: "Failed to fetch self member record" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/me/payments
// Get the logged-in member's payment history
// ─────────────────────────────────────────────
router.get("/members/me/payments", async (req: Request, res: Response) => {
  const email = req.headers["x-user-email"] as string;
  if (!email) {
    return res.status(400).json({ error: "Missing user email header" });
  }

  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.email, email))
      .limit(1);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    const payments = await db
      .select({
        id: cooperativePayments.id,
        amount: cooperativePayments.amount,
        currency: cooperativePayments.currency,
        reference: cooperativePayments.reference,
        status: cooperativePayments.status,
        createdAt: cooperativePayments.createdAt,
        updatedAt: cooperativePayments.updatedAt,
      })
      .from(cooperativePayments)
      .where(eq(cooperativePayments.memberId, member.id))
      .orderBy(cooperativePayments.createdAt);

    return res.json(payments);
  } catch (err) {
    console.error("[cooperative] fetch member payments error:", err);
    return res.status(500).json({ error: "Failed to fetch payments" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/:id
// Admin/Coordinator — get a single cooperative member
// ─────────────────────────────────────────────
router.get("/members/:id", async (req: Request, res: Response) => {
  const role = req.headers["x-user-role"] as string;
  const assignedLga = req.headers["x-user-assigned-lga"] as string;

  try {
    const [member] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, req.params.id))
      .limit(1);

    if (!member) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (role === "coordinator" && assignedLga && member.lga !== assignedLga) {
      return res.status(403).json({ error: "Forbidden — member is outside your assigned LGA" });
    }

    return res.json(member);
  } catch {
    return res.status(500).json({ error: "Failed to fetch member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/members/by-application/:applicationId
// Get cooperative member record by application ID
// NOTE: must be defined before /members/:id so Express
// doesn't match "by-application" as an :id param
// ─────────────────────────────────────────────
router.get(
  "/members/by-application/:applicationId",
  async (req: Request, res: Response) => {
    const role = req.headers["x-user-role"] as string;
    const assignedLga = req.headers["x-user-assigned-lga"] as string;

    try {
      const [member] = await db
        .select()
        .from(cooperativeMembers)
        .where(eq(cooperativeMembers.applicationId, req.params.applicationId))
        .limit(1);

      if (!member) {
        return res
          .status(404)
          .json({ error: "No cooperative record found for this application" });
      }

      if (role === "coordinator" && assignedLga && member.lga !== assignedLga) {
        return res.status(403).json({ error: "Forbidden — member is outside your assigned LGA" });
      }

      return res.json(member);
    } catch {
      return res.status(500).json({ error: "Failed to fetch member" });
    }
  }
);

// ─────────────────────────────────────────────
// PATCH /cooperative/members/:id
// Admin/Coordinator — update a member
// ─────────────────────────────────────────────
router.patch("/members/:id", async (req: Request, res: Response) => {
  const role = req.headers["x-user-role"] as string;
  const assignedLga = req.headers["x-user-assigned-lga"] as string;

  const schema = z.object({
    status: z.enum(["active", "inactive"]).optional(),
    livestockType: z.string().optional(),
    willingToContribute: z.boolean().optional(),
    agreesToConstitution: z.boolean().optional(),
    remarks: z.string().optional().nullable(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  try {
    const [existing] = await db
      .select()
      .from(cooperativeMembers)
      .where(eq(cooperativeMembers.id, req.params.id))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ error: "Member not found" });
    }

    if (role === "coordinator" && assignedLga && existing.lga !== assignedLga) {
      return res.status(403).json({ error: "Forbidden — member is outside your assigned LGA" });
    }

    const [updated] = await db
      .update(cooperativeMembers)
      .set({
        ...parsed.data,
        updatedAt: new Date(),
      })
      .where(eq(cooperativeMembers.id, req.params.id))
      .returning();

    return res.json(updated);
  } catch (err) {
    console.error("[cooperative] patch error:", err);
    return res.status(500).json({ error: "Failed to update member" });
  }
});

// ─────────────────────────────────────────────
// GET /cooperative/stats
// Admin/Coordinator — quick stats for the dashboard
// ─────────────────────────────────────────────
router.get("/stats", async (req: Request, res: Response) => {
  const role = req.headers["x-user-role"] as string;
  const assignedLga = req.headers["x-user-assigned-lga"] as string;
  const assignedState = req.headers["x-user-assigned-state"] as string;
  const assignedZone = req.headers["x-user-assigned-zone"] as string;

  try {
    const getStatsQuery = (status?: "active" | "inactive") => {
      let q = db
        .select({ count: count() })
        .from(cooperativeMembers);

      let conds = [];
      if (status) {
        conds.push(eq(cooperativeMembers.status, status));
      }

      if (role === "coordinator") {
        if (assignedLga) {
          conds.push(eq(cooperativeMembers.lga, assignedLga));
          if (conds.length > 0) {
            return q.where(and(...conds));
          }
          return q;
        } else if (assignedState) {
          let qState = db
            .select({ count: count() })
            .from(cooperativeMembers)
            .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id));
          conds.push(eq(cooperatives.state, assignedState));
          return qState.where(and(...conds));
        } else if (assignedZone) {
          let qZone = db
            .select({ count: count() })
            .from(cooperativeMembers)
            .leftJoin(cooperatives, eq(cooperativeMembers.cooperativeId, cooperatives.id));
          conds.push(eq(cooperatives.zone, assignedZone));
          return qZone.where(and(...conds));
        }
      }

      if (conds.length > 0) {
        return q.where(and(...conds));
      }
      return q;
    };

    const totalQuery = getStatsQuery();
    const activeQuery = getStatsQuery("active");
    const inactiveQuery = getStatsQuery("inactive");

    const [total] = await totalQuery;
    const [active] = await activeQuery;
    const [inactive] = await inactiveQuery;

    return res.json({
      total: Number(total.count),
      active: Number(active.count),
      inactive: Number(inactive.count),
    });
  } catch (err) {
    console.error("[cooperative] fetch stats error:", err);
    return res.status(500).json({ error: "Failed to fetch cooperative stats" });
  }
});

export default router;