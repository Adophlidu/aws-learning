import { createFileRoute, Link } from "@tanstack/react-router";
import { ChevronRight, History, TerminalSquare, Users } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { NeonHeader } from "@/components/neon-header";
import { listProfiles, type Profile, submitToken } from "@/lib/api";

export const Route = createFileRoute("/")({
	component: HomeComponent,
});

function HomeComponent() {
	const [token, setToken] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [profiles, setProfiles] = useState<Profile[]>([]);
	const [loading, setLoading] = useState(true);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setProfiles(await listProfiles());
		} catch (e) {
			toast.error(e instanceof Error ? e.message : "加载列表失败");
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		refresh();
	}, [refresh]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (!token.trim()) {
			return;
		}
		setSubmitting(true);
		try {
			const profile = await submitToken(token.trim());
			toast.success(`扫描完成 // @${profile.login}`);
			setToken("");
			await refresh();
		} catch (err) {
			toast.error(err instanceof Error ? err.message : "提交失败");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<>
			<NeonHeader />
			<main className="mx-auto max-w-[1200px] px-4 pt-24 pb-12 md:px-8">
				<header className="mb-12">
					<div className="mb-4 inline-block border-np-primary border-l-2 bg-np-primary/10 px-3 py-1">
						<span className="font-label text-[11px] text-np-primary uppercase tracking-widest">
							系统状态：运行中
						</span>
					</div>
					<h1 className="np-text-glow mb-2 font-display font-extrabold text-5xl text-np-primary tracking-tight">
						令牌扫描器
					</h1>
					<p className="max-w-2xl text-np-on-variant">
						高性能 GitHub access token 扫描与收录套件。输入
						token，抓取并归档对应的 GitHub 身份档案。
					</p>
				</header>

				<section className="np-glass np-glow-primary mb-12 border-np-primary/30">
					<div className="flex items-center justify-between border-np-outline-variant border-b bg-np-surface-high px-4 py-2">
						<div className="flex gap-1.5">
							<div className="size-2.5 rounded-full bg-np-error/40" />
							<div className="size-2.5 rounded-full bg-np-tertiary/40" />
							<div className="size-2.5 rounded-full bg-np-primary/40" />
						</div>
						<span className="font-label text-[11px] text-np-on-variant/60">
							bash — 80x24
						</span>
						<div className="w-10" />
					</div>
					<form
						className="flex flex-col gap-6 p-8 md:p-12"
						onSubmit={handleSubmit}
					>
						<div>
							<label
								className="mb-3 block font-label text-[11px] text-np-primary/70 uppercase tracking-widest"
								htmlFor="token"
							>
								输入 GitHub 访问令牌
							</label>
							<div className="relative flex items-center">
								<span className="absolute left-4 font-code text-np-primary">
									$
								</span>
								<input
									className="w-full border-np-outline border-b-2 bg-np-surface-lowest py-4 pl-10 font-code text-np-secondary placeholder:text-np-on-variant/30 focus:border-np-secondary focus:outline-none"
									id="token"
									onChange={(e) => setToken(e.target.value)}
									placeholder="ghp_************************************"
									type="password"
									value={token}
								/>
							</div>
						</div>
						<button
							className="flex items-center justify-center gap-3 bg-np-primary px-8 py-4 font-bold font-display text-np-on-primary transition-all hover:shadow-[0_0_20px_rgba(108,221,129,0.5)] active:scale-95 disabled:opacity-50 md:self-start"
							disabled={submitting || !token.trim()}
							type="submit"
						>
							<TerminalSquare className="size-5" />
							{submitting ? "扫描中..." : "开始扫描"}
						</button>
					</form>
				</section>

				<section>
					<div className="mb-6 flex items-center justify-between">
						<div className="flex items-center gap-3">
							<History className="size-5 text-np-secondary" />
							<h2 className="font-display text-np-on text-xl uppercase tracking-tight">
								已收录档案
							</h2>
						</div>
						<div className="flex items-center gap-2 border border-np-outline-variant bg-np-surface px-3 py-1 font-label text-[11px] text-np-on-variant uppercase">
							<Users className="size-3" />
							已归档 {profiles.length}
						</div>
					</div>

					{loading && (
						<p className="font-code text-np-on-variant text-sm">加载中...</p>
					)}
					{!loading && profiles.length === 0 && (
						<p className="font-code text-np-on-variant text-sm">
							{"暂无记录 // 提交一个 token 开始扫描。"}
						</p>
					)}
					{!loading && profiles.length > 0 && (
						<div className="grid grid-cols-1 gap-1 md:grid-cols-2 lg:grid-cols-3">
							{profiles.map((p) => (
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
												公开仓库
											</span>
											<span className="font-code text-np-on text-xs">
												{p.public_repos}
											</span>
										</div>
										<div className="flex justify-between">
											<span className="font-label text-[11px] text-np-on-variant uppercase">
												关注者
											</span>
											<span className="font-code text-np-on text-xs">
												{p.followers}
											</span>
										</div>
									</div>
									<div className="flex items-center justify-center gap-1 border border-np-outline-variant py-1 font-label text-[11px] text-np-on-variant uppercase transition-all group-hover:border-np-primary group-hover:text-np-primary">
										查看完整档案
										<ChevronRight className="size-3" />
									</div>
								</Link>
							))}
						</div>
					)}
				</section>
			</main>
		</>
	);
}
