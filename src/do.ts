import { DurableObject } from 'cloudflare:workers';

/**
 * Retained v2 Durable Object class — live production namespace contains stored data.
 * Do not delete this class or its wrangler migration.
 */
export class SmolState extends DurableObject<Env> {
	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
	}
}

export class SmolDurableObject extends DurableObject<Env> {
	public id: string;

	constructor(state: DurableObjectState, env: Env) {
		super(state, env);
		this.id = state.id.toString();
	}

	/**
	 * Persist a single workflow step key in DO storage.
	 * New v2 workflow calls pass `{ persistMedia: false }` and manage R2 uploads explicitly
	 * in dedicated workflow steps (after swap resolution / inside the ElevenLabs step).
	 * Legacy 2-argument callers keep backwards-compatible R2 behavior during drain.
	 */
	async saveStep(step: string, data: any, options?: { persistMedia?: boolean }) {
		if (step !== 'retry_chain_root_id') {
			await this.ctx.storage.put({
				[step]: data,
				workflow_executed: true,
			});
			await this.ctx.storage.delete('retry_seed_pending');
		} else {
			await this.ctx.storage.put(step, data);
		}

		if (options?.persistMedia === false) {
			return;
		}

		switch (step) {
			case 'image_base64':
				if (typeof data === 'string' && data.length > 0) {
					await this.env.SMOL_BUCKET.put(`${this.id}.png`, Buffer.from(data, 'base64'), {
						httpMetadata: { contentType: 'image/png' },
						customMetadata: { smolId: this.id },
					});
				}
				break;

			case 'songs':
				if (Array.isArray(data)) {
					for (const song of data) {
						if (song?.audio && song.status >= 4 && song.music_id) {
							const key = `${song.music_id}.mp3`;
							if (!await this.env.SMOL_BUCKET.head(key)) {
								const res = await fetch(song.audio, { signal: AbortSignal.timeout(30_000) });
								if (!res.ok) {
									throw new Error(`Failed to fetch song audio: ${song.audio} (${res.status})`);
								}
								await this.env.SMOL_BUCKET.put(key, await res.arrayBuffer(), {
									httpMetadata: { contentType: 'audio/mpeg' },
									customMetadata: {
										smolId: this.id,
										provider: song.service || 'aisonggenerator',
									},
								});
							}
						}
					}
				}
				break;
		}
	}

	async saveSteps(entries: Record<string, unknown>) {
		const sanitized = { ...entries };
		if ('provider_attempt' in sanitized) {
			const existingAttempt = await this.ctx.storage.get<ProviderAttemptState>('provider_attempt');
			const incomingAttempt = sanitized.provider_attempt as ProviderAttemptState | undefined;
			// Defense in depth: never downgrade an existing non-failed paid claim to 'failed' or empty
			if (existingAttempt && existingAttempt.status !== 'failed' && (!incomingAttempt || incomingAttempt.status === 'failed')) {
				sanitized.provider_attempt = existingAttempt;
			}
		}
		await this.ctx.storage.put(sanitized);
	}

	/**
	 * Inspect whether a reserved retry successor DO is genuinely empty, seeded-but-unstarted,
	 * or shows evidence of prior execution (e.g. an expired Workflow instance whose DO survived).
	 */
	async inspectRetrySuccessorState(): Promise<RetrySuccessorInspection> {
		const existingMap = await this.ctx.storage.list();
		if (existingMap.size === 0) {
			return { state: 'empty' };
		}

		const existingAttempt = existingMap.get('provider_attempt') as ProviderAttemptState | undefined;
		const retrySeedPending = existingMap.get('retry_seed_pending') === true;
		const workflowExecuted = existingMap.get('workflow_executed') === true;
		const hasOwnAttempt = Boolean(
			existingAttempt
			&& (
				existingAttempt.source_smol_id === this.id
				|| existingAttempt.attempt_id === `smol-${this.id}-aisg`
			)
		);
		const hasExecutionArtifacts = Boolean(
			workflowExecuted
			|| hasOwnAttempt
			|| existingMap.has('image_base64')
			|| existingMap.has('description')
			|| existingMap.has('lyrics')
			|| existingMap.has('nsfw')
			|| existingMap.has('retry_reservation')
			|| existingMap.has('retry_successor_id')
		);

		if (retrySeedPending && !hasExecutionArtifacts) {
			const seededPayload = existingMap.get('payload') as WorkflowParams | undefined;
			const seededOverride = existingMap.get('retry_override_provider') as MusicProvider | undefined;
			return {
				state: 'seeded_unstarted',
				retrySourceId: typeof existingMap.get('retry_source_id') === 'string'
					? existingMap.get('retry_source_id') as string
					: undefined,
				provider: seededPayload?.provider,
				overrideProvider: seededOverride,
				...(existingAttempt ? { existingAttempt } : {}),
			};
		}

		return {
			state: 'executed',
			retrySourceId: typeof existingMap.get('retry_source_id') === 'string'
				? existingMap.get('retry_source_id') as string
				: undefined,
			...(existingAttempt ? { existingAttempt } : {}),
		};
	}

