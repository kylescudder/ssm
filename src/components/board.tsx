import { useQuery } from "@tanstack/react-query";
import {
	Check as CheckIcon,
	ChevronDown,
	ExternalLink,
	Rabbit,
	UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
	Board,
	Check,
	JiraTicket,
	PrView,
	Stage,
	TicketGroup,
} from "#/lib/types";
import { KINDS, STAGE_META, STAGES, stageIndex } from "#/lib/types";
import {
	assignJiraFn,
	closeThreadsFn,
	getTransitionsFn,
	mergePrFn,
	moveToPrStatusFn,
	requeueChecksFn,
	retriggerCodeRabbitFn,
	searchAssigneesFn,
	setDraftFn,
	transitionJiraFn,
} from "#/server/fns";
import { ActionButton, cx, relative, Spinner, useNow } from "./ui";

export type GroupBy = "stage" | "kind";

// ── Meaning → colour ─────────────────────────────────────────
// Flag red is reserved for "your move"; everything else says who it's waiting on.
const STAGE_COLOR: Record<Stage, string> = {
	raised: "text-dim",
	cr_rate_limited: "text-amber",
	cr_feedback: "text-flag",
	cr_approved: "text-telemetry",
	cr_qa_approved: "text-go",
};
const KIND_COLOR = {
	ship: "text-go",
	show: "text-telemetry",
	ask: "text-amber",
} as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ── Start lights ─────────────────────────────────────────────
/** Five lamps, one per stage. Lit up to the current stage; the current lamp glows. */
function Lights({
	stage,
	urgent,
	ready = false,
}: {
	stage: Stage;
	urgent: boolean;
	ready?: boolean;
}) {
	const at = stageIndex(stage);
	const done = stage === "cr_qa_approved";
	if (ready)
		return (
			<span
				className="flex items-center gap-[3px]"
				role="img"
				aria-label="Ready to merge"
				title="Ready to merge"
			>
				{STAGES.map((s) => (
					<span
						key={s.id}
						className="lamp-live lamp-urgent size-[9px] rounded-full bg-go text-go"
					/>
				))}
			</span>
		);
	return (
		<span
			className="flex items-center gap-[3px]"
			title={STAGE_META[stage].label}
			role="img"
			aria-label={STAGE_META[stage].label}
		>
			{STAGES.map((s, i) => (
				<span
					key={s.id}
					className={cx(
						"size-[9px] rounded-full",
						// All five lit green = lights out, go.
						done && "bg-go",
						!done && i < at && "bg-spent",
						!done && i > at && "border border-spent",
						i === at &&
							cx(
								"lamp-live",
								!done && "bg-current",
								urgent ? "text-flag lamp-urgent" : STAGE_COLOR[stage],
							),
					)}
				/>
			))}
		</span>
	);
}

// ── What should I do next? ───────────────────────────────────
/** act = only you can unblock it (red); nudge = a click keeps it moving (quiet); go = ready to merge (green). */
type Tier = "act" | "nudge" | "go";
type Next =
	| {
			type: "run";
			tier: Tier;
			label: string;
			run: () => Promise<unknown>;
			done: string;
			/** What it does, so the details panel doesn't offer the same thing twice. */
			does: "ask-rabbit" | "rerun" | "publish" | "resolve" | "merge";
			confirm?: string;
			count?: number;
	  }
	| { type: "open"; tier: Tier; label: string; href: string }
	| { type: "wait"; label: string };

const isRequeueable = (c: Check) =>
	c.isBuild &&
	(c.state === "failed" ||
		c.state === "expired" ||
		c.state === "canceled" ||
		c.state === "queued");

