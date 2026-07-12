import { Toaster } from "@my-better-t-app/ui/components/sonner";
import {
	createRootRouteWithContext,
	HeadContent,
	Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { ThemeProvider } from "@/components/theme-provider";

import "../index.css";

export type RouterAppContext = Record<string, never>;

export const Route = createRootRouteWithContext<RouterAppContext>()({
	component: RootComponent,
	head: () => ({
		meta: [
			{
				title: "GH 指挥中心",
			},
			{
				name: "description",
				content: "GitHub 档案收集器 —— 赛博朋克指挥中心",
			},
		],
		links: [
			{
				rel: "icon",
				href: "/favicon.ico",
			},
		],
	}),
});

function RootComponent() {
	return (
		<>
			<HeadContent />
			<ThemeProvider
				attribute="class"
				defaultTheme="dark"
				disableTransitionOnChange
				storageKey="vite-ui-theme"
			>
				<div className="relative min-h-svh overflow-x-hidden bg-np-bg font-bodynp text-np-on">
					<div className="np-grid-bg pointer-events-none fixed inset-0 z-0 opacity-20" />
					<div className="np-scanline pointer-events-none fixed inset-0 z-10" />
					<div className="relative z-20">
						<Outlet />
					</div>
				</div>
				<Toaster richColors />
			</ThemeProvider>
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
