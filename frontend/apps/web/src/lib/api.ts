const API_URL = import.meta.env.VITE_API_URL ?? "";

// 与 Go profile-service 实际返回一致：含 github_id，无 stored_at，空值为 "" 而非 null
export interface Profile {
	avatar_url: string;
	bio: string;
	company: string;
	followers: number;
	following: number;
	github_created_at: string;
	github_id: number;
	id: number;
	location: string;
	login: string;
	name: string;
	public_repos: number;
}

// stats-service：/stats/{gid} 语言聚合
export interface LangStat {
	language: string;
	repo_count: number;
	star_sum: number;
}

// stats-service：/repos/{gid} 单仓库
export interface RepoStat {
	github_id: number;
	language: string;
	repo_name: string;
	stargazers_count: number;
	updated_at: string;
}

export type LeaderboardBy = "repos" | "stars";

// stats-service：/leaderboard，展示字段经 Cloud Map 从 profile-service 补全
export interface LeaderboardEntry {
	avatar_url: string;
	github_id: number;
	login: string;
	name: string;
	total_repos: number;
	total_stars: number;
}

export interface SearchFilter {
	location?: string;
	minFollowers?: number;
	q?: string;
}

async function parseError(res: Response): Promise<string> {
	try {
		const data = (await res.json()) as { error?: string };
		return data.error ?? `请求失败 (${res.status})`;
	} catch {
		return `请求失败 (${res.status})`;
	}
}

// 统一 GET + 错误处理
async function request<T>(path: string): Promise<T> {
	const res = await fetch(`${API_URL}${path}`);
	if (!res.ok) {
		throw new Error(await parseError(res));
	}
	return res.json() as Promise<T>;
}

export function listProfiles(): Promise<Profile[]> {
	return request<Profile[]>("/profiles");
}

export function getProfile(id: number | string): Promise<Profile> {
	return request<Profile>(`/profiles/${id}`);
}

export function searchProfiles(filter: SearchFilter): Promise<Profile[]> {
	const params = new URLSearchParams();
	if (filter.q) {
		params.set("q", filter.q);
	}
	if (filter.location) {
		params.set("location", filter.location);
	}
	if (filter.minFollowers && filter.minFollowers > 0) {
		params.set("minFollowers", String(filter.minFollowers));
	}
	const qs = params.toString();
	return request<Profile[]>(qs ? `/profiles?${qs}` : "/profiles");
}

export function getStats(gid: number): Promise<LangStat[]> {
	return request<LangStat[]>(`/stats/${gid}`);
}

export function getRepos(gid: number): Promise<RepoStat[]> {
	return request<RepoStat[]>(`/repos/${gid}`);
}

export function getLeaderboard(by: LeaderboardBy): Promise<LeaderboardEntry[]> {
	return request<LeaderboardEntry[]>(`/leaderboard?by=${by}`);
}

export async function submitToken(token: string): Promise<Profile> {
	const res = await fetch(`${API_URL}/profiles`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ token }),
	});
	if (!res.ok) {
		throw new Error(await parseError(res));
	}
	return res.json();
}
