type Stop = () => void | Promise<unknown>

export async function stopServices(...stops: Stop[]): Promise<void> {
  const results = await Promise.allSettled(stops.map(stop => Promise.resolve().then(stop)))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, errors.map(String).join('\n'))
}

/** Only the approved second app.quit() may reach will-quit and close SQLite. */
export class QuitCoordinator {
  private phase: 'idle' | 'confirming' | 'stopping' | 'retry' | 'ready' = 'idle'
  private options: { confirm: () => Promise<boolean>; stop: Stop; quit: () => void; failed: (cause: unknown) => void }
  constructor(options: QuitCoordinator['options']) { this.options = options }
  get ready() { return this.phase === 'ready' }
  get stopping() { return this.phase === 'stopping' || this.phase === 'retry' || this.ready }
  async beforeQuit(event: { preventDefault(): void }) {
    if (this.ready) return
    event.preventDefault()
    if (this.phase === 'confirming' || this.phase === 'stopping') return
    try {
      if (this.phase === 'idle') {
        this.phase = 'confirming'
        if (!await this.options.confirm()) { this.phase = 'idle'; return }
      }
      this.phase = 'stopping'
      await this.options.stop()
      this.phase = 'ready'
      this.options.quit()
    } catch (cause) {
      this.phase = this.phase === 'confirming' ? 'idle' : 'retry'
      this.options.failed(cause)
    }
  }
}
