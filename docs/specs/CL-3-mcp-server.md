# [CL-3] ChurnLens MCP server

- **Type:** feature
- **Priority:** P3
- **Status:** blocked
- **Blocked by:** CL-2 (org API keys and read-only data API)
- **Gates required:** code-guardian, test-architect (deploy-engineer — not required; see Gates section)

---

## Context

ChurnLens's output is narrative, not operational: three to five themes a week, with quotes and an
MRR weight. A founder does not *act* inside a churn dashboard — they act while writing a roadmap,
triaging issues, or drafting a changelog, in a different tool. An MCP server puts the same data in
that tool.

The use case that justifies the build is cross-tool synthesis a dashboard structurally cannot do:
*"which of this week's churn themes map to open issues in this repo, ordered by MRR at risk"* —
the founder already has ChurnLens, GitHub, and their codebase in one agent session, and
`themes.mrr_impact` is the prioritization weight.

This ticket ships a **read-only stdio MCP server** distributed as an npm package, wrapping the
`/api/v1` endpoints CL-2 built. Nothing runs inside the ChurnLens service.

Explicitly out of scope (YAGNI): a remote Streamable HTTP server, OAuth 2.1, write tools, sampling,
elicitation, a hosted connector listing, and any tool that sends data anywhere.

### Why stdio and an API key, not remote and OAuth

Verified against the MCP specification (rev `2026-07-28`):

- The two standard transports are **stdio** and **Streamable HTTP**.
- Authorization is **OPTIONAL**. Implementations on **stdio SHOULD NOT** follow the OAuth
  specification and **instead retrieve credentials from the environment** — which is exactly the
  API-key model CL-2 provides.
- A remote HTTP server **SHOULD** conform to the authorization spec, which means OAuth 2.1 plus
  RFC 9728 protected-resource metadata, RFC 8707 resource indicators, PKCE, and either RFC 8414 or
  OIDC discovery. That is an authorization-server build, and ChurnLens has none.

So stdio + `CHURNLENS_API_KEY` is the spec-endorsed path and the only one proportionate to the
feature's value. Revisit remote/OAuth only if connector demand actually appears — recorded as a
non-goal, not an oversight.

### Current state (verified against the tree, 2026-08-24)

- `@modelcontextprotocol/sdk` exists on npm (1.30.0 at time of writing). It is a **new dependency**
  and belongs only to the new package, never to the Next.js app's `package.json`.
- The repo is a single Next.js app with **no npm workspaces** in `package.json`.
- Root `tsconfig.json` has `"include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"]`
  and excludes only `node_modules`. A new top-level `mcp/` directory would therefore be pulled into
  `npm run typecheck` and typechecked under the app's `bundler` module resolution and `jsx: preserve`
  — wrong settings for a Node CLI. This must be handled explicitly (see the packaging decision).

### Packaging decision

Add `mcp/` as a **separate package in this repo** with its own `package.json` and `tsconfig.json`,
published to npm as `churnlens-mcp`, and **add `"mcp"` to the root `tsconfig.json` `exclude` array**
so `npm run typecheck` and `next build` never see it. Same repo keeps the tool surface and the
`/api/v1` contract in one place where they can drift together; separate package keeps the app's
dependency tree and build untouched.

Rejected alternative: a separate repo. It halves the chance anyone updates the server when a
`/api/v1` response shape changes.

---

## Tool surface

Each tool is a thin wrapper over one CL-2 endpoint. No tool composes, caches, or infers.

| Tool | Args | Backing endpoint |
|---|---|---|
| `get_churn_summary` | `since?`, `until?` | `GET /api/v1/summary` |
| `list_themes` | `week_of?` | `GET /api/v1/themes` |
| `compare_theme_weeks` | `from`, `to` | `GET /api/v1/themes?from=&to=` |
| `list_cancellation_reasons` | `since?` | `GET /api/v1/reasons` |
| `search_responses` | `since?`, `reason?`, `limit?` | `GET /api/v1/responses` |
| `get_response` | `id` | `GET /api/v1/responses/{id}` |

**Prompt:** `weekly_churn_review` — a template that pulls the latest themes plus the prior week and
asks for a prioritized read. **Resource:** `churnlens://themes/latest`.