function nextFor(pr: PrView, now: number): Next {
	const checks = pr.checks.filter(
		(c) => c.state !== "not_applicable" && c.isBlocking,
	);
	const failed = checks.filter((c) => c.isBuild && c.state === "failed");
	// Policies like "Comment requirements" fail too, but can't be re-run, only fixed.
	const failedPolicy = checks.find((c) => !c.isBuild && c.state === "failed");
	const stale = checks.filter(
		(c) =>
			c.isBuild &&
			(c.state === "expired" || c.state === "canceled" || c.state === "queued"),
	);
	const cr = pr.codeRabbit;
	const crApproved = (cr.vote ?? 0) >= 5;
	const windowOpen =
		cr.rateLimited &&
		!crApproved &&
		(!cr.rateLimitEta || Date.parse(cr.rateLimitEta) <= now);
	const peopleThreads = pr.openThreads - cr.openThreads;
	const requeue = (cs: Check[]) => () =>
		requeueChecksFn({ data: { evaluationIds: cs.map((c) => c.evaluationId) } });
	const askRabbit = () =>
		retriggerCodeRabbitFn({ data: { repoId: pr.repoId, prId: pr.id } });

	if (pr.hasConflicts)
		return { type: "open", tier: "act", label: "Fix conflicts", href: pr.url };
	if (failed.length)
		return {
			type: "run",
			tier: "act",
			label: `Re-run ${plural(failed.length, "failed check")}`,
			does: "rerun",
			count: failed.length,
			run: requeue(failed),
			done: "Re-run queued",
		};
	if (cr.openThreads)
		return {
			type: "open",
			tier: "act",
			label: `Answer ${plural(cr.openThreads, "CodeRabbit comment")}`,
			href: pr.url,
		};
	if (peopleThreads > 0)
		return {
			type: "open",
			tier: "act",
			label: `Reply to ${plural(peopleThreads, "comment")}`,
			href: pr.url,
		};
	if (failedPolicy && pr.ackThreadIds.length)
		return {
			type: "run",
			tier: "act",
			label: "Resolve CodeRabbit's reply",
			does: "resolve",
			run: () =>
				closeThreadsFn({
					data: { repoId: pr.repoId, prId: pr.id, threadIds: pr.ackThreadIds },
				}),
			done: "Resolved",
		};
	// SSM just resolved CodeRabbit chatter; ADO may still be re-evaluating the comment policy.
	if (failedPolicy && pr.autoResolved && /comment/i.test(failedPolicy.name))
		return { type: "wait", label: "Comment check re-running" };
	if (failedPolicy)
		return {
			type: "open",
			tier: "act",
			label: `Fix ${failedPolicy.name.toLowerCase()}`,
			href: pr.url,
		};
	// Don't offer to ask again while a request is in flight or was just answered.
	if (windowOpen && !cr.request)
		return {
			type: "run",
			tier: "nudge",
			label: "Ask CodeRabbit to review",
			does: "ask-rabbit",
			run: askRabbit,
			done: "Asked",
		};
	if (stale.length)
		return {
			type: "run",
			tier: "nudge",
			label: `Re-run ${plural(stale.length, "check")}`,
			does: "rerun",
			count: stale.length,
			run: requeue(stale),
			done: "Re-run queued",
		};
	if (pr.isDraft)
		return {
			type: "run",
			tier: "nudge",
			label: "Publish draft",
			does: "publish",
			run: () =>
				setDraftFn({
					data: { repoId: pr.repoId, prId: pr.id, isDraft: false },
				}),
			done: "Published",
		};
	if (pr.stage === "cr_qa_approved") {
		// ADO won't complete the PR until every required check has passed.
		const unfinished = checks.filter((c) => c.state !== "passed");
		if (unfinished.length)
			return {
				type: "wait",
				label: unfinished.some((c) => c.state === "running")
					? "Checks running"
					: "Waiting on required checks",
			};
		return {
			type: "run",
			tier: "go",
			label: "Merge",
			does: "merge",
			confirm: "Click again to merge",
			run: () => mergePrFn({ data: { repoId: pr.repoId, prId: pr.id } }),
			done: "Merging",
		};
	}
	// Things you can do outrank things you're waiting on.
	if (cr.request?.state === "pending")
		return { type: "wait", label: "Waiting for CodeRabbit to answer" };
	if (cr.request?.state === "accepted")
		return { type: "wait", label: "CodeRabbit is reviewing" };
	if (cr.request?.state === "declined")
		return {
			type: "wait",
			label: cr.request.reason
				? `CodeRabbit: ${cr.request.reason.toLowerCase()}`
				: "CodeRabbit declined",
		};
	if ((cr.vote ?? 0) < 0 && !cr.rateLimited)
		return {
			type: "run",
			tier: "nudge",
			label: "Ask CodeRabbit to re-review",
			does: "ask-rabbit",
			run: askRabbit,
			done: "Asked",
		};
	if (cr.rateLimited && cr.rateLimitEta)
		return {
			type: "wait",
			label: `CodeRabbit back in ${relative(Date.parse(cr.rateLimitEta) - now)}`,
		};
	if (checks.some((c) => c.state === "running"))
		return { type: "wait", label: "Checks running" };
	if (pr.stage === "cr_approved")
		return { type: "wait", label: "Waiting on QA" };
	return { type: "wait", label: "Waiting on CodeRabbit" };
}

const isReady = (next: Next) => next.type === "run" && next.does === "merge";

function NextAction({ next }: { next: Next }) {
	if (next.type === "wait")
		return <span className="text-[13px] text-dim">{next.label}</span>;
	if (next.type === "open")
		return (
			<a
				href={next.href}
				target="_blank"
				rel="noreferrer"
				className={cx(
					"inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold",
					next.tier === "act"
						? "bg-flag text-ink hover:bg-[#ff6a55]"
						: "border border-line text-chalk hover:border-dim",
				)}
			>
				{next.label}
				<ExternalLink className="size-3" aria-hidden="true" />
			</a>
		);
	return (
		<ActionButton
			variant={
				next.tier === "act" ? "primary" : next.tier === "go" ? "go" : "default"
			}
			run={next.run}
			done={next.done}
			confirm={next.confirm}
			className="font-semibold"
		>
			{next.label}
		</ActionButton>
	);
}

