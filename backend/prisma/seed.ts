import "dotenv/config"
import { PrismaClient } from "@prisma/client"
import bcrypt from "bcryptjs"

const prisma = new PrismaClient()

const SUPER_ADMIN_EMAIL = "alex.chen@cmmp.example"
const SUPER_ADMIN_PASSWORD = "cmmp-demo-2026"

async function main() {
  const passwordHash = await bcrypt.hash(SUPER_ADMIN_PASSWORD, 10)

  const org = await prisma.organization.upsert({
    where: { slug: "golden-fork" },
    update: {},
    create: {
      name: "Golden Fork",
      slug: "golden-fork",
      contactName: "Alex Chen",
      contactEmail: SUPER_ADMIN_EMAIL,
      plan: "ENTERPRISE",
      status: "ACTIVE",
    },
  })

  await prisma.user.upsert({
    where: { email: SUPER_ADMIN_EMAIL },
    update: { passwordHash, role: "SUPER_ADMIN" },
    create: {
      name: "Alex Chen",
      email: SUPER_ADMIN_EMAIL,
      passwordHash,
      role: "SUPER_ADMIN",
      organizationId: null,
    },
  })

  const existingLocation = await prisma.location.findFirst({ where: { organizationId: org.id, city: "Dubai" } })
  if (!existingLocation) {
    await prisma.location.create({
      data: {
        organizationId: org.id,
        name: "Golden Fork — Downtown Dubai",
        address: "Sheikh Mohammed bin Rashid Blvd",
        city: "Dubai",
        region: "Dubai",
        country: "United Arab Emirates",
        timezone: "Asia/Dubai",
      },
    })
  }

  console.log(`Seeded: SUPER_ADMIN ${SUPER_ADMIN_EMAIL} / ${SUPER_ADMIN_PASSWORD}`)
  console.log(`Seeded: organization "${org.name}" (${org.id}) with a Dubai location.`)
}

main()
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