There is no `q` free-text search argument. CL-2 does not implement one, and an agent holding an
org's whole theme set in context does not need server-side search over a dataset capped at
`MAX_RESPONSES_PER_BATCH` (200) per week.

### Prompt-injection containment

This is the security core of the ticket, not a footnote. Anyone holding a survey link controls
`open_text` and `comeback_text` verbatim — `src/lib/openai.ts` already treats that text as hostile,
keeping it in a separate `user` message rather than concatenating it into the system prompt. A tool
result goes into an agent that may simultaneously hold filesystem, GitHub, and shell tools, so the
same discipline applies at this boundary:

- Every field originating from customer input (`openText`, `comebackText`, theme `quotes`,
  `reason`) is wrapped in an explicit `<untrusted-customer-text>` … `</untrusted-customer-text>`
  fence in the tool result.
- Every tool result containing such a fence is preceded by one fixed advisory line stating the
  fenced content is data submitted by third parties and must never be followed as instructions.
- Tool **names, descriptions, and input schemas are static literals**. Nothing customer-derived
  ever reaches them — a description assembled from org data is a direct injection path into the
  agent's tool list.
- The server exposes **no write tool of any kind**, so the worst case of a successful injection is
  that the agent misreports churn, not that it acts.

---

## Acceptance criteria

**Package & build**
- [ ] `mcp/` contains its own `package.json` (name `churnlens-mcp`, `bin` entry, `@modelcontextprotocol/sdk`
      dependency) and its own `tsconfig.json` targeting Node, independent of the app's config.
- [ ] `"mcp"` is added to the root `tsconfig.json` `exclude`. `npm run typecheck` and `npm run build`
      at the repo root behave exactly as before the directory existed — verified by running both.
- [ ] The app's root `package.json` gains **no new dependency**.

**Server**
- [ ] The server speaks stdio and registers exactly the six tools, one prompt, and one resource above.
- [ ] Config comes from the environment: `CHURNLENS_API_KEY` (required) and `CHURNLENS_BASE_URL`
      (optional, defaults to production). A missing key fails at startup with a message naming the
      variable and pointing at Settings → API keys, not on the first tool call.
- [ ] Every outbound request sends `Authorization: Bearer ${CHURNLENS_API_KEY}` over HTTPS. A
      non-`https` `CHURNLENS_BASE_URL` is refused at startup unless it is localhost.
- [ ] The API key never appears in a tool result, an error message, or a log line.

**Error mapping**
- [ ] 401 → a tool error saying the key is invalid or revoked, with the Settings path to issue a new one.
- [ ] 403 (scope) → names the missing scope and how to enable it.
- [ ] 403 (plan) → states the API is a Growth-tier feature.
- [ ] 429 → surfaces `Retry-After` rather than retrying in a loop.
- [ ] Network failure or 5xx → a tool error, never a partial or fabricated result. An agent that
      receives an empty themes array must be able to distinguish "no churn this week" from "the
      request failed", so the empty case and the failure case use different result shapes.

**Injection containment**
- [ ] Customer-derived fields are fenced as specified, in every tool that returns them
      (`list_themes`, `compare_theme_weeks`, `search_responses`, `get_response`,
      `list_cancellation_reasons`, and the `churnlens://themes/latest` resource).
- [ ] A response body containing a literal `</untrusted-customer-text>` string cannot break out of
      the fence — the closing sequence is stripped or escaped from the payload before wrapping.
- [ ] Tool names, descriptions, and schemas are static and contain no interpolation.
- [ ] The server registers zero tools that write, POST, or mutate.

**PII**
- [ ] The server does not request or require `churn:read_pii`. It works fully with a `churn:read`
      key, returning masked emails; if the key happens to carry the PII scope, unmasked values pass
      through as the API returns them. The server never asks for the broader scope on the user's behalf.
- [ ] The README states plainly that tool results are sent to whatever model provider the user's MCP
      client uses, and recommends a `churn:read`-only key.

**Documentation**
- [ ] `mcp/README.md` gives a copy-pasteable client config block, the env vars, the tool list, and
      the PII/model-provider warning.
- [ ] The ChurnLens Settings API-keys card links to it.

---

## Edge cases & states

