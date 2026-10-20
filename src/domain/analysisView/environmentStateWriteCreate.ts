import {
  isStateWrite,
  normalizedPath,
  scalarText,
  type JsonObject,
  type StateEntity,
} from "./environmentStateRules.js";
import { createdFields } from "./environmentStateWriteApply.js";
import {
  collectionTarget,
  entityTarget,
} from "./environmentStateWriteChecks.js";
import {
  built,
  callOf,
  fail,
  refuse,
  requestObject,
  searchFrom,
  startOf,
  UNKNOWN,
  type EffectContext,
  type EffectResult,
  type WriteDraft,
  type WriteStep,
} from "./environmentStateWriteEffects.js";
import {
  explainCreate,
  insertCandidates,
  insertIndex,
  responseShapeOf,
} from "./environmentStateWriteExplain.js";
import {
  laterObservation,
  newEntityIn,
  type Observed,
} from "./environmentStateWriteObserve.js";
import type { WriteCall } from "./environmentStateWriteRules.js";

/** The written entity a create's response or a later read shows. */
const createdObservation = (
  context: EffectContext,
  step: WriteStep,
  target: {
    readonly type: string;
    readonly collection: string;
    readonly idField: string;
  },
): Observed | undefined => {
  const held = (id: string) =>
    context.state.entity(target.type, target.collection, id) !== undefined;
  const own = context.io.withBody(step.record.ordinal, (body) =>
    newEntityIn(step.record.ordinal, body, target.idField, held),
  );
  if (own !== undefined) return own;
  const later = laterObservation(searchFrom(context, step), {
    ...target,
    held,
    isWrite: isStateWrite,
  });
  if (later !== undefined) context.observed(later.ordinal);
  return later;
};

const fieldsOf = (entities: readonly StateEntity[]): JsonObject[] =>
  entities.map((entity) => entity.fields);

/** Build a create plan from its exemplar's observation. */
const buildCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
  evidence: {
    readonly observed: Observed;
    readonly call: WriteCall & { readonly body: JsonObject };
    readonly collection: string;
  },
): void => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const members = fieldsOf(context.state.members(type, evidence.collection));
  const explained = explainCreate({
    entity: evidence.observed.object,
    call: evidence.call,
    idField,
    startMs: startOf(context, step),
    collection: members,
    type: fieldsOf(context.state.ofType(type)),
  });
  const clocks = explained.rules.flatMap((rule) =>
    rule.rule === "clock" ? [rule.field] : [],
  );
  // Identity and clock orders first, then any other scalar field the collection may be sorted by.
  const scalars = Object.keys(members[0] ?? {}).filter((field) =>
    members.every((member) =>
      ["string", "number"].includes(typeof member[field]),
    ),
  );
  draft.candidates = insertCandidates(members, [
    ...new Set([idField, ...clocks, ...scalars]),
  ]);
  Object.assign(draft.plan, {
    exemplar_ordinal: step.record.ordinal,
    observation: {
      ordinal: evidence.observed.ordinal,
      pointer: evidence.observed.pointer,
    },
    response: context.io.withBody(step.record.ordinal, (body) =>
      responseShapeOf(
        step.record.ordinal,
        body,
        context.io.emptyResponse(step.record.ordinal),
        { idField, id: evidence.observed.id },
      ),
    ),
    body: explained.body,
    rules: explained.rules,
    collection: explained.tied ? evidence.collection : null,
    insert: draft.candidates[0]!,
  });
  draft.observed = evidence.observed.object;
};

/** Add a created entity to the state at the plan's insert position, or last before the plan has one. */
const insertCreated = (
  context: EffectContext,
  draft: WriteDraft,
  entity: StateEntity,
): string => {
  const members = fieldsOf(
    context.state.members(entity.type, entity.collection),
  );
  context.io.retain(64 + JSON.stringify(entity.fields).length * 2);
  context.state.put(
    entity,
    draft.plan.insert === null
      ? members.length
      : insertIndex(draft.plan.insert, members, entity.fields),
  );
  return entityTarget(entity.type, entity.collection, entity.id);
};

/** Apply a recorded create, with the values it recorded for generated fields; an unexplained create adds what it recorded. */
export const applyCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const collection = normalizedPath(step.record.path);
  const body = requestObject(context, step.record);
  const observed = createdObservation(context, step, {
    type,
    collection,
    idField,
  });
  if (observed === undefined) {
    fail(draft, step, body === undefined ? "body-unusable" : "no-observation");
    return UNKNOWN;
  }
  const entity = (fields: JsonObject, id: string): StateEntity => ({
    type,
    collection,
    id,
    fields,
    view_fields: [],
    record_ordinals: [],
  });
  const recorded = (): EffectResult => {
    const inserted = insertCreated(
      context,
      draft,
      entity(observed.object, observed.id),
    );
    return {
      kind: "observed",
      targets: [inserted, collectionTarget(type, collection)],
      entity: { type, collection, id: observed.id },
    };
  };
  if (step.observeOnly || body === undefined) {
    fail(draft, step, "body-unusable");
    return recorded();
  }
  const call = { ...callOf(step, body), body };
  if (!built(draft))
    buildCreate(context, draft, step, { observed, call, collection });
  const fields = createdFields(
    draft.plan,
    draft.observed!,
    call,
    (rule) => observed.object[rule.field] ?? null,
  );
  const id = fields.ok ? scalarText(fields.value[idField]) : undefined;
  if (
    !fields.ok ||
    id === undefined ||
    context.state.entity(type, collection, id) !== undefined
  ) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  const inserted = insertCreated(context, draft, entity(fields.value, id));
  return {
    kind: "applied",
    targets: [inserted, collectionTarget(type, collection)],
    entity: { type, collection, id },
    inserted,
  };
};
