-- CreateTable
CREATE TABLE "coffee_fortunes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "interpretation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coffee_fortunes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dream_analyses" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dreamText" TEXT NOT NULL,
    "interpretation" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dream_analyses_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "coffee_fortunes" ADD CONSTRAINT "coffee_fortunes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dream_analyses" ADD CONSTRAINT "dream_analyses_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
