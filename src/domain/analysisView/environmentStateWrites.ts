import type { ExtractedState } from "./environmentStateRules.js";
import {
  EnvironmentStateWriteSimulation,
  type WriteSimulationInput,
} from "./EnvironmentStateWriteSimulation.js";

/** The instant a served clock starts from: the end of the last timed record, to the next whole second. */
const clockStart = (
  records: WriteSimulationInput["records"],
  timed: boolean,
): string | null => {
  if (!timed || records.length === 0) return null;
  const end = records.reduce(
    (latest, record) => Math.max(latest, record.end),
    Number.NEGATIVE_INFINITY,
  );
  return Number.isFinite(end)
    ? new Date(Math.ceil(end / 1000) * 1000).toISOString()
    : null;
};

/** The write plans a capture's own timeline confirms against an extracted state, and the served clock's start. */
export const extractWrites = (
  state: Pick<ExtractedState, "views" | "types" | "entities" | "documents">,
  input: Omit<
    WriteSimulationInput,
    "views" | "types" | "entities" | "documents"
  >,
): Pick<ExtractedState, "writes" | "write_clock"> => ({
  writes: new EnvironmentStateWriteSimulation({
    ...input,
    views: new Map(state.views.map((view) => [view.tool, view])),
    types: state.types,
    entities: state.entities,
    documents: state.documents,
  }).run(),
  write_clock: clockStart(input.records, input.timed),
});
