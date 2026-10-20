import { z } from "zod";
import type { CapturedFields } from "./browserScenarioCaptureFields.js";
import {
  browserScenarioEventKindFamily,
  browserScenarioOmissionKindSelected,
  enabledScenarioEventFamilies,
  type BrowserScenarioEventBudgetReason,
  type BrowserScenarioEventKind,
} from "./browserScenarioCaptureValues.js";

/**
 * Retained events belong only to families the scenario selected; omission
 * accounting follows the producer's admission rule for selected families, and
 * only the network collector accounts network transaction omissions.
 */
const refineSelectedEventFamilies = (
  { scenario, events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const selected = new Set(
    enabledScenarioEventFamilies(
      scenario.event_families,
      scenario.network_content,
    ),
  );
  const unselected = (
    kind: BrowserScenarioEventKind,
    path: readonly (string | number)[],
  ): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message: `Event kind ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family, which the scenario did not select`,
    });
  };
  for (const [index, { kind }] of events.items.entries())
    if (!selected.has(browserScenarioEventKindFamily(kind)))
      unselected(kind, ["events", "items", index, "kind"]);
  for (const [index, { kind }] of events.omissions.by_kind.entries())
    if (!browserScenarioOmissionKindSelected(kind, selected))
      unselected(kind, ["events", "omissions", "by_kind", index, "kind"]);
  const networkSelected = selected.has("network");
  const networkOmission = (path: readonly (string | number)[]): void => {
    context.addIssue({
      code: "custom",
      path: [...path],
      message:
        "Network transaction omissions require the network family, which the scenario did not select",
    });
  };
  for (const [
    index,
    omission,
  ] of events.omissions.network_transactions.entries()) {
    const path = ["events", "omissions", "network_transactions", index];
    if (!networkSelected) {
      networkOmission(path);
      continue;
    }
    for (const [kindIndex, kind] of omission.omitted_kinds.entries())
      if (browserScenarioEventKindFamily(kind) !== "network")
        context.addIssue({
          code: "custom",
          path: [...path, "omitted_kinds", kindIndex],
          message: `Network transaction omissions name only network event kinds; ${kind} belongs to the ${browserScenarioEventKindFamily(kind)} family`,
        });
  }
  if (events.omissions.network_transaction_range !== null && !networkSelected)
    networkOmission(["events", "omissions", "network_transaction_range"]);
};

/** Without network the family rule already rejects network omission records. */
const networkSelected = ({ scenario }: CapturedFields): boolean =>
  enabledScenarioEventFamilies(
    scenario.event_families,
    scenario.network_content,
  ).includes("network");

type EventOmissions = CapturedFields["events"]["omissions"];

/**
 * Admitted transactions name the network kinds they lost, one record each.
 * A record citing only max-network-transactions is reported on its own and
 * stands for no admitted drop.
 */
const transactionsNaming = (
  { network_transactions: transactions }: EventOmissions,
  kind: BrowserScenarioEventKind,
): number =>
  transactions.filter(
    ({ omitted_kinds: kinds, reasons }) =>
      kinds.includes(kind) &&
      reasons.some((reason) => reason !== "max-network-transactions"),
  ).length;

/**
 * The fewest drops one by_kind row can stand for: each listed reason occurred
 * at least once, and each admitted transaction naming the kind lost at least
 * one of its events for a reason other than max-network-transactions.
 */
const minimumDrops = (
  omissions: EventOmissions,
  { kind, reasons }: EventOmissions["by_kind"][number],
): { readonly other: number; readonly refused: number } => {
  const listed = new Set(reasons);
  const refused = listed.has("max-network-transactions") ? 1 : 0;
  return {
    other: Math.max(listed.size - refused, transactionsNaming(omissions, kind)),
    refused,
  };
};

/**
 * by_kind keeps one count per kind across its reasons, so drops of refused
 * transactions are bounded rather than counted exactly.
 */
const refusedDropBounds = (
  omissions: EventOmissions,
): { readonly atLeast: number; readonly atMost: number } => {
  let atLeast = 0;
  let atMost = 0;
  for (const omission of omissions.by_kind) {
    const { other, refused } = minimumDrops(omissions, omission);
    if (
      refused === 0 ||
      browserScenarioEventKindFamily(omission.kind) !== "network"
    )
      continue;
    atMost += omission.count - other;
    atLeast += new Set(omission.reasons).size === 1 ? omission.count : 1;
  }
  return { atLeast, atMost };
};

