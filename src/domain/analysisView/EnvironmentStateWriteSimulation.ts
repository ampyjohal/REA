import {
  at,
  changesState,
  collectionPathOf,
  isObject,
  isStateWrite,
  lastSegmentValue,
  normalizedPath,
  type StateDocument,
  type StateEntity,
  type StateRecordFacts,
  type StateToolFacts,
  type StateType,
  type StateView,
} from "./environmentStateRules.js";
import { updatedEntity } from "./environmentStateWriteApply.js";
import {
  checkDocumentRead,
  checkItemRead,
  checkListRead,
  entityTarget,
  isAbsence,
  writtenFieldChecks,
  SimulatedState,
  type CheckOutcome,
} from "./environmentStateWriteChecks.js";
import { applyCreate } from "./environmentStateWriteCreate.js";
import {
  applyDelete,
  applyDocument,
  applyUpdate,
  type EffectContext,
  type EffectResult,
  type WriteDraft,
  type WriteIo,
  type WriteStep,
} from "./environmentStateWriteEffects.js";
import { insertIndex } from "./environmentStateWriteExplain.js";
import {
  classifyWrite,
  prefixRelated,
  unservedPlan,
  type StateWritePlan,
} from "./environmentStateWriteRules.js";
import { WriteTaint } from "./environmentStateWriteTaint.js";

/** What the write gate reads: the manifest tools, the timeline, the read views and the initial state. */
export interface WriteSimulationInput {
  readonly tools: readonly StateToolFacts[];
  readonly records: readonly StateRecordFacts[];
  readonly timed: boolean;
  readonly views: ReadonlyMap<string, StateView>;
  readonly types: readonly StateType[];
  readonly entities: readonly StateEntity[];
  readonly documents: readonly StateDocument[];
  readonly volatileOf: (type: string) => ReadonlySet<string>;
  readonly io: WriteIo;
}

const requestLine = (record: StateRecordFacts): string =>
  record.path + (record.query ?? "");

const APPLY = {
  create: applyCreate,
  update: applyUpdate,
  delete: applyDelete,
  document: applyDocument,
} as const;

/**
 * Replay the capture's timeline on a copy of the initial state: modelled writes apply their
 * effects, other writes taint related types, and each read the served state would answer is
 * compared with its recording and attributed to the writes it exercises.
 */
