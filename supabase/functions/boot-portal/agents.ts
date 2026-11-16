// LotLogic's boot agents: the drivers and dispatchers who sign in to the boot portal to place LotLogic's boots.
//
// LotLogic owns its boots through the enforcement_partners row "LotLogic", so an agent is a partner_members row of
// that company. LotLogic admins (admin.ts) manage them from the Enforcement tab:
//
//   GET  /boot-portal/agents                                     -> the agents, and every live property to pick from
//   POST /boot-portal/agent-add     {name, email, phone?, role, property_ids}
//   POST /boot-portal/agent-resend  {member_id}                  -> a new set-password email
//   POST /boot-portal/agent-remove  {member_id}                  -> removed_at, and every portal session ended
//
// Add, resend and remove go through the backend's own team routes (/partner/team/*?partner_id=, the ones the
// dashboard's View as Partner uses) with the admin's dashboard session. That is where the set-password email lives
// (the "team_invite" mail and its link), where removed_at is set and where "one active person per email" is
// checked, so nothing here sends mail or hashes a password. The backend refuses a caller who is not a platform
// admin. What the backend cannot do for LotLogic is the properties: its assignment route only accepts a tow
// company's own properties, and LotLogic's agents work at any LotLogic property, so the assignment is written here.

import { HttpError } from "../_shared/boot.ts";

export const LOTLOGIC_COMPANY = "LotLogic";
export const AGENT_ROLES = ["driver", "dispatcher"] as const;
export type AgentRole = typeof AGENT_ROLES[number];

export type AgentInput = { name: string; email: string; phone: string | null; role: AgentRole; property_ids: string[] };
export type MemberRow = {
  id: string; name: string; email: string; phone: string | null; role: string;
  password_hash?: string | null; last_login_at: string | null; created_at?: string | null;
};
export type Property = { id: string; name: string };

/** The database reads and writes the agent routes need; supabaseStore() is the real one, tests use a fake. */
export interface AgentStore {
  lotlogicPartnerId(): Promise<string | null>;
  members(partnerId: string): Promise<MemberRow[]>;                // active only
  member(partnerId: string, id: string): Promise<MemberRow | null>; // active only
  memberByEmail(partnerId: string, email: string): Promise<MemberRow | null>;
  liveProperties(): Promise<Property[]>;
  assignments(memberIds: string[]): Promise<Array<{ member_id: string; property_id: string }>>;
  setProperties(memberId: string, propertyIds: string[]): Promise<void>;
  revokeSessions(memberId: string): Promise<number>;
}

/** One call to the backend with the admin's dashboard session: {status, data}. */
export type TeamCall = (method: "GET" | "POST" | "DELETE", path: string, body?: unknown) => Promise<{ status: number; data: unknown }>;

type Caller = { lotlogic?: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Only a LotLogic admin on a dashboard session; a portal member (any role, any company) is refused. */
export function requireLotLogicAdmin(me: Caller) {
  if (!me?.lotlogic) throw new HttpError(403, "not_allowed", "Managing agents is for LotLogic admins.");
}

/** The add body, checked: a name, an email, a role of driver or dispatcher, and a driver covers at least one property. */
export function parseAgent(body: Record<string, unknown>): AgentInput {
  const s = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = s(body?.name, 80);
  const email = s(body?.email, 200).toLowerCase();
  const phone = s(body?.phone, 32) || null;
  const role = s(body?.role, 20) as AgentRole;
  const raw = Array.isArray(body?.property_ids) ? body.property_ids : [];
  const property_ids = [...new Set(raw.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()))];
  if (name.length < 2) throw new HttpError(400, "name_required", "Enter the agent's name.");
  if (!EMAIL.test(email)) throw new HttpError(400, "email_required", "Enter a valid email address.");
  if (!AGENT_ROLES.includes(role)) throw new HttpError(400, "bad_role", "Pick driver or dispatcher.");
  if (property_ids.some((id) => !UUID.test(id))) throw new HttpError(400, "unknown_property", "Pick properties from the list.");
  if (role === "driver" && !property_ids.length) {
    throw new HttpError(400, "properties_required", "Pick at least one property this driver covers.");
  }
  return { name, email, phone, role, property_ids };
}

