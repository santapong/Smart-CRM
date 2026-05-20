import {
  PrismaClient,
  Role,
  DealStatus,
  ActivityType,
  AccountTier,
  AccountTeamRole,
  DecisionRole,
  TicketPriority,
  TicketStatus,
  CustomFieldEntity,
  CustomFieldType,
} from "@prisma/client";
import bcrypt from "bcryptjs";

const db = new PrismaClient();

const DEFAULT_STAGES = [
  { name: "Lead", order: 0, color: "#64748b" },
  { name: "Qualified", order: 1, color: "#0ea5e9" },
  { name: "Proposal", order: 2, color: "#8b5cf6" },
  { name: "Negotiation", order: 3, color: "#f59e0b" },
  { name: "Closing", order: 4, color: "#10b981" },
];

const DEFAULT_SLA: { tier: AccountTier; firstResponseMinutes: number; resolutionMinutes: number }[] = [
  { tier: "STRATEGIC", firstResponseMinutes: 60, resolutionMinutes: 60 * 4 },
  { tier: "ENTERPRISE", firstResponseMinutes: 60 * 4, resolutionMinutes: 60 * 24 },
  { tier: "MID_MARKET", firstResponseMinutes: 60 * 8, resolutionMinutes: 60 * 48 },
  { tier: "SMB", firstResponseMinutes: 60 * 24, resolutionMinutes: 60 * 24 * 5 },
];

async function main() {
  console.log("Seeding…");

  // Wipe in dependency order (dev only).
  await db.customFieldValue.deleteMany();
  await db.customFieldDefinition.deleteMany();
  await db.ticket.deleteMany();
  await db.slaPolicy.deleteMany();
  await db.accountAssignment.deleteMany();
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
      slaPolicies: { create: DEFAULT_SLA },
    },
    include: { stages: true, tags: true },
  });

  // Globex demonstrates a parent → subsidiary hierarchy (mimicking how a
  // large account might have multiple subsidiaries in one CRM).
  const globexParent = await db.company.create({
    data: { orgId: org.id, name: "Globex Corp", domain: "globex.com", industry: "Manufacturing", size: "201-500", tier: AccountTier.STRATEGIC, arr: 1_500_000 },
  });
  const globexCloud = await db.company.create({
    data: {
      orgId: org.id,
      name: "Globex Cloud",
      domain: "cloud.globex.com",
      industry: "Software",
      size: "51-200",
      tier: AccountTier.ENTERPRISE,
      arr: 600_000,
      parentCompanyId: globexParent.id,
    },
  });
  const otherCompanies = await Promise.all(
    [
      { name: "Initech", domain: "initech.com", industry: "Software", size: "51-200", tier: AccountTier.ENTERPRISE, arr: 400_000 },
      { name: "Soylent", domain: "soylent.com", industry: "Food", size: "11-50", tier: AccountTier.MID_MARKET, arr: 80_000 },
      { name: "Massive Dynamic", domain: "massivedynamic.com", industry: "R&D", size: "501-1000", tier: AccountTier.STRATEGIC, arr: 2_500_000 },
      { name: "Stark Industries", domain: "stark.io", industry: "Defense", size: "1001+", tier: AccountTier.STRATEGIC, arr: 4_000_000 },
    ].map((c) => db.company.create({ data: { ...c, orgId: org.id } })),
  );
  const companies = [globexParent, globexCloud, ...otherCompanies];

  // Account team on Globex (parent) — Owner + AE + SE + CSM.
  await db.accountAssignment.createMany({
    data: [
      { orgId: org.id, companyId: globexParent.id, userId: owner.id, role: AccountTeamRole.OWNER },
      { orgId: org.id, companyId: globexParent.id, userId: owner.id, role: AccountTeamRole.AE },
      { orgId: org.id, companyId: globexParent.id, userId: member.id, role: AccountTeamRole.CSM },
    ],
  });

  const firstNames = ["Alice", "Bob", "Carol", "Dan", "Eve", "Frank", "Grace", "Henry", "Ivy", "Jack",
                      "Kate", "Liam", "Mia", "Noah", "Olive", "Pia", "Quinn", "Ron", "Sue", "Tom"];
  const lastNames  = ["Anderson", "Brown", "Clark", "Davis", "Evans", "Foster", "Garcia", "Hill",
                      "Iverson", "Jones", "Kim", "Lopez", "Miller", "Nguyen", "Owens", "Patel",
                      "Quinn", "Roberts", "Smith", "Turner"];

  const decisionRoles: DecisionRole[] = [
    DecisionRole.CHAMPION,
    DecisionRole.ECONOMIC_BUYER,
    DecisionRole.USER,
    DecisionRole.INFLUENCER,
    DecisionRole.BLOCKER,
  ];

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
          isPrimary: i % 5 === 0,
          decisionRole: decisionRoles[i % decisionRoles.length],
        },
      }),
    );
  }

  // Tag a few contacts.
  const vip = org.tags.find((t) => t.name === "VIP")!;
  await db.contactTag.createMany({
    data: [contacts[0].id, contacts[3].id, contacts[7].id].map((cid) => ({ contactId: cid, tagId: vip.id })),
  });

  // Deals across stages.
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

  // A handful of activities.
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

  // Two tickets on Globex — one fresh (within SLA), one older (at-risk on a
  // STRATEGIC 1h first-response policy) so the UI shows colored badges.
  const now = Date.now();
  await db.ticket.createMany({
    data: [
      {
        orgId: org.id,
        companyId: globexParent.id,
        contactId: contacts[0].id,
        assigneeId: owner.id,
        subject: "Renewal kickoff",
        body: "Schedule the renewal QBR with the Globex team for next quarter.",
        priority: TicketPriority.NORMAL,
        status: TicketStatus.OPEN,
        createdAt: new Date(now - 10 * 60_000),
      },
      {
        orgId: org.id,
        companyId: globexCloud.id,
        contactId: contacts[1].id,
        assigneeId: owner.id,
        subject: "SSO outage report",
        body: "Customer reported a 5-minute SSO outage at 09:00. Need to confirm RCA.",
        priority: TicketPriority.HIGH,
        status: TicketStatus.IN_PROGRESS,
        createdAt: new Date(now - 50 * 60_000),
      },
    ],
  });

  // Two custom fields on COMPANY to demo the renderer.
  const msaSigned = await db.customFieldDefinition.create({
    data: {
      orgId: org.id,
      entity: CustomFieldEntity.COMPANY,
      key: "msa_signed",
      label: "MSA signed",
      type: CustomFieldType.BOOLEAN,
      order: 0,
    },
  });
  const renewalDate = await db.customFieldDefinition.create({
    data: {
      orgId: org.id,
      entity: CustomFieldEntity.COMPANY,
      key: "renewal_date",
      label: "Renewal date",
      type: CustomFieldType.DATE,
      order: 1,
    },
  });
  await db.customFieldValue.create({
    data: { orgId: org.id, definitionId: msaSigned.id, companyId: globexParent.id, valueBoolean: true },
  });
  await db.customFieldValue.create({
    data: {
      orgId: org.id,
      definitionId: renewalDate.id,
      companyId: globexParent.id,
      valueDate: new Date(now + 90 * 86400_000),
    },
  });

  console.log(`Seeded org "${org.name}" (owner: owner@demo.com / password123)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
