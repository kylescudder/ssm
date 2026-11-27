import { describe, expect, it } from "vitest";
import {
	type CrEvents,
	computeAllowance,
	extractCrEvents,
	mergeEvents,
	parsePerHour,
	parseRemaining,
	pushTriggers,
} from "./coderabbit-allowance";
import type { ThreadLike } from "./signals";

// Real wording and timings from 27 Nov 2026 (UTC), allowance 1 review/hour.
const CR = {
	displayName: "Code Rabbit",
	uniqueName: "coderabbit@example.com",
};
const ME = {
	displayName: "Jane Dev",
	uniqueName: "jane.dev@example.com",
};
const t = (hhmmss: string) => `2026-11-27T${hhmmss}.000Z`;
const at = (hhmmss: string) => Date.parse(t(hhmmss));

const reviewComment = (
	when: string,
	remaining = 0,
	perHour = 1,
): ThreadLike => ({
	status: "fixed",
	comments: [
		{
			author: CR,
			publishedDate: t(when),
			lastUpdatedDate: t(when),
			content: `**Actionable comments posted: 1**\n<summary>ℹ️ Review info</summary>\n- **Run ID**: \`run-${when}\`\n**Included review availability:** This review used your included allowance. ${remaining} included reviews remain after this review. Your included PR review attempts over the past 7 days set your current allowance at ${perHour} review per hour.`,
		},
	],
});

const notice = (when: string, wait: string, published = when): ThreadLike => ({
	status: "fixed",
	comments: [
		{
			author: CR,
			publishedDate: t(published),
			lastUpdatedDate: t(when),
			lastContentUpdatedDate: t(when),
			content: `<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n> ## Review limit reached\n> **Next included review available in ${wait}.**\n> **Limit details:** You’ve used the included review currently available. Your 71 included PR review attempts over the past 7 days set your current allowance at 1 review per hour.\n- **Run ID**: \`rl-${when}\``,
		},
	],
});

const manual = (when: string, text = "@coderabbitai review"): ThreadLike => ({
	status: "closed",
	comments: [{ author: ME, publishedDate: t(when), content: text }],
});

const pr = (
	id: number,
	threads: ThreadLike[],
	pushes: string[] = [],
): CrEvents => {
	const e = extractCrEvents(id, threads, ["coderabbit"]);
	return {
		...e,
		triggers: [
			...e.triggers,
			...pushTriggers(
				id,
				pushes.map((p) => ({ createdDate: t(p) })),
			),
		],
	};
};

const today = (upTo: string) => {
	const cut = at(upTo);
	const all = mergeEvents([
		pr(13501, [reviewComment("11:12:41")], ["11:05:59"]),
		pr(13502, [notice("11:22:04", "44 minutes")], ["11:21:30"]),
		pr(13381, [
			manual("12:00:22", "@coderabbitai full review"),
			notice("12:00:53", "5 minutes", "09:00:00"),
		]),
		pr(13405, at("12:13:24") <= cut ? [reviewComment("12:13:24")] : [], [
			"12:07:02",
		]),
	]);
	return {
		reviews: all.reviews.filter((r) => r.at <= cut),
		notices: all.notices.filter((n) => n.at <= cut),
		triggers: all.triggers.filter((x) => x.at <= cut),
	};
};

describe("parsing CodeRabbit's wording", () => {
	it("reads the hourly allowance", () => {
		expect(
			parsePerHour("set your current allowance at 1 review per hour."),
		).toBe(1);
		expect(
			parsePerHour("set your current allowance at 8 reviews per hour."),
		).toBe(8);
		expect(
			parsePerHour(
				"Your plan provides up to 10 included reviews per hour; 7 remain",
			),
		).toBe(10);
	});
	it("reads what's left after a review", () => {
		expect(parseRemaining("0 included reviews remain after this review.")).toBe(
			0,
		);
		expect(parseRemaining("1 included review remains after this review.")).toBe(
			1,
		);
		expect(
			parseRemaining(
				"up to 10 included reviews per hour; 7 remain after this review.",
			),
		).toBe(7);
	});
	it("treats both review commands as triggers", () => {
		const e = extractCrEvents(
			1,
			[
				manual("10:00:00"),
				manual("10:01:00", "@coderabbitai full review"),
				manual("10:02:00", "@coderabbitai summary"),
			],
			["coderabbit"],
		);
		expect(e.triggers.map((x) => x.at)).toEqual([
			at("10:00:00"),
			at("10:01:00"),
		]);
	});
});

