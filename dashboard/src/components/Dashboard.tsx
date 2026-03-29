import { useState, useEffect } from 'react';
import AnalyticsTab from './AnalyticsTab';
import JobsTab from './JobsTab';
import DebugTab from './DebugTab';

type Tab = 'analytics' | 'jobs' | 'debug';

export default function Dashboard() {
	const [tab, setTab] = useState<Tab>('analytics');
	const [token, setToken] = useState('');
	const [tokenSaved, setTokenSaved] = useState(false);

	// Hydration-safe: read localStorage only after mount (avoids React error #418)
	useEffect(() => {
		const saved = localStorage.getItem('vr2-token') ?? '';
		if (saved) { setToken(saved); setTokenSaved(true); }
	}, []);

	const saveToken = () => {
		localStorage.setItem('vr2-token', token);
		setTokenSaved(true);
	};

	return (
		<div className="min-h-screen p-4 max-w-6xl mx-auto">
			<header className="flex items-center justify-between mb-6">
				<h1 className="text-xl font-semibold tracking-tight">video-resizer-2</h1>
				<div className="flex items-center gap-2">
					<input
						type="password"
						placeholder="API token"
						value={token}
						onChange={(e) => { setToken(e.target.value); setTokenSaved(false); }}
						onKeyDown={(e) => e.key === 'Enter' && saveToken()}
						className="px-3 py-1.5 text-sm rounded-md border"
						style={{ background: 'var(--bg-card)', borderColor: 'var(--border)', color: 'var(--text)' }}
					/>
					{!tokenSaved && (
						<button onClick={saveToken} className="px-3 py-1.5 text-sm rounded-md" style={{ background: 'var(--accent)', color: 'white' }}>
							Save
						</button>
					)}
				</div>
			</header>

			<nav className="flex gap-1 mb-6 border-b" style={{ borderColor: 'var(--border)' }}>
				{(['analytics', 'jobs', 'debug'] as Tab[]).map((t) => (
					<button
						key={t}
						onClick={() => setTab(t)}
						className="px-4 py-2 text-sm font-medium capitalize transition-colors"
						style={{
							borderBottom: tab === t ? '2px solid var(--accent)' : '2px solid transparent',
							color: tab === t ? 'var(--text)' : 'var(--text-muted)',
						}}
					>
						{t}
					</button>
				))}
			</nav>

			{tab === 'analytics' && <AnalyticsTab token={token} />}
			{tab === 'jobs' && <JobsTab token={token} />}
			{tab === 'debug' && <DebugTab />}
		</div>
	);
}
