import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { adminEmails, adminFromAuthMe, DEFAULT_ADMIN_EMAILS, looksLikeJwt } from "./admin.ts";

Deno.test("adminEmails: the env list, lower-cased; the default two when unset or junk", () => {
  assertEquals(adminEmails(" Gabriel@LotLogicParking.com , victor@lotlogicparking.com "), ["gabriel@lotlogicparking.com", "victor@lotlogicparking.com"]);
  assertEquals(adminEmails(undefined), DEFAULT_ADMIN_EMAILS);
  assertEquals(adminEmails(""), DEFAULT_ADMIN_EMAILS);
  assertEquals(adminEmails("nope, ,"), DEFAULT_ADMIN_EMAILS);
});

Deno.test("looksLikeJwt: a dashboard token yes, a 64-hex portal token no", () => {
  assertEquals(looksLikeJwt("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc-_123"), true);
  assertEquals(looksLikeJwt("a".repeat(64)), false);
  assertEquals(looksLikeJwt(""), false);
});

Deno.test("adminFromAuthMe: only the allowed emails, case-insensitive; everyone else null", () => {
  const allowed = DEFAULT_ADMIN_EMAILS;
  const g = adminFromAuthMe({ email: "Gabriel@lotlogicparking.com", name: "Gabe" }, allowed);
  assertEquals(g?.email, "gabriel@lotlogicparking.com");
  assertEquals(g?.role, "admin");
  assertEquals(g?.lotlogic, true);
  assertEquals(g?.partner_id, null);
  assertEquals(g?.name, "Gabe");
  assertEquals(adminFromAuthMe({ email: "victor@lotlogicparking.com" }, allowed)?.name, "victor@lotlogicparking.com");
  // a platform admin on another email is still refused: the list is the scope
  assertEquals(adminFromAuthMe({ email: "victorsimmons2002@gmail.com", is_platform_admin: true }, allowed), null);
  assertEquals(adminFromAuthMe({ email: "manager@property.com" }, allowed), null);
  assertEquals(adminFromAuthMe(null, allowed), null);
  assertEquals(adminFromAuthMe({}, allowed), null);
});
