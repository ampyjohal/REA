import {
  createdFields,
  updatedEntity,
  updatedFields,
  valueAt,
  writtenDocument,
  writtenResponse,
  type GenerateValue,
} from "../../domain/analysisView/environmentStateWriteApply.js";
import { insertIndex } from "../../domain/analysisView/environmentStateWriteExplain.js";
import type {
  GeneratedRule,
  StateWritePlan,
  WriteCall,
} from "../../domain/analysisView/environmentStateWriteRules.js";
import {
  formatClock,
  integerOf,
  isUuid,
  seededToken,
  seededUuid,
  spelledLike,
} from "../../domain/analysisView/environmentStateWriteValues.js";
import {
  isObject,
  scalarText,
  type JsonObject,
  type StateEntity,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  replayAnswer,
  selectReplayExchange,
  type ReplayArguments,
} from "./environmentReplay.js";
import type { EnvironmentManifestTool } from "./environmentSource.js";
import {
  callSegments,
  collectionMatch,
  itemCall,
  missingAnswer,
  namedEntity,
  recordedJson,
  refused,
  stateAnswer,
  type StateAnswer,
  type StateProvenance,
  type StateServing,
} from "./environmentStateAnswer.js";
import { environmentToolArguments } from "./environmentTools.js";

/** Attempts at a generated UUID or token before a collision with held values is refused. */
const GENERATION_ATTEMPTS = 64;

/** One served write call: the tool, its plan and its arguments. */
interface WriteRequest {
  readonly tool: EnvironmentManifestTool;
  readonly plan: StateWritePlan;
  readonly args: ReplayArguments;
}

/** The path values a call supplies, keyed by template segment as write plans name them. */
const pathValues = (
  tool: EnvironmentManifestTool,
  args: ReplayArguments,
): Map<string, string> => {
  const names = environmentToolArguments(tool).path;
  const template = tool.path_template
    .slice(tool.path_template.indexOf("/") + 1)
    .split("/");
  const values = new Map<string, string>();
  for (const param of tool.params) {
    const value = args[names.get(param.name) ?? param.name];
    const segment = template[param.index] ?? "";
    if (typeof value === "string") values.set(segment.slice(1, -1), value);
  }
  return values;
};

/** The call's body: an object, nothing, or a refusal for any other value. */
const callBody = ({
  tool,
  args,
}: WriteRequest): Result<JsonObject | undefined, AnalysisError> => {
  const name = environmentToolArguments(tool).body;
  const value = name === undefined ? undefined : args[name];
  if (value === undefined) return ok(undefined);
  return isObject(value as JsonValue)
    ? ok(value as JsonObject)
    : err(refused(tool, `Tool ${tool.name} takes a JSON object body.`));
};

/** The entity a recorded observation shows: the values a create keeps and an update's constants. */
const observedEntity = (
  serving: StateServing,
  plan: StateWritePlan,
): JsonObject | undefined => {
  if (plan.observation === null) return undefined;
  const exchange = serving.source.exchanges.get(plan.observation.ordinal);
  const body = exchange === undefined ? undefined : recordedJson(exchange);
  const object =
    body === undefined ? undefined : valueAt(body, plan.observation.pointer);
  return isObject(object) ? object : undefined;
};

/** The largest integer the entities hold in a field, plus one. */
const nextInteger = (entities: readonly StateEntity[], field: string): number =>
  entities.reduce(
    (largest, entity) =>
      Math.max(largest, integerOf(entity.fields[field]) ?? 0),
    0,
  ) + 1;

/**
 * Values one served write generates: its clock instant, sequences one past the largest held
 * value, and UUIDs and tokens seeded by the state Evidence, tool, field and write count,
 * skipping values the type already holds.
 */
