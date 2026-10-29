// src/panel/admin-error.ts
/** Only explicitly public messages may be returned by administration APIs. */
var AdminInputError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "AdminInputError";
	}
};

export { AdminInputError };