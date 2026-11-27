import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env";

const ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798";
const exec = promisify(execFile);
/** az can wedge (e.g. on token-cache contention); don't let it hang a board load forever. */
const run = (cmd: string, args: string[]) =>
	exec(cmd, args, { timeout: 90_000, killSignal: "SIGKILL" });
let azToken: { value: string; expiresAt: number } | null = null;
let azTenant: string | null | undefined; // undefined = not resolved yet, null = az default

async function azAccessToken(tenant: string | null) {
	const args = [
		"account",
		"get-access-token",
		"--resource",
		ADO_RESOURCE,
		"-o",
		"json",
	];
	if (tenant) args.push("--tenant", tenant);
	const t = JSON.parse((await run("az", args)).stdout);
	return {
		value: t.accessToken as string,
		expiresAt: t.expires_on
			? Number(t.expires_on) * 1000
			: Date.parse(String(t.expiresOn).replace(" ", "T")),
	};
}

/**
 * Without a PAT, borrow the az CLI login. Like `az devops`, try each signed-in tenant
 * until one yields a token the org accepts (ADO_TENANT short-circuits the search).
 */
let azPending: Promise<string> | null = null;

/** One az lookup at a time: parallel board fetches share it instead of each spawning az. */
function azBearer() {
	if (azToken && azToken.expiresAt > Date.now() + 120_000)
		return Promise.resolve(azToken.value);
	azPending ??= resolveAzBearer().finally(() => {
		azPending = null;
	});
	return azPending;
}