const generator = (
  serving: StateServing,
  request: WriteRequest,
  target: {
    readonly name: string;
    readonly collection: readonly StateEntity[];
    readonly observed: JsonObject;
  },
): {
  readonly generate: GenerateValue;
  readonly taken: Map<string, number>;
} => {
  const { store } = serving;
  const write = store.pendingWrite();
  const taken = new Map<string, number>();
  const sequence = (key: string, held: number): number => {
    const value = store.sequenceAfter(key, held);
    taken.set(key, value);
    return value;
  };
  const ofType = store.ofType(request.plan.target ?? "");
  const unused = (field: string, make: (attempt: number) => string): string => {
    const held = new Set(
      ofType.map((entity) => scalarText(entity.fields[field])),
    );
    for (let attempt = 0; attempt < GENERATION_ATTEMPTS; attempt += 1) {
      const value = make(attempt);
      if (!held.has(value)) return value;
    }
    return make(GENERATION_ATTEMPTS);
  };
  const generate = (rule: GeneratedRule): JsonValue => {
    const exemplar = target.observed[rule.field] ?? "";
    const seed = (attempt: number) =>
      `${store.state.evidenceId}:${request.tool.name}:${rule.field}:${String(write.count)}:${String(attempt)}`;
    switch (rule.rule) {
      case "clock":
        return formatClock(write.clockMs, rule.format);
      case "sequence":
        return spelledLike(
          exemplar,
          sequence(
            `${request.tool.name} ${rule.field} ${rule.scope === "collection" ? target.name : ""}`,
            nextInteger(
              rule.scope === "collection" ? target.collection : ofType,
              rule.field,
            ),
          ),
        );
      case "unique":
        return unused(rule.field, (attempt) =>
          seededUuid(seed(attempt), String(exemplar)),
        );
      case "identity":
        if (rule.generator === "sequence")
          return spelledLike(
            exemplar,
            sequence(
              `${request.plan.target ?? ""} ${rule.field} ${target.name}`,
              nextInteger(target.collection, rule.field),
            ),
          );
        return unused(rule.field, (attempt) =>
          rule.generator === "uuid" || isUuid(exemplar)
            ? seededUuid(seed(attempt), String(exemplar))
            : seededToken(seed(attempt), String(exemplar)),
        );
    }
  };
  return { generate, taken };
};

/** A write's answer on its recorded response's status and content type: a rendered body, none, or the recorded one. */
const writeAnswer = (
  serving: StateServing,
  request: WriteRequest,
  rendered: { readonly fields: JsonObject | undefined; readonly id: string },
  state: StateProvenance,
): Result<StateAnswer, AnalysisError> => {
  const { plan, tool, args } = request;
  const exchange =
    plan.response === null
      ? undefined
      : serving.source.exchanges.get(plan.response.ordinal);
  if (plan.response === null || exchange === undefined)
    return err(refused(tool, `Tool ${tool.name} has no recorded response.`));
  const exact =
    selectReplayExchange(tool, new Map([[exchange.ordinal, exchange]]), args)
      ?.exact === true;
  if (plan.response.shape === "recorded")
    return ok({ ...replayAnswer(serving.source, exchange, exact), state });
  const body = writtenResponse(plan.response, recordedJson(exchange), rendered);
  if (!body.ok) return err(refused(tool, body.error));
  return stateAnswer(serving, { exchange, exact }, body.value ?? null, state);
};

/** The collection a create writes to: a held collection the call's path matches, else the path as supplied. */
const createdCollection = (
  serving: StateServing,
  request: WriteRequest,
): string | undefined => {
  const segments = callSegments(request.tool, request.args);
  if (segments === undefined) return undefined;
  const held = serving.store
    .collectionsOf(request.plan.target ?? "")
    .find((collection) => collectionMatch(collection, segments) !== undefined);
  return (
    held ??
    `/${segments.map(({ text, supplied }) => (supplied ? encodeURIComponent(text) : text)).join("/")}`
  );
};

const answerCreate = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const type = plan.target ?? "";
  const idField = serving.store.type(type)?.id_field ?? "";
  const collection = createdCollection(serving, request);
  const observed = observedEntity(serving, plan);
  if (collection === undefined || observed === undefined)
    return err(refused(tool, `Tool ${tool.name} needs every path argument.`));
  if (plan.collection !== null && plan.collection !== collection)
    return err(
      refused(
        tool,
        `The recorded create's values are tied to ${plan.collection}; the environment models creates only there.`,
      ),
    );
  const members = serving.store.inCollection(type, collection);
  const values = generator(serving, request, {
    name: collection,
    collection: members,
    observed,
  });
  const fields = createdFields(plan, observed, call, values.generate);
  if (!fields.ok) return err(refused(tool, fields.error));
  const id = scalarText(fields.value[idField]);
  if (
    id === undefined ||
    serving.store.entity(type, collection, id) !== undefined
  )
    return err(
      refused(
        tool,
        `The state already holds a ${type} entity ${id ?? ""} in ${collection}.`,
      ),
    );
  const state = {
    source: "state",
    view: "create",
    type,
    collection,
    id,
  } as const;
  const answer = writeAnswer(
    serving,
    request,
    { fields: fields.value, id },
    state,
  );
  if (!answer.ok) return answer;
  serving.store.insert(
    {
      type,
      collection,
      id,
      fields: fields.value,
      view_fields: [],
      record_ordinals: [],
    },
    insertIndex(
      plan.insert ?? { rule: "last" },
      members.map((entity) => entity.fields),
      fields.value,
    ),
  );
  serving.store.commitWrite(values.taken);
  return answer;
};

