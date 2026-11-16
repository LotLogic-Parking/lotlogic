import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { HttpError } from "../_shared/boot.ts";
import {
  addAgent, type AgentStore, isLotLogicAgent, listAgents, type MemberRow, parseAgent, removeAgent, resendAgent, type TeamCall,
} from "./agents.ts";

const LL = "44b39865-dd8d-4fdf-8dcc-76edf7344fbf";
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const GONE = "33333333-3333-4333-8333-333333333333";
const ADMIN = { lotlogic: true };
// A portal session: a real partner member, even LotLogic's own dispatcher, is not a LotLogic admin.
const DISPATCHER = { lotlogic: undefined, role: "dispatcher", company: "LotLogic" };

type World = {
  members: Array<MemberRow & { partner_id: string; removed_at: string | null }>;
  assignments: Array<{ member_id: string; property_id: string }>;
  sessions: Array<{ member_id: string; revoked_at: string | null }>;
  calls: Array<{ method: string; path: string; body?: unknown }>;
};

function world(): World {
  return { members: [], assignments: [], sessions: [], calls: [] };
}

function store(w: World, partnerId: string | null = LL): AgentStore {
  const active = (pid: string) => w.members.filter((m) => m.partner_id === pid && !m.removed_at);
  return {
    lotlogicPartnerId: () => Promise.resolve(partnerId),
    members: (pid) => Promise.resolve(active(pid)),
    member: (pid, id) => Promise.resolve(active(pid).find((m) => m.id === id) ?? null),
    memberByEmail: (pid, email) => Promise.resolve(active(pid).find((m) => m.email === email) ?? null),
    liveProperties: () => Promise.resolve([{ id: P1, name: "Ashford Green" }, { id: P2, name: "Brook Hollow" }]),
    assignments: (ids) => Promise.resolve(w.assignments.filter((a) => ids.includes(a.member_id))),
    setProperties: (mid, ids) => {
      w.assignments = [...w.assignments.filter((a) => a.member_id !== mid), ...ids.map((property_id) => ({ member_id: mid, property_id }))];
      return Promise.resolve();
    },
    revokeSessions: (mid) => {
      let n = 0;
      for (const s of w.sessions) if (s.member_id === mid && !s.revoked_at) { s.revoked_at = "now"; n++; }
      return Promise.resolve(n);
    },
  };
}

/** A fake of the backend's /partner/team routes, enough for the three calls the panel makes. */
function backend(w: World, status?: number, detail?: string): TeamCall {
  return (method, path, body) => {
    w.calls.push({ method, path, body });
    if (status) return Promise.resolve({ status, data: { detail } });
    const pid = new URL(`http://x${path}`).searchParams.get("partner_id")!;
    if (method === "POST" && path.startsWith("/partner/team/invite")) {
      const b = body as { name: string; email: string; phone: string | null; role: string };
      if (w.members.some((m) => !m.removed_at && m.email === b.email)) return Promise.resolve({ status: 409, data: { detail: "email_in_use" } });
      const id = crypto.randomUUID();
      w.members.push({ id, partner_id: pid, ...b, password_hash: null, last_login_at: null, removed_at: null });
      return Promise.resolve({ status: 201, data: { member: { id } } });
    }
    if (method === "DELETE") {
      const id = path.split("/")[3].split("?")[0];
      const m = w.members.find((x) => x.id === id && x.partner_id === pid);
      if (!m) return Promise.resolve({ status: 404, data: { detail: "not_found" } });
      m.removed_at = "now";
      return Promise.resolve({ status: 200, data: { ok: true } });
    }
    return Promise.resolve({ status: 200, data: { ok: true } }); // resend
  };
}

const body = { name: "Dana Reyes", email: " Dana@Example.com ", phone: "704-555-0101", role: "driver", property_ids: [P1] };

async function refused(p: Promise<unknown>, status: number, code: string) {
  const e = await assertRejects(() => p, HttpError);
  assertEquals([(e as HttpError).status, (e as HttpError & { code: string }).code], [status, code]);
}

// ---------------------------------------------------------------- add
Deno.test("add: invites through the backend for the LotLogic company, then assigns the properties", async () => {
  const w = world();
  const r = await addAgent(store(w), backend(w), ADMIN, body);
  assertEquals(w.calls.length, 1);
  assertEquals(w.calls[0].method, "POST");
  assertEquals(w.calls[0].path, `/partner/team/invite?partner_id=${LL}`);
  assertEquals(w.calls[0].body, { name: "Dana Reyes", email: "dana@example.com", phone: "704-555-0101", role: "driver" });
  assertEquals(r.agent.email, "dana@example.com");
  assertEquals(r.agent.role, "driver");
  assertEquals(r.agent.has_password, false);
  assertEquals(r.agent.properties, [{ id: P1, name: "Ashford Green" }]);
  assertEquals(w.assignments, [{ member_id: r.agent.id, property_id: P1 }]);
  const list = await listAgents(store(w), ADMIN);
  assertEquals(list.agents.map((a) => [a.name, a.properties.length]), [["Dana Reyes", 1]]);
});

Deno.test("add: a dispatcher needs no property; a driver needs one", async () => {
  const w = world();
  const r = await addAgent(store(w), backend(w), ADMIN, { ...body, role: "dispatcher", property_ids: [] });
  assertEquals(r.agent.properties, []);
  await refused(addAgent(store(w), backend(w), ADMIN, { ...body, email: "x@y.com", property_ids: [] }), 400, "properties_required");
});

