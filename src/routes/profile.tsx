import { useSession } from "@better-auth-ui/react";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Passkeys } from "@/components/auth/passkey/passkeys";
import { UserProfile } from "@/components/auth/settings/account/user-profile";
import { ChangePassword } from "@/components/auth/settings/security/change-password";
import { BetterAuthUIProvider } from "@/components/BetterAuthUIProvider";
import { PaddockShell } from "@/components/PaddockShell";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { clearPendingSignIn } from "@/lib/pending-sign-in";
import { getSessionFn } from "@/server/fns";

export const Route = createFileRoute("/profile")({
	beforeLoad: async () => {
		if (!(await getSessionFn()))
			throw redirect({ href: "/auth/sign-in?redirectTo=%2Fprofile" });
	},
	component: ProfilePage,
});

function ProfilePage() {
	return (
		<PaddockShell back>
			<main className="profile-page">
				<div className="eyebrow">SHIT SHOW MANAGER</div>
				<h1>Your profile</h1>
				<div className="paddock-auth">
					<BetterAuthUIProvider redirectTo="/profile">
						<BetterAuthProfile />
					</BetterAuthUIProvider>
				</div>
			</main>
		</PaddockShell>
	);
}

function BetterAuthProfile() {
	// Better Auth UI's session query, not the client's nanostore: sign-in awaits
	// this query before navigating here, while the nanostore can still hold the
	// signed-out value after a "Sign in again" round trip and bounce to sign-in.
	const { data: session, isPending } = useSession(authClient);
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [error, setError] = useState("");
	const [signingOut, setSigningOut] = useState(false);
	useEffect(() => {
		if (session) clearPendingSignIn();
		else if (!isPending)
			void navigate({
				href: "/auth/sign-in?redirectTo=%2Fprofile",
				replace: true,
			});
	}, [isPending, navigate, session]);
	if (!session)
		return (
			<output className="flex items-center gap-2 text-muted-foreground">
				<LoaderCircle className="size-4 animate-spin" /> Checking sign-in…
			</output>
		);
	async function signOut() {
		setSigningOut(true);
		setError("");
		try {
			const result = await authClient.signOut();
			if (result.error) {
				setError("Unable to sign out. Please try again.");
				return;
			}
			queryClient.clear();
			await navigate({ to: "/auth/$path", params: { path: "sign-in" } });
		} catch {
			setError("Unable to sign out. Please try again.");
		} finally {
			setSigningOut(false);
		}
	}
	return (
		<>
			<UserProfile key={session.user.id} />
			<div className="mt-8">
				<ChangePassword />
			</div>
			<Passkeys className="mt-8" />
			<p className="profile-note">
				Email codes and links remain available if you lose your password or
				passkey.
			</p>
			{error && (
				<p role="alert" className="mt-6 text-destructive">
					{error}
				</p>
			)}
			<Button
				type="button"
				variant="outline"
				className="mt-8"
				disabled={signingOut}
				onClick={() => void signOut()}
			>
				{signingOut ? "Signing out…" : "Sign out"}
			</Button>
		</>
	);
}