// ── Cells ────────────────────────────────────────────────────
function CodeRabbitCell({ pr, now }: { pr: PrView; now: number }) {
	const cr = pr.codeRabbit;
	const v = cr.vote ?? 0;
	let text = "Not reviewed";
	let tone = "text-dim";
	const req = cr.request;
	if (req?.state === "pending")
		[text, tone] = ["Review requested", "text-telemetry"];
	else if (req?.state === "accepted")
		[text, tone] = ["Reviewing", "text-telemetry"];
	else if (req?.state === "declined")
		[text, tone] = [
			`Declined, ${(req.reason ?? "no reason").toLowerCase()}`,
			"text-amber",
		];
	else if (v >= 10) [text, tone] = ["Approved", "text-telemetry"];
	else if (v >= 5) [text, tone] = ["Approved, with notes", "text-telemetry"];
	else if (cr.openThreads)
		[text, tone] = [plural(cr.openThreads, "comment"), "text-flag"];
	else if (cr.rateLimited) {
		const left = cr.rateLimitEta ? Date.parse(cr.rateLimitEta) - now : 0;
		[text, tone] = [
			left > 0 ? `Limited, ${relative(left)}` : "Limit lifted",
			"text-amber",
		];
	} else if (v < 0 && cr.awaitingReReview)
		[text, tone] = ["Re-review pending", "text-telemetry"];
	else if (v < 0) [text, tone] = ["Changes asked", "text-flag"];
	return (
		<span
			className={cx("flex items-center gap-1.5 text-[13px]", tone)}
			title={
				req
					? `You asked ${relative(now - Date.parse(req.at))} ago${req.reason ? `. CodeRabbit: ${req.reason}` : ""}`
					: undefined
			}
		>
			<Rabbit className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
			<span className="truncate">{text}</span>
		</span>
	);
}

function PeopleCell({ pr }: { pr: PrView }) {
	const others = pr.reviewers.filter((r) => r.role === "other" && r.vote > 0);
	const q = pr.qaVote;
	const [text, tone] =
		q == null
			? ["No QA", "text-dim"]
			: q >= 5
				? ["QA approved", "text-go"]
				: q < 0
					? ["QA bounced", "text-flag"]
					: ["QA pending", "text-chalk/70"];
	return (
		<span className="flex items-center gap-2 text-[13px]">
			<span className={tone}>{text}</span>
			{others.length > 0 && (
				<span
					className="flex items-center gap-0.5 text-go/80"
					title={`Also approved by ${others.map((o) => o.name).join(", ")}`}
				>
					<CheckIcon className="size-3" aria-hidden="true" />
					{others.length}
				</span>
			)}
		</span>
	);
}

const CHECK_ORDER: Check["state"][] = [
	"failed",
	"expired",
	"canceled",
	"running",
	"queued",
	"passed",
];
const CHECK_FILL: Record<Check["state"], string> = {
	failed: "bg-flag",
	expired: "bg-amber",
	canceled: "bg-amber/50",
	running: "bg-telemetry animate-pulse",
	queued: "border border-spent",
	passed: "bg-go/70",
	not_applicable: "hidden",
};

/**
 * A strip of segments, worst first, with words only for what isn't fine.
 * Clicking it opens the PR's details: the full check list with per-check re-runs.
 */
function ChecksCell({
	checks,
	open,
	onToggle,
	controls,
}: {
	checks: Check[];
	open: boolean;
	onToggle: () => void;
	controls: string;
}) {
	const cs = checks
		.filter((c) => c.state !== "not_applicable" && c.isBlocking)
		.sort(
			(a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state),
		);
	const toggle = cx(
		"-mx-1.5 flex items-center gap-2 justify-self-start rounded-md px-1.5 py-1 hover:bg-line/60",
		open && "bg-line/60",
	);
	if (!cs.length)
		return (
			<button
				type="button"
				aria-expanded={open}
				aria-controls={controls}
				onClick={onToggle}
				className={toggle}
			>
				<span className="text-[13px] text-dim">No checks</span>
			</button>
		);
	const count = (s: Check["state"]) => cs.filter((c) => c.state === s).length;
	const [label, tone] = count("failed")
		? [`${count("failed")} failed`, "text-flag"]
		: count("expired")
			? [`${count("expired")} expired`, "text-amber"]
			: count("canceled")
				? [`${count("canceled")} cancelled`, "text-amber"]
				: count("running")
					? [`${count("running")} running`, "text-telemetry"]
					: count("queued")
						? [`${count("queued")} not run`, "text-dim"]
						: ["All passed", "text-go"];
	return (
		<button
			type="button"
			aria-expanded={open}
			aria-controls={controls}
			aria-label={`${label}. ${open ? "Hide" : "Show"} checks and details`}
			title={cs.map((c) => `${c.name}: ${c.state}`).join("\n")}
			onClick={onToggle}
			className={toggle}
		>
			<span className="flex gap-[2px]">
				{cs.map((c) => (
					<span
						key={c.evaluationId}
						className={cx("h-2.5 w-[5px] rounded-[1px]", CHECK_FILL[c.state])}
					/>
				))}
			</span>
			<span className={cx("text-[13px]", tone)}>{label}</span>
		</button>
	);
}

// ── Jira ─────────────────────────────────────────────────────
const jiraTone = (t: JiraTicket) =>
	t.statusCategory === "done"
		? "text-go"
		: t.statusCategory === "indeterminate"
			? "text-telemetry"
			: "text-dim";
const ACRONYMS = new Set(["PR", "QA", "UAT", "SHIP", "SHOW", "ASK"]);
/** "ITERATION REQUIRED" → "Iteration required", "IN PR" → "In PR". */
const sentence = (s: string) =>
	s
		.split(" ")
		.map((w, i) =>
			ACRONYMS.has(w.toUpperCase())
				? w.toUpperCase()
				: i === 0
					? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()
					: w.toLowerCase(),
		)
		.join(" ");

