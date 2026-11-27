import { createServerFn } from "@tanstack/react-start";
import { loadCodeRabbitStatus } from "./coderabbit";
import { requireUser } from "./session";

export const getCodeRabbitStatusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		await requireUser();
		return loadCodeRabbitStatus();
	},
);
