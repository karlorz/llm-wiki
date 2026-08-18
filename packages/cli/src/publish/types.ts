import type { ErrResult, Result } from "@skillwiki/shared";
import type { ManagedWriteMode, ManagedWritePreflightInput, ManagedWriteReceipt } from "../utils/managed-write-preflight.js";
import type { ApprovalPayload } from "../utils/publication-approval.js";
import type { PublicationIdentitySummary } from "../utils/publication-operation-journal.js";

export type RootAggregateMode = "dual" | "source-only";

export function resolveRootAggregateMode(env: Record<string, string | undefined> = process.env): RootAggregateMode {
  if (env.SKILLWIKI_ROOT_AGGREGATE_MODE === "source-only") return "source-only";
  return "dual";
}

export type PipelineStageName =
  | "journal"
  | "schema"
  | "taxonomy"
  | "page"
  | "verify"
  | "project-index"
  | "index"
  | "unlock"
  | "event"
  | "log"
  | "journal-cleanup";

export interface PublicationPipelineDeps {
  afterStage(stage: string): Promise<void>;
  preflight(
    input: ManagedWritePreflightInput,
  ): Promise<{ exitCode: number; result: Result<ManagedWriteReceipt> }>;
}

export interface PreparedPublicationCore {
  target: string;
  targetPath: string;
  pageType: string;
  tags: string[];
  title: string;
  content: string;
  date: string;
  taxonomyComment: string;
  draftSha256: string;
  priorTargetSha256: string;
  approvalPayload: ApprovalPayload;
  operationId: string;
  source: { kind: "file"; realPath: string } | { kind: "content" };
  logNote?: string;
  project?: string;
  identity?: PublicationIdentitySummary;
}

export interface TargetIndexUpdateResult {
  changed: boolean;
  paths?: string[];
}

export interface PublicationStrategy<
  TPrepared extends PreparedPublicationCore = PreparedPublicationCore,
  TOutput = unknown,
> {
  publisherKind: "page" | "project-page";
  taxonomyStageName: "schema" | "taxonomy";
  requireApprovalOnWrite: boolean;
  usesJournal: boolean;

  revalidateTargetUnderLock(
    prepared: TPrepared,
    vault: string,
  ): Promise<Result<{ absolutePath: string }>>;

  verifyPublishedBytes(
    prepared: TPrepared,
    visiblePage: string,
    visibleTaxonomy: string[],
  ): boolean;

  updateIndicesLocked(
    prepared: TPrepared,
    vault: string,
    state: PipelineLockedState,
    observe: (stage: string) => Promise<ErrResult | undefined>,
  ): Promise<ErrResult | undefined>;

  previewIndices(
    prepared: TPrepared,
    vault: string,
    pageChanged: boolean,
  ): Promise<
    | { ok: true; data: { indexChanged?: boolean; projectIndexChanged: boolean; projectIndexPaths: string[] } }
    | { ok: false; exitCode: number; result: ErrResult }
  >;

  buildLogContent(
    prepared: TPrepared,
    taxonomyAdded: string[],
  ): string;

  buildLogEvent(
    prepared: TPrepared,
    writeReceipt: ManagedWriteReceipt,
  ): {
    kind: string;
    note: string;
    metadata: Record<string, unknown>;
  };

  buildOutput(
    prepared: TPrepared,
    details: {
      taxonomyAdded: string[];
      pageChanged: boolean;
      indexUpdated?: boolean;
      projectIndexChanged: boolean;
      logAppended: boolean;
      filesChanged: string[];
      dryRun: boolean;
      approvalToken?: string;
      receipt?: ManagedWriteReceipt | null;
    },
  ): TOutput;
}

export interface PipelineLockedState {
  taxonomyAdded: string[];
  pageChanged: boolean;
  indexUpdated: boolean;
  projectIndexUpdated: boolean;
  published: boolean;
  verified: boolean;
  changed: Set<string>;
}
