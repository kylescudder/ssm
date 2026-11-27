import { describe, expect, it } from "vitest";
import {
	codeRabbitSignal,
	computeStage,
	extractKind,
	extractTicketKey,
	isCodeRabbitChatter,
	parseRateLimitWait,
	type ThreadLike,
} from "./signals";

const CR = {
	displayName: "Code Rabbit",
	uniqueName: "coderabbit@example.com",
};
const ME = {
	displayName: "Jane Dev",
	uniqueName: "jane@example.com",
};
const RATE_LIMITED = `<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> **Next included review available in 44 minutes.**`;
const sig = (
	o: Partial<ReturnType<typeof codeRabbitSignal>>,
): ReturnType<typeof codeRabbitSignal> => ({
	vote: 0,
	rateLimited: false,
	rateLimitEta: null,
	openThreads: 0,
	request: null,
	awaitingReReview: false,
	...o,
});

describe("extractTicketKey", () => {
	it("reads the key from a SHIP title", () =>
		expect(extractTicketKey("SHIP: ABC-16701 Fix E2E Tests", "")).toBe(
			"ABC-16701",
		));
	it("reads keys embedded in merge titles", () =>
		expect(
			extractTicketKey(
				"Merge feature/ABC-11919_SaveButtonWording into develop",
				"",
			),
		).toBe("ABC-11919"));
	it("falls back to the branch", () =>
		expect(extractTicketKey("Tidy things", "feature/abc-42-tidy")).toBe(
			"ABC-42",
		));
	it("honours the project allow-list", () =>
		expect(extractTicketKey("UTF-8 fix for ABC-7", "", ["ABC"])).toBe("ABC-7"));
	it("returns null without a key", () =>
		expect(extractTicketKey("Bump deps", "chore/deps")).toBeNull());
});

describe("parseRateLimitWait", () => {
	it("parses minutes", () =>
		expect(parseRateLimitWait(RATE_LIMITED)).toBe(44 * 60_000));
	it("parses mixed units", () =>
		expect(
			parseRateLimitWait(
				"Please wait **1 hour and 3 minutes and 20 seconds** before",
			),
		).toBe(3_800_000));
	it("returns null when absent", () =>
		expect(parseRateLimitWait("all good")).toBeNull());
});

describe("codeRabbitSignal", () => {
	it("flags the rate limit and its ETA from the latest CodeRabbit comment", () => {
		const threads: ThreadLike[] = [
			{
				status: "fixed",
				comments: [
					{
						author: CR,
						content: RATE_LIMITED,
						lastUpdatedDate: "2026-11-27T11:22:00.000Z",
					},
				],
			},
		];
		const s = codeRabbitSignal(threads, 0, ["coderabbit"]);
		expect(s.rateLimited).toBe(true);
		expect(s.rateLimitEta).toBe("2026-11-27T12:06:00.000Z");
	});

	it("clears the rate limit once a later review lands", () => {
		const threads: ThreadLike[] = [
			{
				status: "fixed",
				comments: [
					{
						author: CR,
						content: RATE_LIMITED,
						lastUpdatedDate: "2026-11-27T10:00:00Z",
					},
				],
			},
			{
				status: "fixed",
				comments: [
					{
						author: CR,
						content: "**Actionable comments posted: 0**",
						lastUpdatedDate: "2026-11-27T11:00:00Z",
					},
				],
			},
		];
		expect(codeRabbitSignal(threads, 0, ["coderabbit"]).rateLimited).toBe(
			false,
		);
	});

	it("counts only open threads CodeRabbit started", () => {
		const threads: ThreadLike[] = [
			{
				status: "active",
				comments: [{ author: CR, content: "Assert identities" }],
			},
			{ status: "fixed", comments: [{ author: CR, content: "done" }] },
			{
				status: "active",
				comments: [{ author: ME, content: "@coderabbitai review" }],
			},
			{
				status: "active",
				comments: [
					{
						author: CR,
						content: "Code Rabbit voted -5",
						commentType: "system",
					},
				],
			},
		];
		expect(codeRabbitSignal(threads, -5, ["coderabbit"]).openThreads).toBe(1);
	});
});

describe("computeStage", () => {
	it("raised by default", () =>
		expect(computeStage(sig({}), null)).toBe("raised"));
	it("rate limited", () =>
		expect(computeStage(sig({ rateLimited: true }), null)).toBe(
			"cr_rate_limited",
		));
	it("feedback beats rate limit while comments are open", () =>
		expect(
			computeStage(sig({ rateLimited: true, openThreads: 2, vote: -5 }), null),
		).toBe("cr_feedback"));
	it("rate limited re-review after fixes", () =>
		expect(computeStage(sig({ rateLimited: true, vote: -5 }), null)).toBe(
			"cr_rate_limited",
		));
	it("waiting-for-author vote is feedback", () =>
		expect(computeStage(sig({ vote: -5 }), null)).toBe("cr_feedback"));
	it("CodeRabbit approved", () =>
		expect(computeStage(sig({ vote: 10 }), 0)).toBe("cr_approved"));
	it("CodeRabbit + QA approved", () =>
		expect(computeStage(sig({ vote: 10 }), 10)).toBe("cr_qa_approved"));
	it("QA alone does not skip CodeRabbit", () =>
		expect(computeStage(sig({ vote: 0 }), 10)).toBe("raised"));
});

