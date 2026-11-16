// LotLogic admins in the boot portal, signed in with their main-dashboard session
// (Gabe, 2026-11-15: "scope it for only victor and i at the emails of
// victor@lotlogicparking.com and gabriel@lotlogicparking.com, it needs to be on
// the main dashboard").
//
// The main dashboard's session is the backend's JWT. The portal does not trust
// its claims: it asks the backend who the token belongs to (GET /auth/me) and
// lets the caller in only when that email is on BOOT_ADMIN_EMAILS. An admin acts
// across every partner's boots, as role "admin", with no partner_members row,
// so actor columns are left empty and the email goes in the audit details.

export const DEFAULT_ADMIN_EMAILS = ["gabriel@lotlogicparking.com", "victor@lotlogicparking.com"];
export const DEFAULT_DASHBOARD_API = "https://lotlogic-backend-production.up.railway.app";

/** BOOT_ADMIN_EMAILS="a@x.com, b@y.com" → ["a@x.com","b@y.com"]; unset or empty → the default two. */
export function adminEmails(raw: string | undefined | null): string[] {
  const list = String(raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => s.includes("@"));
  return list.length ? list : [...DEFAULT_ADMIN_EMAILS];
}

/** A dashboard session token looks like a JWT; a portal token is 64 hex. */
export function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token) && token.length < 4096;
}

export type AdminMe = {
  member_id: null; partner_id: null; role: "admin"; name: string; email: string; company: string; lotlogic: true;
};

/**
 * The team member a backend /auth/me body describes: {member_id, partner_id}, or null. An agent signs in to
 * the main dashboard with the same partner_members email and password the portal's /login takes, so their
 * dashboard session reaches the portal as that member (Gabe, 2026-11-16: "merge the lotlogic agent into the
 * enforcement tab"). A company's own pre-team login names no member and is refused.
 */
export function memberFromAuthMe(body: unknown): { member_id: string; partner_id: string } | null {
  const b = (body ?? {}) as { type?: unknown; id?: unknown; member?: { id?: unknown } | null };
  if (b.type !== "partner" || typeof b.id !== "string" || !b.id) return null;
  const id = b.member && typeof b.member === "object" ? b.member.id : null;
  return typeof id === "string" && id ? { member_id: id, partner_id: b.id } : null;
}

/** The admin a backend /auth/me body describes, or null when its email is not allowed. */
export function adminFromAuthMe(body: unknown, allowed: string[]): AdminMe | null {
  const b = (body ?? {}) as { email?: unknown; name?: unknown; first_name?: unknown };
  const email = typeof b.email === "string" ? b.email.trim().toLowerCase() : "";
  if (!email || !allowed.includes(email)) return null;
  const name = typeof b.name === "string" && b.name.trim() ? b.name.trim()
    : typeof b.first_name === "string" && b.first_name.trim() ? b.first_name.trim() : email;
  return { member_id: null, partner_id: null, role: "admin", name, email, company: "LotLogic", lotlogic: true };
}