/** Each by_kind row counts at least the drops its reasons and records imply. */
const refineOmissionCounts = (
  { events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  for (const [index, omission] of events.omissions.by_kind.entries()) {
    const { other, refused } = minimumDrops(events.omissions, omission);
    if (omission.count < other + refused)
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind", index, "count"],
        message: `${String(omission.count)} dropped ${omission.kind} events cannot cover its listed reasons and transactions, which need at least ${String(other + refused)}`,
      });
  }
};

/**
 * Only the network collector refuses transactions, so max-network-transactions
 * marks network drops alone; refused transactions fill the omitted range, and
 * each drops at least one of its network events.
 */
const refineTransactionRange = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const { omissions } = capture.events;
  const selected = new Set(
    enabledScenarioEventFamilies(
      capture.scenario.event_families,
      capture.scenario.network_content,
    ),
  );
  for (const [index, { kind, reasons }] of omissions.by_kind.entries())
    if (
      reasons.includes("max-network-transactions") &&
      browserScenarioEventKindFamily(kind) !== "network" &&
      // The family rule reports kinds the scenario did not select.
      browserScenarioOmissionKindSelected(kind, selected)
    )
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind", index],
        message: `max-network-transactions refuses network transactions, not ${kind} events`,
      });
  if (!selected.has("network")) return;
  const range = omissions.network_transaction_range;
  const refused = refusedDropBounds(omissions);
  if (range === null ? refused.atLeast > 0 : refused.atMost < range.count)
    context.addIssue({
      code: "custom",
      path: ["events", "omissions", "network_transaction_range"],
      message:
        range === null
          ? "Network events dropped for max-network-transactions require the omitted transaction range"
          : "Each transaction in the omitted range drops at least one network event for max-network-transactions",
    });
};

/** Admitted transactions are omitted for any budget except the range's own. */
const transactionOmissionReason = (
  reason: BrowserScenarioEventBudgetReason,
): boolean => reason !== "max-network-transactions";

/**
 * An admitted transaction names an omitted kind and reason only after that
 * event was dropped for that reason, so each per-transaction omission is
 * backed by by_kind, and every budget drop of a network kind names its
 * transaction. Refused transactions belong to the omitted range instead.
 */
const refineTransactionOmissions = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  if (!networkSelected(capture)) return;
  const { by_kind: byKind, network_transactions: transactions } =
    capture.events.omissions;
  const dropped = new Map(byKind.map((omission) => [omission.kind, omission]));
  for (const [index, omission] of transactions.entries()) {
    // The family rule reports non-network kinds.
    if (
      omission.omitted_kinds.some(
        (kind) => browserScenarioEventKindFamily(kind) !== "network",
      )
    )
      continue;
    const backed =
      omission.omitted_kinds.every((kind) => dropped.has(kind)) &&
      omission.reasons.every(
        (reason) =>
          transactionOmissionReason(reason) &&
          omission.omitted_kinds.some((kind) =>
            dropped.get(kind)?.reasons.includes(reason),
          ),
      );
    if (!backed)
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "network_transactions", index],
        message:
          "Each omitted transaction kind and budget reason must be dropped in by_kind",
      });
  }
  for (const [index, omission] of byKind.entries()) {
    if (browserScenarioEventKindFamily(omission.kind) !== "network") continue;
    const unnamed = omission.reasons.filter(
      (reason) =>
        transactionOmissionReason(reason) &&
        !transactions.some(
          (transaction) =>
            transaction.omitted_kinds.includes(omission.kind) &&
            transaction.reasons.includes(reason),
        ),
    );
    if (unnamed.length > 0)
      context.addIssue({
        code: "custom",
        path: ["events", "omissions", "by_kind", index],
        message: `${omission.kind} events dropped for ${unnamed.join(", ")} must name their transactions in network_transactions`,
      });
  }
};

/**
 * Every sequence number the recorder spends belongs to a retained or dropped
 * event, and drops of refused transactions spend none. No retained event or
 * recorded window therefore reaches past the sequenced events.
 */
