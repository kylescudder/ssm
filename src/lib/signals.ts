import type { CodeRabbitSignal, PrKind, Stage } from "./types";

const norm = (s: string) => s.toLowerCase().replace(/[\s_\-\\[\]]+/g, "");

export function matchesAny(
	identity: { displayName?: string; uniqueName?: string },
	needles: string[],
) {
	const hay = norm(
		`${identity.displayName ?? ""}|${identity.uniqueName ?? ""}`,
	);
	return needles.some((n) => hay.includes(norm(n)));
}

/** First Jira key in the PR title, falling back to the source branch. */
export function extractTicketKey(
	title: string,
	branch: string,
	projects: string[] = [],
) {
	const prefix = projects.length
		? `(?:${projects.map((p) => p.replace(/[^A-Z0-9]/gi, "")).join("|")})`
		: "[A-Z][A-Z0-9]+";
	const re = new RegExp(`(?<![A-Za-z0-9])(${prefix}-\\d+)(?!\\d)`, "i");
	const m = title.match(re) ?? branch.match(re);
	return m ? m[1].toUpperCase() : null;
}

/**
 * Reads a SHIP / SHOW / ASK prefix. Uppercase is enough ("SHIP fix x"); any case needs
 * a colon or brackets ("Ship: fix x", "[ask] fix x") so "Show totals" isn't misread.
 */
export function extractKind(title: string): {
	kind: PrKind | null;
	rest: string;
} {
	const m =
		title.match(/^\s*\[?(SHIP|SHOW|ASK)\]?(?=[\s:\-–|]|$)[\s:\-–|]*/) ??
		title.match(/^\s*(?:\[(ship|show|ask)\]|(ship|show|ask)\s*:)[\s:\-–|]*/i);
	if (!m) return { kind: null, rest: title };
	const kind = (m[1] ?? m[2]).toLowerCase() as PrKind;
	return { kind, rest: title.slice(m[0].length) || title };
}

const RATE_LIMIT_MARKER = "rate limited by coderabbit.ai";

/** Parses "Next included review available in 44 minutes." / "Please wait **1 hour and 3 minutes**". */
export function parseRateLimitWait(content: string): number | null {
	const m = content.match(/(?:available in|please wait)\s*\**\s*([^.\n]*)/i);
	if (!m) return null;
	let ms = 0;
	for (const [, n, unit] of m[1].matchAll(
		/(\d+)\s*(hour|hr|minute|min|second|sec)s?/gi,
	)) {
		const u = unit.toLowerCase();
		ms +=
			Number(n) *
			(u.startsWith("h") ? 3_600_000 : u.startsWith("m") ? 60_000 : 1_000);
	}
	return ms || null;
}

export interface ThreadLike {
	status?: string;
	isDeleted?: boolean;
	/** ADO system threads say what they are, e.g. { CodeReviewThreadType: { $value: "RefUpdate" } }. */
	properties?: Record<string, { $value?: string } | undefined>;
	comments: {
		author?: { displayName?: string; uniqueName?: string };
		content?: string;
		commentType?: string;
		isDeleted?: boolean;
		publishedDate?: string;
		lastUpdatedDate?: string;
		lastContentUpdatedDate?: string;
	}[];
}

const OPEN_STATUSES = new Set(["active", "pending"]);
/** "@coderabbitai review" / "@coderabbitai full review" — both start a review. */
const MANUAL_TRIGGER = /^\s*@coderabbitai\s+(?:full\s+)?review\b/i;
/** CodeRabbit's answer to a command, e.g. "Actions performed" or "Action not completed". */
const COMMAND_REPLY =
	/CodeRabbit review command invocation|auto-generated reply by CodeRabbit/i;

/** CodeRabbit's acknowledgement of a command: an active thread, but nothing for anyone to reply to. */
/**
 * A thread holding nothing but "@coderabbitai review" requests and CodeRabbit's
 * acknowledgements. Nobody needs to read it, yet while active it fails "Comment requirements".
 */
export function isCodeRabbitChatter(
	t: Pick<ThreadLike, "comments">,
	crMatch: string[],
) {
	const said = t.comments.filter(
		(c) => !c.isDeleted && c.commentType !== "system",
	);
	return (
		said.length > 0 &&
		said.every((c) =>
			c.author && matchesAny(c.author, crMatch)
				? COMMAND_REPLY.test(c.content ?? "")
				: MANUAL_TRIGGER.test(c.content ?? ""),
		)
	);
}

export const isCommandReply = (content: string | undefined) =>
	COMMAND_REPLY.test(content ?? "");

const stamp = (c: ThreadLike["comments"][number]) =>
	Date.parse(
		c.lastContentUpdatedDate ?? c.lastUpdatedDate ?? c.publishedDate ?? "",
	) || 0;
const posted = (c: ThreadLike["comments"][number]) =>
	Date.parse(c.publishedDate ?? "") || stamp(c);

