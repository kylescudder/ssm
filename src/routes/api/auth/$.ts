import { createFileRoute } from "@tanstack/react-router";
import { auth, ensureMigrated } from "#/server/auth";

const handle = async ({ request }: { request: Request }) => {
	await ensureMigrated();
	return auth.handler(request);
};

export const Route = createFileRoute("/api/auth/$")({
	server: { handlers: { GET: handle, POST: handle } },
});
