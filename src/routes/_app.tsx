import {
	createFileRoute,
	Link,
	Outlet,
	redirect,
	useRouter,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { Button, Logo } from "#/components/ui";
import { authClient } from "#/lib/auth-client";
import { getSessionFn } from "#/server/fns";

export const Route = createFileRoute("/_app")({
	beforeLoad: async ({ location }) => {
		const session = await getSessionFn();
		if (!session)
			throw redirect({
				href: `/auth/sign-in?redirectTo=${encodeURIComponent(location.href)}`,
			});
		return { user: session.user };
	},
	component: AppLayout,
});

function AppLayout() {
	const { user } = Route.useRouteContext();
	const router = useRouter();
	// The whole app sits on the pit-wall palette; portals (menus, toasts) need it too.
	useEffect(() => {
		document.documentElement.classList.add("dark");
		return () => document.documentElement.classList.remove("dark");
	}, []);
	return (
		<div className="dark min-h-screen bg-ink font-sans text-chalk [color-scheme:dark]">
			<header className="border-b border-line">
				<div className="mx-auto flex h-14 max-w-[1320px] items-center gap-3 px-4 md:px-6">
					<Link to="/" className="flex items-center gap-2.5">
						<Logo className="size-7" />
						<span className="font-display text-[17px] font-semibold tracking-tight">
							SSM
						</span>
					</Link>
					<nav className="ml-auto flex items-center gap-1">
						<Link
							to="/profile"
							className="rounded-md px-2.5 py-1.5 text-[13px] text-dim hover:bg-line/60 hover:text-chalk"
						>
							{user.name || user.email}
						</Link>
						<Button
							variant="ghost"
							onClick={async () => {
								await authClient.signOut();
								await router.navigate({
									to: "/auth/$path",
									params: { path: "sign-in" },
								});
							}}
						>
							Sign out
						</Button>
					</nav>
				</div>
			</header>
			<Outlet />
		</div>
	);
}