/** "<summary>Action not completed</summary>\n\nReview rate limited." → state + first line of the body. */
function readCommandReply(content: string): {
	state: "accepted" | "declined";
	reason: string | null;
} {
	const summary = content.match(/<summary>([^<]*)<\/summary>/i)?.[1] ?? "";
	const body = content.split(/<\/summary>/i)[1] ?? "";
	const reason =
		body
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l && !l.startsWith(">") && !l.startsWith("<"))
			?.replace(/\.$/, "") ?? null;
	return {
		state: /not completed|failed|unable/i.test(summary)
			? "declined"
			: "accepted",
		reason,
	};
}

export function codeRabbitSignal(
	threads: ThreadLike[],
	crVote: number | null,
	crMatch: string[],
): CodeRabbitSignal {
	let openThreads = 0;
	let latest: { at: number; content: string } | null = null;
	let lastAsk = 0;
	let lastPush = 0;
	let lastVote = 0;
	let lastReview = 0;
	const replies: { at: number; content: string }[] = [];

	for (const t of threads) {
		if (t.isDeleted) continue;
		const first = t.comments[0];
		const firstIsCr = first?.author && matchesAny(first.author, crMatch);
		// Command acknowledgements arrive as active threads but aren't review feedback.
		if (
			firstIsCr &&
			first.commentType !== "system" &&
			!COMMAND_REPLY.test(first.content ?? "") &&
			OPEN_STATUSES.has(t.status ?? "")
		)
			openThreads++;

		const kind = t.properties?.CodeReviewThreadType?.$value;
		for (const [i, c] of t.comments.entries()) {
			if (c.isDeleted || !c.author) continue;
			const content = c.content ?? "";
			if (c.commentType === "system") {
				if (
					kind === "RefUpdate" ||
					/^The reference .+ was updated/i.test(content)
				)
					lastPush = Math.max(lastPush, posted(c));
				else if (
					(kind === "VoteUpdate" || /\bvoted -?\d+/i.test(content)) &&
					matchesAny(c.author, crMatch)
				)
					lastVote = Math.max(lastVote, posted(c));
				continue;
			}
			if (!matchesAny(c.author, crMatch)) {
				if (MANUAL_TRIGGER.test(content))
					lastAsk = Math.max(lastAsk, posted(c));
				continue;
			}
			if (COMMAND_REPLY.test(content)) {
				replies.push({ at: posted(c), content });
				continue;
			}
			// Replies inside a thread ("✅ Confirmed as addressed") are conversation, not review state.
			if (i > 0) continue;
			const at = stamp(c);
			if (!latest || at >= latest.at) latest = { at, content };
			if (/Actionable comments posted|Review info/i.test(content))
				lastReview = Math.max(lastReview, posted(c));
			else if (
				/summarize by coderabbit/i.test(content) &&
				!content.includes(RATE_LIMIT_MARKER)
			)
				lastReview = Math.max(lastReview, at);
		}
	}

	let rateLimited = !!latest?.content.includes(RATE_LIMIT_MARKER);
	const wait =
		rateLimited && latest ? parseRateLimitWait(latest.content) : null;

	// A request stays open until CodeRabbit posts or rewrites a review after it.
	let request: CodeRabbitSignal["request"] = null;
	if (lastAsk && !(latest && latest.at > lastAsk)) {
		const reply = replies
			.filter((r) => r.at >= lastAsk)
			.sort((a, b) => a.at - b.at)[0];
		const read = reply ? readCommandReply(reply.content) : null;
		request = {
			at: new Date(lastAsk).toISOString(),
			state: read?.state ?? "pending",
			reason: read?.reason ?? null,
		};
		if (read?.state === "declined" && /rate limit/i.test(read.reason ?? ""))
			rateLimited = true;
	}

	return {
		vote: crVote,
		rateLimited,
		rateLimitEta:
			wait && latest ? new Date(latest.at + wait).toISOString() : null,
		openThreads,
		request,
		// A "waiting for author" vote goes stale once you push and CodeRabbit hasn't looked since.
		awaitingReReview:
			(crVote ?? 0) < 0 && lastPush > Math.max(lastVote, lastReview),
	};
}

/** ADO votes: 10 approved, 5 approved w/ suggestions, 0 none, -5 waiting for author, -10 rejected. */
export function computeStage(
	cr: CodeRabbitSignal,
	qaVote: number | null,
): Stage {
	const crApproved = (cr.vote ?? 0) >= 5;
	if (crApproved && (qaVote ?? 0) >= 5) return "cr_qa_approved";
	if (crApproved) return "cr_approved";
	if (cr.openThreads > 0) return "cr_feedback";
	if (cr.rateLimited) return "cr_rate_limited";
	if ((cr.vote ?? 0) < 0 && !cr.awaitingReReview) return "cr_feedback";
	return "raised";
}
