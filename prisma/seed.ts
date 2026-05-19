import { PrismaClient, Role, DealStatus, ActivityType, MessageChannel } from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const DEFAULT_STAGES = [
  { name: "Lead", order: 0, color: "#64748b" },
  { name: "Qualified", order: 1, color: "#0ea5e9" },
  { name: "Proposal", order: 2, color: "#8b5cf6" },
  { name: "Negotiation", order: 3, color: "#f59e0b" },
  { name: "Closing", order: 4, color: "#10b981" },
];

async function main() {
  console.log("Seeding…");

  // Wipe in dependency order (dev only).
  await db.messageLog.deleteMany();
  await db.messageTemplate.deleteMany();
  await db.activity.deleteMany();
  await db.contactTag.deleteMany();
  await db.deal.deleteMany();
  await db.contact.deleteMany();
  await db.company.deleteMany();
  await db.tag.deleteMany();
  await db.pipelineStage.deleteMany();
  await db.membership.deleteMany();
  await db.organization.deleteMany();
  await db.user.deleteMany();

  const password = await bcrypt.hash("password123", 10);

  const owner = await db.user.create({
    data: { email: "owner@demo.com", name: "Demo Owner", passwordHash: password, emailVerified: new Date() },
  });
  const member = await db.user.create({
    data: { email: "member@demo.com", name: "Demo Member", passwordHash: password, emailVerified: new Date() },
  });

  const org = await db.organization.create({
    data: {
      name: "Acme Demo Co.",
      slug: "acme",
      memberships: {
        create: [
          { userId: owner.id, role: Role.OWNER },
          { userId: member.id, role: Role.MEMBER },
        ],
      },
      stages: { create: DEFAULT_STAGES },
      tags: {
        create: [
          { name: "VIP", color: "#ef4444" },
          { name: "Partner", color: "#10b981" },
          { name: "Newsletter", color: "#3b82f6" },
        ],
      },
    },
    include: { stages: true, tags: true },
  });

  const companies = await Promise.all(
    [
      { name: "Globex Corp", domain: "globex.com", industry: "Manufacturing", size: "201-500" },
      { name: "Initech", domain: "initech.com", industry: "Software", size: "51-200" },
      { name: "Soylent", domain: "soylent.com", industry: "Food", size: "11-50" },
      { name: "Massive Dynamic", domain: "massivedynamic.com", industry: "R&D", size: "501-1000" },
      { name: "Stark Industries", domain: "stark.io", industry: "Defense", size: "1001+" },
    ].map((c) => db.company.create({ data: { ...c, orgId: org.id } }))
  );

  const firstNames = ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Henry", "Ivy", "Jack",
                      "Kate", "Liam", "Mia", "Noah", "Olive", "Pia", "Quinn", "Ron", "Sue", "Tom"];
  const lastNames  = ["Anderson", "Brown", "Clark", "Davis", "Evans", "Foster", "Garcia", "Hill",
                      "Iverson", "Jones", "Kim", "Lopez", "Miller", "Nguyen", "Owens", "Patel",
                      "Quinn", "Roberts", "Smith", "Turner"];

  const contacts = [];
  for (let i = 0; i < 20; i++) {
    const company = companies[i % companies.length];
    contacts.push(
      await db.contact.create({
        data: {
          orgId: org.id,
          companyId: company.id,
          firstName: firstNames[i],
          lastName: lastNames[i],
          email: `${firstNames[i].toLowerCase()}.${lastNames[i].toLowerCase()}@${company.domain}`,
          phone: `+1-555-01${String(i).padStart(2, "0")}`,
          title: i % 3 === 0 ? "VP Sales" : i % 3 === 1 ? "Engineer" : "Founder",
        },
      })
    );
  }

  // tag a few contacts
  const vip = org.tags.find((t) => t.name === "VIP")!;
  await db.contactTag.createMany({
    data: [contacts[0].id, contacts[3].id, contacts[7].id].map((cid) => ({ contactId: cid, tagId: vip.id })),
  });

  // 10 deals across stages
  for (let i = 0; i < 10; i++) {
    const stage = org.stages[i % org.stages.length];
    const contact = contacts[i];
    await db.deal.create({
      data: {
        orgId: org.id,
        title: `${contact.firstName}'s ${["Pilot", "Expansion", "Renewal", "POC", "Upsell"][i % 5]}`,
        value: 1000 * (i + 1) * 5,
        currency: "USD",
        status: i === 9 ? DealStatus.WON : i === 8 ? DealStatus.LOST : DealStatus.OPEN,
        stageId: stage.id,
        contactId: contact.id,
        companyId: contact.companyId,
        ownerId: owner.id,
        closeDate: new Date(Date.now() + (i + 1) * 86400000 * 7),
      },
    });
  }

  // 8 activities
  const dealsArr = await db.deal.findMany({ where: { orgId: org.id } });
  const types: ActivityType[] = [ActivityType.TASK, ActivityType.CALL, ActivityType.MEETING, ActivityType.NOTE];
  for (let i = 0; i < 8; i++) {
    await db.activity.create({
      data: {
        orgId: org.id,
        type: types[i % types.length],
        title: `${types[i % types.length]} with ${contacts[i].firstName}`,
        dueAt: new Date(Date.now() + (i - 2) * 86400000),
        completedAt: i < 2 ? new Date() : null,
        contactId: contacts[i].id,
        dealId: dealsArr[i % dealsArr.length].id,
        ownerId: owner.id,
      },
    });
  }

  // Message templates — one per channel — so the Send Message panel can be
  // demoed by picking a template key.
  await db.messageTemplate.createMany({
    data: [
      {
        orgId: org.id,
        channel: MessageChannel.EMAIL,
        key: "welcome",
        subject: "Welcome to Acme, {{firstName}}",
        body: "Hi {{firstName}},\n\nThanks for chatting today. Let us know if you have questions.\n\n— The Acme team",
      },
      {
        orgId: org.id,
        channel: MessageChannel.TELEGRAM,
        key: "follow-up",
        body: "Hey {{firstName}} — quick follow-up on our last conversation. Let me know if next week works.",
      },
      {
        orgId: org.id,
        channel: MessageChannel.LINE,
        key: "follow-up",
        body: "สวัสดีคุณ {{firstName}} — ติดตามการพูดคุยของเราเมื่อวานครับ ขอบคุณครับ",
      },
    ],
  });

  console.log(`Seeded org "${org.name}" (owner: owner@demo.com / password123)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
