import {
	type Allowance,
	type CrEvents,
	computeAllowance,
	extractCrEvents,
	mergeEvents,
	pushTriggers,
	WINDOW_MS,
} from "#/lib/coderabbit-allowance";
import * as ado from "./ado";
import { env } from "./env";

export interface WaitingPr {
	id: number;
	repoId: string;
	title: string;
	url: string;
	/** When CodeRabbit rate-limited it. */
	since: string;
}

export interface CodeRabbitStatus extends Allowance {
	fetchedAt: string;
	/** Rate-limited open PRs, oldest first — the queue for the next free slot. */
	queue: WaitingPr[];
	/** Titles for PRs holding a slot, by id (closed ones included). */
	titles: Record<number, string>;
}

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

let cache: { at: number; value: Promise<CodeRabbitStatus> } | null = null;

/**
 * Rebuilds the developer's CodeRabbit allowance from every PR that can hold a slot:
 * open PRs plus any closed within the last two windows (a review on a PR merged
 * 20 minutes ago still counts). Drafts are skipped — CodeRabbit doesn't review them.
 */
export function loadCodeRabbitStatus(): Promise<CodeRabbitStatus> {
	if (cache && Date.now() - cache.at < 20_000) return cache.value;
	const value = load();
	cache = { at: Date.now(), value };
	value.catch(() => {
		cache = null;
	});
	return value;
}

async function load(): Promise<CodeRabbitStatus> {
	const now = Date.now();
	const me = await ado.me();
	const [open, closed] = await Promise.all([
		ado.listPrs({ creatorId: me.id }),
		ado.listClosedPrsSince(me.id, now - 2 * WINDOW_MS),
	]);
	const prs = [...open, ...closed];

	const perPr: CrEvents[] = await mapLimit(prs, 6, async (pr) => {
		const [ths, its] = await Promise.all([
			ado.threads(pr.repository.id, pr.pullRequestId),
			pr.isDraft
				? Promise.resolve([])
				: ado.iterations(pr.repository.id, pr.pullRequestId),
		]);
		const e = extractCrEvents(pr.pullRequestId, ths, env.ado.coderabbitMatch);
		return {
			...e,
			triggers: [...e.triggers, ...pushTriggers(pr.pullRequestId, its)],
		};
	});
	const events = mergeEvents(perPr);
	const allowance = computeAllowance(events, now);

	const lastNotice = new Map<number, number>();
	for (const n of events.notices)
		lastNotice.set(n.prId, Math.max(lastNotice.get(n.prId) ?? 0, n.at));
	const openById = new Map(
		open.filter((p) => !p.isDraft).map((p) => [p.pullRequestId, p]),
	);
	const queue = allowance.waiting
		.map((id) => openById.get(id))
		.filter((p): p is ado.AdoPr => !!p)
		.map((p) => ({
			id: p.pullRequestId,
			repoId: p.repository.id,
			title: p.title,
			url: ado.prUrl(p.repository.name, p.pullRequestId),
			since: new Date(lastNotice.get(p.pullRequestId) ?? now).toISOString(),
		}))
		.sort((a, b) => Date.parse(a.since) - Date.parse(b.since));

	return {
		...allowance,
		fetchedAt: new Date(now).toISOString(),
		queue,
		titles: Object.fromEntries(prs.map((p) => [p.pullRequestId, p.title])),
	};
}
