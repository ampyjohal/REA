import type { JsonValue } from "../jsonValue.js";
import { compositeKey } from "../unicodeCodePointOrder.js";
import {
  at,
  collectionPathOf,
  isObject,
  lastSegmentValue,
  listItems,
  renderStateEntity,
  renderStateList,
  same,
  scalarText,
  type JsonObject,
  type StateDocument,
  type StateEntity,
  type StateItemView,
  type StateListView,
  type StateRecordFacts,
} from "./environmentStateRules.js";

export const entityTarget = (type: string, collection: string, id: string) =>
  `e${compositeKey([type, collection, id])}`;
export const collectionTarget = (type: string, collection: string) =>
  `c${compositeKey([type, collection])}`;
export const documentTarget = (tool: string) => `d${compositeKey([tool])}`;

/** The gate's copy of the state: entities in collection order and documents, changed by modelled writes. */
export class SimulatedState {
  readonly #entities = new Map<string, StateEntity>();
  readonly #collections = new Map<string, string[]>();
  readonly #documents = new Map<string, JsonValue>();

  constructor(
    entities: readonly StateEntity[],
    documents: readonly StateDocument[],
  ) {
    for (const entity of entities) this.put(entity);
    for (const document of documents)
      this.#documents.set(document.tool, document.value);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(entityTarget(type, collection, id));
  }

  members(type: string, collection: string): StateEntity[] {
    return (
      this.#collections.get(collectionTarget(type, collection)) ?? []
    ).map((key) => this.#entities.get(key)!);
  }

  ofType(type: string): StateEntity[] {
    return [...this.#entities.values()].filter(
      (entity) => entity.type === type,
    );
  }

  /** Replace an entity in place, or add it at `index` of its collection (the end when omitted). */
  put(entity: StateEntity, index?: number): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    const known = this.#entities.has(key);
    this.#entities.set(key, entity);
    if (known) return;
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    order.splice(index ?? order.length, 0, key);
    this.#collections.set(collection, order);
  }

  remove(entity: StateEntity): void {
    const key = entityTarget(entity.type, entity.collection, entity.id);
    this.#entities.delete(key);
    const collection = collectionTarget(entity.type, entity.collection);
    const order = this.#collections.get(collection) ?? [];
    this.#collections.set(
      collection,
      order.filter((member) => member !== key),
    );
  }

  document(tool: string): JsonValue | undefined {
    return this.#documents.get(tool);
  }

  setDocument(tool: string, value: JsonValue): void {
    this.#documents.set(tool, value);
  }
}

/** An item read status that says the entity does not exist: 400, 404 or 410, as applications answer a missing id. */
export const isAbsence = (status: number | null): boolean =>
  status === 400 || status === 404 || status === 410;

const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/** A check's outcome and the targets it covered. */
export interface CheckOutcome {
  readonly pass: boolean;
  readonly targets: readonly string[];
  /** Entities the recording lists that the state does not hold, by target. */
  readonly unheld: readonly string[];
}

/** An item read: the recorded entity object must render from the held entity; a recorded 404 or 410 agrees with none held. */
export const checkItemRead = (
  state: SimulatedState,
  view: StateItemView,
  record: StateRecordFacts,
  check: {
    readonly body: JsonValue | undefined;
    readonly volatile: ReadonlySet<string>;
  },
): CheckOutcome | undefined => {
  const collection = collectionPathOf(record, true);
  const id = lastSegmentValue(record.path);
  const entity = state.entity(view.type, collection, id);
  const targets = [entityTarget(view.type, collection, id)];
  if (isAbsence(record.status) || (succeeded(record) && check.body === null))
    return { pass: entity === undefined, targets, unheld: [] };
  if (record.status === null || record.status < 200 || record.status >= 300)
    return undefined;
  const object =
    check.body === undefined ? undefined : at(check.body, view.pointer);
  if (!isObject(object)) return undefined;
  if (entity === undefined) return { pass: false, targets, unheld: targets };
  return {
    pass: same(renderStateEntity(entity, view, check.volatile, object), object),
    targets,
    unheld: [],
  };
};

