import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { RefreshCw, Search } from "lucide-react";
import { useState } from "react";
import { BoardView, type GroupBy, StageNav } from "#/components/board";
import { cx, relative, Spinner, useNow } from "#/components/ui";
import { getBoardFn } from "#/server/fns";

export const Route = createFileRoute("/_app/")({
	validateSearch: (search: Record<string, unknown>): { by?: GroupBy } =>
		search.by === "kind" ? { by: "kind" } : {},
	component: BoardPage,
});

const GROUPINGS: { id: GroupBy; label: string }[] = [
	{ id: "stage", label: "By stage" },
	{ id: "kind", label: "By ship, show, ask" },
];

const ago = (ms: number) =>
	relative(ms) === "now" ? "just now" : `${relative(ms)} ago`;

function GroupByToggle({ by }: { by: GroupBy }) {
	return (
		<div
			role="tablist"
			aria-label="Group PRs"
			className="flex rounded-lg border border-line p-0.5"
		>
			{GROUPINGS.map((g) => (
				<Link
					key={g.id}
					to="/"
					role="tab"
					aria-selected={by === g.id}
					search={g.id === "kind" ? { by: "kind" } : {}}
					className={cx(
						"rounded-md px-3 py-1 text-[13px] transition-colors",
						by === g.id ? "bg-line text-chalk" : "text-dim hover:text-chalk",
					)}
				>
					{g.label}
				</Link>
			))}
		</div>
	);
}

function BoardPage() {
	const by = Route.useSearch().by ?? "stage";
	const now = useNow(5_000);
	const [filter, setFilter] = useState("");
	const board = useQuery({
		queryKey: ["board"],
		queryFn: () => getBoardFn(),
		// Builds move fast while running; otherwise a gentle 90s poll is plenty.
		refetchInterval: (q) =>
			q.state.data?.lanes.some((l) =>
				l.groups.some((g) =>
					g.prs.some((p) => p.checks.some((c) => c.state === "running")),
				),
			)
				? 15_000
				: 90_000,
	});

	return (
		<main className="mx-auto max-w-[1320px] px-2 pb-24 md:px-6">
			<div className="z-20 md:sticky md:top-0 -mx-2 space-y-3 border-b border-line bg-ink/92 px-4 py-3 backdrop-blur md:-mx-6 md:px-6">
				<div className="flex flex-wrap items-center gap-3">
					<label className="relative w-full max-w-sm">
						<span className="sr-only">Filter</span>
						<Search
							className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-dim"
							aria-hidden="true"
						/>
						<input
							type="search"
							placeholder="Filter by ticket, title or branch"
							value={filter}
							onChange={(e) => setFilter(e.target.value)}
							className="h-9 w-full rounded-lg border border-line bg-panel pr-3 pl-8 text-sm text-chalk outline-none placeholder:text-dim focus:border-dim"
						/>
					</label>
					<GroupByToggle by={by} />
					<button
						type="button"
						onClick={() => board.refetch()}
						disabled={board.isFetching}
						className="ml-auto flex items-center gap-2 rounded-md px-2 py-1 text-[13px] text-dim hover:text-chalk disabled:opacity-60"
					>
						{board.data && (
							<span>Updated {ago(now - Date.parse(board.data.fetchedAt))}</span>
						)}
						<RefreshCw
							className={cx("size-3.5", board.isFetching && "animate-spin")}
							aria-hidden="true"
						/>
						<span className="sr-only">Refresh</span>
					</button>
				</div>
				{board.data && <StageNav board={board.data} filter={filter} by={by} />}
			</div>

			<div className="pt-6">
				{board.isPending && (
					<p className="flex items-center gap-2 px-4 py-20 text-sm text-dim">
						<Spinner /> Loading PRs from Azure DevOps and tickets from Jira
					</p>
				)}
				{board.error && (
					<p className="mx-4 rounded-lg border border-flag/40 p-3 text-sm text-flag">
						{board.error.message}
					</p>
				)}
				{board.data && (
					<>
						{board.data.errors.length > 0 && (
							<details className="mx-4 mb-6 text-[13px] text-amber">
								<summary className="cursor-pointer">
									{board.data.errors.length === 1
										? "1 source failed to load"
										: `${board.data.errors.length} sources failed to load`}
								</summary>
								<ul className="mt-2 space-y-1 text-dim">
									{board.data.errors.map((e) => (
										<li key={e} className="break-all">
											{e}
										</li>
									))}
								</ul>
							</details>
						)}
						<BoardView board={board.data} filter={filter} by={by} />
					</>
				)}
			</div>
		</main>
	);
}
