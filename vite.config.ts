import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
	// Make every .env value (not just VITE_*) visible to server code in dev.
	Object.assign(process.env, loadEnv(mode, process.cwd(), ""), process.env);
	return {
		resolve: { tsconfigPaths: true },
		server: { port: Number(process.env.PORT ?? 3000) },
		plugins: [nitro(), tailwindcss(), tanstackStart(), viteReact()],
	};
});