	/**
	 * Atomically initialize a newly reserved retry successor DO ONLY if it is currently empty.
	 * Preserves any existing DO state (especially ambiguous/submitted/committed paid claims)
	 * untouched so recovery after Workflow retention expiry can never overwrite a successor's claim.
	 */
	async seedRetrySuccessorIfEmpty(entries: Record<string, unknown>): Promise<{
		seeded: boolean;
		inspection: RetrySuccessorInspection;
	}> {
		const existingMap = await this.ctx.storage.list();
		if (existingMap.size === 0) {
			await this.ctx.storage.put({
				...entries,
				retry_seed_pending: true,
			});
			return {
				seeded: true,
				inspection: { state: 'seeded_unstarted' },
			};
		}

		const inspection = await this.inspectRetrySuccessorState();
		return {
			seeded: false,
			inspection,
		};
	}

	async getStep<T = unknown>(step: string): Promise<T | undefined> {
		return await this.ctx.storage.get<T>(step);
	}

	async getSteps() {
		return Object.fromEntries((await this.ctx.storage.list()).entries());
	}

	/**
	 * Atomically claim a paid generation attempt before dispatching to an external provider.
	 * Prevents workflow replays or cross-provider retries from silently authorizing a duplicate
	 * paid POST while any attempt is claimed, submitted, committed, or ambiguous.
	 */
	async claimPaidAttempt(
		provider: MusicProvider,
		meta?: Partial<ProviderAttemptState>
	): Promise<{ claimed: boolean; attempt: ProviderAttemptState }> {
		const existing = await this.ctx.storage.get<ProviderAttemptState>('provider_attempt');
		if (existing && existing.status !== 'failed') {
			return { claimed: false, attempt: existing };
		}

		const nextAttempt: ProviderAttemptState = {
			...meta,
			provider,
			status: 'claimed',
			updated_at: new Date().toISOString(),
		};
		await this.ctx.storage.put({
			provider_attempt: nextAttempt,
			workflow_executed: true,
		});
		await this.ctx.storage.delete('retry_seed_pending');
		return { claimed: true, attempt: nextAttempt };
	}

	async updatePaidAttempt(attempt: ProviderAttemptState): Promise<void> {
		await this.ctx.storage.put({
			provider_attempt: {
				...attempt,
				updated_at: new Date().toISOString(),
			},
			workflow_executed: true,
		});
		await this.ctx.storage.delete('retry_seed_pending');
	}

	/**
	 * Read the current retry reservation (successorId + authoritative predecessorId).
	 * Falls back cleanly to legacy `retry_successor_id` entries stored prior to reservation metadata.
	 */
	async getRetryReservation(): Promise<RetryReservation | null> {
		const reservation = await this.ctx.storage.get<RetryReservation>('retry_reservation');
		if (reservation?.successorId) {
			return {
				successorId: reservation.successorId,
				predecessorId: reservation.predecessorId || this.id,
			};
		}
		const legacy = await this.ctx.storage.get<string>('retry_successor_id');
		if (legacy) {
			return {
				successorId: legacy,
				predecessorId: this.id,
			};
		}
		return null;
	}

	/**
	 * Atomically deduplicate concurrent manual retries targeting the same failed smol chain,
	 * persisting the authoritative predecessor ID alongside the reserved successor ID so crash
	 * recovery restores the predecessor's paid claim/receipt instead of an older ancestor.
	 */
	async claimRetrySuccessor(
		candidateId: string,
		predecessorId?: string
	): Promise<{ successorId: string; predecessorId: string; isNew: boolean }> {
		const existing = await this.getRetryReservation();
		if (existing) {
			return { ...existing, isNew: false };
		}
		const next: RetryReservation = {
			successorId: candidateId,
			predecessorId: predecessorId || this.id,
		};
		await this.ctx.storage.put({
			retry_reservation: next,
			retry_successor_id: candidateId,
		});
		return { ...next, isNew: true };
	}

	async replaceRetrySuccessor(
		previousId: string,
		candidateId: string,
		predecessorId?: string
	): Promise<{ successorId: string; predecessorId: string; isNew: boolean }> {
		const existing = await this.getRetryReservation();
		if (existing && existing.successorId !== previousId) {
			return { ...existing, isNew: false };
		}
		const next: RetryReservation = {
			successorId: candidateId,
			predecessorId: predecessorId || previousId || this.id,
		};
		await this.ctx.storage.put({
			retry_reservation: next,
			retry_successor_id: candidateId,
		});
		return { ...next, isNew: true };
	}

	async setToFlush() {
		await this.ctx.storage.setAlarm(Date.now() + (1000 * 60));
	}

	private async flush() {
		await this.ctx.storage.deleteAll();
	}

	async alarm() {
		await this.flush();
	}
}