describe("extractKind", () => {
	it.each([
		["SHIP: ABC-16701 Fix E2E Tests", "ship", "ABC-16701 Fix E2E Tests"],
		["SHOW ABC-1 thing", "show", "ABC-1 thing"],
		["ASK - ABC-2 thing", "ask", "ABC-2 thing"],
		["[ASK] ABC-3 thing", "ask", "ABC-3 thing"],
		["Ship: ABC-4 thing", "ship", "ABC-4 thing"],
		["[show] ABC-5 thing", "show", "ABC-5 thing"],
	])("%s", (title, kind, rest) =>
		expect(extractKind(title)).toEqual({ kind, rest }));

	it.each([
		"Show totals on the grid",
		"Shipping address fix",
		"Merge feature/ABC-11919_SaveButtonWording into develop",
		"ASKED questions",
	])("ignores %s", (title) => expect(extractKind(title).kind).toBeNull());
});

describe("codeRabbitSignal — manual review requests", () => {
	const ask = (at: string): ThreadLike => ({
		status: "closed",
		comments: [
			{ author: ME, content: "@coderabbitai review", publishedDate: at },
		],
	});
	const reply = (at: string, summary: string, body = ""): ThreadLike => ({
		status: "active",
		comments: [
			{
				author: CR,
				publishedDate: at,
				lastUpdatedDate: at,
				content: `<!-- This is an auto-generated reply by CodeRabbit -->\n<!-- CodeRabbit review command invocation: v2:abc -->\n<details>\n<summary>${summary}</summary>\n\n${body}\n\n> Note: CodeRabbit is an incremental review system.\n</details>`,
			},
		],
	});
	const summaryNotice: ThreadLike = {
		status: "fixed",
		comments: [
			{
				author: CR,
				content: RATE_LIMITED,
				lastUpdatedDate: "2026-11-27T10:00:00Z",
			},
		],
	};

	it("is pending until CodeRabbit answers", () => {
		const s = codeRabbitSignal(
			[summaryNotice, ask("2026-11-27T12:22:16Z")],
			0,
			["coderabbit"],
		);
		expect(s.request).toEqual({
			at: "2026-11-27T12:22:16.000Z",
			state: "pending",
			reason: null,
		});
	});

	it("reads 'Action not completed' as declined, with the reason, and keeps the rate limit", () => {
		const s = codeRabbitSignal(
			[
				summaryNotice,
				ask("2026-11-27T12:22:16Z"),
				reply(
					"2026-11-27T12:22:26Z",
					"Action not completed",
					"Review rate limited.",
				),
			],
			0,
			["coderabbit"],
		);
		expect(s.request).toMatchObject({
			state: "declined",
			reason: "Review rate limited",
		});
		expect(s.rateLimited).toBe(true);
		// The reply thread is an acknowledgement, not review feedback.
		expect(s.openThreads).toBe(0);
	});

	it("reads 'Action performed' as accepted", () => {
		const s = codeRabbitSignal(
			[
				ask("2026-11-27T12:22:16Z"),
				reply(
					"2026-11-27T12:22:26Z",
					"✅ Actions performed",
					"Review triggered.",
				),
			],
			0,
			["coderabbit"],
		);
		expect(s.request?.state).toBe("accepted");
	});

	it("clears once a review lands after the request", () => {
		const review: ThreadLike = {
			status: "fixed",
			comments: [
				{
					author: CR,
					content: "**Actionable comments posted: 0**",
					lastUpdatedDate: "2026-11-27T12:40:00Z",
				},
			],
		};
		const s = codeRabbitSignal(
			[
				ask("2026-11-27T12:22:16Z"),
				reply("2026-11-27T12:22:26Z", "Actions performed", "Review triggered."),
				review,
			],
			0,
			["coderabbit"],
		);
		expect(s.request).toBeNull();
	});

	it("ignores comments that only mention CodeRabbit", () => {
		const chat: ThreadLike = {
			status: "active",
			comments: [{ author: ME, content: "thanks @coderabbitai, fixed" }],
		};
		expect(codeRabbitSignal([chat], 0, ["coderabbit"]).request).toBeNull();
	});
});