const refineSequenceAccounting = (
  { steps, events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const accounted =
    events.retained +
    events.dropped -
    refusedDropBounds(events.omissions).atLeast;
  for (const [index, { sequence }] of events.items.entries())
    if (sequence > accounted)
      context.addIssue({
        code: "custom",
        path: ["events", "items", index, "sequence"],
        message: `Event sequence ${String(sequence)} exceeds the ${String(accounted)} sequenced retained and dropped events`,
      });
  for (const [index, step] of steps.entries())
    if (step.event_sequence_end > accounted)
      context.addIssue({
        code: "custom",
        path: ["steps", index, "event_sequence_end"],
        message: `Step ${String(index)}'s receipt window ends after the ${String(accounted)} sequenced retained and dropped events`,
      });
};

/**
 * Network content records exactly the facets the scenario selected for its
 * phase: headers with header_values, and the body with that phase's body
 * facet. Without any selected facet the recorder neither keeps nor drops it.
 */
const refineNetworkContentFacets = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  if (!networkSelected(capture)) return;
  const selection = capture.scenario.network_content;
  if (
    !selection.header_values &&
    !selection.request_body &&
    !selection.response_body
  )
    for (const [index, { kind }] of capture.events.omissions.by_kind.entries())
      if (kind === "network-content")
        context.addIssue({
          code: "custom",
          path: ["events", "omissions", "by_kind", index, "kind"],
          message:
            "No network content facet was selected, so no network content was dropped",
        });
  for (const [index, event] of capture.events.items.entries()) {
    if (event.kind !== "network-content") continue;
    const path = ["events", "items", index];
    const bodySelected =
      event.phase === "request"
        ? selection.request_body
        : selection.response_body;
    if (!selection.header_values && !bodySelected) {
      context.addIssue({
        code: "custom",
        path,
        message: `No ${event.phase} content facet was selected`,
      });
      continue;
    }
    if ((event.headers.state === "not_requested") === selection.header_values)
      context.addIssue({
        code: "custom",
        path: [...path, "headers"],
        message: selection.header_values
          ? "Selected header values cannot be recorded as not requested"
          : "Header values were not selected",
      });
    if ((event.body.state === "not_requested") === bodySelected)
      context.addIssue({
        code: "custom",
        path: [...path, "body"],
        message: bodySelected
          ? `The selected ${event.phase} body cannot be recorded as not requested`
          : `The ${event.phase} body was not selected`,
      });
  }
};

/** The collector creates each transaction once and emits its request once. */
const refineTransactionRequests = (
  { events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const requested = new Set<string>();
  for (const [index, event] of events.items.entries()) {
    if (event.kind !== "request") continue;
    if (requested.has(event.transaction_id))
      context.addIssue({
        code: "custom",
        path: ["events", "items", index, "transaction_id"],
        message: `Transaction ${event.transaction_id} already has a request event`,
      });
    requested.add(event.transaction_id);
  }
};

/**
 * The recorder stops retaining events at max_events, and the network collector
 * admits at most max_network_transactions transactions; refused ones only
 * appear in the omitted range.
 */
const refineEventLimits = (
  { scenario, events }: CapturedFields,
  context: z.RefinementCtx,
): void => {
  const { max_events: maxEvents, max_network_transactions: maxTransactions } =
    scenario.limits;
  if (events.retained > maxEvents)
    context.addIssue({
      code: "custom",
      path: ["events", "retained"],
      message: `${String(events.retained)} retained events exceed max_events ${String(maxEvents)}`,
    });
  const admitted = new Set([
    ...events.items.flatMap((event) =>
      "transaction_id" in event ? [event.transaction_id] : [],
    ),
    ...events.omissions.network_transactions.map(
      ({ transaction_id: id }) => id,
    ),
  ]);
  if (admitted.size > maxTransactions)
    context.addIssue({
      code: "custom",
      path: ["events", "items"],
      message: `${String(admitted.size)} admitted network transactions exceed max_network_transactions ${String(maxTransactions)}`,
    });
};

/** Cross-field rules for retained events, their accounting and omissions. */
export const refineScenarioEvents = (
  capture: CapturedFields,
  context: z.RefinementCtx,
): void => {
  refineSelectedEventFamilies(capture, context);
  refineOmissionCounts(capture, context);
  refineTransactionRange(capture, context);
  refineTransactionOmissions(capture, context);
  refineSequenceAccounting(capture, context);
  refineNetworkContentFacets(capture, context);
  refineTransactionRequests(capture, context);
  refineEventLimits(capture, context);
};
