'use strict';

// One error type carrying the wire contract: machine-readable `error`, human `message`,
// optional `detail`. Thrown by the storage layer and by routing; the server turns it into
// the failure envelope. Anything else that escapes is a bug, not a client error.
class HttpError extends Error {
	constructor(status, error, message, detail) {
		super(message);
		this.name = 'HttpError';
		this.status = status;
		this.error = error;
		this.detail = detail;
	}
}

module.exports = { HttpError };
