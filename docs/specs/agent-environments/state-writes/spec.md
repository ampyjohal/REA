# Apply write effects to the served state

Issue: https://github.com/morluto/rea/issues/4933

## Outcome

An environment served from its state also serves the write tools whose effects
the capture itself confirms:

- a create adds an entity;
- an update changes the fields the call sends;
- a delete removes the entity;
- a document write changes a document.

Later reads, list membership and `data/get` show the change, and `data/reset`
undoes it.

The `environment-state` view decides which write tools are served. It replays
the capture's own timeline on the extracted initial state: each recorded write
applies its modelled effect, and each later read that the state answers is
rendered and compared with the recorded response. A write tool is served only
when at least one later read reproduces after its effect and none contradicts
it. Every other write tool stays unserved, listed with the reason.

Values the application generates are deterministic: identities, sequences and
clock values follow the formats the capture recorded, so the same calls after
a reset give the same state.

## Write plans

The view adds two members to its result:

- `writes`: one plan per manifest tool whose method may change state
  (`changesState`);
- `write_clock`: the instant the served clock starts from.

**Effects.** Each plan classifies its tool:

| Effect     | Tool                                                                  | Target                    |
| ---------- | --------------------------------------------------------------------- | ------------------------- |
| `create`   | `POST` to a state type's `collection_template`                        | an entity of that type    |
| `update`   | `PUT`, `PATCH` or `POST` to that template plus one trailing parameter | the entity the path names |
| `delete`   | `DELETE` to that same item template                                   | the entity the path names |
| `document` | `PUT`, `PATCH` or `POST` to a document view's path                    | that document             |
| `none`     | anything else                                                         | reason `no-state-target`  |

**Exemplar.** A plan is built from its first successful (2xx) recorded call,
the exemplar.

- **Request body.** The exemplar's request body must be a JSON object that
  could enter the state: a JSON-like media type, complete UTF-8 text within
  256 KiB, exact numbers, no `__proto__` member. Otherwise the reason is
  `body-unusable`. A `DELETE` takes no body.
- **The written entity.** The entity is observed in the exemplar's response,
  located by its identity value at the root, in one member, or in a
  one-element array, as item views locate it. When the response does not carry
  it, the entity is observed in the first later read that shows it: an item
  read of that entity, or for a create, the one entity a collection read newly
  lists. With neither, the reason is `no-observation`.

**Field rules for creates.** Each field of the observed entity gets the first
rule that explains its value. Rules that read the call come first, so an
identity the client sends is an echo:

1. **Echo.** A body member of the same name with an equal value.
2. **Copy.** A body string of 8 or more characters, found at a JSON pointer of
   the body (the shallowest match).
3. **Path.** The value of a path parameter of the call.
4. **Slug.** The slug of a body string member: lower case, runs of other
   characters joined by `-`.
5. **Identity.** The type's `id_field` is generated. A sequence when it is an
   integer (or a string of digits); otherwise a UUID when it has the
   `8-4-4-4-12` hex shape; otherwise a token of the same length and character
   classes.
6. **Clock.** A timestamp within 10 minutes of the exemplar's start time. The
   format is kept: ISO-8601 with its separator, fraction digits and zone, or
   epoch seconds or milliseconds.
7. **Sequence.** An integer one greater than the largest value of the field in
   the collection, else in the type.
8. **Unique.** A UUID-shaped string that no other entity of the type shares.
9. **Template.** A string containing a generated value as a delimited token
   (for example a URL that ends in the new id). It is rebuilt around the new
   value.
10. **Constant.** Otherwise the exemplar's value.

When a constant, or the text a template keeps, contains a path value of the
exemplar's call as a delimited token, the create is served only for calls
naming the exemplar's collection.

**Body members of a create.** A member is either accepted or not:

- **Accepted.** An echoed member, or the identity field's value. Every member
  the exemplar sent is required.
- **Not accepted.** A member the application stored with a different value
  (transformed), or one it did not show. A call that sends such a member is a
  tool error naming the accepted members.

**Updates.** Body members follow the same accepted and not-accepted rules.
`PUT` requires every member the exemplar sent; `PATCH` and `POST` require at
least one. A field the exemplar's update changed without sending it is
explained as one of:

- clock;
- an increment by one;
- a slug of an echoed member.

Any other change is `unexplained-change`.

**Deletes.** A delete removes the entity. Its response is the exemplar's
response, with the entity re-rendered when the response carries it.

**Documents.** A document write merges the body's members (replaces them, for
`PUT`) into the document object that holds most of them: the root or one
member.

**Responses.** A write answers with the status and content type of one
recorded response:

| Response   | Body                                                                                                      |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `entity`   | the written entity, rendered into the recorded envelope at the plan's pointer through the recorded fields |
| `identity` | the recorded body with the new identity at the plan's pointer                                             |
| `empty`    | no body                                                                                                   |
| `recorded` | the recorded body                                                                                         |

A rendered body missing a field the recorded response carried is a tool error,
and the state is left unchanged.

**List position.** A create's `insert` rule places the new entity in its
collection's order: sorted by the identity field or a clock field (ascending
or descending), `first` or `last`. The rule is the first candidate consistent
with both the initial `all`-membership recordings and the position a later
recorded list shows. With no evidence, the rule is `last`.

## The gate

The view replays every primary-origin record in timeline order on a copy of
the initial state.

**Writes.** A modelled write applies its effect, using the values it recorded
for generated fields and the stored values for fields it transformed. A
modelled write whose call the plan does not explain brings its entity to the
recorded outcome instead, without attribution.

Any other successful write is unmodelled, and what it may have changed
depends on where its path lies relative to each type's collection paths
(segment-prefix related, parameters matching any segment):