describe("computeAllowance — 27 Nov replay", () => {
	it("charges a review from the push that started it, not when its comment landed", () => {
		const a = computeAllowance(today("11:15:00"), at("11:15:00"));
		expect(a).toMatchObject({ perHour: 1, busy: 1, available: 0 });
		expect(a.slots[0]).toMatchObject({
			prId: 13501,
			at: t("11:05:59"),
			freesAt: t("12:05:59"),
		});
	});

	it("lets a rate-limit notice pin the exact release time", () => {
		const a = computeAllowance(today("11:30:00"), at("11:30:00"));
		expect(a.nextFreeAt).toBe(t("12:06:04"));
		expect(a.waiting).toEqual([13502]);
	});

	it("does not charge rate-limited attempts", () => {
		const a = computeAllowance(today("12:01:00"), at("12:01:00"));
		expect(a.busy).toBe(1); // still just !13501's review
		expect(a.waiting.sort()).toEqual([13381, 13502]);
	});

	it("shows a free slot once the window rolls over", () => {
		const a = computeAllowance(today("12:06:30"), at("12:06:30"));
		expect(a).toMatchObject({ available: 1, busy: 0, nextFreeAt: null });
	});

	it("counts a push with no answer yet as a review in flight", () => {
		const a = computeAllowance(today("12:08:00"), at("12:08:00"));
		expect(a).toMatchObject({ available: 0, nextFreeAt: t("13:07:02") });
		expect(a.slots[0]).toMatchObject({ prId: 13405, source: "in_flight" });
	});

	it("turns the in-flight slot into a review once CodeRabbit posts", () => {
		const a = computeAllowance(today("12:14:00"), at("12:14:00"));
		expect(a.nextFreeAt).toBe(t("13:07:02"));
		expect(a.slots[0]).toMatchObject({
			prId: 13405,
			source: "review",
			at: t("12:07:02"),
		});
	});

	it("drops a push CodeRabbit never answered after 15 minutes", () => {
		const events = mergeEvents([pr(1, [], ["10:00:00"])]);
		expect(computeAllowance(events, at("10:10:00")).available).toBe(0);
		expect(computeAllowance(events, at("10:16:00")).available).toBe(1);
	});
});

describe("computeAllowance — what CodeRabbit says beats what we see", () => {
	it("infers reviews on PRs we didn't load from 'N remain'", () => {
		const events = mergeEvents([
			pr(1, [reviewComment("10:05:00", 0, 2)], ["10:00:00"]),
		]);
		const a = computeAllowance(events, at("10:10:00"));
		expect(a).toMatchObject({ perHour: 2, busy: 2, available: 0 });
		expect(a.slots.map((s) => s.source).sort()).toEqual(["inferred", "review"]);
	});

	it("infers a hidden review when a notice says all slots are busy", () => {
		const events = mergeEvents([
			pr(1, [notice("10:00:00", "40 minutes")], ["09:59:40"]),
		]);
		const a = computeAllowance(events, at("10:05:00"));
		expect(a).toMatchObject({ available: 0, nextFreeAt: t("10:40:00") });
		expect(a.slots[0].source).toBe("inferred");
	});

	it("discards in-flight guesses a later notice contradicts", () => {
		// Two pushes with no answer, then CodeRabbit says the only slot frees at 10:30.
		const events = mergeEvents([
			pr(1, [], ["10:00:00"]),
			pr(2, [], ["10:01:00"]),
			pr(3, [notice("10:02:00", "28 minutes")], ["10:01:50"]),
		]);
		const a = computeAllowance(events, at("10:03:00"));
		expect(a).toMatchObject({ busy: 1, nextFreeAt: t("10:30:00") });
	});
});