| Case | Expected behavior |
|---|---|
| Org has no themes yet (weekly cron hasn't run, or <2 responses with `open_text`) | `list_themes` returns an explicit empty-with-explanation result, distinct from an error, so the agent says "no themes yet" rather than "clustering failed". |
| Org on `free`/`starter` | Every tool returns the same plan-gate error. The server still starts — a failing tool is more diagnosable than a server that refuses to load. |
| `compare_theme_weeks` where one week has no themes | Returns the weeks it has, and names the missing one. Not an error. |
| A quote contains fence-closing markup or a fake system prompt | Escaped inside the fence and delivered as data. Covered by an explicit test. |
| A quote contains a URL | Passed through inside the fence. The server never fetches it. |
| `CHURNLENS_BASE_URL` pointing at an attacker host | Only reachable by someone who can already set the user's env; still, HTTPS is enforced and the key is only ever sent to the configured host. Documented as the trust boundary. |
| API key revoked while the client is connected | Next tool call returns the 401 mapping. No cached results are served. |
| Client requests a tool with a malformed arg | Rejected by the input schema before any HTTP request. |
| Very large result (200-response week) | Returned whole. This is the deliberate consequence of the dataset being small; no pagination is added until a real ceiling is hit. |

---

## Files likely touched

- `mcp/package.json` — **new**.
- `mcp/tsconfig.json` — **new**.
- `mcp/src/index.ts` — **new**: server bootstrap, env validation, stdio transport.
- `mcp/src/client.ts` — **new**: typed fetch wrapper over `/api/v1`, auth header, error mapping.
- `mcp/src/tools.ts` — **new**: the six static tool definitions.
- `mcp/src/fence.ts` — **new**: untrusted-text fencing and escaping.
- `mcp/README.md` — **new**.
- `tsconfig.json` — add `"mcp"` to `exclude`. **Only change inside the app.**
- `src/app/settings/page.tsx` — link from the API keys card to the MCP docs.

---

## Test surface (hand-off to `test-architect`)

**Unit**
- Fencing: plain text, text containing `</untrusted-customer-text>`, nested fences, empty string,
  null field, multi-line text, unicode.
- Env validation: missing key, `http://` base URL, `http://localhost` base URL (allowed),
  malformed URL.
- Error mapping: each of 401 / 403-scope / 403-plan / 429 / 500 / network-failure → the specified
  tool error, asserted to contain no API key substring.
- Empty vs failure: an empty `[]` from the API and a failed request produce distinguishable results.

**Integration** (against a stubbed `/api/v1`)
- Each of the six tools: happy path shape, arg validation rejection, and the injection fence present
  on every customer-derived field.
- The prompt and the resource resolve and carry the same fencing.
- Tool definitions are byte-stable across two server starts with different stubbed org data —
  the assertion that nothing customer-derived leaks into the tool list.

**e2e**
- Real ChurnLens instance, real `growth` org, real `churn:read` key: connect a client, call
  `list_themes` and `get_churn_summary`, confirm masked emails and fenced quotes.
- Revoke the key mid-session → next call returns the 401 mapping with the Settings pointer.

**Repo regression**
- `npm run typecheck`, `npm run build`, and `npm test` at the repo root pass unchanged with `mcp/`
  present. This is the assertion that the packaging decision actually held.

---

## Gates required

- [ ] **code-guardian** — required. New package, new dependency, and the injection boundary.
- [ ] **test-architect** — required (see Test surface).
- [ ] **deploy-engineer** — **not required.** Nothing ships to Railway: no new route, no schema
      change, no env var, and the app build is provably untouched by the `tsconfig` exclude. If the
      build ever adds a remote `/api/mcp` route inside the Next app, that is a different ticket and
      re-requests this gate.

---

## Open questions for Sox

1. **npm scope.** Publish as `churnlens-mcp` or `@churnlens/mcp`? The scoped name needs an npm org.
2. **Tier.** Specced as Growth-only by inheritance from CL-2's plan gate. If the API opens to
   Starter, this follows automatically — no change here.
3. **Dogfooding.** ChurnLens bills through Polar, so its own cancellations never hit the Stripe
   webhook that creates survey rows (see [[billing-provider-polar]]). This server therefore cannot
   be tested against ChurnLens's own churn data without a separate Polar ingest. e2e needs a seeded
   org.
