/** Shared domain types. Phase 2A only defines what the placeholder shell needs. */

export interface SelectableOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
}

export interface MetricPlaceholder {
  readonly id: string;
  readonly label: string;
  /** What this card will show once its data source is connected. */
  readonly description: string;
}

export type MilestoneState = "done" | "planned";

export interface Milestone {
  readonly id: string;
  readonly label: string;
  readonly state: MilestoneState;
}