async function resolveAzBearer() {
	if (azToken && azToken.expiresAt > Date.now() + 120_000) return azToken.value;
	if (azTenant !== undefined) {
		azToken = await azAccessToken(azTenant);
		return azToken.value;
	}
	const failures: string[] = [];
	const tried = new Set<string | null>();
	const tryTenant = async (tenant: string | null) => {
		if (tried.has(tenant)) return null;
		tried.add(tenant);
		try {
			const tok = await azAccessToken(tenant);
			const res = await fetch(
				`https://dev.azure.com/${env.ado.org}/_apis/connectionData?api-version=7.1-preview`,
				{
					headers: { Authorization: `Bearer ${tok.value}` },
				},
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			azTenant = tenant;
			azToken = tok;
			return tok.value;
		} catch (e) {
			failures.push(
				`${tenant ?? "default"}: ${(e as Error).message.split("\n")[0].slice(0, 120)}`,
			);
			return null;
		}
	};
	// Cheap guesses first; listing every tenant is a slow az call, so only when they miss.
	for (const tenant of [env.ado.tenant || null, null]) {
		const tok = await tryTenant(tenant);
		if (tok) return tok;
	}
	const listed = JSON.parse(
		(
			await run("az", [
				"account",
				"list",
				"--all",
				"--query",
				"[].tenantId",
				"-o",
				"json",
			])
		).stdout,
	) as string[];
	for (const tenant of new Set(listed)) {
		const tok = await tryTenant(tenant);
		if (tok) return tok;
	}
	throw new Error(
		`No ADO_PAT set and no az CLI tenant can reach ${env.ado.org}. Tried ${failures.join("; ")}`,
	);
}

async function authHeader() {
	if (env.ado.pat)
		return `Basic ${Buffer.from(`:${env.ado.pat}`).toString("base64")}`;
	return `Bearer ${await azBearer()}`;
}

async function ado<T>(path: string, init: RequestInit = {}): Promise<T> {
	if (!env.ado.org || !env.ado.project)
		throw new Error("Set ADO_ORG and ADO_PROJECT");
	const res = await fetch(`https://dev.azure.com/${env.ado.org}${path}`, {
		...init,
		headers: {
			Authorization: await authHeader(),
			"Content-Type": "application/json",
			Accept: "application/json",
			...init.headers,
		},
	});
	if (!res.ok)
		throw new Error(
			`ADO ${init.method ?? "GET"} ${path.split("?")[0]} → ${res.status}: ${(await res.text()).slice(0, 300)}`,
		);
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

const proj = () => `/${encodeURIComponent(env.ado.project)}`;

// ── Types (subset of the ADO REST shapes we read) ───────────
export interface AdoIdentity {
	id: string;
	displayName: string;
	uniqueName?: string;
	isContainer?: boolean;
}
export interface AdoReviewer extends AdoIdentity {
	vote: number;
	isRequired?: boolean;
	votedFor?: AdoReviewer[];
}
export interface AdoPr {
	pullRequestId: number;
	title: string;
	status: string;
	isDraft: boolean;
	createdBy: AdoIdentity;
	creationDate: string;
	sourceRefName: string;
	targetRefName: string;
	mergeStatus?: string;
	reviewers: AdoReviewer[];
	repository: {
		id: string;
		name: string;
		project: { id: string; name: string };
	};
}
export interface AdoThread {
	id: number;
	status?: string;
	isDeleted?: boolean;
	comments: {
		id: number;
		author?: AdoIdentity;
		content?: string;
		commentType?: string;
		isDeleted?: boolean;
		publishedDate?: string;
		lastUpdatedDate?: string;
		lastContentUpdatedDate?: string;
	}[];
}
export interface AdoEvaluation {
	evaluationId: string;
	status:
		| "queued"
		| "running"
		| "approved"
		| "rejected"
		| "notApplicable"
		| "broken";
	configuration: {
		isBlocking: boolean;
		isEnabled: boolean;
		type: { id: string; displayName: string };
		settings?: { displayName?: string; buildDefinitionId?: number };
	};
	context?: {
		buildId?: number;
		isExpired?: boolean;
		buildOutputPreview?: unknown;
	};
}

// ── Reads ────────────────────────────────────────────────────
let meCache: AdoIdentity | null = null;
export async function me() {
	if (meCache) return meCache;
	const data = await ado<{
		authenticatedUser: { id: string; providerDisplayName: string };
	}>("/_apis/connectionData?api-version=7.1-preview");
	meCache = {
		id: data.authenticatedUser.id,
		displayName: data.authenticatedUser.providerDisplayName,
	};
	return meCache;
}

export async function listPrs(criteria: {
	creatorId?: string;
	reviewerId?: string;
}) {
	const q = new URLSearchParams({
		"searchCriteria.status": "active",
		$top: "200",
		"api-version": "7.1",
	});
	if (criteria.creatorId) q.set("searchCriteria.creatorId", criteria.creatorId);
	if (criteria.reviewerId)
		q.set("searchCriteria.reviewerId", criteria.reviewerId);
	return (
		await ado<{ value: AdoPr[] }>(`${proj()}/_apis/git/pullrequests?${q}`)
	).value;
}

export async function threads(repoId: string, prId: number) {
	return (
		await ado<{ value: AdoThread[] }>(
			`${proj()}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=7.1`,
		)
	).value;
}

export async function evaluations(projectId: string, prId: number) {
	const artifactId = `vstfs:///CodeReview/CodeReviewId/${projectId}/${prId}`;
	return (
		await ado<{ value: AdoEvaluation[] }>(
			`${proj()}/_apis/policy/evaluations?artifactId=${encodeURIComponent(artifactId)}&api-version=7.1-preview.1`,
		)
	).value;
}

/** PRs by `creatorId` that completed or were abandoned since `sinceMs` (newest first). */
export async function listClosedPrsSince(creatorId: string, sinceMs: number) {
	const page = async (status: "completed" | "abandoned") => {
		const q = new URLSearchParams({
			"searchCriteria.status": status,
			"searchCriteria.creatorId": creatorId,
			$top: "25",
			"api-version": "7.1",
		});
		return (
			await ado<{ value: (AdoPr & { closedDate?: string })[] }>(
				`${proj()}/_apis/git/pullrequests?${q}`,
			)
		).value;
	};
	const all = (
		await Promise.all([page("completed"), page("abandoned")])
	).flat();
	return all.filter((p) => Date.parse(p.closedDate ?? "") >= sinceMs);
}

/** One entry per push (ADO "iteration"), including the PR's creation. */
export async function iterations(repoId: string, prId: number) {
	return (
		await ado<{
			value: { id: number; createdDate: string; reason?: string }[];
		}>(
			`${proj()}/_apis/git/repositories/${repoId}/pullRequests/${prId}/iterations?api-version=7.1`,
		)
	).value;
}

/** A build's outcome; used to tell a cancelled (superseded) build from a real failure. */
export function build(buildId: number) {
	return ado<{ status: string; result?: string }>(
		`${proj()}/_apis/build/builds/${buildId}?api-version=7.1`,
	);
}

// ── Writes ───────────────────────────────────────────────────
export function requeueEvaluation(evaluationId: string) {
	return ado<AdoEvaluation>(
		`${proj()}/_apis/policy/evaluations/${evaluationId}?api-version=7.1-preview.1`,
		{
			method: "PATCH",
		},
	);
}

/** Posts a comment as a closed thread so it never trips "all comments resolved" policies. */
export function postComment(repoId: string, prId: number, content: string) {
	return ado(
		`${proj()}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads?api-version=7.1`,
		{
			method: "POST",
			body: JSON.stringify({
				comments: [{ parentCommentId: 0, content, commentType: 1 }],
				status: "closed",
			}),
		},
	);
}

export function setDraft(repoId: string, prId: number, isDraft: boolean) {
	return ado(
		`${proj()}/_apis/git/repositories/${repoId}/pullrequests/${prId}?api-version=7.1`,
		{
			method: "PATCH",
			body: JSON.stringify({ isDraft }),
		},
	);
}

/**
 * Completes (merges) a PR the way you would in ADO. Re-reads the PR first so it merges
 * exactly the commit ADO last evaluated; ADO refuses if a required policy isn't met.
 */
export async function completePr(repoId: string, prId: number) {
	const path = `${proj()}/_apis/git/repositories/${repoId}/pullrequests/${prId}?api-version=7.1`;
	const pr = await ado<{
		status: string;
		title: string;
		isDraft: boolean;
		mergeStatus?: string;
		lastMergeSourceCommit?: { commitId: string };
	}>(path);
	if (pr.status !== "active") throw new Error(`PR is already ${pr.status}`);
	if (pr.isDraft) throw new Error("PR is a draft; publish it first");
	if (pr.mergeStatus === "conflicts") throw new Error("PR has merge conflicts");
	if (!pr.lastMergeSourceCommit)
		throw new Error("ADO hasn't evaluated a merge for this PR yet");
	const done = await ado<{ status: string; mergeStatus?: string }>(path, {
		method: "PATCH",
		body: JSON.stringify({
			status: "completed",
			lastMergeSourceCommit: pr.lastMergeSourceCommit,
			completionOptions: {
				mergeStrategy: env.ado.mergeStrategy,
				deleteSourceBranch: env.ado.deleteSourceBranch,
				mergeCommitMessage: `Merged PR ${prId}: ${pr.title}`,
				transitionWorkItems: false,
			},
		}),
	});
	return { status: done.status };
}

/** Resolves comment threads, e.g. CodeRabbit's command acknowledgements blocking "Comment requirements". */
export function closeThreads(
	repoId: string,
	prId: number,
	threadIds: number[],
) {
	return Promise.all(
		threadIds.map((id) =>
			ado(
				`${proj()}/_apis/git/repositories/${repoId}/pullRequests/${prId}/threads/${id}?api-version=7.1`,
				{
					method: "PATCH",
					body: JSON.stringify({ status: "closed" }),
				},
			),
		),
	);
}

// ── URLs ─────────────────────────────────────────────────────
export const prUrl = (repoName: string, id: number) =>
	`https://dev.azure.com/${env.ado.org}/${encodeURIComponent(env.ado.project)}/_git/${encodeURIComponent(repoName)}/pullrequest/${id}`;
export const buildUrl = (buildId: number) =>
	`https://dev.azure.com/${env.ado.org}/${encodeURIComponent(env.ado.project)}/_build/results?buildId=${buildId}`;