/** The held entity an update or delete names, or the answer for one the state does not hold. */
const targetEntity = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateEntity, Result<StateAnswer, AnalysisError>> => {
  const { tool, plan, args } = request;
  const call = itemCall(tool, args);
  if (call === undefined)
    return err(
      err(refused(tool, `Tool ${tool.name} needs every path argument.`)),
    );
  const entity = namedEntity(serving.store, plan.target ?? "", call);
  return entity === undefined
    ? err(
        missingAnswer(serving, tool, {
          type: plan.target ?? "",
          collection: `/${call.segments.map(({ text }) => text).join("/")}`,
          id: call.id,
        }),
      )
    : ok(entity);
};

const answerUpdate = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const target = targetEntity(serving, request);
  if (!target.ok) return target.error;
  const entity = target.value;
  const observed = observedEntity(serving, plan) ?? {};
  const values = generator(serving, request, {
    name: entity.collection,
    collection: serving.store.inCollection(entity.type, entity.collection),
    observed,
  });
  const written = updatedFields(
    plan,
    { before: entity.fields, observed },
    { ...call, id: entity.id },
    values.generate,
  );
  if (!written.ok) return err(refused(tool, written.error));
  const answer = writeAnswer(
    serving,
    request,
    { fields: written.value, id: entity.id },
    {
      source: "state",
      view: "update",
      type: entity.type,
      collection: entity.collection,
      id: entity.id,
    },
  );
  if (answer.ok) {
    serving.store.update(updatedEntity(entity, written.value));
    serving.store.commitWrite(values.taken);
  }
  return answer;
};

const answerDelete = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateAnswer, AnalysisError> => {
  const target = targetEntity(serving, request);
  if (!target.ok) return target.error;
  const entity = target.value;
  const answer = writeAnswer(
    serving,
    request,
    { fields: entity.fields, id: entity.id },
    {
      source: "state",
      view: "delete",
      type: entity.type,
      collection: entity.collection,
      id: entity.id,
    },
  );
  if (answer.ok) {
    serving.store.remove(entity);
    serving.store.commitWrite(new Map());
  }
  return answer;
};

const answerDocument = (
  serving: StateServing,
  request: WriteRequest,
  call: WriteCall,
): Result<StateAnswer, AnalysisError> => {
  const { tool, plan } = request;
  const held = serving.store.document(plan.target ?? "");
  if (held === undefined)
    return err(
      refused(tool, `The state holds no document for ${plan.target ?? ""}.`),
    );
  const written = writtenDocument(plan, held.value, call);
  if (!written.ok) return err(refused(tool, written.error));
  const state = {
    source: "state",
    view: "document-write",
    path: held.path,
  } as const;
  const answer =
    plan.response?.shape === "entity"
      ? (() => {
          const exchange = serving.source.exchanges.get(plan.response.ordinal);
          return exchange === undefined
            ? err(refused(tool, `Tool ${tool.name} has no recorded response.`))
            : stateAnswer(
                serving,
                { exchange, exact: true },
                written.value,
                state,
              );
        })()
      : writeAnswer(serving, request, { fields: undefined, id: "" }, state);
  if (answer.ok) {
    serving.store.setDocument(plan.target ?? "", written.value);
    serving.store.commitWrite(new Map());
  }
  return answer;
};

/** Apply one served write tool call to the live state and answer it; a refused call leaves the state unchanged. */
export const answerWrite = (
  serving: StateServing,
  request: WriteRequest,
): Result<StateAnswer, AnalysisError> => {
  const body = callBody(request);
  if (!body.ok) return body;
  const call: WriteCall = {
    path: request.tool.path_template,
    pathValues: pathValues(request.tool, request.args),
    body: body.value,
  };
  switch (request.plan.effect) {
    case "create":
      return answerCreate(serving, request, call);
    case "update":
      return answerUpdate(serving, request, call);
    case "delete":
      return answerDelete(serving, request);
    case "document":
      return answerDocument(serving, request, call);
    case "none":
      return err(
        refused(
          request.tool,
          `Tool ${request.tool.name} is not served from the state.`,
        ),
      );
  }
};
