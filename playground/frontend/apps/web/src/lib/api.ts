const API_URL = import.meta.env.VITE_API_URL ?? "";

export interface ProfileSummary {
	avatar_url: string | null;
	followers: number;
	id: number;
	login: string;
	name: string | null;
	public_repos: number;
}

export interface ProfileDetail extends ProfileSummary {
	bio: string | null;
	company: string | null;
	following: number;
	github_created_at: string | null;
	github_id: number;
	location: string | null;
	stored_at: string | null;
}

async function parseError(res: Response): Promise<string> {
	try {
		const data = (await res.json()) as { error?: string };
		return data.error ?? `请求失败 (${res.status})`;
	} catch {
		return `请求失败 (${res.status})`;
	}
}

export async function listProfiles(): Promise<ProfileSummary[]> {
	const res = await fetch(`${API_URL}/profiles`);
	if (!res.ok) {
		throw new Error(await parseError(res));
	}
	return res.json();
}

export async function getProfile(id: string | number): Promise<ProfileDetail> {
	const res = await fetch(`${API_URL}/profiles/${id}`);
	if (!res.ok) {
		throw new Error(await parseError(res));
	}
	return res.json();
}

export async function submitToken(token: string): Promise<ProfileDetail> {
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