/** A list read of every entity of a collection: membership, order, fields and counters must render from the state. */
const checkAllList = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: {
    readonly body: JsonValue;
    readonly items: readonly JsonObject[];
    readonly idField: string;
    readonly volatile: ReadonlySet<string>;
  },
): CheckOutcome => {
  const collection = collectionPathOf(record, false);
  const members = state.members(view.type, collection);
  const observed = new Map(
    check.items.map((item) => [scalarText(item[check.idField]) ?? "", item]),
  );
  const rendered = members.map((entity) =>
    renderStateEntity(entity, view, check.volatile, observed.get(entity.id)),
  );
  const held = new Set(members.map((entity) => entity.id));
  return {
    pass: same(renderStateList(view, check.body, rendered), check.body),
    targets: [
      collectionTarget(view.type, collection),
      ...members.map((entity) =>
        entityTarget(view.type, collection, entity.id),
      ),
    ],
    unheld: [...observed.keys()]
      .filter((id) => !held.has(id))
      .map((id) => entityTarget(view.type, collection, id)),
  };
};

/** A list read of recorded members: every listed entity the state holds must render; others are not compared. */
const checkRecordedList = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: {
    readonly items: readonly JsonObject[];
    readonly idField: string;
    readonly volatile: ReadonlySet<string>;
  },
): CheckOutcome => {
  const collection = collectionPathOf(record, false);
  const targets: string[] = [];
  const unheld: string[] = [];
  let pass = true;
  for (const item of check.items) {
    const id = scalarText(item[check.idField]) ?? "";
    const target = entityTarget(view.type, collection, id);
    const entity = state.entity(view.type, collection, id);
    if (entity === undefined) {
      unheld.push(target);
      continue;
    }
    targets.push(target);
    if (!same(renderStateEntity(entity, view, check.volatile, item), item))
      pass = false;
  }
  return { pass, targets, unheld };
};

/** A list read on a checked line, compared as the served environment answers it. */
export const checkListRead = (
  state: SimulatedState,
  view: StateListView,
  record: StateRecordFacts,
  check: {
    readonly body: JsonValue | undefined;
    readonly idField: string;
    readonly volatile: ReadonlySet<string>;
  },
): CheckOutcome | undefined => {
  if (record.status === null || record.status < 200 || record.status >= 300)
    return undefined;
  const items =
    check.body === undefined ? undefined : listItems(check.body, view.pointer);
  if (check.body === undefined || items === undefined) return undefined;
  return view.membership === "all"
    ? checkAllList(state, view, record, { ...check, body: check.body, items })
    : checkRecordedList(state, view, record, { ...check, items });
};

/** A document read on its checked line must equal the held document. */
export const checkDocumentRead = (
  state: SimulatedState,
  tool: string,
  record: StateRecordFacts,
  body: JsonValue | undefined,
): CheckOutcome | undefined => {
  if (record.status === null || record.status < 200 || record.status >= 300)
    return undefined;
  const value = state.document(tool);
  if (body === undefined || value === undefined) return undefined;
  return {
    pass: same(value, body),
    targets: [documentTarget(tool)],
    unheld: [],
  };
};

/**
 * Check, field by field, the writes that changed an entity an unmodelled write also changed:
 * each write's own fields must show as the state holds them. A create wrote every field, so it
 * cannot be told apart from the unmodelled change and is not checked.
 */
export const writtenFieldChecks = (
  entity: StateEntity,
  view: StateItemView,
  observed: JsonObject,
  check: {
    readonly volatile: ReadonlySet<string>;
    readonly writes: ReadonlyMap<string, readonly string[] | null>;
  },
): Map<string, boolean> => {
  const shown = renderStateEntity(entity, view, check.volatile, observed);
  const outcomes = new Map<string, boolean>();
  for (const [tool, fields] of check.writes) {
    const compared = (fields ?? []).filter(
      (field) => Object.hasOwn(observed, field) || Object.hasOwn(shown, field),
    );
    if (fields === null || compared.length === 0) continue;
    outcomes.set(
      tool,
      compared.every((field) => same(shown[field], observed[field])),
    );
  }
  return outcomes;
};
