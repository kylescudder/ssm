import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";

export const cx = (...c: (string | false | null | undefined)[]) =>
	c.filter(Boolean).join(" ");

export function Spinner({ className = "size-3.5" }: { className?: string }) {
	return (
		<svg
			className={cx("animate-spin", className)}
			viewBox="0 0 24 24"
			fill="none"
			aria-hidden="true"
		>
			<circle
				cx="12"
				cy="12"
				r="9"
				stroke="currentColor"
				strokeOpacity=".25"
				strokeWidth="3"
			/>
			<path
				d="M21 12a9 9 0 0 0-9-9"
				stroke="currentColor"
				strokeWidth="3"
				strokeLinecap="round"
			/>
		</svg>
	);
}

const BTN = {
	default: "border border-line bg-panel text-chalk hover:border-dim",
	/** Your move. */
	primary: "bg-flag text-ink hover:bg-[#ff6a55] border border-transparent",
	warn: "bg-amber text-ink hover:bg-[#f3c46a] border border-transparent",
	/** Lights out: it's ready to go. */
	go: "bg-go text-ink hover:bg-[#b6dba3] border border-transparent shadow-[0_0_18px_-4px_var(--color-go)]",
	ghost: "text-dim hover:text-chalk hover:bg-line/60",
};

export function Button({
	variant = "default",
	size = "sm",
	className,
	...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
	variant?: keyof typeof BTN;
	size?: "xs" | "sm" | "md";
}) {
	return (
		<button
			type="button"
			{...props}
			className={cx(
				"inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-50",
				size === "xs" && "h-6 px-2 text-[11px]",
				size === "sm" && "h-7 px-2.5 text-xs",
				size === "md" && "h-10 px-4 text-sm",
				BTN[variant],
				className,
			)}
		/>
	);
}

/** Runs an action, shows busy/error state, then refreshes the board. */
export function ActionButton({
	run,
	children,
	done,
	confirm,
	...props
}: Omit<React.ComponentProps<typeof Button>, "onClick"> & {
	run: () => Promise<unknown>;
	done?: ReactNode;
	/** For things you can't undo: the first click arms the button, a second one runs it. */
	confirm?: ReactNode;
}) {
	const qc = useQueryClient();
	const [state, setState] = useState<
		"idle" | "armed" | "busy" | "done" | "error"
	>("idle");
	useEffect(() => {
		if (state !== "armed") return;
		const t = setTimeout(() => setState("idle"), 4000);
		return () => clearTimeout(t);
	}, [state]);
	const [error, setError] = useState<string>();
	return (
		<span className="inline-flex items-center gap-1.5">
			<Button
				{...props}
				disabled={props.disabled || state === "busy"}
				onClick={async () => {
					if (confirm && state !== "armed") {
						setState("armed");
						return;
					}
					setState("busy");
					setError(undefined);
					try {
						await run();
						setState("done");
						// ADO takes a few seconds to reflect a re-run or a review request; look again as it settles.
						for (const ms of [1500, 8000, 20000])
							setTimeout(
								() => qc.invalidateQueries({ queryKey: ["board"] }),
								ms,
							);
						setTimeout(() => setState("idle"), 4000);
					} catch (e) {
						setError(e instanceof Error ? e.message : String(e));
						setState("error");
					}
				}}
			>
				{state === "busy" && <Spinner className="size-3" />}
				{state === "armed"
					? confirm
					: state === "done" && done
						? done
						: children}
			</Button>
			{state === "error" && (
				<span className="max-w-72 truncate text-[11px] text-flag" title={error}>
					{error}
				</span>
			)}
		</span>
	);
}

export function useNow(intervalMs = 15_000) {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const t = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(t);
	}, [intervalMs]);
	return now;
}

export function relative(ms: number) {
	const abs = Math.abs(ms);
	const m = Math.round(abs / 60_000);
	if (m < 1) return "now";
	if (m < 60) return `${m}m`;
	const h = Math.floor(m / 60);
	if (h < 48) return `${h}h${m % 60 && h < 6 ? ` ${m % 60}m` : ""}`;
	return `${Math.floor(h / 24)}d`;
}

export function Logo({ className = "size-7" }: { className?: string }) {
	return (
		// Same mark as public/favicon.svg and assets/icon.svg.
		<svg viewBox="0 0 64 64" className={className} aria-hidden="true">
			<rect width="64" height="64" rx="14" fill="#101111" />
			<path
				fillRule="evenodd"
				d="M34 8 46 28l-5-1 7 14-7 13H23l-7-13 8-17 4 8zM32 34l-6 10 3 5h6l3-5z"
				fill="#f14936"
			/>
		</svg>
	);
}
