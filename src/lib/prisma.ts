import { PrismaClient } from "@prisma/client";

// Fastify hot-reload/dev sırasında birden fazla PrismaClient instance'ı oluşmasını önler.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
