class EngineError extends Error {
  constructor(code, message, details = null) {
    super(message)
    this.name = 'EngineError'
    this.code = code
    this.details = details
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details
    }
  }

  static from(err, fallbackCode = CODES.E_INTERNAL) {
    if (err instanceof EngineError) return err
    return new EngineError(fallbackCode, err && err.message ? err.message : String(err))
  }
}

const CODES = {
  E_NET: 'E_NET',
  E_AUTH: 'E_AUTH',
  E_NOKEY: 'E_NOKEY',
  E_CORRUPT: 'E_CORRUPT',
  E_HOST_UNREACHABLE: 'E_HOST_UNREACHABLE',
  E_BACKEND_UNSUPPORTED: 'E_BACKEND_UNSUPPORTED',
  E_BACKEND_UNAVAILABLE: 'E_BACKEND_UNAVAILABLE',
  // A request that cannot be honoured as asked (e.g. changing a fixed field).
  E_INVALID: 'E_INVALID',
  // Playback, sharing or a history copy asked of a session created with
  // `record: false`: it keeps no history to play, share or copy.
  E_NOT_RECORDED: 'E_NOT_RECORDED',
  E_INTERNAL: 'E_INTERNAL'
}

module.exports = { EngineError, CODES }
