import "dotenv/config";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { sql, eq, inArray } from "drizzle-orm";
import { applications, cooperativeMembers, cooperativePayments } from "./db/schema";

const isLive = process.argv.includes("--live");

async function runDeduplication() {
  const client = postgres(process.env.DATABASE_URL!);
  const db = drizzle(client);

  console.log(`Starting Deduplication Script... Mode: ${isLive ? "LIVE (Write)" : "DRY RUN (Read Only)"}`);
  console.log(`Database: ${process.env.DATABASE_URL?.replace(/:[^:@]+@/, ":****@")}\n`);

  await db.transaction(async (tx) => {
    // ==========================================
    // 1. DEDUPLICATE APPLICATIONS
    // ==========================================
    console.log("=== PROCESSING APPLICATIONS ===");
    
    // Fetch all active applications
    const allApps = await tx
      .select()
      .from(applications)
      .where(eq(applications.isDeleted, false));
    
    console.log(`Fetched ${allApps.length} active applications.`);

    // Group apps by email and phone (excluding placeholders)
    const emailGroups: Record<string, typeof allApps> = {};
    const phoneGroups: Record<string, typeof allApps> = {};

    const isPlaceholderEmail = (email: string) => {
      const normalized = email.toLowerCase().trim();
      return (
        normalized === "no" ||
        normalized === "none" ||
        normalized === "n/a" ||
        normalized === "null" ||
        normalized === "undefined" ||
        normalized === "" ||
        !normalized.includes("@")
      );
    };

    for (const app of allApps) {
      if (app.email && !isPlaceholderEmail(app.email)) {
        const normEmail = app.email.toLowerCase().trim();
        emailGroups[normEmail] = emailGroups[normEmail] || [];
        emailGroups[normEmail].push(app);
      }
      if (app.phone) {
        const normPhone = app.phone.replace(/[\s-]/g, "").trim();
        if (normPhone) {
          phoneGroups[normPhone] = phoneGroups[normPhone] || [];
          phoneGroups[normPhone].push(app);
        }
      }
    }

    // Find all duplicate groups using Union-Find or basic clustering
    // To keep it simple and robust, let's build components of duplicates
    const parent: Record<string, string> = {};
    const appMap: Record<string, typeof allApps[0]> = {};

    for (const app of allApps) {
      parent[app.id] = app.id;
      appMap[app.id] = app;
    }

    function find(id: string): string {
      if (parent[id] === id) return id;
      parent[id] = find(parent[id]);
      return parent[id];
    }

    function union(id1: string, id2: string) {
      const root1 = find(id1);
      const root2 = find(id2);
      if (root1 !== root2) {
        parent[root2] = root1;
      }
    }

    // Union by email
    for (const group of Object.values(emailGroups)) {
      if (group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          union(group[0].id, group[i].id);
        }
      }
    }

    // Union by phone
    for (const group of Object.values(phoneGroups)) {
      if (group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          union(group[0].id, group[i].id);
        }
      }
    }

    // Cluster applications by root parent
    const clusters: Record<string, string[]> = {};
    for (const app of allApps) {
      const root = find(app.id);
      clusters[root] = clusters[root] || [];
      clusters[root].push(app.id);
    }

    const appStatusPriority: Record<string, number> = {
      approved: 1,
      shortlisted: 2,
      rejection_review: 3,
      pending: 4,
      rejected: 5,
      archived: 6,
    };

    let totalDeletedApps = 0;

    for (const [rootId, ids] of Object.entries(clusters)) {
      if (ids.length > 1) {
        // Fetch if any of these are referenced in cooperative_members
        const memberRefs = await tx
          .select({ id: cooperativeMembers.id, applicationId: cooperativeMembers.applicationId })
          .from(cooperativeMembers)
          .where(inArray(cooperativeMembers.applicationId, ids));

        const referencedIds = new Set(memberRefs.map((m) => m.applicationId).filter(Boolean) as string[]);

        // Sort ids based on our priority rule
        const sortedApps = ids
          .map((id) => appMap[id])
          .sort((a, b) => {
            // Rule 1: Referenced in cooperative_members first
            const aRef = referencedIds.has(a.id) ? 1 : 0;
            const bRef = referencedIds.has(b.id) ? 1 : 0;
            if (aRef !== bRef) return bRef - aRef; // descending (1 before 0)

            // Rule 2: Status priority
            const aPriority = appStatusPriority[a.status] || 99;
            const bPriority = appStatusPriority[b.status] || 99;
            if (aPriority !== bPriority) return aPriority - bPriority; // ascending (1 before 2 before 3...)

            // Rule 3: Oldest submission date first
            return a.submittedAt.getTime() - b.submittedAt.getTime(); // ascending
          });

        const primaryApp = sortedApps[0];
        const duplicateApps = sortedApps.slice(1);

        console.log(`\nDuplicate cluster found (${ids.length} applications) for ${primaryApp.firstName} ${primaryApp.lastName} (${primaryApp.email} / ${primaryApp.phone}):`);
        console.log(`  -> KEEPING Primary App: ID: ${primaryApp.id}, Status: ${primaryApp.status}, Submitted: ${primaryApp.submittedAt}`);

        for (const dupApp of duplicateApps) {
          console.log(`  -> DELETING Duplicate App: ID: ${dupApp.id}, Status: ${dupApp.status}, Submitted: ${dupApp.submittedAt}`);

          // Check if this duplicate app was referenced (shouldn't happen since sorting puts referenced first, but just in case)
          const dupRefs = memberRefs.filter((ref) => ref.applicationId === dupApp.id);
          for (const ref of dupRefs) {
            console.log(`     Updating reference in cooperative_members (Member ID: ${ref.id}) to point to primary app ${primaryApp.id}`);
            if (isLive) {
              await tx
                .update(cooperativeMembers)
                .set({ applicationId: primaryApp.id, updatedAt: new Date() })
                .where(eq(cooperativeMembers.id, ref.id));
            }
          }

          if (isLive) {
            await tx.delete(applications).where(eq(applications.id, dupApp.id));
          }
          totalDeletedApps++;
        }
      }
    }

    console.log(`\nTotal applications to be deleted: ${totalDeletedApps}`);

    // ==========================================
    // 2. DEDUPLICATE COOPERATIVE MEMBERS
    // ==========================================
    console.log("\n=== PROCESSING COOPERATIVE MEMBERS ===");

    const allMembers = await tx.select().from(cooperativeMembers);
    console.log(`Fetched ${allMembers.length} cooperative members.`);

    const memberEmailGroups: Record<string, typeof allMembers> = {};
    const memberPhoneGroups: Record<string, typeof allMembers> = {};

    for (const member of allMembers) {
      if (member.email && !isPlaceholderEmail(member.email)) {
        const normEmail = member.email.toLowerCase().trim();
        memberEmailGroups[normEmail] = memberEmailGroups[normEmail] || [];
        memberEmailGroups[normEmail].push(member);
      }
      if (member.phone) {
        const normPhone = member.phone.replace(/[\s-]/g, "").trim();
        if (normPhone) {
          memberPhoneGroups[normPhone] = memberPhoneGroups[normPhone] || [];
          memberPhoneGroups[normPhone].push(member);
        }
      }
    }

    // Union-Find for members
    const memberParent: Record<string, string> = {};
    const memberMap: Record<string, typeof allMembers[0]> = {};

    for (const member of allMembers) {
      memberParent[member.id] = member.id;
      memberMap[member.id] = member;
    }

    function findMember(id: string): string {
      if (memberParent[id] === id) return id;
      memberParent[id] = findMember(memberParent[id]);
      return memberParent[id];
    }

    function unionMember(id1: string, id2: string) {
      const root1 = findMember(id1);
      const root2 = findMember(id2);
      if (root1 !== root2) {
        memberParent[root2] = root1;
      }
    }

    // Union by email
    for (const group of Object.values(memberEmailGroups)) {
      if (group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          unionMember(group[0].id, group[i].id);
        }
      }
    }

    // Union by phone
    for (const group of Object.values(memberPhoneGroups)) {
      if (group.length > 1) {
        for (let i = 1; i < group.length; i++) {
          unionMember(group[0].id, group[i].id);
        }
      }
    }

    // Cluster members
    const memberClusters: Record<string, string[]> = {};
    for (const member of allMembers) {
      const root = findMember(member.id);
      memberClusters[root] = memberClusters[root] || [];
      memberClusters[root].push(member.id);
    }

    let totalDeletedMembers = 0;

    for (const [rootId, ids] of Object.entries(memberClusters)) {
      if (ids.length > 1) {
        // Fetch payments associated with any of these members
        const payments = await tx
          .select({ id: cooperativePayments.id, memberId: cooperativePayments.memberId })
          .from(cooperativePayments)
          .where(inArray(cooperativePayments.memberId, ids));

        const sortMembers = ids
          .map((id) => memberMap[id])
          .sort((a, b) => {
            // Rule 1: Has applicationId linked first
            const aApp = a.applicationId ? 1 : 0;
            const bApp = b.applicationId ? 1 : 0;
            if (aApp !== bApp) return bApp - aApp; // descending

            // Rule 2: Status active first
            const aActive = a.status === "active" ? 1 : 0;
            const bActive = b.status === "active" ? 1 : 0;
            if (aActive !== bActive) return bActive - aActive; // descending

            // Rule 3: Oldest joined date first
            return a.joinedAt.getTime() - b.joinedAt.getTime(); // ascending
          });

        const primaryMember = sortMembers[0];
        const duplicateMembers = sortMembers.slice(1);

        console.log(`\nDuplicate cluster found (${ids.length} members) for ${primaryMember.fullName} (${primaryMember.email} / ${primaryMember.phone}):`);
        console.log(`  -> KEEPING Primary Member: ID: ${primaryMember.id}, App ID: ${primaryMember.applicationId}, Status: ${primaryMember.status}, Joined: ${primaryMember.joinedAt}`);

        for (const dupMember of duplicateMembers) {
          console.log(`  -> DELETING Duplicate Member: ID: ${dupMember.id}, App ID: ${dupMember.applicationId}, Status: ${dupMember.status}, Joined: ${dupMember.joinedAt}`);

          // Update cooperativePayments reference to point to primary member ID
          const dupPayments = payments.filter((p) => p.memberId === dupMember.id);
          for (const payment of dupPayments) {
            console.log(`     Updating reference in cooperative_payments (Payment ID: ${payment.id}) to point to primary member ${primaryMember.id}`);
            if (isLive) {
              await tx
                .update(cooperativePayments)
                .set({ memberId: primaryMember.id, updatedAt: new Date() })
                .where(eq(cooperativePayments.id, payment.id));
            }
          }

          if (isLive) {
            await tx.delete(cooperativeMembers).where(eq(cooperativeMembers.id, dupMember.id));
          }
          totalDeletedMembers++;
        }
      }
    }

    console.log(`\nTotal cooperative members to be deleted: ${totalDeletedMembers}`);

    if (!isLive) {
      console.log("\n[DRY RUN COMPLETE] No modifications were made to the database. Run with '--live' flag to apply.");
      // Rollback transaction to ensure absolute safety in dry run mode
      throw new Error("DRY_RUN_ROLLBACK");
    } else {
      console.log("\n[LIVE RUN COMPLETE] Database successfully updated.");
    }
  });

  await client.end();
}

runDeduplication().catch((err) => {
  if (err.message === "DRY_RUN_ROLLBACK") {
    process.exit(0);
  }
  console.error("Deduplication error:", err);
  process.exit(1);
});
