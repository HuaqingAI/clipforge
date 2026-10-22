import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import type { KlingProfile, KlingAuthSession } from "./types";

export const klingProfiles = sqliteTable("kling_profiles", {
  id: text("id").primaryKey(),
  data: text("data", { mode: "json" }).$type<KlingProfile>().notNull(),
  leaseOwner: text("lease_owner"),
  leaseExpiresAt: integer("lease_expires_at"),
  leaseToken: integer("lease_token").notNull().default(0),
  leaseChildPid: integer("lease_child_pid"),
});

export const klingAuthSessions = sqliteTable("kling_auth_sessions", {
  id: text("id").primaryKey(),
  profileId: text("profile_id").notNull().references(() => klingProfiles.id),
  state: text("state").$type<KlingAuthSession["state"]>().notNull(),
  data: text("data", { mode: "json" }).$type<KlingAuthSession>().notNull(),
});
