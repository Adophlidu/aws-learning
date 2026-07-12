import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, SearchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { NeonHeader } from "@/components/neon-header";
import { type Profile, searchProfiles } from "@/lib/api";

interface SearchParams {
	location?: string;
	minFollowers?: number;
	q?: string;
}

export const Route = createFileRoute("/search")({
	validateSearch: (raw: Record<string, unknown>): SearchParams => ({
		q: typeof raw.q === "string" ? raw.q : undefined,
		location: typeof raw.location === "string" ? raw.location : undefined,
		minFollowers:
			typeof raw.minFollowers === "number" ? raw.minFollowers : undefined,
	}),
	component: SearchComponent,
});

function SearchComponent() {
	const params = Route.useSearch();
	const [q, setQ] = useState(params.q ?? "");
	const [location, setLocation] = useState(params.location ?? "");
	const [minFollowers, setMinFollowers] = useState(
		params.minFollowers ? String(params.minFollowers) : ""
	);
	const [results, setResults] = useState<Profile[]>([]);
	const [loading, setLoading] = useState(false);
	const [searched, setSearched] = useState(false);

	const run = useCallback(
		async (filter: {
			location?: string;
			minFollowers?: number;
			q?: string;
		}) => {
			setLoading(true);
			setSearched(true);
			try {
				setResults(await searchProfiles(filter));
			} catch (e) {
				toast.error(e instanceof Error ? e.message : "搜索失败");
			} finally {
				setLoading(false);
			}
		},
		[]
	);

	// URL 带 query（如从榜单跳转）时自动执行一次
	useEffect(() => {
		if (params.q || params.location || params.minFollowers) {
			run({
				q: params.q,
				location: params.location,
				minFollowers: params.minFollowers,
			});
		}
	}, [params.q, params.location, params.minFollowers, run]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		run({
			q: q.trim() || undefined,
			location: location.trim() || undefined,
			minFollowers: minFollowers ? Number(minFollowers) : undefined,
		});
	};

	return (
		<>
			<NeonHeader showReturn />
			<main className="mx-auto max-w-[1200px] px-4 pt-24 pb-12 md:px-8">
				<header className="mb-8">
					<div className="mb-4 inline-block border-np-primary border-l-2 bg-np-primary/10 px-3 py-1">
						<span className="font-label text-[11px] text-np-primary uppercase tracking-widest">
							Query Engine
						</span>
					</div>
					<h1 className="np-text-glow mb-2 flex items-center gap-3 font-display font-extrabold text-4xl text-np-primary tracking-tight">
						<SearchIcon className="size-8" />
						SEARCH_ARCHIVE
					</h1>
					<p className="max-w-2xl text-np-on-variant">
						按 login/name 关键词、地区、最小关注数筛选已收录档案。
					</p>
				</header>

				<form
					className="np-glass mb-10 grid grid-cols-1 gap-4 border-np-primary/30 p-6 md:grid-cols-4"
					onSubmit={handleSubmit}
				>
					<div className="md:col-span-2">
						<label
							className="mb-2 block font-label text-[11px] text-np-primary/70 uppercase tracking-widest"
							htmlFor="q"
						>
							Keyword
						</label>
						<input
							className="w-full border-np-outline border-b-2 bg-np-surface-lowest px-3 py-2 font-code text-np-secondary placeholder:text-np-on-variant/30 focus:border-np-secondary focus:outline-none"
							id="q"
							onChange={(ev) => setQ(ev.target.value)}
							placeholder="login / name"
							value={q}
						/>
					</div>
					<div>
						<label
							className="mb-2 block font-label text-[11px] text-np-primary/70 uppercase tracking-widest"
							htmlFor="location"
						>
							Location
						</label>
						<input
							className="w-full border-np-outline border-b-2 bg-np-surface-lowest px-3 py-2 font-code text-np-secondary placeholder:text-np-on-variant/30 focus:border-np-secondary focus:outline-none"
							id="location"
							onChange={(ev) => setLocation(ev.target.value)}
							placeholder="CN / Tokyo"
							value={location}
						/>
					</div>
					<div>
						<label
							className="mb-2 block font-label text-[11px] text-np-primary/70 uppercase tracking-widest"
							htmlFor="minFollowers"
						>
							Min Followers
						</label>
						<input
							className="w-full border-np-outline border-b-2 bg-np-surface-lowest px-3 py-2 font-code text-np-secondary placeholder:text-np-on-variant/30 focus:border-np-secondary focus:outline-none"
							id="minFollowers"
							min={0}
							onChange={(ev) => setMinFollowers(ev.target.value)}
							placeholder="0"
							type="number"
							value={minFollowers}
						/>
					</div>
					<button
						className="flex items-center justify-center gap-2 bg-np-primary px-6 py-2 font-bold font-display text-np-on-primary transition-all hover:shadow-[0_0_20px_rgba(108,221,129,0.5)] active:scale-95 disabled:opacity-50 md:col-span-4 md:justify-self-start"
						disabled={loading}
						type="submit"
					>
						<SearchIcon className="size-4" />
						{loading ? "QUERYING..." : "RUN_QUERY"}
					</button>
				</form>

				{loading && (
					<p className="font-code text-np-on-variant text-sm">QUERYING...</p>
				)}
				{!loading && searched && results.length === 0 && (
					<p className="font-code text-np-on-variant text-sm">
						{"NO_MATCH // 无匹配档案。"}
					</p>
				)}
				{!loading && results.length > 0 && (
					<div className="grid grid-cols-1 gap-1 md:grid-cols-2 lg:grid-cols-3">
						{results.map((p) => (
							<Link
								className="group border border-np-outline-variant bg-np-surface-low p-4 transition-all hover:bg-np-surface-high"
								key={p.id}
								params={{ id: String(p.id) }}
								to="/profiles/$id"
							>
								<div className="mb-4 flex items-center gap-3">
									{p.avatar_url ? (
										<img
											alt={`${p.login} avatar`}
											className="size-12 border border-np-outline-variant"
											height={48}
											src={p.avatar_url}
											width={48}
										/>
									) : (
										<div className="size-12 bg-np-surface-highest" />
									)}
									<div className="min-w-0">
										<div className="truncate font-code text-np-secondary">
											@{p.login}
										</div>
										<div className="truncate text-np-on-variant text-sm">
											{p.name || "—"}
										</div>
									</div>
								</div>
								<div className="mb-4 space-y-2">
									<div className="flex justify-between">
										<span className="font-label text-[11px] text-np-on-variant uppercase">
											Location
										</span>
										<span className="truncate font-code text-np-on text-xs">
											{p.location || "—"}
										</span>
									</div>
									<div className="flex justify-between">
										<span className="font-label text-[11px] text-np-on-variant uppercase">
											Followers
										</span>
										<span className="font-code text-np-on text-xs">
											{p.followers}
										</span>
									</div>
								</div>
								<div className="flex items-center justify-center gap-1 border border-np-outline-variant py-1 font-label text-[11px] text-np-on-variant uppercase transition-all group-hover:border-np-primary group-hover:text-np-primary">
									View Full Report
									<ChevronRight className="size-3" />
								</div>
							</Link>
						))}
					</div>
				)}
			</main>
		</>
	);
}
