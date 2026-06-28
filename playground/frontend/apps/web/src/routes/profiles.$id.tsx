import { createFileRoute } from "@tanstack/react-router";
import {
	Building2,
	Calendar,
	Clock,
	Hash,
	MapPin,
	UserCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { NeonHeader } from "@/components/neon-header";
import { getProfile, type ProfileDetail } from "@/lib/api";

export const Route = createFileRoute("/profiles/$id")({
	component: DetailComponent,
});

const FRACTION_RE = /\.\d+Z?$/;

function formatDate(value: string | null): string {
	if (!value) {
		return "—";
	}
	return value.replace("T", " ").replace(FRACTION_RE, "").replace("Z", "");
}

const STAT_LABEL =
	"font-label text-[11px] text-np-on-variant uppercase tracking-widest group-hover:text-np-primary transition-colors";
const STAT_VALUE = "font-display font-bold text-3xl text-np-primary";

function DetailComponent() {
	const { id } = Route.useParams();
	const [profile, setProfile] = useState<ProfileDetail | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			setProfile(await getProfile(id));
		} catch (e) {
			setError(e instanceof Error ? e.message : "加载失败");
		} finally {
			setLoading(false);
		}
	}, [id]);

	useEffect(() => {
		load();
	}, [load]);

	return (
		<>
			<NeonHeader showReturn />
			<main className="mx-auto max-w-[1200px] px-4 pt-24 pb-12 md:px-8">
				{loading && (
					<p className="font-code text-np-on-variant text-sm">
						DECRYPTING_RECORD...
					</p>
				)}
				{error && !loading && (
					<div className="border border-np-error/40 bg-np-error/10 p-6 font-code text-np-error">
						{`ERROR // ${error}`}
					</div>
				)}
				{profile && !loading && (
					<div className="space-y-8">
						<section className="relative overflow-hidden border border-np-outline-variant bg-np-surface-lowest/80 p-8 backdrop-blur-xl">
							<div className="absolute top-0 right-0 select-none p-4 font-code text-np-primary text-xs opacity-20">
								{`ID: 0x${profile.github_id.toString(16).toUpperCase()} // ACTIVE`}
							</div>
							<div className="relative z-10 flex flex-col items-center gap-12 lg:flex-row">
								<div className="relative">
									<div className="relative size-48 border-2 border-np-primary p-2">
										{profile.avatar_url ? (
											<img
												alt={`${profile.login} avatar`}
												className="size-full object-cover"
												height={176}
												src={profile.avatar_url}
												width={176}
											/>
										) : (
											<div className="size-full bg-np-surface-highest" />
										)}
									</div>
									<div className="absolute -bottom-2 left-1/2 -translate-x-1/2 bg-np-primary px-3 py-1 font-label text-[11px] text-np-on-primary">
										@{profile.login}
									</div>
								</div>
								<div className="flex-1 space-y-4 text-center lg:text-left">
									<div>
										<h1 className="mb-2 font-display font-extrabold text-5xl text-np-primary leading-none">
											{profile.name ?? profile.login}
										</h1>
										<p className="max-w-2xl text-np-on-variant">
											{profile.bio ?? "No bio on record."}
										</p>
									</div>
									<div className="grid grid-cols-1 gap-4 pt-4 sm:grid-cols-3">
										<div className="group border border-np-outline-variant bg-np-surface-low p-4 transition-colors hover:border-np-primary">
											<div className={STAT_LABEL}>Public Repos</div>
											<div className={STAT_VALUE}>{profile.public_repos}</div>
										</div>
										<div className="group border border-np-outline-variant bg-np-surface-low p-4 transition-colors hover:border-np-primary">
											<div className={STAT_LABEL}>Followers</div>
											<div className={STAT_VALUE}>{profile.followers}</div>
										</div>
										<div className="group border border-np-outline-variant bg-np-surface-low p-4 transition-colors hover:border-np-primary">
											<div className={STAT_LABEL}>Following</div>
											<div className={STAT_VALUE}>{profile.following}</div>
										</div>
									</div>
								</div>
							</div>
						</section>

						<section className="space-y-6">
							<div className="flex items-center justify-between border-np-outline-variant border-b pb-2">
								<h2 className="flex items-center gap-2 font-display text-np-secondary text-xl">
									<UserCheck className="size-5" />
									SYSTEM_RECORD
								</h2>
							</div>
							<div className="grid grid-cols-1 gap-4 md:grid-cols-2">
								<MetaPacket
									icon={<Building2 className="size-4" />}
									label="Company"
									value={profile.company ?? "—"}
								/>
								<MetaPacket
									icon={<MapPin className="size-4" />}
									label="Location"
									value={profile.location ?? "—"}
								/>
								<MetaPacket
									icon={<Calendar className="size-4" />}
									label="GitHub Joined"
									value={formatDate(profile.github_created_at)}
								/>
								<MetaPacket
									icon={<Hash className="size-4" />}
									label="GitHub ID"
									value={String(profile.github_id)}
								/>
								<MetaPacket
									icon={<Clock className="size-4" />}
									label="Archived At"
									value={formatDate(profile.stored_at)}
								/>
							</div>
						</section>
					</div>
				)}
			</main>
		</>
	);
}

function MetaPacket({
	icon,
	label,
	value,
}: {
	icon: React.ReactNode;
	label: string;
	value: string;
}) {
	return (
		<div className="flex items-center justify-between border border-np-outline-variant bg-np-surface-low p-6 transition-all hover:border-np-primary hover:bg-np-primary/5">
			<div className="flex items-center gap-3 text-np-on-variant">
				{icon}
				<span className="font-label text-[11px] uppercase tracking-widest">
					{label}
				</span>
			</div>
			<span className="font-code text-np-on text-sm">{value}</span>
		</div>
	);
}