async function lotlogicId(store: AgentStore) {
  const id = await store.lotlogicPartnerId();
  if (!id) throw new HttpError(409, "no_lotlogic_company", `There is no active "${LOTLOGIC_COMPANY}" company to add agents to.`);
  return id;
}

async function activeMember(store: AgentStore, partnerId: string, memberId: unknown) {
  if (typeof memberId !== "string" || !UUID.test(memberId)) throw new HttpError(400, "member_required");
  const m = await store.member(partnerId, memberId);
  if (!m) throw new HttpError(404, "unknown_agent", "That agent isn't on LotLogic's team.");
  return m;
}

/** A backend answer that is not 2xx, as the error the panel shows. */
function teamError(status: number, data: unknown): HttpError {
  const code = (data as { detail?: unknown; error?: unknown } | null)?.detail ?? (data as { error?: unknown } | null)?.error;
  if (status === 409 && code === "email_in_use") {
    return new HttpError(409, "email_in_use", "That email already signs in to LotLogic. Use a different address.");
  }
  if (status === 409 && code === "last_admin") return new HttpError(409, "last_admin", "That person is the company's only admin.");
  if (status === 401) return new HttpError(401, "signed_out", "Please sign in again.");
  if (status === 403 || status === 404) {
    return new HttpError(403, "not_platform_admin", "The dashboard didn't accept you as a platform admin for this.");
  }
  return new HttpError(502, "team_unavailable", "Couldn't reach the LotLogic team service. Try again.");
}

async function team(call: TeamCall, method: "POST" | "DELETE", path: string, body?: unknown) {
  let r: { status: number; data: unknown };
  try {
    r = await call(method, path, body);
  } catch {
    throw new HttpError(502, "team_unavailable", "Couldn't reach the LotLogic team service. Try again.");
  }
  if (r.status < 200 || r.status >= 300) throw teamError(r.status, r.data);
  return r.data;
}

function agentJson(m: MemberRow, props: Property[]) {
  return {
    id: m.id, name: m.name, email: m.email, phone: m.phone, role: m.role,
    has_password: !!m.password_hash, last_login_at: m.last_login_at, properties: props,
  };
}

// ---------------------------------------------------------------- list
export async function listAgents(store: AgentStore, me: Caller) {
  requireLotLogicAdmin(me);
  const partnerId = await lotlogicId(store);
  const [members, properties] = await Promise.all([store.members(partnerId), store.liveProperties()]);
  const byId = new Map(properties.map((p) => [p.id, p]));
  const mine = new Map<string, Property[]>();
  for (const a of await store.assignments(members.map((m) => m.id))) {
    const p = byId.get(a.property_id);
    if (p) mine.set(a.member_id, [...(mine.get(a.member_id) ?? []), p]);
  }
  const order = (r: string) => (r === "dispatcher" ? 0 : r === "driver" ? 1 : 2);
  const agents = members
    .map((m) => agentJson(m, (mine.get(m.id) ?? []).sort((a, b) => a.name.localeCompare(b.name))))
    .sort((a, b) => order(a.role) - order(b.role) || a.name.localeCompare(b.name));
  return { ok: true, company: LOTLOGIC_COMPANY, agents, properties };
}

// ---------------------------------------------------------------- add
export async function addAgent(store: AgentStore, call: TeamCall, me: Caller, body: Record<string, unknown>) {
  requireLotLogicAdmin(me);
  const a = parseAgent(body);
  const partnerId = await lotlogicId(store);
  const live = await store.liveProperties();
  const picked = live.filter((p) => a.property_ids.includes(p.id));
  if (picked.length !== a.property_ids.length) throw new HttpError(422, "unknown_property", "One of those properties is no longer live. Reload and pick again.");

  const res = await team(call, "POST", `/partner/team/invite?partner_id=${partnerId}`,
    { name: a.name, email: a.email, phone: a.phone, role: a.role }) as { member?: { id?: string } } | null;
  const id = res?.member?.id ?? (await store.memberByEmail(partnerId, a.email))?.id;
  if (!id) throw new HttpError(502, "team_unavailable", "The agent was invited but couldn't be read back. Reload the list.");
  await store.setProperties(id, a.property_ids);
  const m = await store.member(partnerId, id);
  return {
    ok: true,
    agent: agentJson(m ?? { id, name: a.name, email: a.email, phone: a.phone, role: a.role, last_login_at: null }, picked),
    message: `Added ${a.name}. LotLogic emailed ${a.email} a link to set a password.`,
  };
}

