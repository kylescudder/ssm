/**
 * CodeRabbit review allowance — per developer, rolling 60-minute window.
 *
 * Docs (docs.coderabbit.ai/management/rate-limits): limits are per developer identity;
 * each review holds one slot until it ages out of the rolling hour; a rate-limited push
 * costs nothing; the hourly allowance N adapts to the last 7 days of usage.
 *
 * What ADO shows us, per PR thread:
 *  - Review: a CodeRabbit comment with "ℹ️ Review info" + a Run ID. Fresh comments
 *    ("Actionable comments posted") are stamped when the review *finishes*; the summary
 *    comment is edited in place. Recent ones say "N remain after this review".
 *  - Notice: the summary rewritten as "Review limit reached … Next included review
 *    available in X". That gives the exact time the earliest slot frees.
 *  - My own "@coderabbitai review" with no answer yet: a review is probably running.
 *
 * A slot is spent when a review *starts* (~5–10 min before its comment), so review
 * timestamps over-estimate; each notice pins the real release time and corrects them.
 */
import { matchesAny, parseRateLimitWait, type ThreadLike } from "./signals";

export const WINDOW_MS = 60 * 60_000;

export interface CrReview {
	at: number;
	prId: number;
	runId: string | null;
	remaining: number | null;
	perHour: number | null;
}

export interface CrNotice {
	at: number;
	prId: number;
	releaseAt: number | null;
	perHour: number | null;
	weekAttempts: number | null;
}

/** Something that starts a review: PR opened, a push, or a manual "@coderabbitai review". */
export interface CrTrigger {
	at: number;
	prId: number;
	kind: "push" | "manual";
}

export interface CrEvents {
	reviews: CrReview[];
	notices: CrNotice[];
	triggers: CrTrigger[];
}

const RATE_LIMIT_MARKER = "rate limited by coderabbit.ai";
const SUMMARY_MARKER = "summarize by coderabbit.ai";

const num = (re: RegExp, s: string) => {
	const m = s.match(re);
	return m ? Number(m[1]) : null;
};

export const parsePerHour = (s: string) =>
	num(/allowance at (\d+) reviews? per hour/i, s) ??
	num(/up to (\d+) included reviews? per hour/i, s);

export const parseRemaining = (s: string) =>
	num(/(\d+) included reviews? remains? after this review/i, s) ??
	num(/;\s*(\d+) remains? after this review/i, s);

const ts = (s?: string) => (s ? Date.parse(s) || 0 : 0);

/** Pulls review/notice/trigger events out of one PR's threads. */
/** "@coderabbitai review" / "@coderabbitai full review" — both start a review. */
const MANUAL_TRIGGER = /^\s*@coderabbitai\s+(?:full\s+)?review\b/i;

export function extractCrEvents(
	prId: number,
	threads: ThreadLike[],
	crMatch: string[],
): CrEvents {
	const reviews: CrReview[] = [];
	const notices: CrNotice[] = [];
	const triggers: CrTrigger[] = [];

	for (const t of threads) {
		if (t.isDeleted) continue;
		for (const c of t.comments) {
			if (c.isDeleted || c.commentType === "system" || !c.author) continue;
			const body = c.content ?? "";
			const edited = ts(c.lastContentUpdatedDate ?? c.lastUpdatedDate);
			if (!matchesAny(c.author, crMatch)) {
				if (MANUAL_TRIGGER.test(body))
					triggers.push({ at: ts(c.publishedDate), prId, kind: "manual" });
				continue;
			}

			if (body.includes(RATE_LIMIT_MARKER)) {
				const wait = parseRateLimitWait(body);
				notices.push({
					at: edited,
					prId,
					releaseAt: wait ? edited + wait : null,
					perHour: parsePerHour(body),
					weekAttempts: num(
						/Your (\d+) included PR review attempts over the past 7 days/i,
						body,
					),
				});
				continue;
			}
			const run = body.match(/\*\*Run ID\*\*:\s*`([0-9a-f-]+)`/i);
			if (!run && !body.includes("Included review availability")) continue;
			reviews.push({
				// Summary comments are rewritten per review; fresh comments are posted per review.
				at: body.includes(SUMMARY_MARKER) ? edited : ts(c.publishedDate),
				prId,
				runId: run?.[1] ?? null,
				remaining: parseRemaining(body),
				perHour: parsePerHour(body),
			});
		}
	}

	return { reviews, notices, triggers };
}

