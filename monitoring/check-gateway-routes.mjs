#!/usr/bin/env node
// Flags gateway routes that are shadowed by an earlier, less-protected route.
// Express matches routes in registration order, so a public "/api/x/:id" registered
// before an admin-only "/api/x/members" silently serves "members" without auth.
// Usage: node monitoring/check-gateway-routes.mjs   (exit code 1 if any are found)
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("../services/api-gateway/src/index.ts", import.meta.url));
const src = readFileSync(file, "utf8");
const routes = [];
const re = /app\.(get|post|patch|put|delete)\(\s*"([^"]+)",([\s\S]*?)\n\);/g;
for (let m; (m = re.exec(src)); ) {
  const [, method, path, body] = m;
  routes.push({
    method,
    path,
    line: src.slice(0, m.index).split("\n").length,
    auth: body.includes("authenticate"),
    roles: body.match(/requireRole\(([^)]*)\)/)?.[1] || "",
  });
}

// "/api/x/:id([0-9a-f-]{36})" -> /^\/api\/x\/[0-9a-f-]{36}$/ ; plain ":id" matches one segment
const toRegex = (p) =>
  new RegExp("^" + p.replace(/:[A-Za-z]+(\(([^)]*)\))?/g, (_, __, constraint) => constraint || "[^/]+") + "$");

let problems = 0;
routes.forEach((r, i) => {
  const shadow = routes
    .slice(0, i)
    .find((e) => e.method === r.method && e.path !== r.path && e.path.includes(":") && toRegex(e.path).test(r.path));
  if (!shadow) return;
  const weaker = (r.auth && !shadow.auth) || (r.roles && shadow.roles !== r.roles);
  if (weaker) problems++;
  console.log(
    `${weaker ? "SECURITY" : "info    "} ${r.method.toUpperCase()} ${r.path} (line ${r.line}, auth=${r.auth} ${r.roles}) ` +
      `is caught first by ${shadow.path} (line ${shadow.line}, auth=${shadow.auth} ${shadow.roles})`,
  );
});
console.log(problems ? `${problems} route(s) bypass their auth checks.` : "No auth-bypassing route shadowing found.");
process.exit(problems ? 1 : 0);
