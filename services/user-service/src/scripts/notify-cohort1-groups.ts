import "dotenv/config";
import { eq } from "drizzle-orm";
import { db } from "../index";
import { users, cohorts, cohortMembers, groups, groupMembers } from "../db/schema";
import { publishEvent, connectRabbitMQ } from "../rabbitmq";

async function run() {
  console.log("=== Cohort 1 Group & Physical Training Email Notifier ===");
  console.log("Location: LAUTECH Ogbomoso");
  console.log("Time: 9:00 AM – 5:00 PM\n");

  try {
    if (process.env.RABBITMQ_URL) {
      await connectRabbitMQ(process.env.RABBITMQ_URL);
    }

    // 1. Fetch Cohort 1
    const allCohorts = await db.select().from(cohorts);
    const cohort1 = allCohorts.find((c) =>
      c.name.toLowerCase().includes("cohort 1") || c.name.toLowerCase().includes("cohort a")
    ) || allCohorts[0];

    if (!cohort1) {
      console.error("Error: No cohort found in database!");
      process.exit(1);
    }

    console.log(`Target Cohort: ${cohort1.name} (ID: ${cohort1.id})`);

    // 2. Fetch members of Cohort 1
    const enrolledUsers = await db
      .select({
        id: users.id,
        email: users.email,
        firstName: users.firstName,
        lastName: users.lastName,
        role: users.role,
      })
      .from(cohortMembers)
      .innerJoin(users, eq(users.id, cohortMembers.userId))
      .where(eq(cohortMembers.cohortId, cohort1.id));

    console.log(`Found ${enrolledUsers.length} enrolled trainees in ${cohort1.name}.`);

    // 3. Fetch groups & group members
    const cohortGroups = await db
      .select()
      .from(groups)
      .where(eq(groups.cohortId, cohort1.id));

    const groupMap = new Map<string, { name: string; practicalDay?: string | null }>(
      cohortGroups.map((g) => [g.id, { name: g.name, practicalDay: g.practicalDay }])
    );

    const allGroupMembers = await db.select().from(groupMembers);
    const userGroupMap = new Map<string, { name: string; practicalDay?: string | null }>();
    for (const gm of allGroupMembers) {
      if (groupMap.has(gm.groupId)) {
        userGroupMap.set(gm.userId, groupMap.get(gm.groupId)!);
      }
    }

    // 4. Dispatch Notifications
    const location = "LAUTECH Ogbomoso";
    const timeRange = "9:00 AM – 5:00 PM";
    let dispatchedCount = 0;

    for (const user of enrolledUsers) {
      const assignedGroup = userGroupMap.get(user.id);
      const groupName = assignedGroup?.name || "Group Unassigned";
      const practicalDay = assignedGroup?.practicalDay || undefined;

      console.log(`-> Sending to ${user.firstName} ${user.lastName} (${user.email}) | Group: ${groupName}`);

      await publishEvent("cohort.group_notification_requested", {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        cohortName: cohort1.name,
        groupName,
        practicalDay,
        location,
        timeRange,
      });

      dispatchedCount++;
    }

    console.log(`\nSuccessfully queued ${dispatchedCount} email notifications!`);
    process.exit(0);
  } catch (err) {
    console.error("Error executing notifier script:", err);
    process.exit(1);
  }
}

run();