/** PR iterations (ADO records the PR's creation and every push as one). */
export function pushTriggers(
	prId: number,
	iterations: { createdDate?: string }[],
): CrTrigger[] {
	return iterations
		.map((i) => ({ at: ts(i.createdDate), prId, kind: "push" as const }))
		.filter((t) => t.at > 0);
}

export function mergeEvents(list: CrEvents[]): CrEvents {
	const seen = new Set<string>();
	const reviews = list
		.flatMap((e) => e.reviews)
		.filter((r) => !r.runId || (!seen.has(r.runId) && seen.add(r.runId)));
	return {
		reviews,
		notices: list.flatMap((e) => e.notices),
		triggers: list.flatMap((e) => e.triggers),
	};
}

export type SlotSource = "review" | "in_flight" | "inferred";

export interface Slot {
	prId: number | null;
	/** When the slot was spent (the trigger that started the review). */
	at: string;
	freesAt: string;
	source: SlotSource;
}

export interface Allowance {
	perHour: number;
	busy: number;
	available: number;
	/** When the next slot frees; null when one is free now. */
	nextFreeAt: string | null;
	/** Busy slots right now, earliest release first. */
	slots: Slot[];
	/** PRs whose latest CodeRabbit word is a rate-limit notice, with nothing triggered since. */
	waiting: number[];
	/** "Your N included PR review attempts over the past 7 days", from the latest notice. */
	weekAttempts: number | null;
	/** Typical trigger → review-comment delay seen in the data (ms). */
	reviewLagMs: number;
}

/** No response this long after a trigger: CodeRabbit isn't reviewing it (paused, draft, ignored). */
export const IN_FLIGHT_MS = 15 * 60_000;
/** A review comment more than this after a trigger isn't that trigger's review. */
const MAX_REVIEW_LAG_MS = 30 * 60_000;
const DEFAULT_LAG_MS = 6 * 60_000;

interface WorkSlot {
	prId: number | null;
	at: number;
	freesAt: number;
	source: SlotSource;
}

const median = (xs: number[]) => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
};

/**
 * 1. Pair each review with the trigger that started it — the slot is spent at the trigger,
 *    not when the comment lands. Triggers answered by a rate-limit notice cost nothing;
 *    unanswered recent triggers are reviews in flight.
 * 2. Replay CodeRabbit's own statements in time order to correct what we can't see:
 *    "N remain after this review" reveals reviews on PRs we didn't load; "next included
 *    review available in X" pins exactly when the earliest busy slot frees.
 */