// ---------------------------------------------------------------- resend
export async function resendAgent(store: AgentStore, call: TeamCall, me: Caller, body: Record<string, unknown>) {
  requireLotLogicAdmin(me);
  const partnerId = await lotlogicId(store);
  const m = await activeMember(store, partnerId, body?.member_id);
  await team(call, "POST", `/partner/team/${m.id}/resend?partner_id=${partnerId}`, {});
  return { ok: true, message: `Sent ${m.email} a new set-password link. The old link stops working.` };
}

// ---------------------------------------------------------------- remove
export async function removeAgent(store: AgentStore, call: TeamCall, me: Caller, body: Record<string, unknown>) {
  requireLotLogicAdmin(me);
  const partnerId = await lotlogicId(store);
  const m = await activeMember(store, partnerId, body?.member_id);
  await team(call, "DELETE", `/partner/team/${m.id}?partner_id=${partnerId}`);   // removed_at = now()
  const ended = await store.revokeSessions(m.id);
  return { ok: true, sessions_ended: ended, message: `Removed ${m.name}. They're signed out of the boot portal.` };
}

// ---------------------------------------------------------------- what a LotLogic agent may boot at
/** True for a portal member of the LotLogic company (not a LotLogic admin on a dashboard session). */
export function isLotLogicAgent(me: { lotlogic?: boolean; company?: string | null }) {
  return !me.lotlogic && me.company === LOTLOGIC_COMPANY;
}

// ---------------------------------------------------------------- the real store
// deno-lint-ignore no-explicit-any
type Db = any; // SupabaseClient; typed loosely so this file needs no npm import

export function supabaseStore(db: Db): AgentStore {
  const MEMBER = "id, name, email, phone, role, password_hash, last_login_at, created_at";
  const must = <T>(r: { data: T; error: unknown }) => {
    if (r.error) throw r.error;
    return r.data;
  };
  return {
    async lotlogicPartnerId() {
      const rows = must(await db.from("enforcement_partners").select("id").eq("company_name", LOTLOGIC_COMPANY).eq("active", true)) as Array<{ id: string }>;
      return rows?.length === 1 ? rows[0].id : null;
    },
    async members(partnerId) {
      return must(await db.from("partner_members").select(MEMBER).eq("partner_id", partnerId).is("removed_at", null)) ?? [];
    },
    async member(partnerId, id) {
      return must(await db.from("partner_members").select(MEMBER).eq("partner_id", partnerId).eq("id", id).is("removed_at", null).maybeSingle());
    },
    async memberByEmail(partnerId, email) {
      const rows = must(await db.from("partner_members").select(MEMBER).eq("partner_id", partnerId).is("removed_at", null)) as MemberRow[];
      return (rows ?? []).find((r) => r.email.toLowerCase() === email) ?? null;
    },
    async liveProperties() {
      return must(await db.from("properties").select("id, name").is("archived_at", null).order("name")) ?? [];
    },
    async assignments(memberIds) {
      if (!memberIds.length) return [];
      return must(await db.from("partner_member_properties").select("member_id, property_id").in("member_id", memberIds)) ?? [];
    },
    async setProperties(memberId, propertyIds) {
      must(await db.from("partner_member_properties").delete().eq("member_id", memberId));
      if (propertyIds.length) {
        must(await db.from("partner_member_properties").insert(propertyIds.map((property_id) => ({ member_id: memberId, property_id, assigned_by: null }))));
      }
    },
    async revokeSessions(memberId) {
      const rows = must(await db.from("boot_portal_sessions").update({ revoked_at: new Date().toISOString() })
        .eq("member_id", memberId).is("revoked_at", null).select("token_hash")) as unknown[];
      return rows?.length ?? 0;
    },
  };
}