Deno.test("add: refuses an admin role, a bad email and a property that is not live, before calling the backend", async () => {
  const w = world();
  await refused(addAgent(store(w), backend(w), ADMIN, { ...body, role: "admin" }), 400, "bad_role");
  await refused(addAgent(store(w), backend(w), ADMIN, { ...body, email: "nope" }), 400, "email_required");
  await refused(addAgent(store(w), backend(w), ADMIN, { ...body, property_ids: [GONE] }), 422, "unknown_property");
  assertEquals(w.calls.length, 0);
});

Deno.test("add: an email that already signs in is a 409 the panel can show", async () => {
  const w = world();
  await addAgent(store(w), backend(w), ADMIN, body);
  await refused(addAgent(store(w), backend(w), ADMIN, body), 409, "email_in_use");
});

Deno.test("add: no LotLogic company is a clear 409, not a silent miss", async () => {
  const w = world();
  await refused(addAgent(store(w, null), backend(w), ADMIN, body), 409, "no_lotlogic_company");
});

// ---------------------------------------------------------------- resend
Deno.test("resend: the backend's resend route for that LotLogic agent", async () => {
  const w = world();
  const { agent } = await addAgent(store(w), backend(w), ADMIN, body);
  const r = await resendAgent(store(w), backend(w), ADMIN, { member_id: agent.id });
  assertEquals(r.ok, true);
  assertEquals(w.calls.at(-1), { method: "POST", path: `/partner/team/${agent.id}/resend?partner_id=${LL}`, body: {} });
});

Deno.test("resend: someone not on LotLogic's team is 404, and the backend is never called", async () => {
  const w = world();
  w.members.push({ id: GONE, partner_id: "other-company", name: "X", email: "x@tow.com", phone: null, role: "driver", last_login_at: null, removed_at: null });
  await refused(resendAgent(store(w), backend(w), ADMIN, { member_id: GONE }), 404, "unknown_agent");
  await refused(resendAgent(store(w), backend(w), ADMIN, { member_id: "not-a-uuid" }), 400, "member_required");
  assertEquals(w.calls.length, 0);
});

// ---------------------------------------------------------------- remove
Deno.test("remove: removed_at through the backend, then every live portal session ended", async () => {
  const w = world();
  const { agent } = await addAgent(store(w), backend(w), ADMIN, body);
  w.sessions.push({ member_id: agent.id, revoked_at: null }, { member_id: agent.id, revoked_at: null }, { member_id: "someone-else", revoked_at: null });
  const r = await removeAgent(store(w), backend(w), ADMIN, { member_id: agent.id });
  assertEquals(w.calls.at(-1)?.method, "DELETE");
  assertEquals(w.calls.at(-1)?.path, `/partner/team/${agent.id}?partner_id=${LL}`);
  assertEquals(w.members.find((m) => m.id === agent.id)?.removed_at, "now");
  assertEquals(r.sessions_ended, 2);
  assertEquals(w.sessions.map((s) => s.revoked_at), ["now", "now", null]);
  assertEquals((await listAgents(store(w), ADMIN)).agents, []);
  // removing them again: they are no longer on the team
  await refused(removeAgent(store(w), backend(w), ADMIN, { member_id: agent.id }), 404, "unknown_agent");
});

Deno.test("remove: when the backend refuses, no session is touched", async () => {
  const w = world();
  const { agent } = await addAgent(store(w), backend(w), ADMIN, body);
  w.sessions.push({ member_id: agent.id, revoked_at: null });
  await refused(removeAgent(store(w), backend(w, 503), ADMIN, { member_id: agent.id }), 502, "team_unavailable");
  assertEquals(w.sessions[0].revoked_at, null);
});

// ---------------------------------------------------------------- refused
Deno.test("a non-admin is refused on every agent route, before any read or call", async () => {
  for (const me of [DISPATCHER, { lotlogic: false, role: "admin", company: "N Style Towing" }, {}]) {
    const w = world();
    await refused(listAgents(store(w), me), 403, "not_allowed");
    await refused(addAgent(store(w), backend(w), me, body), 403, "not_allowed");
    await refused(resendAgent(store(w), backend(w), me, { member_id: P1 }), 403, "not_allowed");
    await refused(removeAgent(store(w), backend(w), me, { member_id: P1 }), 403, "not_allowed");
    assertEquals(w.calls.length, 0);
  }
});

Deno.test("a LotLogic admin the backend does not take as a platform admin gets a 403, not a crash", async () => {
  const w = world();
  await refused(addAgent(store(w), backend(w, 404, "not_found"), ADMIN, body), 403, "not_platform_admin");
});

// ---------------------------------------------------------------- pure helpers
Deno.test("parseAgent trims, lower-cases and de-duplicates", () => {
  assertEquals(parseAgent({ name: " Al ", email: "A@B.CO", role: "dispatcher", property_ids: [P1, P1.toUpperCase()] }),
    { name: "Al", email: "a@b.co", phone: null, role: "dispatcher", property_ids: [P1] });
});

Deno.test("isLotLogicAgent: a LotLogic portal member, never a LotLogic admin or another company", () => {
  assertEquals(isLotLogicAgent({ company: "LotLogic" }), true);
  assertEquals(isLotLogicAgent({ company: "LotLogic", lotlogic: true }), false);
  assertEquals(isLotLogicAgent({ company: "N Style Towing" }), false);
});
