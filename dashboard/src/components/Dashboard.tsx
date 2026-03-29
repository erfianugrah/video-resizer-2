import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Container, Bug, KeyRound, Check, Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { TooltipProvider } from './ui/tooltip';
import AnalyticsTab from './AnalyticsTab';
import JobsTab from './JobsTab';
import DebugTab from './DebugTab';

export default function Dashboard() {
	const [token, setToken] = useState('');
	const [tokenSaved, setTokenSaved] = useState(false);
	const [saving, setSaving] = useState(false);

	// Hydration-safe: read localStorage only after mount
	useEffect(() => {
		const saved = localStorage.getItem('vr2-token') ?? '';
		if (saved) {
			setToken(saved);
			setTokenSaved(true);
		}
	}, []);

	const saveToken = useCallback(() => {
		localStorage.setItem('vr2-token', token);
		setSaving(true);
		setTokenSaved(true);
		setTimeout(() => setSaving(false), 1000);
	}, [token]);

	return (
		<TooltipProvider>
			<div className="min-h-screen p-4 md:p-6 max-w-6xl mx-auto">
				{/* Header */}
				<header className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
					<div className="flex items-center gap-3">
						<div className="flex h-8 w-8 items-center justify-center rounded-md bg-lv-purple/10">
							<svg className="h-5 w-5 text-lv-purple" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
								<rect x="2" y="4" width="20" height="16" rx="2" />
								<path d="M10 9l5 3-5 3V9z" fill="currentColor" />
							</svg>
						</div>
						<h1 className="text-lg font-semibold tracking-tight">video-resizer</h1>
					</div>
					<div className="flex items-center gap-2 w-full sm:w-auto">
						<div className="relative flex-1 sm:flex-initial sm:w-56">
							<KeyRound className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
							<Input
								type="password"
								placeholder="API token"
								value={token}
								onChange={(e) => { setToken(e.target.value); setTokenSaved(false); }}
								onKeyDown={(e) => e.key === 'Enter' && saveToken()}
								className="pl-8 font-data text-xs"
								aria-label="API token"
							/>
						</div>
						{!tokenSaved ? (
							<Button onClick={saveToken} size="sm">Save</Button>
						) : (
							<Button size="sm" variant="ghost" className="text-lv-green pointer-events-none" aria-label="Token saved">
								{saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
							</Button>
						)}
					</div>
				</header>

				{/* Tabs */}
				<Tabs defaultValue="analytics">
					<TabsList className="w-full sm:w-auto">
						<TabsTrigger value="analytics" className="gap-1.5">
							<BarChart3 className="h-3.5 w-3.5" />
							Analytics
						</TabsTrigger>
						<TabsTrigger value="jobs" className="gap-1.5">
							<Container className="h-3.5 w-3.5" />
							Jobs
						</TabsTrigger>
						<TabsTrigger value="debug" className="gap-1.5">
							<Bug className="h-3.5 w-3.5" />
							Debug
						</TabsTrigger>
					</TabsList>

					<TabsContent value="analytics">
						<AnalyticsTab token={token} />
					</TabsContent>
					<TabsContent value="jobs">
						<JobsTab token={token} />
					</TabsContent>
					<TabsContent value="debug">
						<DebugTab />
					</TabsContent>
				</Tabs>
			</div>
		</TooltipProvider>
	);
}
