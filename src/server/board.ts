import {
	codeRabbitSignal,
	computeStage,
	extractKind,
	extractTicketKey,
	isCodeRabbitChatter,
	matchesAny,
} from "#/lib/signals";
import {
	type Board,
	type Check,
	type CheckState,
	type JiraTicket,
	type PrView,
	type Reviewer,
	STAGES,
	stageIndex,
	type TicketGroup,
} from "#/lib/types";
import * as ado from "./ado";
import { env } from "./env";
import * as jira from "./jira";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Tiny concurrency limiter so a big board doesn't hammer ADO. */
async function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (t: T) => Promise<R>,
) {
	const out: R[] = new Array(items.length);
	let i = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (i < items.length) {
				const idx = i++;
				out[idx] = await fn(items[idx]);
			}
		}),
	);
	return out;
}

function checkState(e: ado.AdoEvaluation, isBuild: boolean): CheckState {
	switch (e.status) {
		case "approved":
			return "passed";
		case "rejected":
		case "broken":
			return "failed";
		case "running":
			return "running";
		case "notApplicable":
			return "not_applicable";
		default:
			return isBuild && e.context?.isExpired ? "expired" : "queued";
	}
}

async function toChecks(evals: ado.AdoEvaluation[]): Promise<Check[]> {
	// A rejected build policy may only mean its build was cancelled (e.g. superseded by a
	// re-run). Ask the build, but only for those, to keep the board load cheap.
	const canceled = new Set<string>();
	await Promise.all(
		evals
			.filter(
				(e) =>
					e.status === "rejected" &&
					e.context?.buildId &&
					e.configuration.type.displayName === "Build",
			)
			.map(async (e) => {
				const b = await ado
					.build(e.context?.buildId as number)
					.catch(() => null);
				if (b?.result === "canceled") canceled.add(e.evaluationId);
			}),
	);
	return evals
		.filter((e) => e.configuration.isEnabled !== false)
		.map((e) => {
			const isBuild = e.configuration.type.displayName === "Build";
			return {
				evaluationId: e.evaluationId,
				name:
					e.configuration.settings?.displayName ||
					e.configuration.type.displayName,
				kind: e.configuration.type.displayName,
				state: canceled.has(e.evaluationId)
					? ("canceled" as const)
					: checkState(e, isBuild),
				isBlocking: e.configuration.isBlocking,
				isBuild,
				buildUrl: e.context?.buildId ? ado.buildUrl(e.context.buildId) : null,
			};
		})
		.sort(
			(a, b) =>
				Number(b.isBuild) - Number(a.isBuild) || a.name.localeCompare(b.name),
		);
}

function toReviewers(pr: ado.AdoPr): Reviewer[] {
	return pr.reviewers.map((r) => ({
		name: r.displayName.replace(/^\[[^\]]+\]\\/, ""),
		vote: r.vote,
		isRequired: !!r.isRequired,
		isGroup: !!r.isContainer,
		role: matchesAny(r, env.ado.coderabbitMatch)
			? "coderabbit"
			: matchesAny(r, env.ado.qaMatch)
				? "qa"
				: "other",
	}));
}

const maxVote = (rs: Reviewer[], role: Reviewer["role"]) => {
	const votes = rs.filter((r) => r.role === role).map((r) => r.vote);
	if (!votes.length) return null;
	// A rejection/wait from anyone in the role wins; otherwise the best approval.
	return Math.min(...votes) < 0 ? Math.min(...votes) : Math.max(...votes);
};

const isOpen = (t: ado.AdoThread) =>
	!t.isDeleted && (t.status === "active" || t.status === "pending");

