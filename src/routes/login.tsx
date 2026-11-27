import { createFileRoute, redirect } from "@tanstack/react-router";

// Old URL — the sign-in flow lives at /auth/sign-in.
export const Route = createFileRoute("/login")({
	beforeLoad: () => {
		throw redirect({ to: "/auth/$path", params: { path: "sign-in" } });
	},
});
