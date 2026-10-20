import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  at,
  isObject,
  pointerTokens,
  replaceAt,
  same,
  scalarText,
  type JsonObject,
  type StateEntity,
} from "./environmentStateRules.js";
import type {
  FieldRule,
  GeneratedRule,
  StateWritePlan,
  WriteBody,
  WriteCall,
  WriteResponse,
} from "./environmentStateWriteRules.js";
import {
  integerOf,
  replaceDelimited,
  slugOf,
  spelledLike,
} from "./environmentStateWriteValues.js";

/** The value a generated rule takes: recorded values in the gate, the store's generators when served. */
export type GenerateValue = (rule: GeneratedRule) => JsonValue;

/** A refusal message naming what the call did wrong; the state is left unchanged. */
type Applied<T> = Result<T, string>;

const kindOf = (value: JsonValue | undefined): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

const listed = (members: readonly string[]): string =>
  members.length === 0 ? "none" : members.join(", ");

/** What a body may hold, for refusal messages. */
const bodyContract = (body: WriteBody): string =>
  `accepted members: ${listed(body.accepted)}; members accepted only with their recorded value: ${listed(body.fixed.map(({ member }) => member))}; required: ${listed(body.required)}`;

/** Why a call's body does not fit the members the capture showed, if it does not; `shapes` gives each accepted member's JSON type. */
export const bodyProblem = (
  body: WriteBody,
  call: WriteCall,
  shapes: { readonly entity: JsonObject; readonly id?: string },
): string | undefined => {
  const sent = call.body ?? {};
  const fixed = new Map(body.fixed.map((entry) => [entry.member, entry.sent]));
  for (const [member, value] of Object.entries(sent)) {
    if (member === body.identity) {
      if (scalarText(value) !== shapes.id)
        return `Member ${member} must repeat the target's identity ${shapes.id ?? ""}.`;
      continue;
    }
    if (fixed.has(member)) {
      if (!same(fixed.get(member), value))
        return `Member ${member} is accepted only with the value the capture sent, because the application stored it differently (${bodyContract(body)}).`;
      continue;
    }
    if (!body.accepted.includes(member))
      return `Member ${member} is not one the capture showed stored (${bodyContract(body)}).`;
    const recorded = shapes.entity[member];
    if (
      recorded !== undefined &&
      recorded !== null &&
      kindOf(recorded) !== kindOf(value)
    )
      return `Member ${member} must be a JSON ${kindOf(recorded)}, as the capture stored it.`;
  }
  const missing = body.required.filter(
    (member) => !Object.hasOwn(sent, member),
  );
  if (missing.length > 0)
    return `The call lacks required members ${missing.join(", ")} (${bodyContract(body)}).`;
  return undefined;
};

/** The value at a JSON pointer inside a body, following array indexes and members. */
export const valueAt = (
  body: JsonValue,
  pointer: string,
): JsonValue | undefined => {
  let value: JsonValue | undefined = body;
  for (const token of pointerTokens(pointer)) {
    if (Array.isArray(value)) value = value[Number(token)];
    else if (isObject(value) && Object.hasOwn(value, token))
      value = value[token];
    else return undefined;
  }
  return value;
};

/** A path value spelled as the observed value: a number when the observed value is one. */
const pathValue = (observed: JsonValue | undefined, text: string): JsonValue =>
  typeof observed === "number" && integerOf(text) !== undefined
    ? Number(text)
    : text;

/** One field's value under a rule that reads the call or generates. */
const ruledValue = (
  rule: FieldRule,
  observed: JsonObject,
  call: WriteCall,
  generate: GenerateValue,
): Applied<JsonValue | undefined> => {
  const body = call.body ?? {};
  switch (rule.rule) {
    case "identity":
    case "sequence":
    case "unique":
    case "clock":
      return ok(generate(rule));
    case "echo":
      return ok(Object.hasOwn(body, rule.field) ? body[rule.field] : undefined);
    case "copy": {
      const value = valueAt(body, rule.from);
      return value === undefined
        ? err(
            `The call has no value at ${rule.from} in its body, which ${rule.field} copies.`,
          )
        : ok(value);
    }
    case "path": {
      const value = call.pathValues.get(rule.from);
      return value === undefined
        ? err(
            `The call names no ${rule.from} path value, which ${rule.field} takes.`,
          )
        : ok(pathValue(observed[rule.field], value));
    }
    default:
      return ok(undefined);
  }
};

/** A string field rebuilt around the new value of the generated field it embeds. */
const templated = (
  observed: JsonObject,
  written: JsonObject,
  rule: Extract<FieldRule, { rule: "template" }>,
): JsonValue | undefined => {
  const text = observed[rule.field];
  const token = scalarText(observed[rule.from]);
  const replacement = scalarText(written[rule.from]);
  return typeof text === "string" &&
    token !== undefined &&
    replacement !== undefined
    ? replaceDelimited(text, token, replacement)
    : undefined;
};

/** Apply the rules that derive from fields already written: slugs and templates. */
const derive = (
  rules: readonly FieldRule[],
  observed: JsonObject,
  written: JsonObject,
  sent: JsonObject,
): void => {
  for (const rule of rules) {
    if (rule.rule === "slug") {
      const from = sent[rule.from];
      if (typeof from === "string") written[rule.field] = slugOf(from);
    } else if (rule.rule === "template") {
      const value = templated(observed, written, rule);
      if (value !== undefined) written[rule.field] = value;
    }
  }
};