async function buildPrView(
	pr: ado.AdoPr,
	detailed: boolean,
	warn: (m: string) => void = () => {},
): Promise<PrView> {
	const reviewers = toReviewers(pr);
	let [ths, evals] = detailed
		? await Promise.all([
				ado.threads(pr.repository.id, pr.pullRequestId),
				ado.evaluations(pr.repository.project.id, pr.pullRequestId),
			])
		: [[], []];

	// Review requests and CodeRabbit's acknowledgements fail "Comment requirements" while
	// active, yet need nobody's attention: resolve them, then re-read the policies.
	let chatter = ths.filter(
		(t) => isOpen(t) && isCodeRabbitChatter(t, env.ado.coderabbitMatch),
	);
	let autoResolved = 0;
	if (chatter.length && env.ado.autoResolveChatter) {
		try {
			await ado.closeThreads(
				pr.repository.id,
				pr.pullRequestId,
				chatter.map((t) => t.id),
			);
			autoResolved = chatter.length;
			const closed = new Set(chatter.map((t) => t.id));
			ths = ths.map((t) => (closed.has(t.id) ? { ...t, status: "closed" } : t));
			chatter = [];
			evals = await ado.evaluations(pr.repository.project.id, pr.pullRequestId);
		} catch (e) {
			warn(
				`PR ${pr.pullRequestId}: couldn't resolve CodeRabbit replies (${msg(e)})`,
			);
		}
	}
	const crVote = maxVote(reviewers, "coderabbit");
	const qaVote = maxVote(reviewers, "qa");
	const codeRabbit = codeRabbitSignal(ths, crVote, env.ado.coderabbitMatch);
	const branch = (ref: string) => ref.replace(/^refs\/heads\//, "");
	return {
		id: pr.pullRequestId,
		repoId: pr.repository.id,
		repoName: pr.repository.name,
		projectId: pr.repository.project.id,
		title: pr.title,
		shortTitle: extractKind(pr.title).rest,
		kind: extractKind(pr.title).kind,
		url: ado.prUrl(pr.repository.name, pr.pullRequestId),
		author: pr.createdBy.displayName,
		isDraft: pr.isDraft,
		sourceBranch: branch(pr.sourceRefName),
		targetBranch: branch(pr.targetRefName),
		createdAt: pr.creationDate,
		hasConflicts: pr.mergeStatus === "conflicts",
		ticketKey: extractTicketKey(
			pr.title,
			branch(pr.sourceRefName),
			env.jira.projects,
		),
		reviewers,
		codeRabbit,
		qaVote,
		openThreads: ths.filter(
			(t) =>
				isOpen(t) &&
				t.comments[0]?.commentType !== "system" &&
				!isCodeRabbitChatter(t, env.ado.coderabbitMatch),
		).length,
		ackThreadIds: chatter.map((t) => t.id),
		autoResolved,
		checks: await toChecks(evals),
		stage: computeStage(codeRabbit, qaVote),
	};
}

function jiraNeedsMove(t: JiraTicket | null, prs: PrView[]) {
	if (!t || t.statusCategory === "done" || prs.every((p) => p.isDraft))
		return false;
	const ok = [env.jira.prStatus, ...env.jira.okStatuses].map((s) =>
		s.toLowerCase(),
	);
	return !ok.includes(t.status.toLowerCase());
}

export async function loadBoard(): Promise<Board> {
	const errors: string[] = [];
	let meId: ado.AdoIdentity | null = null;
	let mine: PrView[] = [];

	try {
		meId = await ado.me();
		// Only PRs you raised; other people's PRs never appear.
		const own = await ado.listPrs({ creatorId: meId.id });
		mine = await mapLimit(own, 6, (pr) =>
			buildPrView(pr, true, (m) => errors.push(m)).catch(async (e) => {
				errors.push(`PR ${pr.pullRequestId}: ${msg(e)}`);
				return buildPrView(pr, false);
			}),
		);
	} catch (e) {
		errors.push(`Azure DevOps: ${msg(e)}`);
	}

	const keys = [
		...new Set(mine.map((p) => p.ticketKey).filter((k): k is string => !!k)),
	];
	let tickets = new Map<string, JiraTicket>();
	let openTickets: JiraTicket[] = [];
	let jiraMeId: string | null = null;
	if (env.jira.configured) {
		await Promise.all([
			jira
				.myself()
				.then((id) => {
					jiraMeId = id;
				})
				.catch((e) => errors.push(`Jira (who am I): ${msg(e)}`)),
			jira
				.getMany(keys)
				.then((m) => {
					tickets = m;
				})
				.catch((e) => errors.push(`Jira: ${msg(e)}`)),
			jira
				.search(env.jira.openJql, 50)
				.then((t) => {
					openTickets = t;
				})
				.catch((e) => errors.push(`Jira (no-PR query): ${msg(e)}`)),
		]);
	} else {
		errors.push(
			"Jira not configured — set JIRA_EMAIL and JIRA_API_TOKEN to see ticket status.",
		);
	}

	// Group my PRs by ticket — one card per ticket, however many PRs (main + release branches etc.)
	const byKey = new Map<string, PrView[]>();
	for (const pr of mine) {
		const id = pr.ticketKey ?? `pr:${pr.repoId}:${pr.id}`;
		byKey.set(id, [...(byKey.get(id) ?? []), pr]);
	}
	const groups: TicketGroup[] = [...byKey.entries()].map(([id, prs]) => {
		const ticketKey = prs[0].ticketKey;
		const t = ticketKey ? (tickets.get(ticketKey) ?? null) : null;
		prs.sort(
			(a, b) => stageIndex(a.stage) - stageIndex(b.stage) || a.id - b.id,
		);
		return {
			id,
			ticketKey,
			jira: t,
			prs,
			// A ticket is only as far along as its least-advanced PR.
			stage: prs[0].stage,
			kind: prs.find((p) => p.kind)?.kind ?? null,
			jiraNeedsMove: jiraNeedsMove(t, prs),
		};
	});

	const lanes = STAGES.map((s) => ({
		stage: s.id,
		groups: groups
			.filter((g) => g.stage === s.id)
			.sort(
				(a, b) =>
					Date.parse(a.prs[0].createdAt) - Date.parse(b.prs[0].createdAt),
			),
	}));

	const withPr = new Set(keys);
	return {
		fetchedAt: new Date().toISOString(),
		me: meId ? { name: meId.displayName } : null,
		jiraPrStatus: env.jira.prStatus,
		jiraMeId,
		lanes,
		noPr: openTickets.filter((t) => !withPr.has(t.key)),
		errors,
	};
}
