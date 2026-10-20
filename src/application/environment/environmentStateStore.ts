import type {
  StateEntity,
  StateType,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ok, type Result } from "../../domain/result.js";
import { compositeKey } from "../../domain/unicodeCodePointOrder.js";
import type { EnvironmentState } from "./environmentState.js";
import {
  parseStateDocument,
  type HeldDocument,
  type StateContent,
} from "./environmentStateDocument.js";

/** What `data/get` reports: the current state as a `rea-state/v1` document. */
export interface StateSnapshot {
  readonly rea_state: {
    readonly version: 1;
    readonly state_evidence_id: string;
    readonly types: readonly StateType[];
    readonly entities: readonly StateEntity[];
    readonly documents: readonly HeldDocument[];
  };
}

/**
 * The live state one served environment answers from, shared by every MCP
 * session and the data plane. Mutations are synchronous and swap the whole
 * state, so every answer reads one consistent state.
 */
export class EnvironmentStateStore {
  #entities: ReadonlyMap<string, StateEntity> = new Map();
  #collections: ReadonlyMap<string, readonly StateEntity[]> = new Map();
  #typeCollections: ReadonlyMap<string, readonly string[]> = new Map();
  #documents: ReadonlyMap<string, HeldDocument> = new Map();
  #content: StateContent = { entities: [], documents: [] };
  readonly #types: ReadonlyMap<string, StateType>;
  readonly #clockStart: number;
  /** Served writes since the state was last reset or loaded: the clock's seconds and the generators' counter. */
  #writes = 0;
  /** The largest value each sequence has generated since the last reset or load, so a deleted entity's value is not reused. */
  readonly #sequences = new Map<string, number>();

  constructor(readonly state: EnvironmentState) {
    this.#types = new Map(
      state.types.map((type) => [type.collection_template, type]),
    );
    this.#clockStart =
      state.writeClock === null ? 0 : Date.parse(state.writeClock);
    this.reset();
  }

  /** Restore the initial state the Evidence holds; the clock and counter start again. */
  reset(): void {
    this.#install(this.state);
    this.#restart();
  }

  /** Validate a `rea-state/v1` document and, only when it is valid, make it the whole state; the clock and counter start again. */
  replace(document: unknown): Result<void, AnalysisInputError> {
    const content = parseStateDocument(this.state, document);
    if (!content.ok) return content;
    this.#install(content.value);
    this.#restart();
    return ok(undefined);
  }

  /** The write a served call would be: its number since the last reset or load, and its clock instant, one second past the previous applied write. */
  pendingWrite(): { readonly count: number; readonly clockMs: number } {
    const count = this.#writes + 1;
    return { count, clockMs: this.#clockStart + count * 1000 };
  }

  /** Count an applied write and keep the sequence values it took, so a refused call takes none. */
  commitWrite(sequences: ReadonlyMap<string, number>): void {
    this.#writes += 1;
    for (const [key, value] of sequences)
      this.#sequences.set(key, Math.max(value, this.#sequences.get(key) ?? 0));
  }

  /** The next value of a sequence: one past both the largest held value and the largest an applied write took. */
  sequenceAfter(key: string, held: number): number {
    return Math.max(held, (this.#sequences.get(key) ?? 0) + 1);
  }

  #restart(): void {
    this.#writes = 0;
    this.#sequences.clear();
  }

  /** Every held entity of a type, in state order. */
  ofType(type: string): readonly StateEntity[] {
    return this.#content.entities.filter((entity) => entity.type === type);
  }

  /** Add an entity at `index` of its collection's order. */
  insert(entity: StateEntity, index: number): void {
    const entities = this.#content.entities;
    const members = this.inCollection(entity.type, entity.collection);
    const anchor =
      index < members.length
        ? entities.indexOf(members[index]!)
        : members.length > 0
          ? entities.indexOf(members.at(-1)!) + 1
          : entities.length;
    this.#install({
      ...this.#content,
      entities: [
        ...entities.slice(0, anchor),
        entity,
        ...entities.slice(anchor),
      ],
    });
  }

  /** Replace a held entity's values in place. */
  update(entity: StateEntity): void {
    const key = compositeKey([entity.type, entity.collection, entity.id]);
    this.#install({
      ...this.#content,
      entities: this.#content.entities.map((held) =>
        compositeKey([held.type, held.collection, held.id]) === key
          ? entity
          : held,
      ),
    });
  }

  remove(entity: StateEntity): void {
    const key = compositeKey([entity.type, entity.collection, entity.id]);
    this.#install({
      ...this.#content,
      entities: this.#content.entities.filter(
        (held) => compositeKey([held.type, held.collection, held.id]) !== key,
      ),
    });
  }

  /** Set a held document's value; a value that is not the Evidence's cites no record. */
  setDocument(tool: string, value: JsonValue): void {
    this.#install({
      ...this.#content,
      documents: this.#content.documents.map((document) =>
        document.tool === tool
          ? { tool: document.tool, path: document.path, value }
          : document,
      ),
    });
  }

  type(collectionTemplate: string): StateType | undefined {
    return this.#types.get(collectionTemplate);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(compositeKey([type, collection, id]));
  }

  /** One collection's entities in state order. */
  inCollection(type: string, collection: string): readonly StateEntity[] {
    return this.#collections.get(compositeKey([type, collection])) ?? [];
  }

  /** The collections holding entities of one type, in state order of their first entity. */
  collectionsOf(type: string): readonly string[] {
    return this.#typeCollections.get(type) ?? [];
  }

  document(tool: string): HeldDocument | undefined {
    return this.#documents.get(tool);
  }

  snapshot(): StateSnapshot {
    return {
      rea_state: {
        version: 1,
        state_evidence_id: this.state.evidenceId,
        types: this.state.types,
        entities: this.#content.entities,
        documents: this.#content.documents,
      },
    };
  }

  /** Build every index before assigning any, so a reader never sees half a state. */
  #install(content: StateContent): void {
    const entities = new Map<string, StateEntity>();
    const collections = new Map<string, StateEntity[]>();
    const typeCollections = new Map<string, string[]>();
    for (const entity of content.entities) {
      entities.set(
        compositeKey([entity.type, entity.collection, entity.id]),
        entity,
      );
      const key = compositeKey([entity.type, entity.collection]);
      const members = collections.get(key);
      if (members !== undefined) {
        members.push(entity);
        continue;
      }
      collections.set(key, [entity]);
      const named = typeCollections.get(entity.type);
      if (named === undefined)
        typeCollections.set(entity.type, [entity.collection]);
      else named.push(entity.collection);
    }
    this.#entities = entities;
    this.#collections = collections;
    this.#typeCollections = typeCollections;
    this.#documents = new Map(
      content.documents.map((document) => [document.tool, document]),
    );
    this.#content = content;
  }
}