export class EnvironmentStateWriteSimulation {
  readonly #input: WriteSimulationInput;
  readonly #state: SimulatedState;
  readonly #drafts = new Map<string, WriteDraft>();
  readonly #toolOf = new Map<number, StateToolFacts>();
  readonly #types = new Map<string, StateType>();
  readonly #checkedLines = new Map<string, ReadonlySet<string>>();
  readonly #observations = new Set<number>();
  readonly #taint: WriteTaint;
  /** Modelled writes per target since its last check, with the fields each wrote (null: all). */
  readonly #touched = new Map<string, Map<string, readonly string[] | null>>();
  readonly #lastCheck = new Map<string, number>();
  /** The earliest modelled write to each target since its last check. */
  readonly #touchedSince = new Map<string, number>();
  /** Timeline indexes of writes the gate does not model. */
  readonly #unmodelledAt: number[] = [];
  readonly #log: {
    readonly index: number;
    readonly tool: string;
    readonly path: string;
  }[] = [];
  /** Entities a create inserted, by target, with the create's tool. */
  readonly #inserted = new Map<string, string>();

  constructor(input: WriteSimulationInput) {
    this.#input = input;
    this.#state = new SimulatedState(input.entities, input.documents);
    for (const type of input.types)
      this.#types.set(type.collection_template, type);
    for (const tool of input.tools)
      for (const ordinal of tool.record_ordinals)
        this.#toolOf.set(ordinal, tool);
    const byOrdinal = new Map(
      input.records.map((record) => [record.ordinal, record]),
    );
    for (const view of input.views.values())
      if (view.shape !== "recorded" && view.shape !== "item")
        this.#checkedLines.set(
          view.tool,
          new Set(
            view.checked_record_ordinals.flatMap((ordinal) => {
              const record = byOrdinal.get(ordinal);
              return record === undefined ? [] : [requestLine(record)];
            }),
          ),
        );
    this.#taint = new WriteTaint(
      [...this.#types.keys()],
      new Map(
        input.documents.map((document) => [document.tool, document.path]),
      ),
      (type, collection, id) =>
        this.#state.entity(type, collection, id) !== undefined,
    );
  }

  /** Every state-changing tool's plan, in manifest order, with its verdict. */
  run(): StateWritePlan[] {
    const documents = new Map<string, string>();
    for (const tool of this.#input.tools)
      if (this.#input.views.get(tool.name)?.shape === "document")
        documents.set(normalizedPath(tool.path_template), tool.name);
    const types = new Set(this.#types.keys());
    for (const tool of this.#input.tools) {
      if (!changesState(tool.method, tool.path_template)) continue;
      const { effect, target } = classifyWrite(tool, types, documents);
      this.#input.io.retain(512);
      this.#drafts.set(tool.name, {
        plan: {
          ...unservedPlan(tool.name, effect, target, "no-state-target"),
          reason: effect === "none" ? "no-state-target" : null,
        },
        observed: undefined,
        candidates: [],
        confirmed: [],
        contradictedBy: undefined,
        sideEffect: false,
        calls: 0,
      });
    }
    this.#input.records.forEach((record, index) => this.#step(record, index));
    return [...this.#drafts.values()].map((draft) => this.#verdict(draft));
  }

  #step(record: StateRecordFacts, index: number): void {
    const tool = this.#toolOf.get(record.ordinal);
    if (isStateWrite(record)) this.#write(record, index, tool);
    else if (tool?.method === "GET" && !this.#observations.has(record.ordinal))
      this.#read(record, index, tool);
  }

  #context(): EffectContext {
    return {
      state: this.#state,
      io: this.#input.io,
      records: this.#input.records,
      timed: this.#input.timed,
      viewOf: (ordinal) => {
        const tool = this.#toolOf.get(ordinal);
        return tool === undefined
          ? undefined
          : this.#input.views.get(tool.name);
      },
      idField: (type) => this.#types.get(type)!.id_field,
      observed: (ordinal) => this.#observations.add(ordinal),
      unknown: (type, collection, id) =>
        this.#taint.unknown(type, collection, id),
    };
  }

  #write(
    record: StateRecordFacts,
    index: number,
    tool: StateToolFacts | undefined,
  ): void {
    const draft = tool === undefined ? undefined : this.#drafts.get(tool.name);
    const effect = draft?.plan.effect;
    if (
      draft === undefined ||
      tool === undefined ||
      effect === undefined ||
      effect === "none"
    ) {
      this.#unmodelled(record.path, index);
      return;
    }
    const observeOnly = draft.plan.reason !== null;
    if (!observeOnly) draft.calls += 1;
    const step: WriteStep = { record, index, tool, observeOnly };
    this.#settle(APPLY[effect](this.#context(), draft, step), {
      index,
      tool: tool.name,
      path: record.path,
    });
  }

  /** Attribute an applied effect to its tool; a recorded outcome is the state's new baseline; an unknown one taints. */
  #settle(
    result: EffectResult,
    write: {
      readonly index: number;
      readonly tool: string;
      readonly path: string;
    },
  ): void {
    if (result.kind === "unknown") {
      this.#unmodelled(write.path, write.index);
      return;
    }
    if (result.entity !== undefined)
      this.#taint.known(
        result.entity.type,
        result.entity.collection,
        result.entity.id,
      );
    for (const target of result.targets) {
      // A recorded outcome replaces the entity's values, not its collection's membership.
      if (result.kind === "observed") {
        if (target === result.targets[0]) this.#touched.delete(target);
        continue;
      }
      if (!this.#touchedSince.has(target))
        this.#touchedSince.set(target, write.index);
      const tools = this.#touched.get(target) ?? new Map();
      const before = tools.get(write.tool);
      tools.set(
        write.tool,
        result.fields === undefined || before === null
          ? null
          : [...new Set([...(before ?? []), ...result.fields])],
      );
      this.#touched.set(target, tools);
    }
    if (result.kind !== "applied") return;
    this.#log.push(write);
    if (result.inserted !== undefined)
      this.#inserted.set(result.inserted, write.tool);
  }

  /**
   * An item read of an entity an unmodelled write may have changed shows it again: the writes that
   * changed it are checked on their own fields, and the state takes what the read recorded.
   */
  #resync(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
    entity: StateEntity,
  ): void {
    const target = entityTarget(entity.type, entity.collection, entity.id);
    const writes = this.#touched.get(target) ?? new Map();
    this.#taint.known(entity.type, entity.collection, entity.id);
    this.#touched.delete(target);
    if (isAbsence(record.status)) {
      this.#state.remove(entity);
      return;
    }
    const object = this.#input.io.withBody(record.ordinal, (body) =>
      body === undefined ? undefined : at(body, view.pointer),
    );
    if (!isObject(object)) return;
    const outcomes = writtenFieldChecks(entity, view, object, {
      volatile: this.#input.volatileOf(view.type),
      writes,
    });
    for (const [name, pass] of outcomes) {
      const draft = this.#drafts.get(name)!;
      if (pass) draft.confirmed.push(record.ordinal);
      else draft.contradictedBy ??= record.ordinal;
    }
    this.#state.put(updatedEntity(entity, { ...entity.fields, ...object }));
  }

  /** Whether an item read is of an entity left unknown that it shows again rather than checks. */
  #resynced(view: StateView, record: StateRecordFacts): boolean {
    if (view.shape !== "item") return false;
    const collection = collectionPathOf(record, true);
    const id = lastSegmentValue(record.path);
    if (!this.#taint.unknown(view.type, collection, id)) return false;
    const entity = this.#state.entity(view.type, collection, id);
    // A recorded absence of an entity the state no longer holds is still a check of its delete.
    if (entity === undefined) {
      if (isAbsence(record.status)) return false;
      this.#taint.known(view.type, collection, id);
      return true;
    }
    this.#resync(view, record, entity);
    return true;
  }

  #check(view: StateView, record: StateRecordFacts): CheckOutcome | undefined {
    if (view.shape === "recorded") return undefined;
    if (
      view.shape !== "item" &&
      !this.#checkedLines.get(view.tool)?.has(requestLine(record))
    )
      return undefined;
    if (
      (view.shape === "item" || view.shape === "list") &&
      this.#taint.under(collectionPathOf(record, view.shape === "item"))
    )
      return undefined;
    if (view.shape === "list") {
      const collection = collectionPathOf(record, false);
      const ids = this.#state
        .members(view.type, collection)
        .map((entity) => entity.id);
      if (this.#taint.blocksList(view.type, collection, ids)) return undefined;
    }
    return this.#input.io.withBody(record.ordinal, (body) => {
      if (view.shape === "document")
        return checkDocumentRead(this.#state, view.tool, record, body);
      const check = {
        body,
        idField: this.#types.get(view.type)?.id_field ?? "",
        volatile: this.#input.volatileOf(view.type),
      };
      return view.shape === "item"
        ? checkItemRead(this.#state, view, record, check)
        : checkListRead(this.#state, view, record, check);
    });
  }

  #read(record: StateRecordFacts, index: number, tool: StateToolFacts): void {
    const view = this.#input.views.get(tool.name);
    if (view === undefined || this.#resynced(view, record)) return;
    const outcome = this.#check(view, record);
    if (outcome === undefined) return;
    const keys = [...outcome.targets, ...outcome.unheld];
    if (keys.some((key) => this.#taint.tainted(key))) return;
    const exercised = new Set<string>();
    for (const key of keys)
      for (const name of this.#touched.get(key)?.keys() ?? [])
        exercised.add(name);
    const pass =
      outcome.pass ||
      (view.shape === "list" && this.#retryInsert(view, record, exercised));
    if (pass)
      for (const name of exercised)
        this.#drafts.get(name)!.confirmed.push(record.ordinal);
    else if (this.#interfered(keys)) {
      // An unmodelled write since these writes may explain the difference: check their own members only.
      if (view.shape === "item") this.#checkMembers(view, record);
      else for (const key of keys) this.#taint.fail(key);
    } else this.#mismatch({ record, index, keys, exercised, view });
    if (!pass && view.shape === "item") this.#adopt(view, record);
    for (const key of keys) {
      this.#touched.delete(key);
      this.#touchedSince.delete(key);
      this.#lastCheck.set(key, index);
    }
  }

  #unmodelled(path: string, index: number): void {
    this.#taint.write(path);
    this.#unmodelledAt.push(index);
  }

  /** Whether a write the gate does not model came after the earliest modelled write a failed check exercised. */
  #interfered(keys: readonly string[]): boolean {
    const since = Math.min(
      ...keys.map((key) => this.#touchedSince.get(key) ?? Infinity),
    );
    return this.#unmodelledAt.some((index) => index > since);
  }

  /** Check the writes to an item read's entity on the members they sent, as a resynchronising read does. */
  #checkMembers(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
  ): void {
    const entity = this.#state.entity(
      view.type,
      collectionPathOf(record, true),
      lastSegmentValue(record.path),
    );
    if (entity === undefined) return;
    const writes =
      this.#touched.get(
        entityTarget(entity.type, entity.collection, entity.id),
      ) ?? new Map();
    const object = this.#input.io.withBody(record.ordinal, (body) =>
      body === undefined || body === null ? undefined : at(body, view.pointer),
    );
    if (!isObject(object)) return;
    for (const [name, pass] of writtenFieldChecks(entity, view, object, {
      volatile: this.#input.volatileOf(view.type),
      writes,
    })) {
      const draft = this.#drafts.get(name)!;
      if (pass) draft.confirmed.push(record.ordinal);
      else draft.contradictedBy ??= record.ordinal;
    }
  }

  /** After a failed item check the state takes what the read recorded, so later checks start from it. */
  #adopt(
    view: Extract<StateView, { shape: "item" }>,
    record: StateRecordFacts,
  ): void {
    const collection = collectionPathOf(record, true);
    const id = lastSegmentValue(record.path);
    const entity = this.#state.entity(view.type, collection, id);
    if (entity === undefined) {
      this.#taint.fail(entityTarget(view.type, collection, id));
      return;
    }
    const object = this.#input.io.withBody(record.ordinal, (body) =>
      body === undefined || body === null ? undefined : at(body, view.pointer),
    );
    if (isObject(object))
      this.#state.put(updatedEntity(entity, { ...entity.fields, ...object }));
    else this.#state.remove(entity);
  }

  /** Contradict the writes a failed check exercised, or, when none, the related writes since its targets were last checked; a failed list stops being checked. */
  #mismatch(failed: {
    readonly record: StateRecordFacts;
    readonly index: number;
    readonly keys: readonly string[];
    readonly exercised: ReadonlySet<string>;
    readonly view: StateView;
  }): void {
    if (failed.exercised.size > 0)
      for (const name of failed.exercised) {
        const draft = this.#drafts.get(name)!;
        draft.contradictedBy ??= failed.record.ordinal;
      }
    else {
      const since = Math.min(
        ...failed.keys.map((key) => this.#lastCheck.get(key) ?? -1),
      );
      for (const write of this.#log)
        if (
          write.index > since &&
          prefixRelated(write.path, failed.record.path)
        )
          this.#drafts.get(write.tool)!.sideEffect = true;
    }
    if (failed.view.shape !== "item")
      for (const key of failed.keys) this.#taint.fail(key);
  }

  /** A list that fails only for where one create placed its entities passes under another of that create's insert candidates. */
  #retryInsert(
    view: Extract<StateView, { shape: "list" }>,
    record: StateRecordFacts,
    exercised: ReadonlySet<string>,
  ): boolean {
    if (view.membership !== "all") return false;
    const collection = collectionPathOf(record, false);
    const members = this.#state.members(view.type, collection);
    const key = (entity: StateEntity) =>
      entityTarget(entity.type, entity.collection, entity.id);
    const inserted = members.filter((entity) =>
      this.#inserted.has(key(entity)),
    );
    const creates = new Set(
      inserted.map((entity) => this.#inserted.get(key(entity))!),
    );
    if (creates.size !== 1) return false;
    const [name] = creates;
    const draft = this.#drafts.get(name!)!;
    if (!exercised.has(name!) || draft.confirmed.length > 0) return false;
    for (const candidate of draft.candidates.slice(1)) {
      for (const entity of inserted) this.#state.remove(entity);
      for (const entity of inserted) {
        const order = this.#state
          .members(view.type, collection)
          .map((member) => member.fields);
        this.#state.put(entity, insertIndex(candidate, order, entity.fields));
      }
      if (this.#check(view, record)?.pass === true) {
        draft.plan.insert = candidate;
        return true;
      }
    }
    return false;
  }

  /** Whether an update or delete that answers with the entity can answer for an initial entity: one holds every field its recorded response shows. */
  #renders(plan: StateWritePlan): boolean {
    const { response } = plan;
    if (
      (plan.effect !== "update" && plan.effect !== "delete") ||
      response?.shape !== "entity"
    )
      return true;
    const shown = this.#input.io.withBody(response.ordinal, (body) => {
      const object =
        body === undefined ? undefined : at(body, response.pointer ?? "");
      return isObject(object) ? Object.keys(object) : undefined;
    });
    return (
      shown === undefined ||
      this.#input.entities.some(
        (entity) =>
          entity.type === plan.target &&
          shown.every((field) => Object.hasOwn(entity.fields, field)),
      )
    );
  }

  #verdict(draft: WriteDraft): StateWritePlan {
    const plan = draft.plan;
    if (plan.reason === null) {
      if (draft.calls === 0) plan.reason = "no-call";
      else if (draft.contradictedBy !== undefined) {
        plan.reason = "contradicted";
        plan.contradicted_by = draft.contradictedBy;
      } else if (draft.sideEffect) plan.reason = "side-effect";
      else if (draft.confirmed.length === 0) plan.reason = "unconfirmed";
      else if (!this.#renders(plan)) plan.reason = "incomplete-entities";
    }
    plan.served = plan.reason === null;
    plan.checked_record_ordinals = [...new Set(draft.confirmed)];
    return { ...plan };
  }
}