/** The fields of a created entity: the observed entity with every ruled field taken from the call or generated. */
export const createdFields = (
  plan: Pick<StateWritePlan, "rules" | "body">,
  observed: JsonObject,
  call: WriteCall,
  generate: GenerateValue,
): Applied<JsonObject> => {
  if (plan.body === null) return err("The tool has no modelled body.");
  const problem = bodyProblem(plan.body, call, { entity: observed });
  if (problem !== undefined) return err(problem);
  const written: JsonObject = { ...observed };
  for (const rule of plan.rules) {
    const value = ruledValue(rule, observed, call, generate);
    if (!value.ok) return value;
    if (value.value !== undefined) written[rule.field] = value.value;
    else if (rule.rule === "echo") delete written[rule.field];
  }
  derive(plan.rules, observed, written, call.body ?? {});
  return ok(written);
};

/** The fields of an updated entity: sent echoed members, constants from the recorded update, generated and derived changes. */
export const updatedFields = (
  plan: Pick<StateWritePlan, "rules" | "body">,
  entity: { readonly before: JsonObject; readonly observed: JsonObject },
  call: WriteCall & { readonly id: string },
  generate: GenerateValue,
): Applied<JsonObject> => {
  const { before, observed } = entity;
  if (plan.body === null) return err("The tool has no modelled body.");
  const sent = call.body ?? {};
  const problem = bodyProblem(plan.body, call, {
    entity: { ...observed, ...before },
    id: call.id,
  });
  if (problem !== undefined) return err(problem);
  const members = Object.keys(sent).filter(
    (member) => member !== plan.body?.identity,
  );
  if (members.length === 0)
    return err(
      `The call sends none of the members an update applies (${bodyContract(plan.body)}).`,
    );
  const written: JsonObject = { ...before };
  for (const rule of plan.rules) {
    if (rule.rule === "echo" || rule.rule === "constant") {
      if (!Object.hasOwn(sent, rule.field)) continue;
      written[rule.field] =
        rule.rule === "echo" ? sent[rule.field]! : observed[rule.field]!;
    } else if (rule.rule === "increment") {
      const was = integerOf(before[rule.field]);
      if (was !== undefined)
        written[rule.field] = spelledLike(before[rule.field]!, was + 1);
    } else if (rule.rule === "clock") written[rule.field] = generate(rule);
  }
  derive(
    plan.rules.filter(
      (rule) => rule.rule !== "slug" || Object.hasOwn(sent, rule.from),
    ),
    observed,
    written,
    sent,
  );
  return ok(written);
};

/** A document after a write: the body's members merged into, or replacing, the object at the pointer. */
export const writtenDocument = (
  plan: Pick<StateWritePlan, "merge" | "observation">,
  before: JsonValue,
  call: WriteCall,
): Applied<JsonValue> => {
  const pointer = plan.observation?.pointer ?? "";
  const target = at(before, pointer);
  if (!isObject(target) || call.body === undefined)
    return err("The call's body does not fit the document.");
  const value =
    plan.merge === "replace" ? { ...call.body } : { ...target, ...call.body };
  return ok(replaceAt(before, pointer, value));
};

/** A write's answer body from its recorded response: the entity or identity rendered in, nothing, or the recorded body. */
export const writtenResponse = (
  response: WriteResponse,
  recorded: JsonValue | undefined,
  written: { readonly fields: JsonObject | undefined; readonly id: string },
): Applied<JsonValue | undefined> => {
  if (response.shape === "empty") return ok(undefined);
  if (response.shape === "recorded" || recorded === undefined)
    return ok(recorded);
  const pointer = response.pointer ?? "";
  const shown = at(recorded, pointer);
  if (response.shape === "identity")
    return ok(
      replaceAt(
        recorded,
        pointer,
        typeof shown === "number" && integerOf(written.id) !== undefined
          ? Number(written.id)
          : written.id,
      ),
    );
  if (!isObject(shown) || written.fields === undefined)
    return err("The recorded response does not carry the entity.");
  const missing = Object.keys(shown).filter(
    (field) => !Object.hasOwn(written.fields!, field),
  );
  if (missing.length > 0)
    return err(
      `The state holds no complete entity for this response: it lacks ${missing.join(", ")}.`,
    );
  return ok(
    replaceAt(
      recorded,
      pointer,
      Object.fromEntries(
        Object.keys(shown).map((field) => [field, written.fields![field]!]),
      ),
    ),
  );
};

/** An entity with updated fields: view-specific values of the fields that changed give way to the new values, and it cites no records. */
export const updatedEntity = (
  entity: StateEntity,
  fields: JsonObject,
): StateEntity => {
  const changed = new Set(
    Object.keys(fields).filter(
      (field) => !same(entity.fields[field], fields[field]),
    ),
  );
  // Written values are no longer the ones the cited records show.
  return {
    ...entity,
    fields,
    record_ordinals: [],
    view_fields: entity.view_fields
      .map((view) => ({
        tool: view.tool,
        fields: Object.fromEntries(
          Object.entries(view.fields).filter(([field]) => !changed.has(field)),
        ),
      }))
      .filter((view) => Object.keys(view.fields).length > 0),
  };
};
