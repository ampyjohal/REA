import type {
  StateEntity,
  StateType,
} from "../../domain/analysisView/environmentStateRules.js";
import type { AnalysisInputError } from "../../domain/analysisErrorCore.js";
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

  constructor(readonly state: EnvironmentState) {
    this.#types = new Map(
      state.types.map((type) => [type.collection_template, type]),
    );
    this.reset();
  }

  /** Restore the initial state the Evidence holds. */
  reset(): void {
    this.#install(this.state);
  }

  /** Validate a `rea-state/v1` document and, only when it is valid, make it the whole state. */
  replace(document: unknown): Result<void, AnalysisInputError> {
    const content = parseStateDocument(this.state, document);
    if (!content.ok) return content;
    this.#install(content.value);
    return ok(undefined);
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
