import "dotenv/config";
import { prisma } from "../dist/db/prisma.js";
import { hashPassword } from "../dist/security/password.js";

async function main() {
  const org = await prisma.organization.upsert({
    where: { domain: "seed.local" },
    create: {
      name: "Seed Org",
      domain: "seed.local",
      settings: {},
    },
    update: {},
  });

  const email = "admin@seed.local";
  const password = "SeedPass123!";
  const passwordHash = await hashPassword(password);

  const user = await prisma.user.upsert({
    where: { email },
    create: {
      email,
      passwordHash,
      firstName: "Admin",
      lastName: "Seed",
      emailVerifiedAt: new Date(),
      systemAccessLevel: "organization",
    },
    update: {
      emailVerifiedAt: new Date(),
      systemAccessLevel: "organization",
    },
  });

  await prisma.organizationMember.upsert({
    where: { organizationId_userId: { organizationId: org.id, userId: user.id } },
    create: { organizationId: org.id, userId: user.id, role: "owner", status: "offline" },
    update: { role: "owner" },
  });

  // Workspace: make sure "General" exists, because /playground-ru/seed-info looks for it.
  const workspace = await prisma.workspace.upsert({
    where: { organizationId_name: { organizationId: org.id, name: "General" } },
    create: {
      organizationId: org.id,
      name: "General",
      createdByUserId: user.id,
    },
    update: {},
  });

  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
    create: { workspaceId: workspace.id, userId: user.id, role: "admin" },
    update: { role: "admin" },
  });

  const general = await prisma.channel.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "general" } },
    create: {
      organizationId: org.id,
      workspaceId: workspace.id,
      name: "general",
      type: "public",
      description: "Общий канал",
      isSystem: true,
      createdByUserId: user.id,
    },
    update: {},
  });

  await prisma.channel.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "random" } },
    create: {
      organizationId: org.id,
      workspaceId: workspace.id,
      name: "random",
      type: "public",
      description: "Неформальное общение",
      isSystem: true,
      createdByUserId: user.id,
    },
    update: {},
  });

  await prisma.channel.upsert({
    where: { workspaceId_name: { workspaceId: workspace.id, name: "announcements" } },
    create: {
      organizationId: org.id,
      workspaceId: workspace.id,
      name: "announcements",
      type: "broadcast",
      description: "Объявления (писать могут только администраторы)",
      isSystem: true,
      createdByUserId: user.id,
    },
    update: {},
  });

  console.log(
    JSON.stringify(
      {
        organizationId: org.id,
        workspaceId: workspace.id,
        channelId: general.id,
        adminEmail: email,
        adminPassword: password,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

