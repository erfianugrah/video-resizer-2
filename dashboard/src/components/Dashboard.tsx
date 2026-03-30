import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { BarChart3, Container, Bug, Loader2 } from 'lucide-react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from './ui/tabs';
import { TooltipProvider } from './ui/tooltip';

const AnalyticsTab = lazy(() => import('./AnalyticsTab.lazy'));
const JobsTab = lazy(() => import('./JobsTab.lazy'));
const DebugTab = lazy(() => import('./DebugTab.lazy'));

/** Minimal loading fallback for lazy-loaded tabs. */
function TabFallback() {
	return <div className="flex items-center justify-center h-48"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
}

/**
 * Root dashboard component with tab navigation.
 *
 * Auth is handled by the server-side session cookie (set at login).
 * API calls use `credentials: 'same-origin'` so the browser sends
 * the cookie automatically — no manual token input needed.
 */
export function Dashboard() {
	const [activeTab, setActiveTab] = useState(() => {
		// Restore tab from URL hash on initial load (e.g. #jobs, #debug)
		if (typeof window !== 'undefined') {
			const hash = window.location.hash.slice(1);
			if (['analytics', 'jobs', 'debug'].includes(hash)) return hash;
		}
		return 'analytics';
	});

	// Persist active tab in URL hash so refresh stays on the same page
	const changeTab = useCallback((tab: string) => {
		setActiveTab(tab);
		window.location.hash = tab === 'analytics' ? '' : tab;
	}, []);

	// Handle browser back/forward with hash changes
	useEffect(() => {
		const onHashChange = () => {
			const hash = window.location.hash.slice(1);
			if (['analytics', 'jobs', 'debug'].includes(hash)) setActiveTab(hash);
			else setActiveTab('analytics');
		};
		window.addEventListener('hashchange', onHashChange);
		return () => window.removeEventListener('hashchange', onHashChange);
	}, []);

	return (
		<TooltipProvider>
			<div className="min-h-screen p-4 md:p-6 max-w-6xl mx-auto">
				{/* Header */}
				<header className="flex items-center gap-3 mb-6">
					<div className="flex h-8 w-8 items-center justify-center rounded-md bg-lv-purple/10">
						<svg className="h-5 w-5 text-lv-purple" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
							<rect x="2" y="4" width="20" height="16" rx="2" />
							<path d="M10 9l5 3-5 3V9z" fill="currentColor" />
						</svg>
					</div>
					<h1 className="text-lg font-semibold tracking-tight">video-resizer</h1>
				</header>

				{/* Tabs — only the active tab renders its content */}
				<Tabs value={activeTab} onValueChange={changeTab}>
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

					<Suspense fallback={<TabFallback />}>
						{activeTab === 'analytics' && (
							<TabsContent value="analytics" forceMount>
								<AnalyticsTab />
							</TabsContent>
						)}
						{activeTab === 'jobs' && (
							<TabsContent value="jobs" forceMount>
								<JobsTab />
							</TabsContent>
						)}
						{activeTab === 'debug' && (
							<TabsContent value="debug" forceMount>
								<DebugTab />
							</TabsContent>
						)}
					</Suspense>
				</Tabs>
			</div>
		</TooltipProvider>
	);
}