export function computeAllowance(
	events: CrEvents,
	now: number,
	defaultPerHour = 1,
): Allowance {
	// Notices from up to a week back still mark a PR as waiting; old slots simply aren't active.
	const horizon = now - 7 * 24 * 3_600_000;
	const reviews = events.reviews.filter((r) => r.at > horizon && r.at <= now);
	const notices = events.notices.filter((n) => n.at > horizon && n.at <= now);
	const triggers = events.triggers.filter((t) => t.at > horizon && t.at <= now);

	// ── 1. Attribute responses to triggers, per PR ──
	type Resp = { kind: "review"; r: CrReview } | { kind: "notice"; n: CrNotice };
	const byPr = new Map<
		number,
		{ triggers: CrTrigger[]; responses: (Resp & { at: number })[] }
	>();
	const bucket = (prId: number) => {
		let b = byPr.get(prId);
		if (!b) {
			b = { triggers: [], responses: [] };
			byPr.set(prId, b);
		}
		return b;
	};
	for (const t of triggers) bucket(t.prId).triggers.push(t);
	for (const r of reviews)
		bucket(r.prId).responses.push({ kind: "review", r, at: r.at });
	for (const n of notices)
		bucket(n.prId).responses.push({ kind: "notice", n, at: n.at });

	const slots: WorkSlot[] = [];
	const lags: number[] = [];
	const unmatchedReviews: CrReview[] = [];
	const waiting: number[] = [];

	for (const [prId, b] of byPr) {
		b.triggers.sort((x, y) => x.at - y.at);
		b.responses.sort((x, y) => x.at - y.at);
		let ti = 0;
		let lastAnswered = -1;
		for (const resp of b.responses) {
			// The earliest unanswered trigger before this response started it.
			let start: CrTrigger | null = null;
			while (ti < b.triggers.length && b.triggers[ti].at <= resp.at) {
				if (!start && resp.at - b.triggers[ti].at <= MAX_REVIEW_LAG_MS)
					start = b.triggers[ti];
				ti++;
			}
			lastAnswered = ti - 1;
			if (resp.kind === "notice") continue; // rate-limited attempts cost nothing
			if (start) {
				lags.push(resp.at - start.at);
				slots.push({
					prId,
					at: start.at,
					freesAt: start.at + WINDOW_MS,
					source: "review",
				});
			} else unmatchedReviews.push(resp.r);
		}
		// Triggers after the last response: in flight if recent.
		const open = b.triggers.slice(lastAnswered + 1);
		if (open.length && now - open[0].at < IN_FLIGHT_MS)
			slots.push({
				prId,
				at: open[0].at,
				freesAt: open[0].at + WINDOW_MS,
				source: "in_flight",
			});
		const last = b.responses[b.responses.length - 1];
		if (last?.kind === "notice" && !open.length) waiting.push(prId);
	}

	const reviewLagMs = median(lags) ?? DEFAULT_LAG_MS;
	for (const r of unmatchedReviews)
		slots.push({
			prId: r.prId,
			at: r.at - reviewLagMs,
			freesAt: r.at - reviewLagMs + WINDOW_MS,
			source: "review",
		});

	// ── 2. Replay CodeRabbit's statements as corrections ──
	type Anchor =
		| ({ kind: "review" } & CrReview)
		| ({ kind: "notice" } & CrNotice);
	const anchors: Anchor[] = [
		...reviews.map((r) => ({ kind: "review" as const, ...r })),
		...notices.map((n) => ({ kind: "notice" as const, ...n })),
	].sort((a, b) => a.at - b.at);

	const activeAt = (t: number) =>
		slots
			.filter((s) => s.at <= t && s.freesAt > t)
			.sort((a, b) => a.freesAt - b.freesAt);

	/** CodeRabbit said exactly `busy` slots were taken: in-flight guesses beyond that were wrong. */
	const prune = (t: number, busy: number) => {
		const extra = activeAt(t)
			.filter((s) => s.source === "in_flight")
			.sort((x, y) => y.at - x.at);
		for (
			let over = activeAt(t).length - busy;
			over > 0 && extra.length;
			over--
		) {
			const s = extra.shift() as WorkSlot;
			slots.splice(slots.indexOf(s), 1);
		}
	};

	let perHour = defaultPerHour;
	let weekAttempts: number | null = null;
	for (const a of anchors) {
		if (a.perHour) perHour = a.perHour;
		if (a.kind === "review") {
			if (a.remaining == null) continue;
			prune(a.at, perHour - a.remaining);
			const missing = perHour - a.remaining - activeAt(a.at).length;
			for (let i = 0; i < missing; i++)
				slots.push({
					prId: null,
					at: a.at,
					freesAt: a.at + WINDOW_MS,
					source: "inferred",
				});
			continue;
		}
		if (a.weekAttempts != null) weekAttempts = a.weekAttempts;
		if (a.releaseAt == null) continue;
		prune(a.at, perHour);
		const active = activeAt(a.at);
		for (let i = active.length; i < perHour; i++) {
			const s: WorkSlot = {
				prId: null,
				at: a.at,
				freesAt: a.releaseAt,
				source: "inferred",
			};
			slots.push(s);
			active.push(s);
		}
		active.sort((x, y) => x.freesAt - y.freesAt);
		// Nothing frees before CodeRabbit says; the earliest frees exactly then.
		for (const s of active)
			if (s.freesAt < a.releaseAt) s.freesAt = a.releaseAt;
		if (active[0].freesAt > a.releaseAt) active[0].freesAt = a.releaseAt;
	}

	const busy = activeAt(now);
	const available = Math.max(0, perHour - busy.length);
	const next = available > 0 ? null : busy[busy.length - perHour]?.freesAt;
	const iso = (t: number) => new Date(t).toISOString();

	return {
		perHour,
		busy: busy.length,
		available,
		nextFreeAt: next != null ? iso(next) : null,
		slots: busy.map((s) => ({
			prId: s.prId,
			at: iso(s.at),
			freesAt: iso(s.freesAt),
			source: s.source,
		})),
		waiting,
		weekAttempts,
		reviewLagMs,
	};
}