/** Open/close state for a small anchored menu: closes on outside click and Escape. */
function usePopover() {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const close = (e: MouseEvent) =>
			!ref.current?.contains(e.target as Node) && setOpen(false);
		const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
		document.addEventListener("mousedown", close);
		document.addEventListener("keydown", esc);
		return () => {
			document.removeEventListener("mousedown", close);
			document.removeEventListener("keydown", esc);
		};
	}, [open]);
	return { open, setOpen, ref };
}

const MENU =
	"absolute right-0 z-30 mt-1 max-h-80 w-64 overflow-auto rounded-lg border border-line bg-panel py-1 shadow-2xl shadow-black/50";
const MENU_ITEM = "w-full justify-start text-[13px] text-chalk";

function JiraStatusMenu({ ticket }: { ticket: JiraTicket }) {
	const { open, setOpen, ref } = usePopover();
	const transitions = useQuery({
		queryKey: ["transitions", ticket.key, ticket.status],
		queryFn: () => getTransitionsFn({ data: { key: ticket.key } }),
		enabled: open,
		staleTime: 60_000,
	});

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				className={cx(
					"inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-medium hover:bg-line/60",
					jiraTone(ticket),
				)}
			>
				{sentence(ticket.status)}
				<ChevronDown className="size-3.5 opacity-60" aria-hidden="true" />
			</button>
			{open && (
				<div className={MENU}>
					<p className="px-3 pt-1.5 pb-1 text-xs text-dim">
						Move {ticket.key} to
					</p>
					{transitions.isPending && (
						<p className="flex items-center gap-2 px-3 py-2 text-xs text-dim">
							<Spinner /> Loading statuses
						</p>
					)}
					{transitions.error && (
						<p className="px-3 py-2 text-xs text-flag">
							{transitions.error.message}
						</p>
					)}
					{transitions.data?.map((t) => (
						<div key={t.id} className="px-1">
							<ActionButton
								variant="ghost"
								className="w-full justify-start text-[13px] text-chalk"
								run={async () => {
									await transitionJiraFn({
										data: { key: ticket.key, transitionId: t.id },
									});
									setOpen(false);
								}}
							>
								{sentence(t.to)}
							</ActionButton>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

/** "Product > Area > Feature > Item" → parent + leaf. */
function splitSummary(summary: string) {
	const parts = summary
		.split(/\s*>\s*/)
		.map((p) => p.trim())
		.filter(Boolean);
	return {
		parent: parts.length > 1 ? parts[parts.length - 2] : null,
		leaf: parts[parts.length - 1] ?? summary,
	};
}

function Summary({ text }: { text: string }) {
	const { parent, leaf } = splitSummary(text);
	return (
		<>
			{parent && <span className="text-dim">{parent} › </span>}
			{leaf}
		</>
	);
}

// ── Rows ─────────────────────────────────────────────────────
// One column template so every PR line aligns down the page.
const COLS =
	"md:grid md:grid-cols-[4.5rem_6.75rem_7.5rem_10rem_8rem_10rem_minmax(0,1fr)] md:items-center md:gap-x-3";
const KEY_W = "md:w-[11.25rem]"; // stage + PR columns, so summaries line up with "Into"

function ColumnHeads() {
	return (
		<div className={cx("hidden px-4 pb-1.5 text-xs text-dim/80", COLS)}>
			<span>Stage</span>
			<span>PR</span>
			<span>Into</span>
			<span>CodeRabbit</span>
			<span>People</span>
			<span>Checks</span>
			<span className="text-right">Next</span>
		</div>
	);
}

function useDebounced<T>(value: T, ms: number) {
	const [v, setV] = useState(value);
	useEffect(() => {
		const t = setTimeout(() => setV(value), ms);
		return () => clearTimeout(t);
	}, [value, ms]);
	return v;
}

/** Who the Jira ticket sits with (you, someone else, nobody), and a menu to hand it on. */
function AssigneeMenu({
	ticket,
	me,
}: {
	ticket: JiraTicket;
	me: string | null;
}) {
	const { open, setOpen, ref } = usePopover();
	const [query, setQuery] = useState("");
	const q = useDebounced(query.trim(), 250);
	const people = useQuery({
		queryKey: ["assignable", ticket.key, q],
		queryFn: () => searchAssigneesFn({ data: { key: ticket.key, query: q } }),
		enabled: open,
		staleTime: 5 * 60_000,
		placeholderData: (prev) => prev,
	});
	const mine = !!me && ticket.assigneeId === me;
	const [text, tone] = !ticket.assignee
		? ["Unassigned", "text-amber"]
		: mine
			? ["You", "text-chalk/70"]
			: [ticket.assignee, "text-dim"];
	const assign = (accountId: string | null) => async () => {
		await assignJiraFn({ data: { key: ticket.key, accountId } });
		setOpen(false);
		setQuery("");
	};

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				aria-expanded={open}
				aria-label={`${ticket.assignee ? `Assigned to ${ticket.assignee}` : "Unassigned"}. Change assignee`}
				onClick={() => setOpen((o) => !o)}
				className={cx(
					"inline-flex h-7 max-w-48 items-center gap-1.5 rounded-md px-2 text-[13px] hover:bg-line/60",
					tone,
				)}
			>
				<UserRound
					className="size-3.5 shrink-0 opacity-70"
					aria-hidden="true"
				/>
				<span className="truncate">{text}</span>
				<ChevronDown
					className="size-3.5 shrink-0 opacity-60"
					aria-hidden="true"
				/>
			</button>
			{open && (
				<div className={MENU}>
					<p className="px-3 pt-1.5 pb-1 text-xs text-dim">
						Assign {ticket.key} to
					</p>
					<div className="relative px-2 pb-1.5">
						<input
							// biome-ignore lint/a11y/noAutofocus: the menu exists to search
							autoFocus
							type="search"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							placeholder="Search people"
							aria-label="Search people"
							className="h-8 w-full rounded-md border border-line bg-ink px-2 text-[13px] text-chalk outline-none placeholder:text-dim focus:border-dim"
						/>
						{people.isFetching && (
							<Spinner className="absolute top-2 right-4 size-3.5 text-dim" />
						)}
					</div>
					{!query.trim() && (
						<div className="flex flex-col border-b border-line px-1 pb-1">
							{me && !mine && (
								<ActionButton
									variant="ghost"
									className={MENU_ITEM}
									run={assign(me)}
									done="Assigned"
								>
									Assign to me
								</ActionButton>
							)}
							{ticket.assignee && (
								<ActionButton
									variant="ghost"
									className={cx(MENU_ITEM, "!text-dim")}
									run={assign(null)}
									done="Unassigned"
								>
									Unassign
								</ActionButton>
							)}
						</div>
					)}
					{people.isPending && (
						<p className="flex items-center gap-2 px-3 py-2 text-xs text-dim">
							<Spinner /> Finding people
						</p>
					)}
					{people.error && (
						<p className="px-3 py-2 text-xs text-flag">
							{people.error.message}
						</p>
					)}
					{people.data?.length === 0 && (
						<p className="px-3 py-2 text-xs text-dim">Nobody matches “{q}”.</p>
					)}
					<div
						className={cx(
							"flex flex-col px-1 pt-1 transition-opacity",
							people.isPlaceholderData && "opacity-50",
						)}
						aria-busy={people.isFetching}
					>
						{people.data?.map((u) => (
							<ActionButton
								key={u.accountId}
								variant="ghost"
								className={MENU_ITEM}
								disabled={u.accountId === ticket.assigneeId}
								run={assign(u.accountId)}
								done="Assigned"
							>
								{u.avatar ? (
									<img src={u.avatar} alt="" className="size-4 rounded-full" />
								) : (
									<UserRound className="size-4 opacity-60" aria-hidden="true" />
								)}
								<span className="truncate">{u.name}</span>
								{u.accountId === me && <span className="text-dim">(you)</span>}
								{u.accountId === ticket.assigneeId && (
									<CheckIcon
										className="ml-auto size-3.5 text-go"
										aria-hidden="true"
									/>
								)}
							</ActionButton>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function TicketRow({
	group,
	prStatus,
	now,
	me,
}: {
	group: TicketGroup;
	prStatus: string;
	now: number;
	me: string | null;
}) {
	const t = group.jira;
	const anyReady = group.prs.some((p) => isReady(nextFor(p, now)));
	return (
		<article
			className={cx(
				"border-t border-line px-4 py-3 first:border-t-0",
				anyReady && "shadow-[inset_3px_0_0_0_var(--color-go)]",
			)}
		>
			<header className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<a
					href={t?.url}
					target="_blank"
					rel="noreferrer"
					className={cx(
						"font-display text-sm font-medium tabular-nums text-chalk/90 hover:text-chalk",
						KEY_W,
					)}
				>
					{group.ticketKey ?? "No ticket"}
				</a>
				<h3
					className="min-w-0 flex-1 truncate text-[15px] text-chalk max-md:order-last max-md:basis-full"
					title={t?.summary}
				>
					<Summary text={t?.summary ?? group.prs[0].shortTitle} />
				</h3>
				<span className="flex-1 md:hidden" />
				{t && <AssigneeMenu ticket={t} me={me} />}
				{group.jiraNeedsMove && t && (
					<ActionButton
						variant="ghost"
						className="text-[13px] !text-amber hover:!text-[#f3c46a]"
						title={`Jira says "${t.status}" but the PR is up`}
						run={() => moveToPrStatusFn({ data: { key: t.key } })}
						done="Moved"
					>
						Move to {sentence(prStatus)}
					</ActionButton>
				)}
				{t ? (
					<JiraStatusMenu ticket={t} />
				) : (
					group.ticketKey && (
						<span className="text-xs text-dim">Jira not loaded</span>
					)
				)}
			</header>
			<div className="mt-2 space-y-1">
				{group.prs.map((pr) => (
					<PrLine key={`${pr.repoId}:${pr.id}`} pr={pr} now={now} />
				))}
			</div>
		</article>
	);
}

function PrLine({ pr, now }: { pr: PrView; now: number }) {
	const [open, setOpen] = useState(false);
	const next = nextFor(pr, now);
	const ready = isReady(next);
	const detailsId = `pr-${pr.repoId}-${pr.id}`;
	return (
		<div
			className={cx(
				"-mx-2 rounded-md px-2",
				ready && "bg-go/[0.07] ring-1 ring-go/35",
				open && !ready && "bg-panel",
			)}
		>
			<div
				className={cx(
					"flex flex-wrap items-center gap-x-4 gap-y-1.5 py-1",
					COLS,
				)}
			>
				<Lights
					stage={pr.stage}
					urgent={next.type !== "wait" && next.tier === "act"}
					ready={ready}
				/>
				<span className="flex items-baseline gap-2">
					<a
						href={pr.url}
						target="_blank"
						rel="noreferrer"
						title={pr.title}
						className="font-display text-sm tabular-nums text-chalk hover:underline hover:underline-offset-4"
					>
						!{pr.id}
					</a>
					{pr.kind && (
						<span
							className={cx(
								"font-display text-[11px] font-semibold tracking-wide",
								KIND_COLOR[pr.kind],
							)}
						>
							{pr.kind.toUpperCase()}
						</span>
					)}
				</span>
				<span
					className="truncate text-[13px] text-dim"
					title={`${pr.sourceBranch} → ${pr.targetBranch}`}
				>
					{pr.targetBranch}
					{pr.isDraft && <span className="ml-1.5 text-amber">draft</span>}
				</span>
				<CodeRabbitCell pr={pr} now={now} />
				<PeopleCell pr={pr} />
				<ChecksCell
					checks={pr.checks}
					open={open}
					onToggle={() => setOpen((o) => !o)}
					controls={detailsId}
				/>
				<span className="flex justify-end max-md:order-last max-md:w-full max-md:justify-start">
					<NextAction next={next} />
				</span>
			</div>
			{open && <PrDetails id={detailsId} pr={pr} next={next} />}
		</div>
	);
}

const voteText = (v: number) =>
	v >= 10
		? "approved"
		: v >= 5
			? "approved with notes"
			: v <= -10
				? "rejected"
				: v < 0
					? "waiting on author"
					: "no vote";

function CheckRow({ check: c }: { check: Check }) {
	return (
		<li className="flex items-center gap-2.5 text-[13px]">
			<span
				className={cx(
					"h-2.5 w-[5px] shrink-0 rounded-[1px]",
					CHECK_FILL[c.state],
				)}
			/>
			<span className="min-w-0 flex-1 truncate text-chalk/90">
				{c.buildUrl ? (
					<a
						href={c.buildUrl}
						target="_blank"
						rel="noreferrer"
						className="hover:underline hover:underline-offset-4"
					>
						{c.name}
					</a>
				) : (
					c.name
				)}
			</span>
			<span className="text-dim">
				{c.state === "queued"
					? "not run"
					: c.state === "canceled"
						? "cancelled"
						: c.state}
			</span>
			{isRequeueable(c) && (
				<ActionButton
					variant="ghost"
					size="xs"
					run={() =>
						requeueChecksFn({ data: { evaluationIds: [c.evaluationId] } })
					}
					done="Queued"
				>
					Re-run
				</ActionButton>
			)}
		</li>
	);
}

function PrDetails({ id, pr, next }: { id: string; pr: PrView; next: Next }) {
	const nextDoes = next.type === "run" ? next.does : null;
	const [showOptional, setShowOptional] = useState(false);
	const checks = pr.checks.filter((c) => c.state !== "not_applicable");
	const required = checks.filter((c) => c.isBlocking);
	const optional = checks.filter((c) => !c.isBlocking);
	const requeueable = required.filter(isRequeueable);
	return (
		<div
			id={id}
			className="grid gap-6 border-t border-line py-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)] md:pl-[5.25rem]"
		>
			<div className="min-w-0 space-y-4">
				<div>
					<a
						href={pr.url}
						target="_blank"
						rel="noreferrer"
						className="text-sm text-chalk hover:underline hover:underline-offset-4"
					>
						{pr.title}
					</a>
					<p className="mt-1 truncate text-xs text-dim">
						{pr.sourceBranch} into {pr.targetBranch}, opened{" "}
						{relative(Date.now() - Date.parse(pr.createdAt))} ago by {pr.author}
					</p>
				</div>
				<ul className="space-y-1">
					{required.map((c) => (
						<CheckRow key={c.evaluationId} check={c} />
					))}
				</ul>
				{optional.length > 0 && (
					<div>
						<button
							type="button"
							aria-expanded={showOptional}
							onClick={() => setShowOptional((o) => !o)}
							className="flex items-center gap-1 text-xs text-dim hover:text-chalk"
						>
							<ChevronDown
								className={cx(
									"size-3.5 transition-transform",
									showOptional && "rotate-180",
								)}
								aria-hidden="true"
							/>
							{showOptional ? "Hide" : "Show"}{" "}
							{plural(optional.length, "optional check")}
						</button>
						{showOptional && (
							<ul className="mt-2 space-y-1 opacity-70">
								{optional.map((c) => (
									<CheckRow key={c.evaluationId} check={c} />
								))}
							</ul>
						)}
					</div>
				)}
			</div>
			<div className="space-y-4">
				<ul className="space-y-1 text-[13px]">
					{pr.reviewers.map((r) => {
						// CodeRabbit's "waiting on author" is stale once you've pushed and it hasn't looked again.
						const stale =
							r.role === "coderabbit" &&
							r.vote < 0 &&
							pr.codeRabbit.awaitingReReview;
						return (
							<li key={r.name} className="flex justify-between gap-3">
								<span className="truncate text-chalk/90">
									{r.role === "coderabbit" ? "CodeRabbit" : r.name}
								</span>
								<span
									className={
										stale
											? "text-telemetry"
											: r.vote > 0
												? "text-go"
												: r.vote < 0
													? "text-flag"
													: "text-dim"
									}
								>
									{stale ? "re-review pending" : voteText(r.vote)}
								</span>
							</li>
						);
					})}
				</ul>
				<div className="flex flex-wrap gap-1.5">
					{requeueable.length > 0 &&
						!(
							nextDoes === "rerun" &&
							next.type === "run" &&
							next.count === requeueable.length
						) && (
							<ActionButton
								run={() =>
									requeueChecksFn({
										data: {
											evaluationIds: requeueable.map((c) => c.evaluationId),
										},
									})
								}
								done="Queued"
							>
								Re-run {plural(requeueable.length, "check")}
							</ActionButton>
						)}
					{nextDoes !== "ask-rabbit" && (
						<ActionButton
							run={() =>
								retriggerCodeRabbitFn({
									data: { repoId: pr.repoId, prId: pr.id },
								})
							}
							done="Asked"
						>
							Ask CodeRabbit to review
						</ActionButton>
					)}
					{nextDoes !== "publish" && (
						<ActionButton
							variant="ghost"
							run={() =>
								setDraftFn({
									data: {
										repoId: pr.repoId,
										prId: pr.id,
										isDraft: !pr.isDraft,
									},
								})
							}
						>
							{pr.isDraft ? "Publish draft" : "Mark as draft"}
						</ActionButton>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Sections ─────────────────────────────────────────────────
interface Section {
	id: string;
	label: string;
	hint: string;
	tone: string;
	groups: TicketGroup[];
}

function matches(q: string, ...fields: (string | null | undefined)[]) {
	if (!q) return true;
	const needle = q.toLowerCase();
	return fields.some((f) => f?.toLowerCase().includes(needle));
}

function buildSections(board: Board, by: GroupBy, filter: string): Section[] {
	const all = board.lanes
		.flatMap((l) => l.groups) // lanes are stage-ordered, so cards stay stage-sorted within a kind
		.filter((g) =>
			matches(
				filter,
				g.ticketKey,
				g.kind,
				g.jira?.summary,
				g.jira?.status,
				...g.prs.flatMap((p) => [p.title, p.sourceBranch, String(p.id)]),
			),
		);
	if (by === "stage")
		return board.lanes.map((l) => ({
			id: l.stage,
			label: STAGE_META[l.stage].label,
			hint: STAGE_META[l.stage].hint,
			tone: STAGE_COLOR[l.stage],
			groups: all.filter((g) => g.stage === l.stage),
		}));
	return [
		...KINDS.map((k) => ({
			id: `kind-${k.id}`,
			label: k.label,
			hint: k.hint,
			tone: KIND_COLOR[k.id],
			groups: all.filter((g) => g.kind === k.id),
		})),
		{
			id: "kind-none",
			label: "No prefix",
			hint: "Title doesn't start with SHIP, SHOW or ASK",
			tone: "text-dim",
			groups: all.filter((g) => !g.kind),
		},
	];
}

const filterNoPr = (board: Board, filter: string) =>
	board.noPr.filter((t) => matches(filter, t.key, t.summary, t.status));
function SectionHead({
	id,
	label,
	hint,
	count,
	tone,
}: {
	id: string;
	label: string;
	hint: string;
	count: number;
	tone: string;
}) {
	return (
		<h2 id={id} className="flex scroll-mt-32 items-baseline gap-3 px-4 pb-2">
			<span
				className={cx("size-2 self-center rounded-full bg-current", tone)}
				aria-hidden="true"
			/>
			<span className="font-display text-lg font-medium tracking-tight text-chalk">
				{label}
			</span>
			<span className="font-display text-sm tabular-nums text-dim">
				{count}
			</span>
			<span className="hidden text-[13px] text-dim sm:inline">{hint}</span>
		</h2>
	);
}

const Panel = ({ children }: { children: React.ReactNode }) => (
	<div className="rounded-xl border border-line">{children}</div>
);

/** Every PR (with its ticket) that only needs your Merge click. */
function readyToMerge(board: Board, filter: string, now: number) {
	return buildSections(board, "stage", filter)
		.flatMap((s) => s.groups)
		.flatMap((g) =>
			g.prs.flatMap((pr) => {
				const next = nextFor(pr, now);
				return isReady(next) ? [{ group: g, pr, next }] : [];
			}),
		);
}

/** Pinned above everything: the PRs you can merge right now. */
function ReadyStrip({ items }: { items: ReturnType<typeof readyToMerge> }) {
	if (!items.length) return null;
	return (
		<section
			id="ready"
			aria-labelledby="ready-title"
			className="scroll-mt-32 rounded-xl border border-go/40 bg-go/[0.06] px-4 py-3 shadow-[0_0_40px_-18px_var(--color-go)]"
		>
			<h2 id="ready-title" className="flex items-center gap-3 pb-2">
				<Lights stage="cr_qa_approved" urgent={false} ready />
				<span className="font-display text-lg font-medium tracking-tight text-go">
					{items.length === 1
						? "1 PR ready to merge"
						: `${items.length} PRs ready to merge`}
				</span>
				<span className="hidden text-[13px] text-dim sm:inline">
					CodeRabbit and QA approved, required checks green
				</span>
			</h2>
			<ul className="divide-y divide-go/15">
				{items.map(({ group, pr, next }) => (
					<li
						key={`${pr.repoId}:${pr.id}`}
						className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2"
					>
						<a
							href={pr.url}
							target="_blank"
							rel="noreferrer"
							title={pr.title}
							className="font-display text-sm tabular-nums text-chalk hover:underline hover:underline-offset-4"
						>
							!{pr.id}
						</a>
						{pr.kind && (
							<span
								className={cx(
									"font-display text-[11px] font-semibold tracking-wide",
									KIND_COLOR[pr.kind],
								)}
							>
								{pr.kind.toUpperCase()}
							</span>
						)}
						<span className="font-display text-sm tabular-nums text-chalk/70">
							{group.ticketKey}
						</span>
						<span
							className="min-w-0 flex-1 truncate text-[15px] text-chalk"
							title={group.jira?.summary ?? pr.title}
						>
							{group.jira
								? splitSummary(group.jira.summary).leaf
								: pr.shortTitle}
						</span>
						<span className="text-[13px] text-dim">into {pr.targetBranch}</span>
						<NextAction next={next} />
					</li>
				))}
			</ul>
		</section>
	);
}

export function BoardView({
	board,
	filter,
	by,
}: {
	board: Board;
	filter: string;
	by: GroupBy;
}) {
	const now = useNow();
	const sections = buildSections(board, by, filter).filter(
		(s) => s.groups.length,
	);
	const noPr = filterNoPr(board, filter);
	const ready = readyToMerge(board, filter, now);

	if (!sections.length && !noPr.length)
		return (
			<p className="py-16 text-center text-sm text-dim">
				Nothing matches “{filter}”. Clear the filter to see everything.
			</p>
		);

	return (
		<div className="space-y-10">
			<ReadyStrip items={ready} />
			{sections.map((sec) => (
				<section key={sec.id}>
					<SectionHead
						id={sec.id}
						label={sec.label}
						hint={sec.hint}
						count={sec.groups.length}
						tone={sec.tone}
					/>
					<ColumnHeads />
					<Panel>
						{sec.groups.map((g) => (
							<TicketRow
								key={g.id}
								group={g}
								prStatus={board.jiraPrStatus}
								now={now}
								me={board.jiraMeId}
							/>
						))}
					</Panel>
				</section>
			))}

			{noPr.length > 0 && (
				<section>
					<SectionHead
						id="no_pr"
						label="In progress, no PR"
						hint="Tickets you're on without an open PR"
						count={noPr.length}
						tone="text-chalk/60"
					/>
					<Panel>
						{noPr.map((t) => (
							<div
								key={t.key}
								className="flex items-center gap-3 border-t border-line px-4 py-2 first:border-t-0"
							>
								<a
									href={t.url}
									target="_blank"
									rel="noreferrer"
									className={cx(
										"font-display text-sm tabular-nums text-chalk/90 hover:text-chalk",
										KEY_W,
									)}
								>
									{t.key}
								</a>
								<span
									className="min-w-0 flex-1 truncate text-[15px]"
									title={t.summary}
								>
									<Summary text={t.summary} />
								</span>
								<AssigneeMenu ticket={t} me={board.jiraMeId} />
								<JiraStatusMenu ticket={t} />
							</div>
						))}
					</Panel>
				</section>
			)}
		</div>
	);
}

export function StageNav({
	board,
	filter,
	by,
}: {
	board: Board;
	filter: string;
	by: GroupBy;
}) {
	const now = useNow();
	const ready = readyToMerge(board, filter, now).length;
	const items = [
		...(ready
			? [
					{
						id: "ready",
						label: "Ready to merge",
						count: ready,
						tone: "text-go",
					},
				]
			: []),
		...buildSections(board, by, filter).map((s) => ({
			id: s.id,
			label: s.label,
			count: s.groups.length,
			tone: s.tone,
		})),
		{
			id: "no_pr",
			label: "No PR",
			count: filterNoPr(board, filter).length,
			tone: "text-chalk/60",
		},
	];
	return (
		<nav aria-label="Sections" className="flex flex-wrap gap-x-5 gap-y-1">
			{items.map((i) =>
				i.count ? (
					<a
						key={i.id}
						href={`#${i.id}`}
						className={cx(
							"group flex items-center gap-2 text-[13px] hover:text-chalk",
							i.id === "ready" ? "font-semibold text-go" : "text-chalk/80",
						)}
					>
						<span
							className={cx("size-1.5 rounded-full bg-current", i.tone)}
							aria-hidden="true"
						/>
						{i.label}
						<span className="font-display tabular-nums text-dim group-hover:text-chalk/70">
							{i.count}
						</span>
					</a>
				) : (
					<span
						key={i.id}
						className="flex items-center gap-2 text-[13px] text-dim/50"
					>
						<span
							className="size-1.5 rounded-full border border-current"
							aria-hidden="true"
						/>
						{i.label}
					</span>
				),
			)}
		</nav>
	);
}
