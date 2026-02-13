import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	api,
	type ChannelInfo,
	type InboundMessageEvent,
	type OutboundMessageEvent,
	type TypingStateEvent,
	type WorkerStartedEvent,
	type WorkerStatusEvent,
	type WorkerCompletedEvent,
	type BranchStartedEvent,
	type BranchCompletedEvent,
	type ToolStartedEvent,
	type ToolCompletedEvent,
} from "./api/client";
import { useEventSource } from "./hooks/useEventSource";

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 30_000,
			retry: 1,
			refetchOnWindowFocus: true,
		},
	},
});

interface ChatMessage {
	id: string;
	sender: "user" | "bot";
	senderName?: string;
	text: string;
	timestamp: number;
}

interface ActiveWorker {
	id: string;
	task: string;
	status: string;
	startedAt: number;
	toolCalls: number;
	currentTool: string | null;
}

interface ActiveBranch {
	id: string;
	description: string;
	startedAt: number;
	currentTool: string | null;
	lastTool: string | null;
	toolCalls: number;
}

interface ChannelLiveState {
	isTyping: boolean;
	messages: ChatMessage[];
	workers: Record<string, ActiveWorker>;
	branches: Record<string, ActiveBranch>;
	historyLoaded: boolean;
}

const VISIBLE_MESSAGES = 6;
const MAX_MESSAGES = 50;

function emptyLiveState(): ChannelLiveState {
	return { isTyping: false, messages: [], workers: {}, branches: {}, historyLoaded: false };
}

