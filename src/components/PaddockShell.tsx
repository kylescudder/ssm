import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { Logo } from "./ui";

/** Always-dark Paddock-style frame for the auth and profile pages. */
export function PaddockShell({
	children,
	back = false,
}: {
	children: ReactNode;
	back?: boolean;
}) {
	// Dialogs and toasts portal to <body>, outside this wrapper — force dark there too.
	useEffect(() => {
		document.documentElement.classList.add("dark");
		return () => document.documentElement.classList.remove("dark");
	}, []);
	return (
		<div className="dark paddock-shell">
			<header className="paddock-topbar">
				<Link to="/" className="flex items-center gap-2 !text-[#edece7]">
					<Logo className="size-6" />
					<span className="font-[Space_Grotesk] text-[15px] font-semibold tracking-tight">
						SSM
					</span>
				</Link>
				{back && <Link to="/">← Back to the board</Link>}
			</header>
			{children}
		</div>
	);
}
