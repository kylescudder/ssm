import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { SlotSource } from "#/lib/coderabbit-allowance";
import { getCodeRabbitStatusFn } from "#/server/coderabbit-fns";
import { retriggerCodeRabbitFn } from "#/server/fns";
import { ActionButton, cx, relative, useNow } from "./ui";

const SOURCE_LABEL: Record<SlotSource, string> = {
	review: "reviewed",
	in_flight: "reviewing now",
	inferred: "not on this board",
};

const clock = (iso: string, now: number) => {
	const d = new Date(iso);
	const sameDay = new Date(now).toDateString() === d.toDateString();
	return sameDay
		? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
		: d.toLocaleString([], {
				weekday: "short",
				hour: "2-digit",
				minute: "2-digit",
			});
};

/**
 * CodeRabbit allowance: how many review slots are free right now, when the next one
 * opens, who's holding them, and which rate-limited PRs are queued for one.
 */
export function CodeRabbitStatus() {
	const now = useNow(5_000);
	const qc = useQueryClient();
	const [open, setOpen] = useState(false);
	const q = useQuery({
		queryKey: ["coderabbit"],
		queryFn: () => getCodeRabbitStatusFn(),
		refetchInterval: 60_000,
	});
	const s = q.data;
	if (!s) {
		return (
			<div className="rounded-lg border border-zinc-200 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-800">
				🐇{" "}
				{q.error
					? `CodeRabbit allowance unavailable: ${q.error.message}`
					: "Working out CodeRabbit allowance…"}
			</div>
		);
	}

	// The clock may have rolled past the next release since the last fetch.
	const freedSince = s.slots.filter((x) => Date.parse(x.freesAt) <= now).length;
	const available = Math.min(s.perHour, s.available + freedSince);
	const holding = s.slots.filter((x) => Date.parse(x.freesAt) > now);
	const nextFree =
		available > 0
			? null
			: (holding[holding.length - s.perHour]?.freesAt ?? s.nextFreeAt);
	const queueHours = s.queue.length / s.perHour;

	const ask = async (repoId: string, prId: number) => {
		await retriggerCodeRabbitFn({ data: { repoId, prId } });
		setTimeout(() => qc.invalidateQueries({ queryKey: ["coderabbit"] }), 3_000);
	};

	return (
		<section
			className={cx(
				"rounded-lg border px-3 py-2 text-xs",
				available > 0
					? "border-emerald-300 bg-emerald-50 dark:border-emerald-500/30 dark:bg-emerald-500/10"
					: "border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/60",
			)}
		>
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left"
			>
				<span className="font-semibold">🐇 CodeRabbit</span>
				<span
					className="flex items-center gap-1"
					title={`${s.perHour} review(s) per rolling hour`}
				>
					{Array.from({ length: s.perHour }, (_, i) => (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: fixed-size slot meter
							key={i}
							className={cx(
								"size-2.5 rounded-sm",
								i < available
									? "bg-emerald-500"
									: "bg-zinc-300 dark:bg-zinc-700",
							)}
						/>
					))}
					<span className="ml-1 font-mono">
						{available}/{s.perHour} free
					</span>
				</span>
				{available > 0 ? (
					<span className="font-medium text-emerald-700 dark:text-emerald-400">
						Review available now
						{s.queue.length
							? ` — ${s.queue.length} PR${s.queue.length > 1 ? "s" : ""} waiting`
							: ""}
					</span>
				) : nextFree ? (
					<span>
						Next slot <b>{clock(nextFree, now)}</b>{" "}
						<span className="text-zinc-500">
							(in {relative(Date.parse(nextFree) - now)})
						</span>
					</span>
				) : null}
				{s.queue.length > 0 && (
					<span className="text-zinc-500">
						{s.queue.length} queued ≈{" "}
						{queueHours < 1 ? "<1h" : `${Math.ceil(queueHours)}h`} to clear
					</span>
				)}
				<span className="ml-auto text-zinc-400">{open ? "▴" : "▾"}</span>
			</button>

			{open && (
				<div className="mt-2 space-y-2 border-t border-zinc-200 pt-2 dark:border-zinc-800">
					{holding.length > 0 && (
						<div>
							<div className="mb-1 font-medium text-zinc-500">
								Holding the slot{holding.length > 1 ? "s" : ""}
							</div>
							<ul className="space-y-0.5">
								{holding.map((x) => (
									<li key={`${x.prId}-${x.at}`} className="flex gap-2">
										<span className="font-mono">
											{x.prId ? `!${x.prId}` : "—"}
										</span>
										<span className="min-w-0 flex-1 truncate">
											{x.prId
												? s.titles[x.prId]
												: "A review CodeRabbit counted that isn't on this board"}
										</span>
										<span className="text-zinc-500">
											{SOURCE_LABEL[x.source]} · spent {clock(x.at, now)} ·
											frees {clock(x.freesAt, now)}
										</span>
									</li>
								))}
							</ul>
						</div>
					)}
					{s.queue.length > 0 && (
						<div>
							<div className="mb-1 font-medium text-zinc-500">
								Rate-limited, oldest first
							</div>
							<ul className="space-y-1">
								{s.queue.map((p, i) => (
									<li key={p.id} className="flex items-center gap-2">
										<span className="w-5 text-right font-mono text-zinc-400">
											{i + 1}
										</span>
										<a
											href={p.url}
											target="_blank"
											rel="noreferrer"
											className="font-mono hover:underline"
										>
											!{p.id}
										</a>
										<span className="min-w-0 flex-1 truncate">{p.title}</span>
										<span className="text-zinc-500">
											since {clock(p.since, now)}
										</span>
										<ActionButton
											size="xs"
											variant={available > 0 ? "primary" : "ghost"}
											disabled={available === 0}
											run={() => ask(p.repoId, p.id)}
											done="Asked ✓"
										>
											Ask
										</ActionButton>
									</li>
								))}
							</ul>
						</div>
					)}
					<p className="text-zinc-500">
						Rolling 60-minute window per developer. Each review holds a slot
						from the push or command that started it; rate-limited attempts are
						free.
						{s.weekAttempts != null &&
							` Allowance ${s.perHour}/hour, set by your ${s.weekAttempts} reviews in the last 7 days.`}{" "}
						Reviews take ~{Math.round(s.reviewLagMs / 60_000)}m to post.
					</p>
				</div>
			)}
		</section>
	);
}
