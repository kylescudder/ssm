import { createFileRoute, Navigate } from "@tanstack/react-router";
import { Auth } from "@/components/auth/auth";
import { BetterAuthUIProvider } from "@/components/BetterAuthUIProvider";
import { PaddockShell } from "@/components/PaddockShell";

export const Route = createFileRoute("/auth/$path")({ component: AuthPage });

function AuthPage() {
	const { path } = Route.useParams();
	// Accounts are never self-registered: only whitelisted emails can sign in.
	if (path === "sign-up")
		return <Navigate to="/auth/$path" params={{ path: "sign-in" }} replace />;
	const signingOut = path === "sign-out";
	return (
		<PaddockShell>
			<main className="sign-in-page auth-page">
				<div className="eyebrow">SHIT SHOW MANAGER</div>
				<h1>{signingOut ? "Shit show paused." : "Welcome back."}</h1>
				<p>
					{signingOut
						? "Signing you out of SSM…"
						: "Sign in with your approved account to see where every PR and ticket stands."}
				</p>
				<div className="paddock-auth">
					<BetterAuthUIProvider>
						<Auth path={path} className="w-full max-w-none text-left" />
					</BetterAuthUIProvider>
				</div>
				<p className="auth-note">Whitelisted accounts only.</p>
			</main>
		</PaddockShell>
	);
}