describe("isCodeRabbitChatter", () => {
	const crReply = {
		author: CR,
		content:
			"<!-- This is an auto-generated reply by CodeRabbit -->\n<summary>Action not completed</summary>",
	};
	const askIt = { author: ME, content: "@coderabbitai review" };
	it("matches a review request on its own", () =>
		expect(isCodeRabbitChatter({ comments: [askIt] }, ["coderabbit"])).toBe(
			true,
		));
	it("matches CodeRabbit's acknowledgement", () =>
		expect(isCodeRabbitChatter({ comments: [crReply] }, ["coderabbit"])).toBe(
			true,
		));
	it("matches a request answered in the same thread", () =>
		expect(
			isCodeRabbitChatter({ comments: [askIt, crReply] }, ["coderabbit"]),
		).toBe(true));
	it("leaves threads where a person said anything else", () =>
		expect(
			isCodeRabbitChatter(
				{
					comments: [
						crReply,
						{ author: ME, content: "why was this declined?" },
					],
				},
				["coderabbit"],
			),
		).toBe(false));
	it("leaves real CodeRabbit review comments", () =>
		expect(
			isCodeRabbitChatter(
				{
					comments: [
						{
							author: CR,
							content: "**Assert the bulk-edit option identities**",
						},
					],
				},
				["coderabbit"],
			),
		).toBe(false));
	it("ignores deleted and system comments", () =>
		expect(
			isCodeRabbitChatter(
				{
					comments: [
						askIt,
						{ author: ME, content: "oops", isDeleted: true },
						{
							author: CR,
							content: "Code Rabbit voted -5",
							commentType: "system",
						},
					],
				},
				["coderabbit"],
			),
		).toBe(true));
});

describe("codeRabbitSignal — re-review after a push (PR 13501)", () => {
	const SYS = { displayName: "Microsoft.VisualStudio.Services.TFS" };
	const vote: ThreadLike = {
		properties: { CodeReviewThreadType: { $value: "VoteUpdate" } },
		comments: [
			{
				author: CR,
				content: "Code Rabbit voted -5",
				commentType: "system",
				publishedDate: "2026-11-27T11:12:40Z",
			},
		],
	};
	const review: ThreadLike = {
		status: "fixed",
		comments: [
			{
				author: CR,
				content: "**Actionable comments posted: 1**",
				publishedDate: "2026-11-27T11:12:41Z",
			},
		],
	};
	const inline: ThreadLike = {
		status: "fixed",
		comments: [
			{
				author: CR,
				content: "**Assert the bulk-edit option identities**",
				publishedDate: "2026-11-27T11:12:41Z",
			},
			{
				author: ME,
				content: "Fixed in 13dacfdcc1",
				publishedDate: "2026-11-27T11:39:00Z",
			},
			{
				author: CR,
				content: "✅ Confirmed as addressed",
				publishedDate: "2026-11-27T11:40:13Z",
				lastUpdatedDate: "2026-11-27T11:40:13Z",
			},
		],
	};
	const push: ThreadLike = {
		properties: { CodeReviewThreadType: { $value: "RefUpdate" } },
		comments: [
			{
				author: SYS,
				content: "The reference refs/heads/x was updated.",
				commentType: "system",
				publishedDate: "2026-11-27T11:38:48Z",
			},
		],
	};
	const limited: ThreadLike = {
		status: "fixed",
		comments: [
			{
				author: CR,
				content: RATE_LIMITED,
				publishedDate: "2026-11-27T11:06:33Z",
				lastUpdatedDate: "2026-11-27T11:39:22Z",
			},
		],
	};

	it("treats a −5 vote older than your latest push as awaiting re-review", () => {
		const s = codeRabbitSignal([vote, review, inline, push], -5, [
			"coderabbit",
		]);
		expect(s.awaitingReReview).toBe(true);
		expect(computeStage(s, 0)).toBe("raised");
	});

	it("ignores CodeRabbit's thread replies when reading the rate limit", () => {
		const s = codeRabbitSignal([vote, review, inline, push, limited], -5, [
			"coderabbit",
		]);
		expect(s.rateLimited).toBe(true);
		expect(computeStage(s, 0)).toBe("cr_rate_limited");
	});

	it("keeps 'changes asked' when there's been no push since the vote", () => {
		const s = codeRabbitSignal([vote, review, inline], -5, ["coderabbit"]);
		expect(s.awaitingReReview).toBe(false);
		expect(computeStage(s, 0)).toBe("cr_feedback");
	});

	it("is current again once CodeRabbit reviews the new push", () => {
		const second: ThreadLike = {
			status: "fixed",
			comments: [
				{
					author: CR,
					content: "**Actionable comments posted: 2**",
					publishedDate: "2026-11-27T12:05:00Z",
				},
			],
		};
		expect(
			codeRabbitSignal([vote, review, inline, push, second], -5, ["coderabbit"])
				.awaitingReReview,
		).toBe(false);
	});
});
