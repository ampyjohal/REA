# Verification

Verified base: cbb7b613 (this branch before this file). Executed on macOS with
Node v22.23.1 (the repository pins 24.18.0 in `.nvmrc`, which was not
installed); the AgentEnv runs and the live comparison ran on a disposable Linux
VM. Every check below ran as written after the last source change.

## Gates

- `npm run build:cached`, `npm run check:fast` (typecheck and lint),
  `npm run format:check`, `npx knip`, `npm run scan:todos`, `npm run docs:check`
  and `npm run verify:test-discovery`: passed.
- `npm run jscpd`: 3.43% duplicated lines over 3538 files, under the 3.5% gate.
- `npx vitest run --project domain --project services`: 7407 passed, 5
  pre-existing skips.
- `npm run test:prepare`, then `npm run test:focused --` the new write MCP
  boundary, the serve MCP, CLI and process boundaries, the export CLI
  boundary, the analysis-view CLI and MCP boundaries, the compact input schema
  boundary and the contract description tests: 10 files, 72 passed.
- `npm run mcp-catalog:check`: passed.

New tests: `environmentStateWriteValues` (94), `environmentStateWriteExplain`
(101), `environmentStateWriteApply` (52), `environmentStateWrites` (16, the gate
through the view), `environmentStateWriteAnswer` (14, serving) and
`environmentServeWritesMcp` (1, the built CLI over MCP). The replay card pinned
by the serve MCP boundary changed with the response summaries tool descriptions
carry; its digest now matches the combined branch.

## Real captures

The `environment-state` view ran over the 51 showcase captures (44 HAR, 5
`capture_browser_scenario`, the rest public APIs), each within its budget in
8–110 ms. It served 33 write tools in 16 captures (11 creates, 12 updates, 10
deletes). Of the other 150 state-changing tools, 102 name no state type or
document (most write to literal single-entity paths the manifest left
untemplated, or to collections whose reads are not state-backed), and 48 are
modelled but not served:

- 15 unconfirmed (no later read checked them);
- 13 no-observation;
- 8 contradicted, for example a deleted Airbyte source and EspoCRM task still
  readable, Immich and BookStack item reads showing fields the create
  response lacked, and Sonarr's tag list ordering;
- 7 unexplained-change, such as BookStack's description_html and Paperless's
  derived text colour;
- 4 side-effect, for example a Sonarr tag also listed by `/tag/detail`;
- 1 incomplete-entities: WordPress answers a delete with the post in its edit
  context, which the reads never showed for seeded posts.

| Capture          | Served (create / update / delete) | Not served                                                                                      |
| ---------------- | --------------------------------- | ----------------------------------------------------------------------------------------------- |
| airbyte          | 2 / 2 / 0                         | create contradicted, delete contradicted, delete unconfirmed                                    |
| baserow          | none                              | no-state-target ×3                                                                              |
| bookstack        | 0 / 0 / 1                         | create contradicted, create side-effect, update unexplained-change                              |
| directus         | none                              | no-state-target ×2                                                                              |
| espocrm          | none                              | create unconfirmed, delete contradicted, update unexplained-change                              |
| ghost            | none                              | no-state-target ×2                                                                              |
| gitea            | 1 / 1 / 0                         | no-state-target ×2                                                                              |
| grafana          | none                              | create unconfirmed, no-state-target ×5                                                          |
| grist            | none                              | create no-observation, no-state-target ×5                                                       |
| grocy            | none                              | create no-observation, delete no-observation, update no-observation, no-state-target ×2         |
| healthchecks     | none                              | create no-observation, delete no-observation, update no-observation, no-state-target ×2         |
| homebox          | none                              | document no-observation, no-state-target ×3                                                     |
| immich           | 0 / 0 / 1                         | create contradicted, update contradicted                                                        |
| jellyfin         | none                              | no-state-target ×2                                                                              |
| keycloak         | none                              | no-state-target ×1                                                                              |
| komga            | none                              | create unconfirmed ×2, no-state-target ×4                                                       |
| linkding         | 2 / 2 / 2                         | create unconfirmed, delete unconfirmed, update unconfirmed, no-state-target ×2                  |
| listmonk         | 1 / 1 / 1                         | —                                                                                               |
| lychee           | none                              | no-state-target ×4                                                                              |
| mailpit          | none                              | document no-observation, no-state-target ×5                                                     |
| mattermost       | 1 / 1 / 1                         | no-state-target ×3                                                                              |
| mealie           | none                              | create no-observation, no-state-target ×2                                                       |
| memos            | none                              | no-state-target ×3                                                                              |
| metabase         | 0 / 0 / 1                         | create side-effect, update unexplained-change                                                   |
| miniflux         | 0 / 1 / 0                         | no-state-target ×3                                                                              |
| n8n              | none                              | create unconfirmed, no-state-target ×6                                                          |
| navidrome        | none                              | create no-observation, no-state-target ×2                                                       |
| netbox           | 1 / 1 / 1                         | —                                                                                               |
| nocodb           | none                              | create no-observation, no-state-target ×4                                                       |
| nomad            | none                              | no-state-target ×4                                                                              |
| paperless        | 0 / 0 / 1                         | create unconfirmed, update unexplained-change, no-state-target ×3                               |
| photoprism       | 1 / 1 / 0                         | delete unconfirmed                                                                              |
| pinry            | none                              | create unconfirmed, delete unconfirmed, update unexplained-change                               |
| pocketbase       | none                              | no-state-target ×4                                                                              |
| redpanda-console | none                              | document no-observation, no-state-target ×5                                                     |
| sentry           | 1 / 0 / 0                         | update unexplained-change, no-state-target ×3                                                   |
| shlink           | none                              | create unconfirmed, no-state-target ×1                                                          |
| sonarr           | 0 / 1 / 0                         | create contradicted, create side-effect, update contradicted                                    |
| tandoor          | none                              | no-state-target ×4                                                                              |
| umami            | 1 / 1 / 1                         | —                                                                                               |
| vault            | none                              | no-state-target ×7                                                                              |
| vikunja          | none                              | no-state-target ×4                                                                              |
| wordpress        | none                              | create side-effect, delete incomplete-entities, document unconfirmed, update unexplained-change |