function formatUptime(seconds: number): string {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = seconds % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function formatTimeAgo(dateStr: string): string {
	const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
	if (seconds < 60) return "just now";
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
	if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
	return `${Math.floor(seconds / 86400)}d ago`;
}

function formatTimestamp(ts: number): string {
	return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDuration(startMs: number): string {
	const seconds = Math.floor((Date.now() - startMs) / 1000);
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function platformIcon(platform: string): string {
	switch (platform) {
		case "discord": return "Discord";
		case "slack": return "Slack";
		case "telegram": return "Telegram";
		case "webhook": return "Webhook";
		case "cron": return "Cron";
		default: return platform;
	}
}

function platformColor(platform: string): string {
	switch (platform) {
		case "discord": return "bg-indigo-500/20 text-indigo-400";
		case "slack": return "bg-green-500/20 text-green-400";
		case "telegram": return "bg-blue-500/20 text-blue-400";
		case "cron": return "bg-amber-500/20 text-amber-400";
		default: return "bg-gray-500/20 text-gray-400";
	}
}

function WorkerBadge({ worker }: { worker: ActiveWorker }) {
	return (
		<div className="flex items-center gap-2 rounded-md bg-amber-500/10 px-2.5 py-1.5 text-tiny">
			<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-amber-300">Worker</span>
					<span className="truncate text-ink-dull">{worker.task}</span>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-ink-faint">
					<span>{worker.status}</span>
					{worker.currentTool && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span className="text-amber-400/70">{worker.currentTool}</span>
						</>
					)}
					{worker.toolCalls > 0 && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span>{worker.toolCalls} tools</span>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function BranchBadge({ branch }: { branch: ActiveBranch }) {
	const displayTool = branch.currentTool ?? branch.lastTool;
	return (
		<div className="flex items-center gap-2 rounded-md bg-violet-500/10 px-2.5 py-1.5 text-tiny">
			<div className="h-1.5 w-1.5 animate-pulse rounded-full bg-violet-400" />
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-1.5">
					<span className="font-medium text-violet-300">Branch</span>
					<span className="truncate text-ink-dull">{branch.description}</span>
				</div>
				<div className="mt-0.5 flex items-center gap-2 text-ink-faint">
					<span>{formatDuration(branch.startedAt)}</span>
					{displayTool && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span className={branch.currentTool ? "text-violet-400/70" : "text-violet-400/40"}>{displayTool}</span>
						</>
					)}
					{branch.toolCalls > 0 && (
						<>
							<span className="text-ink-faint/50">·</span>
							<span>{branch.toolCalls} tools</span>
						</>
					)}
				</div>
			</div>
		</div>
	);
}

function ChannelCard({
	channel,
	liveState,
}: {
	channel: ChannelInfo;
	liveState: ChannelLiveState | undefined;
}) {
	const isTyping = liveState?.isTyping ?? false;
	const messages = liveState?.messages ?? [];
	const workers = Object.values(liveState?.workers ?? {});
	const branches = Object.values(liveState?.branches ?? {});
	const visible = messages.slice(-VISIBLE_MESSAGES);
	const hasActivity = workers.length > 0 || branches.length > 0;

	return (
		<div className="flex flex-col rounded-lg border border-app-line bg-app-darkBox transition-colors hover:border-app-line/80">
			{/* Header */}
			<div className="flex items-start justify-between p-4 pb-2">
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="truncate font-medium text-ink">
							{channel.display_name ?? channel.id}
						</h3>
						{isTyping && (
							<div className="flex items-center gap-1">
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0.2s]" />
								<span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent [animation-delay:0.4s]" />
							</div>
						)}
					</div>
					<div className="mt-1 flex items-center gap-2">
						<span className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-tiny font-medium ${platformColor(channel.platform)}`}>
							{platformIcon(channel.platform)}
						</span>
						<span className="text-tiny text-ink-faint">
							{formatTimeAgo(channel.last_activity_at)}
						</span>
						{hasActivity && (
							<span className="text-tiny text-ink-faint">
								{workers.length > 0 && `${workers.length}w`}
								{workers.length > 0 && branches.length > 0 && " "}
								{branches.length > 0 && `${branches.length}b`}
							</span>
						)}
					</div>
				</div>
				<div className="ml-2 flex-shrink-0">
					<div className={`h-2 w-2 rounded-full ${
						hasActivity ? "bg-amber-400 animate-pulse" :
						isTyping ? "bg-accent animate-pulse" :
						"bg-green-500/60"
					}`} />
				</div>
			</div>

			{/* Active workers and branches */}
			{hasActivity && (
				<div className="flex flex-col gap-1.5 px-4 pb-2">
					{workers.map((worker) => (
						<WorkerBadge key={worker.id} worker={worker} />
					))}
					{branches.map((branch) => (
						<BranchBadge key={branch.id} branch={branch} />
					))}
				</div>
			)}

			{/* Message stream */}
			{visible.length > 0 && (
				<div className="flex flex-col gap-1 border-t border-app-line/50 p-3">
					{messages.length > VISIBLE_MESSAGES && (
						<span className="mb-1 text-tiny text-ink-faint">
							{messages.length - VISIBLE_MESSAGES} earlier messages
						</span>
					)}
					{visible.map((message) => (
						<div key={message.id} className="flex gap-2 text-sm">
							<span className="flex-shrink-0 text-tiny text-ink-faint">
								{formatTimestamp(message.timestamp)}
							</span>
							<span className={`flex-shrink-0 text-tiny font-medium ${
								message.sender === "user" ? "text-accent-faint" : "text-green-400"
							}`}>
								{message.sender === "user" ? (message.senderName ?? "user") : "bot"}
							</span>
							<p className="line-clamp-1 text-sm text-ink-dull">{message.text}</p>
						</div>
					))}
				</div>
			)}
		</div>
	);
}

function Dashboard() {
	const { data: statusData } = useQuery({
		queryKey: ["status"],
		queryFn: api.status,
		refetchInterval: 5000,
	});

	const { data: channelsData, isLoading: channelsLoading } = useQuery({
		queryKey: ["channels"],
		queryFn: api.channels,
		refetchInterval: 10000,
	});

	const [liveStates, setLiveStates] = useState<Record<string, ChannelLiveState>>({});

	// Load conversation history for each channel on first appearance
	const channels = channelsData?.channels ?? [];
	useEffect(() => {
		for (const channel of channels) {
			setLiveStates((prev) => {
				if (prev[channel.id]?.historyLoaded) return prev;

				const updated = {
					...prev,
					[channel.id]: { ...(prev[channel.id] ?? emptyLiveState()), historyLoaded: true },
				};

				api.channelMessages(channel.id, MAX_MESSAGES).then((data) => {
					const history: ChatMessage[] = data.messages.map((message) => ({
						id: message.id,
						sender: message.role === "user" ? "user" as const : "bot" as const,
						senderName: message.sender_name ?? (message.role === "user" ? message.sender_id ?? undefined : undefined),
						text: message.content,
						timestamp: new Date(message.created_at).getTime(),
					}));

					setLiveStates((current) => {
						const existing = current[channel.id];
						if (!existing) return current;
						const sseMessages = existing.messages;
						const lastHistoryTs = history.length > 0 ? history[history.length - 1].timestamp : 0;
						const newSseMessages = sseMessages.filter((m) => m.timestamp > lastHistoryTs);
						return {
							...current,
							[channel.id]: {
								...existing,
								messages: [...history, ...newSseMessages].slice(-MAX_MESSAGES),
							},
						};
					});
				}).catch((error) => {
					console.warn(`Failed to load history for ${channel.id}:`, error);
				});

				return updated;
			});
		}
	}, [channels]);

	// Fetch channel status snapshot once on mount for initial state
	useEffect(() => {
		api.channelStatus().then((statusMap) => {
			setLiveStates((prev) => {
				const next = { ...prev };
				for (const [channelId, snapshot] of Object.entries(statusMap)) {
					const existing = next[channelId] ?? emptyLiveState();
					const workers: Record<string, ActiveWorker> = {};
					for (const w of snapshot.active_workers) {
						workers[w.id] = {
							id: w.id,
							task: w.task,
							status: w.status,
							startedAt: new Date(w.started_at).getTime(),
							toolCalls: w.tool_calls,
							currentTool: null,
						};
					}
						const branches: Record<string, ActiveBranch> = {};
						for (const b of snapshot.active_branches) {
							branches[b.id] = {
								id: b.id,
								description: b.description,
								startedAt: new Date(b.started_at).getTime(),
								currentTool: null,
								lastTool: null,
								toolCalls: 0,
							};
						}
					next[channelId] = { ...existing, workers, branches };
				}
				return next;
			});
		}).catch(() => {});
	}, []);

	const getState = useCallback((channelId: string) => {
		return (prev: Record<string, ChannelLiveState>) =>
			prev[channelId] ?? emptyLiveState();
	}, []);

	const pushMessage = useCallback((channelId: string, message: ChatMessage) => {
		setLiveStates((prev) => {
			const existing = getState(channelId)(prev);
			const messages = [...existing.messages, message].slice(-MAX_MESSAGES);
			return { ...prev, [channelId]: { ...existing, messages } };
		});
	}, [getState]);

	const handleInboundMessage = useCallback((data: unknown) => {
		const event = data as InboundMessageEvent;
		pushMessage(event.channel_id, {
			id: `in-${Date.now()}-${Math.random()}`,
			sender: "user",
			senderName: event.sender_id,
			text: event.text,
			timestamp: Date.now(),
		});
		queryClient.invalidateQueries({ queryKey: ["channels"] });
	}, [pushMessage]);

	const handleOutboundMessage = useCallback((data: unknown) => {
		const event = data as OutboundMessageEvent;
		pushMessage(event.channel_id, {
			id: `out-${Date.now()}-${Math.random()}`,
			sender: "bot",
			text: event.text,
			timestamp: Date.now(),
		});
		setLiveStates((prev) => {
			const existing = getState(event.channel_id)(prev);
			return { ...prev, [event.channel_id]: { ...existing, isTyping: false } };
		});
		queryClient.invalidateQueries({ queryKey: ["channels"] });
	}, [pushMessage, getState]);

	const handleTypingState = useCallback((data: unknown) => {
		const event = data as TypingStateEvent;
		setLiveStates((prev) => {
			const existing = getState(event.channel_id)(prev);
			return { ...prev, [event.channel_id]: { ...existing, isTyping: event.is_typing } };
		});
	}, [getState]);

	const handleWorkerStarted = useCallback((data: unknown) => {
		const event = data as WorkerStartedEvent;
		setLiveStates((prev) => {
			const existing = getState(event.channel_id)(prev);
			return {
				...prev,
				[event.channel_id]: {
					...existing,
					workers: {
						...existing.workers,
						[event.worker_id]: {
							id: event.worker_id,
							task: event.task,
							status: "starting",
							startedAt: Date.now(),
							toolCalls: 0,
							currentTool: null,
						},
					},
				},
			};
		});
	}, [getState]);

	const handleWorkerStatus = useCallback((data: unknown) => {
		const event = data as WorkerStatusEvent;
		setLiveStates((prev) => {
			for (const [channelId, state] of Object.entries(prev)) {
				const worker = state.workers[event.worker_id];
				if (worker) {
					return {
						...prev,
						[channelId]: {
							...state,
							workers: {
								...state.workers,
								[event.worker_id]: { ...worker, status: event.status },
							},
						},
					};
				}
			}
			return prev;
		});
	}, []);

	const handleWorkerCompleted = useCallback((data: unknown) => {
		const event = data as WorkerCompletedEvent;
		setLiveStates((prev) => {
			for (const [channelId, state] of Object.entries(prev)) {
				if (state.workers[event.worker_id]) {
					const { [event.worker_id]: _, ...remainingWorkers } = state.workers;
					return {
						...prev,
						[channelId]: { ...state, workers: remainingWorkers },
					};
				}
			}
			return prev;
		});
	}, []);

	const handleBranchStarted = useCallback((data: unknown) => {
		const event = data as BranchStartedEvent;
		setLiveStates((prev) => {
			const existing = getState(event.channel_id)(prev);
			return {
				...prev,
				[event.channel_id]: {
					...existing,
					branches: {
						...existing.branches,
						[event.branch_id]: {
							id: event.branch_id,
							description: event.description || "thinking...",
							startedAt: Date.now(),
							currentTool: null,
							lastTool: null,
							toolCalls: 0,
						},
					},
				},
			};
		});
	}, [getState]);

	const handleBranchCompleted = useCallback((data: unknown) => {
		const event = data as BranchCompletedEvent;
		setLiveStates((prev) => {
			for (const [channelId, state] of Object.entries(prev)) {
				if (state.branches[event.branch_id]) {
					const { [event.branch_id]: _, ...remainingBranches } = state.branches;
					return {
						...prev,
						[channelId]: { ...state, branches: remainingBranches },
					};
				}
			}
			return prev;
		});
	}, []);

	const handleToolStarted = useCallback((data: unknown) => {
		const event = data as ToolStartedEvent;
		setLiveStates((prev) => {
			for (const [channelId, state] of Object.entries(prev)) {
				if (event.process_type === "worker" && state.workers[event.process_id]) {
					const worker = state.workers[event.process_id];
					return {
						...prev,
						[channelId]: {
							...state,
							workers: {
								...state.workers,
								[event.process_id]: { ...worker, currentTool: event.tool_name },
							},
						},
					};
				}
				if (event.process_type === "branch" && state.branches[event.process_id]) {
					const branch = state.branches[event.process_id];
					return {
						...prev,
						[channelId]: {
							...state,
							branches: {
								...state.branches,
								[event.process_id]: { ...branch, currentTool: event.tool_name },
							},
						},
					};
				}
			}
			return prev;
		});
	}, []);

	const handleToolCompleted = useCallback((data: unknown) => {
		const event = data as ToolCompletedEvent;
		setLiveStates((prev) => {
			for (const [channelId, state] of Object.entries(prev)) {
				if (event.process_type === "worker" && state.workers[event.process_id]) {
					const worker = state.workers[event.process_id];
					return {
						...prev,
						[channelId]: {
							...state,
							workers: {
								...state.workers,
								[event.process_id]: {
									...worker,
									currentTool: null,
									toolCalls: worker.toolCalls + 1,
								},
							},
						},
					};
				}
				if (event.process_type === "branch" && state.branches[event.process_id]) {
					const branch = state.branches[event.process_id];
					return {
						...prev,
						[channelId]: {
							...state,
							branches: {
								...state.branches,
								[event.process_id]: {
									...branch,
									currentTool: null,
									lastTool: event.tool_name,
									toolCalls: branch.toolCalls + 1,
								},
							},
						},
					};
				}
			}
			return prev;
		});
	}, []);

	const handlers = useMemo(() => ({
		inbound_message: handleInboundMessage,
		outbound_message: handleOutboundMessage,
		typing_state: handleTypingState,
		worker_started: handleWorkerStarted,
		worker_status: handleWorkerStatus,
		worker_completed: handleWorkerCompleted,
		branch_started: handleBranchStarted,
		branch_completed: handleBranchCompleted,
		tool_started: handleToolStarted,
		tool_completed: handleToolCompleted,
	}), [
		handleInboundMessage, handleOutboundMessage, handleTypingState,
		handleWorkerStarted, handleWorkerStatus, handleWorkerCompleted,
		handleBranchStarted, handleBranchCompleted,
		handleToolStarted, handleToolCompleted,
	]);

	useEventSource(api.eventsUrl, { handlers });

	// Count totals for header
	const totalWorkers = Object.values(liveStates).reduce(
		(sum, s) => sum + Object.keys(s.workers).length, 0,
	);
	const totalBranches = Object.values(liveStates).reduce(
		(sum, s) => sum + Object.keys(s.branches).length, 0,
	);

	return (
		<div className="min-h-screen bg-app">
			{/* Header */}
			<div className="border-b border-app-line bg-app-darkBox/50 px-6 py-4">
				<div className="mx-auto flex max-w-5xl items-center justify-between">
					<div>
						<h1 className="font-plex text-lg font-semibold text-ink">Spacebot</h1>
						<p className="text-tiny text-ink-faint">Control Interface</p>
					</div>
					<div className="flex items-center gap-4 text-sm">
						{statusData && (
							<>
								<div className="flex items-center gap-1.5">
									<div className="h-2 w-2 rounded-full bg-green-500" />
									<span className="text-ink-dull">Running</span>
								</div>
								<span className="text-ink-faint">
									{formatUptime(statusData.uptime_seconds)}
								</span>
							</>
						)}
						{(totalWorkers > 0 || totalBranches > 0) && (
							<div className="flex items-center gap-2 text-tiny">
								{totalWorkers > 0 && (
									<span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-amber-400">
										{totalWorkers} worker{totalWorkers !== 1 ? "s" : ""}
									</span>
								)}
								{totalBranches > 0 && (
									<span className="rounded-md bg-violet-500/15 px-1.5 py-0.5 text-violet-400">
										{totalBranches} branch{totalBranches !== 1 ? "es" : ""}
									</span>
								)}
							</div>
						)}
					</div>
				</div>
			</div>

			{/* Content */}
			<div className="mx-auto max-w-5xl p-6">
				<div className="mb-4 flex items-center justify-between">
					<h2 className="font-plex text-sm font-medium text-ink-dull">
						Active Channels
					</h2>
					<span className="text-tiny text-ink-faint">
						{channels.length} channel{channels.length !== 1 ? "s" : ""}
					</span>
				</div>

				{channelsLoading ? (
					<div className="flex items-center gap-2 text-ink-dull">
						<div className="h-2 w-2 animate-pulse rounded-full bg-accent" />
						Loading channels...
					</div>
				) : channels.length === 0 ? (
					<div className="rounded-lg border border-dashed border-app-line p-8 text-center">
						<p className="text-sm text-ink-faint">
							No active channels. Send a message via Discord, Slack, or webhook to get started.
						</p>
					</div>
				) : (
					<div className="grid gap-3 sm:grid-cols-2">
						{channels.map((channel) => (
							<ChannelCard
								key={channel.id}
								channel={channel}
								liveState={liveStates[channel.id]}
							/>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

export function App() {
	return (
		<QueryClientProvider client={queryClient}>
			<Dashboard />
		</QueryClientProvider>
	);
}