- **Below an item path:** the named entity is unknown until a read shows it
  again. When the path names no held entity, every entity of that collection
  is unknown.
- **At a collection path:** that collection is not checked again.
- **Above collection paths:** everything under the path is not checked again.

An item read of an unknown entity shows it again: the copy takes its recorded
values. Writes that changed it since its last check are checked only on the
members they sent.

**Reads.** A read is checked when the served environment would answer it
from the state:

- an item read of a state-backed item view;
- a list or document read on one of its view's checked request lines.

**Comparison.** The read's answer is rendered from the copy and compared with
the recording, as the read gate compares, with volatile fields taking the
observed values. A recorded 400, 404 or 410, or a 2xx with a JSON `null`
body, for an entity the copy does not hold agrees with it.

**Attribution.**

- A check exercises the write tools that changed its entity or collection
  since the previous check of it. A pass confirms them and a mismatch
  contradicts them.
- A mismatch after an unmodelled write that followed those writes is checked
  only on the members they sent: such a write may explain the rest.
- A mismatch on an entity or collection that no write changed contradicts,
  as `side-effect`, the modelled writes since that previous check whose paths
  are segment-prefix related to the read's path.
- After a failed item check, the copy takes the read's recorded values (or
  drops the entity on a recorded absence). A list whose check failed is not
  checked again.
- A list that fails only for where one create placed its entity passes when
  another of that create's insert candidates reproduces it, which then
  becomes the plan's rule.
- The read that supplied a create's or update's observation does not check
  it.

**Verdicts.** A plan is served when at least one check confirms it and none
contradicts it. Otherwise the reason, in this precedence, is:

1. the first build reason;
2. `contradicted`, with `contradicted_by` naming the first contradicting read;
3. `side-effect`;
4. `unconfirmed`;
5. `incomplete-entities`: an update or delete that answers with the entity,
   when no initial entity holds every field its recorded answer shows (for
   example a delete that answers with an edit view of the entity the reads
   never showed), so it could answer only for entities the environment itself
   created.

`checked_record_ordinals` lists the confirming reads.

## Serving

**Catalog.** In state mode, the catalog adds the write tools whose plan is
served. Their descriptions say the tool:

- applies its effect to the served state;
- names its target type;
- lists its required and accepted body members.

The discovery budget charges them. `--replay-only` and the replay fallback are
unchanged.

**Calls.** A served write answers synchronously against the live store and
changes it atomically, so every MCP session and `data/get` see one state.

**Refusals.** These are tool errors that leave the state unchanged:

- a body that is not an object;
- a missing required member;
- a member that is not accepted;
- a value of another JSON type than the exemplar's;
- an update or delete of an entity the state does not hold;
- a create in another collection when the plan is tied to its own;
- a rendered response missing a recorded field.

When the tool, or else an item view of the type, recorded a 400, 404 or 410
response, an update or delete of a missing entity answers with the latest such
recording instead.

**Clock and generators.** The store's clock starts at `write_clock` and
advances one second before each served write; clock fields take its value in
their recorded format.

- **Sequences:** one more than both the largest current value in their scope
  and the largest value they generated, so a deleted entity's value is not
  reused, as database sequences do not reuse values.
- **UUIDs and tokens:** derived from a SHA-256 of the state Evidence id, the
  tool, the field and a write counter, skipping values the type already holds.

`data/reset` and `data/add` restart the clock, the counter and the
sequences.

**Missing entities.** An item read of an entity the state does not hold
answers with the tool's latest recorded 400, 404 or 410 response when it has
one, labelled `state.view: "missing"`. Otherwise it stays a tool error.

**Lists of a whole collection.** Written entities matter only if lists show
them, so the read gate's `membership: "all"` also covers a line that only pages
its list (`limit`, `offset`, `page`, `per_page`, `perpage`, `page_size`,
`pagesize`, `size`, `start`, `_start`, `_end`) when its recording listed the
whole collection. A list call with no query argument answers from such a line
of an `all` view, with `replay.exact_match` false. A call that asks for a page
still answers from its recording.

**Provenance.** Write answers carry `state: {source: "state", view: "create" |
"update" | "delete", type, collection, id}`, or `{source: "state", view:
"document-write", path}`.

**Data plane and export.**

- `data/get` reports written entities without record citations; they load
  back through `data/add` unchanged.
- `environment-export` counts served write tools in the bundle's tool count
  and README. Its check stays a read tool.

## Not modelled

These stay unserved, or are labelled in the description:

- side effects on counters, relations and copies of entities in other
  collections;
- inputs the application transforms;
- members the capture never sent;
- reordering after an update;
- membership of filtered or paged lists, which answer their recorded members;
- write paths the manifest left literal;
- writes whose request body the capture did not retain;
- referential rules on delete: a delete removes the entity alone, so an
  application that refuses to delete a referenced entity, or deletes its
  dependents with it, is not modelled;
- authorization.

## Acceptance

- **Domain tests:** classification, every field rule, request-body admission,
  observation from a later read, the insert rules, every verdict and reason,
  attribution and resynchronisation, and taint by an unmodelled write.
- **Services tests:**
  - store mutations and their atomicity;
  - every refusal;
  - generated values and their determinism across reset;
  - `data/get` round trips of written entities;
  - the recorded 404 for missing entities;
  - the catalog and descriptions in each mode.
- **Boundary test:** a write tool changes the next read over MCP.

**Real captures.**

- The view runs over every showcase capture within its budget, and the
  verification reports, per capture, the write tools served and the reasons
  for the rest.
- One environment, chosen at random among those serving a write tool, is
  exported, run in the AgentEnv framework, and graded from `data/get` after an
  agent's create, update and delete.
- The served model is compared with that application running live on the same
  calls.

No test reaches an external network.
