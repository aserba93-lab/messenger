-- Align PostgreSQL MemberRole with GraphQL OrgRole (owner, manager, employee).
DO $$ BEGIN
  ALTER TYPE "MemberRole" ADD VALUE 'owner';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "MemberRole" ADD VALUE 'manager';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TYPE "MemberRole" ADD VALUE 'employee';
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
