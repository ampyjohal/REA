import type { JsonValue } from "../jsonValue.js";
import {
  collectionPathOf,
  isObject,
  lastSegmentValue,
  listItems,
  pointerTo,
  scalarText,
  type JsonObject,
  type StateRecordFacts,
  type StateView,
} from "./environmentStateRules.js";

/** Where an observed entity object was found: the record and a JSON pointer into its response. */
export interface Observed {
  readonly ordinal: number;
  readonly pointer: string;
  readonly object: JsonObject;
  readonly id: string;
}

/** Objects a response carries where an entity may be, in precedence tiers: the root, one member, then the element of a one-element array at the root or in one member. */
const entitySlots = (body: JsonValue): [string, JsonValue][][] => {
  const members = isObject(body) ? Object.entries(body) : [];
  const elements: [string, JsonValue][] =
    Array.isArray(body) && body.length === 1 ? [["/0", body[0]!]] : [];
  for (const [name, item] of members)
    if (Array.isArray(item) && item.length === 1)
      elements.push([`${pointerTo(name)}/0`, item[0]!]);
  return [
    [["", body]],
    members.map(([name, item]): [string, JsonValue] => [pointerTo(name), item]),
    elements,
  ];
};

/** The entity object a response carries with an identity value the state does not hold yet: the only one in the first tier that has one. */
export const newEntityIn = (
  ordinal: number,
  body: JsonValue | undefined,
  idField: string,
  held: (id: string) => boolean,
): Observed | undefined => {
  if (body === undefined) return undefined;
  for (const tier of entitySlots(body)) {
    const found = tier.flatMap(([pointer, object]) => {
      const id = isObject(object) ? scalarText(object[idField]) : undefined;
      // An object holding only the identity names the entity without showing it.
      return isObject(object) &&
        id !== undefined &&
        !held(id) &&
        Object.keys(object).some((key) => key !== idField)
        ? [{ ordinal, pointer, object, id }]
        : [];
    });
    if (found.length > 0) return found.length === 1 ? found[0] : undefined;
  }
  return undefined;
};

/** What a forward search for an observation reads: records after a position, read views and response bodies. */
export interface ObservationSearch {
  readonly records: readonly StateRecordFacts[];
  readonly from: number;
  readonly viewOf: (ordinal: number) => StateView | undefined;
  readonly withBody: <T>(
    ordinal: number,
    use: (body: JsonValue | undefined) => T,
  ) => T;
}

const succeeded = (record: StateRecordFacts): boolean =>
  record.status !== null && record.status >= 200 && record.status < 300;

/**
 * The first later read, before the next write, that shows a written entity: an item read of
 * `id` when given, else an item read of an unheld id or a collection read listing exactly one.
 */
export const laterObservation = (
  search: ObservationSearch,
  target: {
    readonly type: string;
    readonly collection: string;
    readonly idField: string;
    readonly id?: string;
    readonly held: (id: string) => boolean;
    readonly isWrite: (record: StateRecordFacts) => boolean;
  },
): Observed | undefined => {
  for (const record of search.records.slice(search.from + 1)) {
    if (target.isWrite(record)) return undefined;
    const view = search.viewOf(record.ordinal);
    if (
      !succeeded(record) ||
      (view?.shape !== "item" && view?.shape !== "list") ||
      view.type !== target.type
    )
      continue;
    const found =
      view.shape === "item"
        ? itemObservation(search, record, view.pointer, target)
        : listObservation(search, record, view.pointer, target);
    if (found !== undefined) return found;
  }
  return undefined;
};

const itemObservation = (
  search: ObservationSearch,
  record: StateRecordFacts,
  pointer: string,
  target: Parameters<typeof laterObservation>[1],
): Observed | undefined => {
  const id = lastSegmentValue(record.path);
  if (
    collectionPathOf(record, true) !== target.collection ||
    (target.id !== undefined ? id !== target.id : target.held(id))
  )
    return undefined;
  return search.withBody(record.ordinal, (body) => {
    const object =
      body === undefined
        ? undefined
        : entitySlots(body)
            .flat()
            .find(([at]) => at === pointer)?.[1];
    return isObject(object) && scalarText(object[target.idField]) === id
      ? { ordinal: record.ordinal, pointer, object, id }
      : undefined;
  });
};

const listObservation = (
  search: ObservationSearch,
  record: StateRecordFacts,
  pointer: string,
  target: Parameters<typeof laterObservation>[1],
): Observed | undefined => {
  if (
    target.id !== undefined ||
    collectionPathOf(record, false) !== target.collection
  )
    return undefined;
  return search.withBody(record.ordinal, (body) => {
    const items = body === undefined ? undefined : listItems(body, pointer);
    const unheld = (items ?? [])
      .map((object, index) => ({
        object,
        index,
        id: scalarText(object[target.idField]),
      }))
      .filter(
        (entry): entry is { object: JsonObject; index: number; id: string } =>
          entry.id !== undefined && !target.held(entry.id),
      );
    return unheld.length === 1
      ? {
          ordinal: record.ordinal,
          pointer: `${pointer}/${String(unheld[0]!.index)}`,
          object: unheld[0]!.object,
          id: unheld[0]!.id,
        }
      : undefined;
  });
};
