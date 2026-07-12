import { Link, useLocation } from "@tanstack/react-router";
import { Bell, CornerDownLeft, Terminal } from "lucide-react";

const NAV_ITEMS = [
	{ label: "TERMINAL", to: "/" },
	{ label: "LEADERBOARD", to: "/leaderboard" },
	{ label: "SEARCH", to: "/search" },
] as const;

export function NeonHeader({ showReturn = false }: { showReturn?: boolean }) {
	const { pathname } = useLocation();
	return (
		<header className="fixed top-0 right-0 left-0 z-50 flex h-16 items-center justify-between border-np-outline-variant border-b bg-np-bg/80 px-4 backdrop-blur-md md:px-8">
			<div className="flex items-center gap-8">
				<Link
					className="font-display text-np-primary text-xl tracking-tighter"
					to="/"
				>
					GH_COMMAND_CENTER
				</Link>
				<nav className="hidden gap-6 md:flex">
					{NAV_ITEMS.map((item) => {
						const active = pathname === item.to;
						return (
							<Link
								className={`font-label text-[11px] tracking-wider transition-colors ${
									active
										? "border-np-primary border-b-2 pb-2 text-np-primary"
										: "text-np-on-variant hover:text-np-on"
								}`}
								key={item.to}
								to={item.to}
							>
								{item.label}
							</Link>
						);
					})}
				</nav>
			</div>
			<div className="flex items-center gap-4">
				{showReturn && (
					<Link
						className="flex items-center gap-2 border border-np-secondary px-4 py-2 font-label text-[11px] text-np-secondary transition-all hover:shadow-[0_0_15px_rgba(166,230,255,0.4)] active:scale-95"
						to="/"
					>
						<CornerDownLeft className="size-4" />
						RETURN_TO_COMMAND
					</Link>
				)}
				<Bell className="size-5 text-np-primary" />
				<Terminal className="size-5 text-np-primary" />
			</div>
		</header>
	);
}