An in-process smoke derived each capture's served state and called every served
write tool once with a varied body: all 33 applied (status equal to the
recording), and every created or updated entity read back from the state;
deleted entities answered the recorded 400 or 404 where one was recorded. Eight
older published manifests no longer match the tool names the current view
derives, so their state is unavailable and they serve replay, as designed;
none of them has a served write tool.

## End to end on a published environment

Five published environments serve a create, an update and a delete (Linkding,
Listmonk, Mattermost, NetBox, Umami); `random.SystemRandom().choice` picked
NetBox (NetBoxEnv-REA, NetBox 4.7.3).

- `rea environment-export` (packed from this branch) wrote the bundle; its
  smoke task passed in AgentEnv framework 0.9.1334 with 42 served tools (39
  reads and `post_dcim_sites`, `patch_dcim_sites_by_id`,
  `delete_dcim_sites_by_id`).
- Four write tasks, each graded by an `env_outcome_verifier` that reads the
  environment's state through `/agentenv` `data/get` (not the agent's reply),
  with the replay-qa agent over the Hugging Face router, one run per task and
  model:

| Task                                            | gpt-oss-120b | GLM-5.3-Flash | Tool calls (gpt-oss)                                         |
| ----------------------------------------------- | ------------ | ------------- | ------------------------------------------------------------ |
| Create a site in the Copper Valley region       | 1.0          | 1.0           | get_dcim_regions, post_dcim_sites                            |
| Update a seeded site's facility and description | 1.0          | 1.0           | get_dcim_sites, patch_dcim_sites_by_id                       |
| Delete one seeded site and only it              | 1.0          | 1.0           | get_dcim_sites, delete_dcim_sites_by_id                      |
| Create a site, then set its facility            | 1.0          | 1.0           | get_dcim_regions, post_dcim_sites, patch_dcim_sites_by_id ×2 |

- The bundle's 12 retrieval tasks (one per seeded object) passed 12/12 for both
  models, as they did on the published replay bundle.

## The served model against the live application

The same NetBox 4.7.3 image ran on the VM, seeded by the capture's own seed
script (the same ids), and one scenario ran against both the live API and the
environment served from the capture. Only `created` and `last_updated` were
normalised; every other member had to be equal:

| Step                                      | Live | Environment | Equal                        |
| ----------------------------------------- | ---- | ----------- | ---------------------------- |
| List sites                                | 200  | 200         | yes                          |
| Create Tide Gauge Annex (id 5)            | 201  | 201         | yes                          |
| Read it                                   | 200  | 200         | yes                          |
| List after the create (sorted by name)    | 200  | 200         | yes                          |
| Patch its description and facility        | 200  | 200         | yes                          |
| Read after the patch                      | 200  | 200         | yes                          |
| Create Granite Spur (id 6)                | 201  | 201         | yes                          |
| Patch a seeded site                       | 200  | 200         | yes                          |
| Delete Tide Gauge Annex                   | 204  | 204         | yes                          |
| Read the deleted site                     | 404  | 404         | yes                          |
| Create Ledger Point (id 7, not reusing 5) | 201  | 201         | yes                          |
| Delete a seeded site with devices         | 409  | 204         | no                           |
| Final list                                | 200  | 200         | no (follows from the delete) |

11 of 13 steps were equal. The difference is NetBox's referential protection:
it refuses to delete a site that devices reference, while the environment's
delete removes the entity alone. The capture only deleted a scratch site with
no dependents, so the gate could not see the rule; it is listed under what is
not modelled.

## Not covered

- A run of the hosted `real-agentenv` lane in CI (the AgentEnv runs here used
  the published framework release on a VM).
- Document writes on a real capture: the four modelled ones are unserved.
- Collections tied to a create's own collection on a real capture, and UUID
  or token identities through an AgentEnv run (both are covered by tests).
- Agent token usage and cost.

## After merging the base branches and main

The branch then merged the serving branch at 5a61853a, the coverage branch at
b4b7ebc7 (their review fixes) and main at edbd291a, then main at 17f581ff
(the analysis-view tool description string, which main changes often). The gates above ran again
and passed: `npm run jscpd` 3.44% over 3579 files; domain and services 7442
passed with 5 pre-existing skips; the focused boundary set 72 passed. The
write verdicts over the 51 captures were unchanged plan by plan, and the
in-process smoke again applied all 33 served write tools. The AgentEnv runs
and the live comparison above ran on cbb7b613, before these merges.
After the second main merge: `npm run check:fast`, `npm run format:check`,
`npm run docs:check` and `npm run mcp-catalog:check` passed; the contracts,
analysis-view and environment tests 857 passed with 3 pre-existing skips; the
analysis-view and environment MCP and CLI boundaries 53 passed.
