export const STAGES = [
	{
		id: "raised",
		label: "PR raised",
		hint: "Waiting on CodeRabbit to review the latest push",
	},
	{
		id: "cr_rate_limited",
		label: "CodeRabbit rate limited",
		hint: "Hit its review limit, ask again once the window opens",
	},
	{
		id: "cr_feedback",
		label: "CodeRabbit fed back",
		hint: "Left comments or asked for changes",
	},
	{ id: "cr_approved", label: "CodeRabbit approved", hint: "Waiting on QA" },
	{
		id: "cr_qa_approved",
		label: "CodeRabbit + QA approved",
		hint: "Both approved; merge once required checks are green",
	},
] as const;

export type Stage = (typeof STAGES)[number]["id"];

/** Ship / Show / Ask — the first word of the PR title. */
export const KINDS = [
	{ id: "ship", label: "SHIP", hint: "Merge without waiting on review" },
	{ id: "show", label: "SHOW", hint: "Merge, then show the team" },
	{ id: "ask", label: "ASK", hint: "Needs review before merge" },
] as const;
export type PrKind = (typeof KINDS)[number]["id"];
export const stageIndex = (s: Stage) => STAGES.findIndex((x) => x.id === s);

export type CheckState =
	| "passed"
	| "failed"
	| "running"
	| "queued"
	| "expired"
	| "canceled"
	| "not_applicable";

export interface Check {
	evaluationId: string;
	name: string;
	kind: string;
	state: CheckState;
	isBlocking: boolean;
	isBuild: boolean;
	buildUrl: string | null;
}

export interface Reviewer {
	name: string;
	vote: number;
	isRequired: boolean;
	role: "coderabbit" | "qa" | "other";
	isGroup: boolean;
}

export interface CodeRabbitSignal {
	vote: number | null;
	rateLimited: boolean;
	/** ISO time the next review window opens, when CodeRabbit says so. */
	rateLimitEta: string | null;
	openThreads: number;
	/**
	 * Your latest "@coderabbitai review", until a review lands after it.
	 * pending: no answer yet. accepted: "Actions performed". declined: "Action not completed".
	 */
	/** CodeRabbit asked for changes, you've pushed since, and it hasn't re-reviewed yet. */
	awaitingReReview: boolean;
	request: {
		at: string;
		state: "pending" | "accepted" | "declined";
		reason: string | null;
	} | null;
}

export interface PrView {
	id: number;
	repoId: string;
	repoName: string;
	projectId: string;
	title: string;
	/** Title without the SHIP/SHOW/ASK prefix. */
	shortTitle: string;
	kind: PrKind | null;
	url: string;
	author: string;
	isDraft: boolean;
	sourceBranch: string;
	targetBranch: string;
	createdAt: string;
	hasConflicts: boolean;
	ticketKey: string | null;
	reviewers: Reviewer[];
	codeRabbit: CodeRabbitSignal;
	qaVote: number | null;
	openThreads: number;
	/** Active threads that are only CodeRabbit acknowledging a command; they still block "Comment requirements". */
	ackThreadIds: number[];
	/** How many of those SSM just resolved itself this load. */
	autoResolved: number;
	checks: Check[];
	stage: Stage;
}

export interface JiraTicket {
	key: string;
	url: string;
	summary: string;
	status: string;
	statusCategory: "new" | "indeterminate" | "done" | string;
	assignee: string | null;
	assigneeId: string | null;
	issueType: string | null;
	issueTypeIcon: string | null;
}

export interface TicketGroup {
	id: string;
	ticketKey: string | null;
	jira: JiraTicket | null;
	prs: PrView[];
	stage: Stage;
	/** Kind of its least-advanced tagged PR. */
	kind: PrKind | null;
	/** Jira should probably be moved to JIRA_PR_STATUS. */
	jiraNeedsMove: boolean;
}

export interface Board {
	fetchedAt: string;
	me: { name: string } | null;
	jiraPrStatus: string;
	/** Jira accountId of the signed-in token, to flag tickets that aren't mine. */
	jiraMeId: string | null;
	lanes: { stage: Stage; groups: TicketGroup[] }[];
	/** Jira tickets in progress with no open PR. */
	noPr: JiraTicket[];
	errors: string[];
}

export interface JiraUser {
	accountId: string;
	name: string;
	avatar: string | null;
}

export interface JiraTransition {
	id: string;
	name: string;
	to: string;
}

export const STAGE_META = Object.fromEntries(
	STAGES.map((s) => [s.id, s]),
) as Record<Stage, (typeof STAGES)[number]>;
