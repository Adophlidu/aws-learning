import { createFileRoute, Link } from "@tanstack/react-router";
import { FolderGit2, Star, Trophy } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { NeonHeader } from "@/components/neon-header";
import {
	getLeaderboard,
	type LeaderboardBy,
	type LeaderboardEntry,
} from "@/lib/api";

export const Route = createFileRoute("/leaderboard")({
	component: LeaderboardComponent,
});

const TABS: { by: LeaderboardBy; icon: typeof Star; label: string }[] = [
	{ by: "stars", icon: Star, label: "按 Star" },
	{ by: "repos", icon: FolderGit2, label: "按仓库数" },
];

function LeaderboardComponent() {
	const [by, setBy] = useState<LeaderboardBy>("stars");
	const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
	const [loading, setLoading] = useState(true);

	const load = useCallback(async () => {
		setLoading(true);
		try {
			setEntries(await getLeaderboard(by));
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "加载榜单失败");
		} finally {
			setLoading(false);
		}
	}, [by]);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<>
			<NeonHeader showReturn />
			<main className="mx-auto max-w-[1200px] px-4 pt-24 pb-12 md:px-8">
				<header className="mb-8">
					<div className="mb-4 inline-block border-np-primary border-l-2 bg-np-primary/10 px-3 py-1">
						<span className="font-label text-[11px] text-np-primary uppercase tracking-widest">
							排行引擎
						</span>
					</div>
					<h1 className="np-text-glow mb-2 flex items-center gap-3 font-display font-extrabold text-4xl text-np-primary tracking-tight">
						<Trophy className="size-8" />
						排行榜
					</h1>
					<p className="max-w-2xl text-np-on-variant">
						按已采集仓库聚合的 star / repo 排行。展示信息由 stats-service 经
						Cloud Map 从 profile-service 补全。
					</p>
				</header>

				<div className="mb-6 flex gap-1">
					{TABS.map((t) => {
						const active = t.by === by;
						return (
							<button
								className={`flex items-center gap-2 border px-4 py-2 font-label text-[11px] uppercase tracking-widest transition-all ${
									active
										? "border-np-primary bg-np-primary/10 text-np-primary"
										: "border-np-outline-variant text-np-on-variant hover:text-np-on"
								}`}
								key={t.by}
								onClick={() => setBy(t.by)}
								type="button"
							>
								<t.icon className="size-3.5" />
								{t.label}
							</button>
						);
					})}
				</div>

				{loading && (
					<p className="font-code text-np-on-variant text-sm">加载中...</p>
				)}
				{!loading && entries.length === 0 && (
					<p className="font-code text-np-on-variant text-sm">
						{"暂无数据 // 尚无采集数据。"}
					</p>
				)}
				{!loading && entries.length > 0 && (
					<div className="divide-y divide-np-outline-variant border border-np-outline-variant">
						{entries.map((e, i) => (
							<Link
								className="flex items-center gap-4 bg-np-surface-low px-4 py-3 transition-colors hover:bg-np-surface-high"
								key={e.github_id}
								search={{ q: e.login }}
								to="/search"
							>
								<span className="w-8 shrink-0 text-center font-bold font-display text-2xl text-np-primary/70">
									{i + 1}
								</span>
								{e.avatar_url ? (
									<img
										alt={`${e.login} avatar`}
										className="size-10 shrink-0 border border-np-outline-variant"
										height={40}
										src={e.avatar_url}
										width={40}
									/>
								) : (
									<div className="size-10 shrink-0 bg-np-surface-highest" />
								)}
								<div className="min-w-0 flex-1">
									<div className="truncate font-code text-np-secondary">
										@{e.login}
									</div>
									<div className="truncate text-np-on-variant text-sm">
										{e.name || "—"}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-6">
									<div className="text-right">
										<div className="font-bold font-display text-np-primary text-xl">
											{e.total_stars}
										</div>
										<div className="font-label text-[10px] text-np-on-variant uppercase">
											Star 数
										</div>
									</div>
									<div className="text-right">
										<div className="font-bold font-display text-np-on text-xl">
											{e.total_repos}
										</div>
										<div className="font-label text-[10px] text-np-on-variant uppercase">
											仓库数
										</div>
									</div>
								</div>
							</Link>
						))}
					</div>
				)}
			</main>
		</>
	);
}
